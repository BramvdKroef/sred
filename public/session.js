// Session token storage + auth-failure handler.
//
// JWT lives in sessionStorage (cleared on tab close). The refresh token used
// to live in localStorage; under V-11 it now lives in an HttpOnly cookie
// scoped to /api/auth/refresh so XSS can no longer exfiltrate it. JS only
// sees the non-HttpOnly `sred_refresh_csrf` cookie which is the double-
// submit token sent in `x-refresh-csrf` on the rotation request.
//
// `handleAuthFailure` is the single recovery path used by fetch.js after a
// non-recoverable 401 — it clears the JWT and bounces to `/` so the login
// flow runs cleanly without re-triggering a deep-link that just 401'd.

const JWT_KEY = 'sred-jwt';
// Legacy key, used solely to migrate a stale localStorage value out of the
// browser on first load post-V-11. Once cleared, never written again.
const LEGACY_REFRESH_KEY = 'sred-refresh';

export const REFRESH_CSRF_COOKIE = 'sred_refresh_csrf';

export const getJwt   = () => sessionStorage.getItem(JWT_KEY);
export const setJwt   = t  => sessionStorage.setItem(JWT_KEY, t);
export const clearJwt = () => sessionStorage.removeItem(JWT_KEY);

// One-time migration: any old refresh token still in localStorage is now
// useless (server moved to the cookie) and is itself the V-11 exposure we
// just fixed. Delete it on every load until gone.
export function purgeLegacyRefresh() {
  try { localStorage.removeItem(LEGACY_REFRESH_KEY); } catch { /* noop */ }
}

// Read the double-submit CSRF cookie. Browsers expose document.cookie as a
// raw "; "-joined string; the cookie is non-HttpOnly so we can read it.
// Returns null if the cookie isn't set (e.g. very first page load before
// any login, or a tab that just cleared session).
export function getRefreshCsrf() {
  const m = (typeof document !== 'undefined' ? document.cookie : '')
    .split('; ')
    .find(s => s.startsWith(REFRESH_CSRF_COOKIE + '='));
  return m ? decodeURIComponent(m.slice(REFRESH_CSRF_COOKIE.length + 1)) : null;
}

// Indicates whether the SPA has a refresh session it can try to use. We
// can't observe the HttpOnly refresh cookie directly, but it's always set
// in tandem with the readable CSRF cookie, so the latter's presence is a
// safe proxy.
export const hasRefreshSession = () => !!getRefreshCsrf();

// Store both halves of a session in one shot. The server set the refresh
// cookie + CSRF cookie on the response; we only need to stash the JWT.
// `refresh_token` is intentionally ignored (kept in the destructure for
// call-site compat during the transition).
export function setSession({ token, refresh_token: _ignored }) {
  setJwt(token);
}
export function clearSession() {
  clearJwt();
  purgeLegacyRefresh();
  // Best-effort: drop the readable CSRF cookie so hasRefreshSession() is
  // false after sign-out. The browser only deletes the cookie if path
  // matches, and our cookies are scoped to /api/auth/refresh, so we let
  // the server's clearCookie call on /api/logout do the actual work.
}

// Module-scoped guard so concurrent 401s from a Promise.all only run the
// redirect once. Stays internal — fetch.js calls handleAuthFailure() which
// reads/writes it; nothing else needs to see it.
let sessionEnded = false;

export function handleAuthFailure() {
  if (sessionEnded) return;
  sessionEnded = true;
  clearSession();
  // Drop the hash so login isn't immediately redirected back to a deep link
  // that triggered the failure (e.g. #exports/12).
  location.assign('/');
}
