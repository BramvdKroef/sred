// JSON + multipart fetch wrappers with transparent refresh-on-401 retry.
//
// `api` / `apiUpload` attach the current JWT, then on a 401 with a stored
// refresh token they call tryRefresh() once and retry the original request.
// Concurrent 401s coalesce on the same in-flight refresh Promise so a
// Promise.all of dead requests only fires a single /refresh call.
//
// V-11: the refresh token now lives in an HttpOnly cookie scoped to
// /api/auth/refresh. We don't read it directly — the browser auto-attaches
// it on the rotation request. We do read the non-HttpOnly
// `sred_refresh_csrf` cookie and echo it in `x-refresh-csrf` to satisfy
// the double-submit CSRF guard on that endpoint.

import { getJwt, getRefreshCsrf, hasRefreshSession, setSession, handleAuthFailure } from './session.js';

let refreshInflight = null;

// Attempt to swap the dead JWT for a fresh pair. Coalesces concurrent
// attempts so a Promise.all of 401s only fires one /refresh call.
//
// Exported so the warm-start path in app.js can reuse the same in-flight
// dedupe + CSRF-header wiring rather than rolling its own /refresh POST.
export async function tryRefresh() {
  if (!hasRefreshSession()) return false;
  if (!refreshInflight) {
    const csrf = getRefreshCsrf();
    refreshInflight = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-refresh-csrf': csrf ?? '',
      },
      // Empty body — server reads refresh_token from the HttpOnly cookie.
      body: '{}',
    }).then(async r => {
      if (!r.ok) return false;
      const d = await r.json();
      setSession({ token: d.token });
      return true;
    }).catch(() => false).finally(() => { refreshInflight = null; });
  }
  return refreshInflight;
}

export async function api(method, path, body, { _retry = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  const jwt = getJwt();
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(path, init);
  if (r.status === 401 && jwt && !_retry) {
    if (await tryRefresh()) return api(method, path, body, { _retry: true });
    handleAuthFailure();
    throw new Error('Session expired');
  }
  if (r.status === 204) return null;
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) {
    // Attach the HTTP status + error code so callers that need to branch
    // (e.g. 409 conflict on optimistic-concurrency PATCHes) can do so
    // without parsing the message. The .message stays as the server's
    // human-readable text so the default inline-banner path keeps working.
    const err = new Error(data.error?.message || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = data.error?.code;
    err.details = data.error?.details;
    throw err;
  }
  return data;
}

export async function apiUpload(path, formData, { _retry = false } = {}) {
  const headers = {};
  const jwt = getJwt();
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const r = await fetch(path, { method: 'POST', headers, body: formData });
  if (r.status === 401 && jwt && !_retry) {
    if (await tryRefresh()) return apiUpload(path, formData, { _retry: true });
    handleAuthFailure();
    throw new Error('Session expired');
  }
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data;
}
