// JSON + multipart fetch wrappers with transparent refresh-on-401 retry.
//
// `api` / `apiUpload` attach the current JWT, then on a 401 with a stored
// refresh token they call tryRefresh() once and retry the original request.
// Concurrent 401s coalesce on the same in-flight refresh Promise so a
// Promise.all of dead requests only fires a single /refresh call.

import { getJwt, getRefresh, setSession, handleAuthFailure } from './session.js';

let refreshInflight = null;

// Attempt to swap the dead JWT for a fresh pair using the stored refresh
// token. Coalesces concurrent attempts so a Promise.all of 401s only fires
// one /refresh call.
async function tryRefresh() {
  const rt = getRefresh();
  if (!rt) return false;
  if (!refreshInflight) {
    refreshInflight = fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    }).then(async r => {
      if (!r.ok) return false;
      const d = await r.json();
      setSession({ token: d.token, refresh_token: d.refresh_token });
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
