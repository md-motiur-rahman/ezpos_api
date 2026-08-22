import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { WebSocket } from 'ws';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { attachKdsSocketServer } from '../../src/modules/kds/kdsSocket.js';

const KNOWN_PIN = '12345678';

/**
 * These tests cannot use supertest for the connection itself - supertest
 * drives HTTP requests, and a WebSocket upgrade never completes through it.
 * So each test binds a REAL http.Server on an ephemeral port (port 0),
 * attaches the KDS socket server to it exactly as src/server.js does, and
 * connects with a real `ws` client.
 *
 * The REST calls still go through supertest against the same `app`. That
 * works because both live in ONE process: kdsSocket.js's connection registry
 * is module-level, so an order created via supertest reaches the socket
 * connected to the standalone server through that shared module state -
 * which is precisely the mechanism production uses too.
 */

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('kds-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function createShop(header, name) {
  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name,
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone: '02011112222',
      vatRegistered: false,
    });
  return res.body.id;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: `KDS Test Ltd ${crypto.randomUUID()}`,
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'chain' });
  const shopId = await createShop(header, 'Test Shop');
  return { header, shopId };
}

async function insertStaff(shopId, role) {
  const pinHash = await bcrypt.hash(KNOWN_PIN, 4); // low cost - tests only
  const staffIdCode = String(crypto.randomInt(10_000_000, 99_999_999));
  const { rows } = await query(
    `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [shopId, `Test ${role}`, role, staffIdCode, pinHash]
  );
  return { id: rows[0].id, staffIdCode };
}

async function staffHeaderFor(shopId, staffIdCode) {
  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });
  return `Bearer ${res.body.sessionToken}`;
}

async function createMenuItem(header, name, price) {
  const catRes = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: `Mains ${crypto.randomUUID()}` });
  const itemRes = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: catRes.body.id, name, price });
  return itemRes.body.id;
}

// --- Real server + socket plumbing ---

async function startServer() {
  const server = http.createServer(app);
  const kds = attachKdsSocketServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, kds, port: server.address().port };
}

async function stopServer(ctx) {
  ctx.kds.close();
  await new Promise((resolve) => ctx.server.close(resolve));
}

/**
 * A no-op 'error' listener is attached at creation deliberately. On an
 * EventEmitter, an 'error' event with NO listener is re-thrown by Node as an
 * uncaught exception - and a refused upgrade emits exactly that
 * asynchronously (terminate() on a still-CONNECTING socket aborts the
 * handshake and emits). Because it is async, a try/catch around the call
 * cannot catch it. Keeping one permanent listener here makes that
 * structurally impossible; the assertions below still attach their own
 * listeners and still observe real errors.
 */
function attachTo(ws) {
  ws.on('error', () => {});
  return ws;
}

function connect(port, shopId, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : {};
  return attachTo(
    new WebSocket(`ws://127.0.0.1:${port}/api/shops/${shopId}/kds/socket`, { headers })
  );
}

/** Resolves with the next parsed message, or rejects on timeout/socket error. */
function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for a KDS message'));
    }, timeoutMs);
    function onMessage(raw) {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

/** Resolves with the HTTP status code the server refused the upgrade with. */
function expectRejection(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for an upgrade rejection'));
    }, timeoutMs);
    function onUnexpected(req, res) {
      cleanup();
      res.resume(); // drain, so the socket can close cleanly
      resolve(res.statusCode);
    }
    function onOpen() {
      cleanup();
      reject(new Error('the socket opened when it should have been refused'));
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('unexpected-response', onUnexpected);
      ws.off('open', onOpen);
      ws.off('error', onError);
    }
    ws.on('unexpected-response', onUnexpected);
    ws.on('open', onOpen);
    ws.on('error', onError);
  });
}

/** Resolves only if NO message arrives within the window - used for isolation. */
function expectNoMessage(ws, windowMs = 600) {
  return new Promise((resolve, reject) => {
    function onMessage(raw) {
      cleanup();
      reject(new Error(`received an unexpected KDS message: ${raw.toString()}`));
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, windowMs);
    ws.on('message', onMessage);
  });
}

/**
 * Cleanup that is safe for a socket which was REFUSED before it ever
 * opened. `ws.terminate()` throws "WebSocket was closed before the
 * connection was established" in that state, which would otherwise surface
 * from a finally block and mask the real assertion result.
 */
function closeQuietly(ws) {
  if (!ws) {
    return;
  }
  try {
    ws.terminate();
  } catch {
    // Already refused / never established - nothing to tear down.
  }
}

/** Connects and consumes the kds.connected handshake message. */
async function connectReady(port, shopId, authHeader) {
  const ws = connect(port, shopId, authHeader);
  const hello = await nextMessage(ws);
  assert.equal(hello.type, 'kds.connected', 'first frame must be the connected handshake');
  return ws;
}

function createOrder(header, shopId, itemId) {
  return request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({ type: 'takeaway', items: [{ menuItemId: itemId, quantity: 1 }] });
}

// --- Connection: authentication ---

test('an owner can open a KDS socket and receives the connected handshake', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  let ws;
  try {
    ws = connect(ctx.port, shopId, header);
    const hello = await nextMessage(ws);
    assert.equal(hello.type, 'kds.connected');
    assert.equal(hello.shopId, shopId);
    assert.equal(hello.actor.type, 'owner');
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('a connection with no Authorization header is refused with 401', async () => {
  const ctx = await startServer();
  const { shopId } = await setupOwnerWithShop();
  let ws;
  try {
    ws = connect(ctx.port, shopId, null);
    assert.equal(await expectRejection(ws), 401);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('a connection with a garbage token is refused with 401', async () => {
  const ctx = await startServer();
  const { shopId } = await setupOwnerWithShop();
  let ws;
  try {
    ws = connect(ctx.port, shopId, 'Bearer not-a-real-token');
    assert.equal(await expectRejection(ws), 401);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('a request to a path that is not the KDS socket is refused with 404', async () => {
  const ctx = await startServer();
  const { header } = await setupOwnerWithShop();
  let ws;
  try {
    ws = attachTo(
      new WebSocket(`ws://127.0.0.1:${ctx.port}/api/not-the-kds`, {
        headers: { Authorization: header },
      })
    );
    assert.equal(await expectRejection(ws), 404);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

// --- Connection: authorization ---

test('a Chef (VIEW_KDS by default) can open a KDS socket', async () => {
  const ctx = await startServer();
  const { shopId } = await setupOwnerWithShop();
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);
  let ws;
  try {
    ws = connect(ctx.port, shopId, chefHeader);
    const hello = await nextMessage(ws);
    // The Chef is the KDS's primary user and has NO till access - which is
    // exactly why VIEW_KDS is a separate permission from ACCESS_TILL.
    assert.equal(hello.type, 'kds.connected');
    assert.equal(hello.actor.type, 'staff');
    assert.equal(hello.actor.id, chef.id);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('a Server (no VIEW_KDS by default) is refused with 403', async () => {
  const ctx = await startServer();
  const { shopId } = await setupOwnerWithShop();
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  let ws;
  try {
    ws = connect(ctx.port, shopId, serverHeader);
    // A Server has ACCESS_TILL but not VIEW_KDS - proving the two gates are
    // genuinely independent, not one reused for both.
    assert.equal(await expectRejection(ws), 403);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test("staff cannot open a socket on a shop that is not their own", async () => {
  const ctx = await startServer();
  const shopA = await setupOwnerWithShop();
  const shopB = await setupOwnerWithShop();
  const chef = await insertStaff(shopA.shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopA.shopId, chef.staffIdCode);
  let ws;
  try {
    // Cross-tenant: shop A's Chef aiming at shop B. resolveActorAuthority
    // rejects this by construction (staff can only act in their own shop).
    ws = connect(ctx.port, shopB.shopId, chefHeader);
    assert.equal(await expectRejection(ws), 404);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test("an owner cannot open a socket on another company's shop", async () => {
  const ctx = await startServer();
  const mine = await setupOwnerWithShop();
  const theirs = await setupOwnerWithShop();
  let ws;
  try {
    ws = connect(ctx.port, theirs.shopId, mine.header);
    assert.equal(await expectRejection(ws), 404);
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

// --- Order push ---

test('creating an order pushes order.created carrying the full order', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 10);
  let ws;
  try {
    ws = await connectReady(ctx.port, shopId, header);
    const pushed = nextMessage(ws);

    const created = await createOrder(header, shopId, itemId);
    assert.equal(created.status, 201);

    const event = await pushed;
    assert.equal(event.type, 'order.created');
    assert.equal(event.shopId, shopId);
    assert.equal(event.order.id, created.body.id);
    // The payload is the same full order shape the REST response returns,
    // so the KDS renders a ticket without a second fetch.
    assert.equal(event.order.items.length, 1);
    assert.equal(event.order.items[0].itemName, 'Burger');
    assert.equal(event.order.status, 'open');
    assert.ok(event.at, 'every event carries a server timestamp');
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('adding items to an open order pushes order.items_added', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 10);
  const created = await createOrder(header, shopId, itemId);
  let ws;
  try {
    ws = await connectReady(ctx.port, shopId, header);
    const pushed = nextMessage(ws);

    const added = await request(app)
      .post(`/api/shops/${shopId}/orders/${created.body.id}/items`)
      .set('Authorization', header)
      .send({ items: [{ menuItemId: itemId, quantity: 2 }] });
    assert.equal(added.status, 201);

    const event = await pushed;
    assert.equal(event.type, 'order.items_added');
    assert.equal(event.order.id, created.body.id);
    assert.equal(event.order.items.length, 2, 'the WHOLE updated order is sent, not just the delta');
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('cancelling an order pushes order.cancelled so the kitchen stops', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 10);
  const created = await createOrder(header, shopId, itemId);
  let ws;
  try {
    ws = await connectReady(ctx.port, shopId, header);
    const pushed = nextMessage(ws);

    const cancelled = await request(app)
      .post(`/api/shops/${shopId}/orders/${created.body.id}/cancel`)
      .set('Authorization', header)
      .send({ wasPrepped: false });
    assert.equal(cancelled.status, 200);

    const event = await pushed;
    assert.equal(event.type, 'order.cancelled');
    assert.equal(event.order.id, created.body.id);
    assert.equal(event.order.status, 'cancelled');
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

test('voiding a line item pushes order.item_voided', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const burgerId = await createMenuItem(header, 'Burger', 10);
  const friesId = await createMenuItem(header, 'Fries', 3);
  const created = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({
      type: 'takeaway',
      items: [
        { menuItemId: burgerId, quantity: 1 },
        { menuItemId: friesId, quantity: 1 },
      ],
    });
  const friesLineId = created.body.items.find((i) => i.menuItemId === friesId).id;
  let ws;
  try {
    ws = await connectReady(ctx.port, shopId, header);
    const pushed = nextMessage(ws);

    const voided = await request(app)
      .post(`/api/shops/${shopId}/orders/${created.body.id}/items/${friesLineId}/void`)
      .set('Authorization', header)
      .send({ wasPrepped: false });
    assert.equal(voided.status, 200);

    const event = await pushed;
    assert.equal(event.type, 'order.item_voided');
    assert.ok(event.order.items.find((i) => i.id === friesLineId).void, 'the voided line is flagged');
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

// --- Tenancy isolation: the security property that matters most ---

test("a shop's order never reaches another shop's KDS", async () => {
  const ctx = await startServer();
  const shopA = await setupOwnerWithShop();
  const shopB = await setupOwnerWithShop();
  const itemA = await createMenuItem(shopA.header, 'Burger', 10);
  let wsA;
  let wsB;
  try {
    wsA = await connectReady(ctx.port, shopA.shopId, shopA.header);
    wsB = await connectReady(ctx.port, shopB.shopId, shopB.header);

    const aReceives = nextMessage(wsA);
    const bReceivesNothing = expectNoMessage(wsB);

    const created = await createOrder(shopA.header, shopA.shopId, itemA);
    assert.equal(created.status, 201);

    const event = await aReceives;
    assert.equal(event.order.id, created.body.id, "shop A's own KDS gets the order");
    // The registry is keyed by shop, so this is correct by construction
    // rather than by a filter that could be forgotten at a new call site.
    await bReceivesNothing;
  } finally {
    closeQuietly(wsA);
    closeQuietly(wsB);
    await stopServer(ctx);
  }
});

test('two KDS screens in the same shop both receive the same order', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 10);
  let ws1;
  let ws2;
  try {
    ws1 = await connectReady(ctx.port, shopId, header);
    ws2 = await connectReady(ctx.port, shopId, header);

    const first = nextMessage(ws1);
    const second = nextMessage(ws2);

    const created = await createOrder(header, shopId, itemId);
    const [e1, e2] = await Promise.all([first, second]);

    assert.equal(e1.order.id, created.body.id);
    assert.equal(e2.order.id, created.body.id);
  } finally {
    closeQuietly(ws1);
    closeQuietly(ws2);
    await stopServer(ctx);
  }
});

// --- Deliberate non-push ---

test('an offline-synced order does NOT push to the KDS', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 10);
  let ws;
  try {
    ws = await connectReady(ctx.port, shopId, header);
    const nothing = expectNoMessage(ws);

    // A 9.7 sync is a HISTORICAL record of a sale that already happened and
    // was already paid for - occurredAt may be hours or days old, and the
    // food was made at the time. Pushing it to the kitchen as new work would
    // be actively wrong, so syncOfflineOrder deliberately does not broadcast.
    const synced = await request(app)
      .post(`/api/shops/${shopId}/orders/sync`)
      .set('Authorization', header)
      .send({
        clientOrderId: `till-1-${crypto.randomUUID()}`,
        occurredAt: '2026-08-20T18:30:00.000Z',
        type: 'takeaway',
        items: [{ menuItemId: itemId, quantity: 1, unitPrice: 10 }],
        payment: { method: 'cash', amountTendered: 10 },
      });
    assert.equal(synced.status, 201, 'the sync itself still succeeds');

    await nothing;
  } finally {
    closeQuietly(ws);
    await stopServer(ctx);
  }
});

// --- Cleanup ---

test('a closed socket is removed from the registry and stops receiving', async () => {
  const ctx = await startServer();
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 10);
  const { connectionCountForShop } = await import('../../src/modules/kds/kdsSocket.js');
  try {
    const ws = await connectReady(ctx.port, shopId, header);
    assert.equal(connectionCountForShop(shopId), 1);

    await new Promise((resolve) => {
      ws.on('close', resolve);
      ws.close();
    });
    // Give the server side a moment to run its own 'close' handler.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(connectionCountForShop(shopId), 0, 'the registry must not leak dead sockets');

    // And creating an order now must not throw despite there being no
    // listeners - a shop with no KDS connected is the common case.
    const created = await createOrder(header, shopId, itemId);
    assert.equal(created.status, 201);
  } finally {
    await stopServer(ctx);
  }
});
