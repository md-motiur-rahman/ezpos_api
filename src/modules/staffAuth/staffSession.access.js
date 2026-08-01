const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Whether a session has gone quiet too long to still be valid. Computed at
 * request time rather than stored as a flag - same reasoning as
 * isBillingLocked in billing.access.js: no cleanup job needed for
 * correctness, an inactive session just naturally stops passing this check.
 */
export function isSessionExpired(session) {
  return Date.now() - new Date(session.last_active_at).getTime() > SESSION_TIMEOUT_MS;
}