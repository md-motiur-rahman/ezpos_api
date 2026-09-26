import { WebSocketServer, WebSocket } from 'ws';
import { resolveActorFromToken, bearerTokenFrom } from '../staffAuth/actorFromToken.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { toKdsOrderView } from './kdsOrderView.js';
import { consumeKdsTicket } from './kdsTicket.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Module 10.1 - real-time order push to the Kitchen Display System.
 *
 * The first WebSocket surface in this project. Deliberately NOT mounted in
 * app.js: a WebSocket upgrade never reaches Express at all. Node's
 * http.Server routes a request carrying `Upgrade: websocket` exclusively to
 * its 'upgrade' listeners and never to the 'request' listener Express is
 * mounted on, so app.js's route table, its middleware chain, and its
 * mount-ordering hazard are all simply not in play
 * here. app.js is therefore untouched by 10.1.
 *
 * KNOWN LIMITATION, flagged rather than hidden: the connection registry
 * below is IN-MEMORY and per-process. Today's deployment is a single Render
 * web service (one instance, no autoscaling configured), so every till and
 * every KDS talk to the same process and this is correct. If that ever
 * becomes multi-instance, a KDS connected to instance A would not see an
 * order created through instance B, and this project has no pub/sub layer
 * (Redis or otherwise) to bridge that yet. That would be the thing to add,
 * not a change to this file's interface.
 *
 * SECOND KNOWN LIMITATION: app.js's express-rate-limit does not apply to
 * upgrades either (same reason as above - it is Express middleware). An
 * unauthenticated attacker hammering this path costs one staff-session DB
 * lookup per attempt, since the owner-JWT check short-circuits locally
 * first. That is the same per-attempt cost as any REST endpoint, just
 * without the 300-per-15-min ceiling in front of it. Flagged deliberately;
 * adding a second, differently-keyed limiter was out of 10.1's scope.
 */

/** `/api/shops/<uuid>/kds/socket` and nothing else. */
const KDS_PATH_PATTERN =
  /^\/api\/shops\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/kds\/socket$/;

/**
 * Event names pushed to a connected KDS. A frozen JS constant, same
 * convention as ORDER_TYPES/WASTAGE_REASONS/ALLERGENS - a small, fixed,
 * rarely-changing set validated in code rather than a DB enum.
 *
 * The first four are exactly the events that change what the kitchen should
 * be working on (10.1). ITEM_STATUS_CHANGED (10.2) is different in kind: it
 * reports the KITCHEN'S OWN progress back out, so every other connected KDS
 * screen for the same shop (an expo screen, a second prep station) stays in
 * sync - reusing the identical best-effort broadcastOrderEvent mechanism
 * 10.1 already proved correct for isolation, not a new channel.
 */
export const KDS_EVENTS = Object.freeze({
  CONNECTED: 'kds.connected',
  // Sent immediately before the server closes a socket whose authorization
  // has been revoked since it connected (see revalidateConnections). A close
  // frame alone cannot carry a reason a client can branch on.
  UNAUTHORIZED: 'kds.unauthorized',
  ORDER_CREATED: 'order.created',
  ORDER_ITEMS_ADDED: 'order.items_added',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_ITEM_VOIDED: 'order.item_voided',
  ITEM_STATUS_CHANGED: 'order.item_status_changed',
});

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * shopId -> Set<WebSocket>. Module-level so order.service.js can broadcast
 * without holding a reference to the server handle.
 *
 * Keyed by shop, which IS the tenancy boundary: a socket only ever lands in
 * the set for the shop its handshake was authorized against, so broadcasting
 * to one shop physically cannot reach another shop's KDS. That is enforced
 * by construction here rather than by a filter at send time, which could be
 * forgotten at a future call site.
 */
const connectionsByShop = new Map();

function registerConnection(shopId, socket) {
  const existing = connectionsByShop.get(shopId);
  if (existing) {
    existing.add(socket);
    return;
  }
  connectionsByShop.set(shopId, new Set([socket]));
}

function unregisterConnection(shopId, socket) {
  const sockets = connectionsByShop.get(shopId);
  if (!sockets) {
    return;
  }
  sockets.delete(socket);
  // Drop the empty Set rather than leaving it behind - otherwise a shop that
  // has ever connected once would leak an entry for the process's lifetime.
  if (sockets.size === 0) {
    connectionsByShop.delete(shopId);
  }
}

/** Test/introspection helper - how many live sockets a shop currently has. */
export function connectionCountForShop(shopId) {
  return connectionsByShop.get(shopId)?.size ?? 0;
}

const STATUS_TEXT = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
});

/**
 * Refuses the upgrade with a real HTTP response before any WebSocket
 * handshake completes, so a rejected client sees a status code rather than a
 * socket that opens and immediately closes. Body matches the REST error
 * shape (`{ error: { message } }`) so a client parses failures the same way
 * everywhere.
 */
function rejectUpgrade(socket, statusCode, message) {
  if (socket.destroyed) {
    return;
  }
  const body = JSON.stringify({ error: { message } });
  socket.write(
    `HTTP/1.1 ${statusCode} ${STATUS_TEXT[statusCode] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body
  );
  socket.destroy();
}

function send(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

/**
 * Pushes one order event to every KDS watching that shop (10.1).
 *
 * BEST-EFFORT BY DESIGN, and this is the most important property in this
 * file: it never throws, never rejects, and never awaits anything. The
 * callers are order.service.js's createOrder/addItemsToOrder/cancelOrder/
 * voidOrderItem - all of which have ALREADY COMMITTED their writes by the
 * time they call this. A notification failure must not turn a successfully
 * recorded order into an error response to the till, and (this project
 * having no transaction wrapper) there would be nothing to roll back even if
 * it did. Every failure is swallowed and logged instead.
 *
 * A shop with no KDS connected is the overwhelmingly common case and is a
 * silent no-op, not an error.
 *
 * The order is narrowed through toKdsOrderView HERE, inside the broadcaster,
 * rather than at each of the five call sites in order.service.js. That is
 * deliberate and is the same "correct by construction" reasoning as keying
 * the registry by shop: a projection applied at the call sites would be one
 * forgotten line away from leaking the payment ledger again the next time
 * someone adds an event, whereas a socket physically cannot be sent an
 * unnarrowed order from here.
 */
export function broadcastOrderEvent(shopId, type, order) {
  try {
    const sockets = connectionsByShop.get(shopId);
    if (!sockets || sockets.size === 0) {
      return;
    }
    const payload = { type, shopId, order: toKdsOrderView(order), at: new Date().toISOString() };
    for (const socket of sockets) {
      try {
        send(socket, payload);
      } catch (err) {
        // One dead socket must not stop the others from being notified.
        logger.warn({ err, shopId, type }, 'KDS push to one socket failed');
      }
    }
  } catch (err) {
    logger.warn({ err, shopId, type }, 'KDS broadcast failed');
  }
}

/**
 * Authenticates and authorizes one upgrade request.
 *
 * Order is deliberate: identify the shop from the path, authenticate the
 * bearer token, THEN authorize against that specific shop. Authorization
 * reuses resolveActorAuthority + assertHasPermission unchanged - the exact
 * same mechanism every REST module uses - rather than re-deriving "may this
 * actor act on this shop". That reuse is what makes cross-tenant isolation
 * correct by construction: for a staff actor resolveActorAuthority already
 * rejects any shopId that is not their own, and for an owner it already
 * requires the shop to belong to their company.
 *
 * **Two ways to supply the token (Module 15.1's own blocker resolution,
 * `kdsTicket.service.js`'s doc has the full reasoning)**: the
 * `Authorization` header, tried first - what every non-browser client
 * (a native till/KDS app, this project's own `ws`-based test suite) uses
 * directly, unchanged from before this module existed; or, only when that
 * header is absent, a `?ticket=` query string - what a BROWSER's
 * `new WebSocket(url)` uses instead, since it cannot set headers at all.
 * `consumeKdsTicket` does its own shopId check and is itself the ticket's
 * entire authorization contract; what happens below is unchanged either
 * way once `token` is in hand.
 *
 * Returns { shopId, actor } on success, or throws an AppError whose
 * statusCode the caller turns into an HTTP rejection.
 */
async function authorizeUpgrade(request) {
  // request.url is path + query only (never absolute) for a server-side
  // request, but parse defensively against a base so a query string can
  // never leak into the path match.
  const url = new URL(request.url, 'http://placeholder.invalid');
  const match = KDS_PATH_PATTERN.exec(url.pathname);

  if (!match) {
    return { rejection: { statusCode: 404, message: 'Not found' } };
  }
  const shopId = match[1];

  let token = bearerTokenFrom(request.headers.authorization);
  if (!token) {
    const ticket = url.searchParams.get('ticket');
    token = ticket ? consumeKdsTicket(ticket, shopId)?.token ?? null : null;
  }
  const actor = await resolveActorFromToken(token);

  if (!actor) {
    return { rejection: { statusCode: 401, message: 'Authentication required' } };
  }

  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.VIEW_KDS,
    'You do not have permission to view the kitchen display'
  );

  return { shopId, actor, token };
}

/**
 * Re-runs the FULL handshake check against one already-connected socket.
 *
 * WHY THIS IS NEEDED. Authorization was previously checked once, at the
 * handshake, and never again. Every REST request re-resolves the actor from
 * its token, so deactivating a staff member or revoking a permission takes
 * effect on the very next call - but a WebSocket has no next call. A kitchen
 * tablet belonging to someone who was deactivated an hour ago kept streaming
 * live order data indefinitely, held open by the heartbeat.
 *
 * It re-resolves from the TOKEN rather than merely re-running
 * resolveActorAuthority on the actor captured at handshake, and that
 * distinction is the whole point: resolveActorAuthority trusts the role and
 * shopId already on the actor object, so on its own it would NOT notice a
 * deactivated staff member. Only resolveActorFromToken re-reads the staff row
 * (its JOIN drops soft-deleted staff), re-checks revoked_at, and re-checks
 * session expiry. Going through it catches all five revocation paths at once:
 * deactivation, logout, session expiry, a role change, and a withdrawn
 * permission override.
 *
 * FAILS CLOSED on an authorization failure, OPEN on an infrastructure one.
 * An AppError (or a null actor) means this connection genuinely may no longer
 * be here, so it is closed. Anything else - most realistically a database
 * blip - must NOT be treated as revocation: doing so would disconnect every
 * KDS in every shop the moment the database hiccuped, turning a brief outage
 * into an estate-wide kitchen blackout. That mirrors resolveActorFromToken's
 * own rule that an infrastructure failure stays a 500 and never degrades into
 * a misleading 401.
 *
 * SIDE EFFECT, deliberate and flagged: resolveActorFromToken touches
 * last_active_at, so a connected KDS keeps its staff session alive on the
 * sliding 60-minute window. That preserves today's behaviour (a kitchen
 * screen stays up through a long service) instead of dropping every socket on
 * the hour, at the cost of a tablet left switched on holding a session open.
 * The trade was taken this way round because a screen that dies hourly
 * mid-service is a worse failure than a session that outlives an idle shift.
 */
async function revalidateConnection(ws) {
  const actor = await resolveActorFromToken(ws.kdsToken);
  if (!actor) {
    return { ok: false, statusCode: 401, message: 'Authentication is no longer valid' };
  }
  const authority = await resolveActorAuthority(actor, ws.kdsShopId);
  assertHasPermission(
    authority,
    PERMISSIONS.VIEW_KDS,
    'You no longer have permission to view the kitchen display'
  );
  return { ok: true };
}

/** WebSocket close codes are application-defined in the 4000-4999 range. */
const CLOSE_CODE_FOR = Object.freeze({ 401: 4401, 403: 4403, 404: 4404 });

function disconnectUnauthorized(ws, statusCode, message) {
  send(ws, { type: KDS_EVENTS.UNAUTHORIZED, statusCode, message, at: new Date().toISOString() });
  ws.close(CLOSE_CODE_FOR[statusCode] ?? 4401, message.slice(0, 120));
}

/**
 * Sweeps every live socket. Never throws and is never awaited by the
 * heartbeat - one socket's problem must not stop the others being checked,
 * and a rejected promise here would be an unhandled rejection that
 * server.js's handler turns into a process exit.
 */
export async function revalidateConnections(wss) {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || !ws.kdsToken) {
      continue;
    }
    try {
      const result = await revalidateConnection(ws);
      if (!result.ok) {
        logger.warn(
          { shopId: ws.kdsShopId, statusCode: result.statusCode },
          'KDS socket closed - authorization revoked'
        );
        disconnectUnauthorized(ws, result.statusCode, result.message);
      }
    } catch (err) {
      if (err?.isOperational === true) {
        logger.warn(
          { shopId: ws.kdsShopId, statusCode: err.statusCode },
          'KDS socket closed - authorization revoked'
        );
        disconnectUnauthorized(ws, err.statusCode, err.message);
      } else {
        // Infrastructure failure - keep the socket. See the fail-open note above.
        logger.error({ err, shopId: ws.kdsShopId }, 'KDS re-authorization check failed');
      }
    }
  }
}

/**
 * Attaches the KDS WebSocket server to an existing http.Server (10.1).
 *
 * `noServer: true` rather than passing the server directly: that is what
 * lets authentication run BEFORE the handshake is completed, so an
 * unauthorized client is refused with a real 401/403/404 and never reaches
 * an open socket. Handing `ws` the server would complete the handshake
 * first and leave us closing an already-open connection.
 *
 * Returns a handle with close(), used by the tests to shut everything down
 * deterministically. The heartbeat timer is unref()'d so it can never by
 * itself keep a process (or a test run) alive.
 */
export function attachKdsSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (request, socket, head) => {
    // A socket error during the pre-handshake window would otherwise be an
    // unhandled 'error' event on a raw socket, which crashes the process.
    socket.on('error', (err) => {
      logger.warn({ err }, 'KDS upgrade socket error');
    });

    authorizeUpgrade(request)
      .then((result) => {
        if (result.rejection) {
          return rejectUpgrade(socket, result.rejection.statusCode, result.rejection.message);
        }
        const { shopId, actor, token } = result;

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.isAlive = true;
          // Retained so the heartbeat can re-run the full authorization check
          // (revalidateConnections). In-process memory only - the same token
          // already lives in the request headers - and never logged or sent.
          ws.kdsToken = token;
          ws.kdsShopId = shopId;
          ws.on('pong', () => {
            ws.isAlive = true;
          });
          ws.on('error', (err) => {
            logger.warn({ err, shopId }, 'KDS socket error');
          });
          ws.on('close', () => unregisterConnection(shopId, ws));

          registerConnection(shopId, ws);

          // Sent so a client knows the handshake was not merely accepted at
          // the TCP level but actually authenticated AND authorized - the
          // two are different, and without this a client cannot tell an
          // authorized idle connection from one that is about to be closed.
          send(ws, {
            type: KDS_EVENTS.CONNECTED,
            shopId,
            actor: { type: actor.type, id: actor.id },
            at: new Date().toISOString(),
          });
        });
      })
      .catch((err) => {
        // AppError from resolveActorAuthority (404) / assertHasPermission
        // (403) lands here, as does any genuine infrastructure failure.
        const statusCode = err?.isOperational === true ? err.statusCode : 500;
        if (statusCode === 500) {
          logger.error({ err }, 'KDS upgrade failed unexpectedly');
        }
        rejectUpgrade(
          socket,
          statusCode,
          statusCode === 500 ? 'Internal server error' : err.message
        );
      });
  };

  httpServer.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        // Missed a full cycle - the peer is gone (a KDS tablet that lost
        // wifi never sends a close frame). terminate() fires 'close', which
        // unregisters it, so the registry can't accumulate dead sockets.
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }

    // Deliberately NOT awaited: the liveness sweep above is synchronous and
    // must not be delayed by database round-trips, and revalidateConnections
    // handles all of its own errors. Piggy-backing on this existing timer
    // rather than adding a second one keeps the revocation window bounded by
    // the same interval the connection is already being probed on.
    revalidateConnections(wss);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      httpServer.off('upgrade', onUpgrade);
      for (const ws of wss.clients) {
        ws.terminate();
      }
      wss.close();
    },
  };
}
