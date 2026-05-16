// Session token storage + auth-failure handler.
//
// JWT lives in sessionStorage (cleared on tab close); refresh token lives in
// localStorage so the user stays signed in across browser restarts and tabs.
// `handleAuthFailure` is the single recovery path used by fetch.js after a
// non-recoverable 401 — it clears both halves and bounces to `/` so the
// login flow runs cleanly without re-triggering a deep-link that just 401'd.

const JWT_KEY     = 'sred-jwt';
const REFRESH_KEY = 'sred-refresh';

export const getJwt   = () => sessionStorage.getItem(JWT_KEY);
export const setJwt   = t  => sessionStorage.setItem(JWT_KEY, t);
export const clearJwt = () => sessionStorage.removeItem(JWT_KEY);

// Refresh token persists across tabs and browser restarts (localStorage).
export const getRefresh   = () => localStorage.getItem(REFRESH_KEY);
export const setRefresh   = t  => localStorage.setItem(REFRESH_KEY, t);
export const clearRefresh = () => localStorage.removeItem(REFRESH_KEY);

// Store both halves of a session in one shot.
export function setSession({ token, refresh_token }) {
  setJwt(token);
  if (refresh_token) setRefresh(refresh_token);
}
export function clearSession() {
  clearJwt();
  clearRefresh();
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
