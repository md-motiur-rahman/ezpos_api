import { WebSocketServer, WebSocket } from 'ws';
import { resolveActorFromToken, bearerTokenFrom } from '../staffAuth/actorFromToken.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { logger } from '../../utils/logger.js';

/**
 * Module 10.1 - real-time order push to the Kitchen Display System.
 *
 * The first WebSocket surface in this project. Deliberately NOT mounted in
 * app.js: a WebSocket upgrade never reaches Express at all. Node's
 * http.Server routes a request carrying `Upgrade: websocket` exclusively to
 * its 'upgrade' listeners and never to the 'request' listener Express is
 * mounted on, so app.js's route table, its middleware chain, and its
 * mount-ordering hazard (CLAUDE.md section 2) are all simply not in play
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
 * 10.2 (item status flow) will add its own values here; the four below are
 * exactly the events that change what the kitchen should be working on.
 */
export const KDS_EVENTS = Object.freeze({
  CONNECTED: 'kds.connected',
  ORDER_CREATED: 'order.created',
  ORDER_ITEMS_ADDED: 'order.items_added',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_ITEM_VOIDED: 'order.item_voided',
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
 */
export function broadcastOrderEvent(shopId, type, order) {
  try {
    const sockets = connectionsByShop.get(shopId);
    if (!sockets || sockets.size === 0) {
      return;
    }
    const payload = { type, shopId, order, at: new Date().toISOString() };
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
 * Returns { shopId, actor } on success, or throws an AppError whose
 * statusCode the caller turns into an HTTP rejection.
 */
async function authorizeUpgrade(request) {
  // request.url is path + query only (never absolute) for a server-side
  // request, but parse defensively against a base so a query string can
  // never leak into the path match.
  const pathname = new URL(request.url, 'http://placeholder.invalid').pathname;
  const match = KDS_PATH_PATTERN.exec(pathname);

  if (!match) {
    return { rejection: { statusCode: 404, message: 'Not found' } };
  }
  const shopId = match[1];

  const token = bearerTokenFrom(request.headers.authorization);
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

  return { shopId, actor };
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
        const { shopId, actor } = result;

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.isAlive = true;
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
