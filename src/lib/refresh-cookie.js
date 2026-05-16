// Refresh-token cookie wiring (V-11 mitigation).
//
// The refresh token used to ride in the JSON body, which forced the SPA to
// stash it in localStorage where any XSS could exfiltrate it. We now mint
// two cookies on every refresh-issuing endpoint:
//
//   sred_refresh       HttpOnly + Secure + SameSite=Strict, path-scoped to
//                      /api/auth/refresh. The browser auto-attaches it on
//                      the rotation request and never exposes it to JS.
//   sred_refresh_csrf  Readable from JS (NOT HttpOnly). Same path scope.
//                      Carries a random value the SPA must echo back in the
//                      `x-refresh-csrf` header — standard double-submit
//                      cookie pattern guarding the cookie endpoint.
//
// The body fallback is preserved during the transition window so an older
// tab loaded before deploy still rotates successfully. See V-11.
//
// All cookies are scoped to /api/auth/refresh, which means /api/logout
// cannot itself clear the cookie because the browser only sends cookies
// whose path is a prefix of the request URI. /api/logout therefore returns
// a clearCookie() with the matching path; the browser deletes the cookie
// on receipt regardless of whether the cookie was attached to the request.
import { config } from '../config.js';
import { randomToken } from './random.js';

export const REFRESH_COOKIE      = 'sred_refresh';
export const REFRESH_CSRF_COOKIE = 'sred_refresh_csrf';
export const REFRESH_CSRF_HEADER = 'x-refresh-csrf';
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';

function isProd() {
  return process.env.NODE_ENV === 'production';
}

// Set both cookies on the response. Caller supplies the refresh token and
// optionally the CSRF value; we always mint a fresh CSRF value on rotation
// so the pair rotates atomically with the refresh token itself.
export function setRefreshCookies(res, refreshToken) {
  const maxAge = config.refreshTtlDays * 86400 * 1000;
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge,
  });
  const csrf = randomToken(24);
  res.cookie(REFRESH_CSRF_COOKIE, csrf, {
    httpOnly: false, // intentionally readable from JS for double-submit
    secure: isProd(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge,
  });
  return csrf;
}

export function clearRefreshCookies(res) {
  // clearCookie must echo the same path it was set with; otherwise the
  // browser keeps the cookie tied to /api/auth/refresh untouched.
  res.clearCookie(REFRESH_COOKIE,      { path: REFRESH_COOKIE_PATH });
  res.clearCookie(REFRESH_CSRF_COOKIE, { path: REFRESH_COOKIE_PATH });
}

// Double-submit CSRF guard for POST /api/auth/refresh. The token is the
// value of the (non-HttpOnly) sred_refresh_csrf cookie, which the SPA reads
// from document.cookie and echoes in the x-refresh-csrf header. A cross-
// origin attacker can't read the cookie (SameSite=Strict + Secure + the
// cookie's CORS-opaque nature) so they can't construct a matching header.
//
// Body-fallback callers (old tabs that still send refresh_token in JSON and
// no cookie at all) skip this check — when no cookie is present there is
// nothing for CSRF to defend, and the body-fallback path is itself going
// away. The guard ONLY engages when the cookie is present.
export function refreshCsrfGuard(req, res, next) {
  const cookieToken = req.cookies?.[REFRESH_CSRF_COOKIE];
  const refreshCookie = req.cookies?.[REFRESH_COOKIE];
  // Old client path: no cookie at all → body fallback. Nothing to defend.
  if (!refreshCookie && !cookieToken) return next();
  const headerToken = req.get(REFRESH_CSRF_HEADER);
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({
      error: { code: 'forbidden', message: 'csrf token missing or invalid' },
    });
  }
  next();
}
