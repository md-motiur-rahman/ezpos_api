import crypto from 'node:crypto';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import { PERMISSIONS } from '../staff/permissions.js';

/**
 * Module 15.1 (frontend roadmap) - resolves the KDS WebSocket handshake's
 * one hard blocker: `kdsSocket.js#authorizeUpgrade` reads the bearer token
 * off the raw `Authorization` header of the upgrade request, but a browser's
 * `new WebSocket(url)` constructor cannot set custom headers at all - there
 * is no API for it. A native till/KDS app (or this project's own test
 * suite, using the `ws` package directly) has no such restriction and keeps
 * using the header path unchanged; this module exists purely to give a
 * BROWSER client a second way in.
 *
 * THE MECHANISM: a short-lived, SINGLE-USE ticket, minted via a normal
 * authenticated REST call (`POST /api/shops/:shopId/kds/ticket`,
 * `kds.routes.js`) - which, being a plain fetch, CAN carry a real
 * `Authorization` header - then handed to the socket as a `?ticket=...`
 * query string, which a browser's WebSocket API CAN set (query strings are
 * just part of the URL).
 *
 * **Deliberately not "just put the real bearer token in the query string
 * directly" (the other option `FRONTEND_CLAUDE.md` §6 named)** - a
 * WebSocket URL's query string is exactly the kind of thing a hosting
 * platform's access log, an intermediate proxy, or a browser's own history
 * can retain, and `kdsSocket.js`'s own `ws.kdsToken` comment already relies
 * on the real session/JWT token staying "never logged or sent" anywhere
 * beyond the header it arrived on. A ticket preserves that invariant: it is
 * a random, single-use, ~15-second-lived opaque value with no authority of
 * its own once consumed, so even a system that DOES retain the URL
 * (deliberately or not) has retained something already worthless a moment
 * later. The real token it stands in for is looked up server-side only,
 * from the SAME in-memory registry pattern `connectionsByShop` already
 * uses in `kdsSocket.js` - not persisted, not logged, gone the instant it's
 * consumed.
 *
 * IN-MEMORY AND PER-PROCESS, same known limitation as `connectionsByShop`
 * in `kdsSocket.js` for the same reason (today's deployment is one Render
 * instance) - a ticket minted against process A cannot be consumed by
 * process B. Multi-instance would need the same fix this file's sibling
 * already flags it would need (a shared store), not a change to this
 * module's own interface.
 */

/** Long enough for a client to mint a ticket and immediately open the
 * socket with it - this is not a session, it's one round trip. Short
 * enough that even an abandoned, never-consumed ticket is worthless well
 * before anyone could reasonably act on a leaked copy of it. */
const TICKET_TTL_MS = 15_000;

/** Bounds how long an abandoned ticket (minted, never consumed - a client
 * that crashed between the two calls) can sit in memory. Consuming a
 * ticket already deletes it immediately regardless of outcome (see
 * `consumeKdsTicket`), so this sweep only ever cleans up the abandoned
 * case; it is not load-bearing for the single-use guarantee itself. */
const SWEEP_INTERVAL_MS = 60_000;

/** ticket (opaque string) -> { token, shopId, expiresAt }. */
const ticketsByValue = new Map();

function sweepExpiredTickets() {
  const now = Date.now();
  for (const [ticket, entry] of ticketsByValue) {
    if (entry.expiresAt <= now) {
      ticketsByValue.delete(ticket);
    }
  }
}

// unref()'d so it can never by itself keep a process (or a test run) alive -
// same discipline `kdsSocket.js`'s own heartbeat timer follows.
const sweepTimer = setInterval(sweepExpiredTickets, SWEEP_INTERVAL_MS);
sweepTimer.unref();

/**
 * Mints one ticket for `actor` to open a KDS socket for `shopId`.
 *
 * Runs the IDENTICAL authorization check `kdsSocket.js#authorizeUpgrade`
 * runs at connect time (`resolveActorAuthority` + `assertHasPermission`,
 * `VIEW_KDS`) - a ticket carries no authority of its own beyond what its
 * holder was already allowed to do at mint time; the socket handshake still
 * re-derives the actor from the real token once the ticket is redeemed; and
 * the 30-second heartbeat sweep still re-validates that actor exactly as it
 * always has. This function only ever shortens "how do we hand a browser a
 * token," never widens who's allowed to watch a shop's kitchen display.
 *
 * `token` is the caller's own real bearer token (owner JWT or staff session
 * token) - the controller reads it off the same `Authorization` header
 * `requireStaffOrOwnerAuth` already required to reach this handler at all,
 * so it is guaranteed present here, never re-validated by this function
 * itself (that already happened in the middleware).
 */
export async function mintKdsTicket(actor, shopId, token) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.VIEW_KDS,
    'You do not have permission to view the kitchen display'
  );

  const ticket = crypto.randomBytes(24).toString('base64url');
  ticketsByValue.set(ticket, { token, shopId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, expiresInMs: TICKET_TTL_MS };
}

/**
 * Redeems one ticket for `shopId`, or returns `null` if it never existed,
 * already expired, or was minted for a DIFFERENT shop.
 *
 * **Deletes the ticket unconditionally on lookup, before checking anything
 * else** - a ticket is consumed by the attempt, not by success. Otherwise a
 * ticket minted for shop A and mistakenly (or maliciously) presented
 * against shop B's socket path would survive that failed attempt and still
 * be usable against shop A afterward, silently widening its effective
 * lifetime past one use.
 *
 * The shopId check is defense in depth, not the only thing standing
 * between a ticket and the wrong shop's kitchen: even if this returned the
 * token for a shopId mismatch, `kdsSocket.js#authorizeUpgrade`'s own
 * subsequent `resolveActorAuthority(actor, shopId)` call would still 404
 * the connection (an actor's authority is per-shop, checked fresh from the
 * URL's own shopId every time) - this just fails a beat earlier, for a
 * cheaper and more specific rejection.
 */
export function consumeKdsTicket(ticket, shopId) {
  const entry = ticketsByValue.get(ticket);
  if (!entry) {
    return null;
  }
  ticketsByValue.delete(ticket);
  if (entry.expiresAt <= Date.now() || entry.shopId !== shopId) {
    return null;
  }
  return { token: entry.token };
}

/** Test/introspection helper - how many unconsumed tickets are currently
 * held in memory, mirroring `kdsSocket.js`'s own `connectionCountForShop`. */
export function pendingTicketCountForTests() {
  return ticketsByValue.size;
}
