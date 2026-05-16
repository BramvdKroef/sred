import { startRegistration, startAuthentication }
  from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/+esm';
import { api, getJwt, hasRefreshSession, purgeLegacyRefresh, tryRefresh, setSession, clearSession, $, esc } from './api.js';
import { renderAdmin } from './admin.js';
import { renderEmployee } from './employee.js';

window.addEventListener('DOMContentLoaded', main);

async function main() {
  // V-11: drop any stale localStorage refresh token left behind by a tab
  // that loaded before the cookie migration. Cheap, idempotent, no-op once
  // gone.
  purgeLegacyRefresh();
  const params = new URLSearchParams(location.search);
  const enrollToken = params.get('token');
  if (enrollToken) return renderEnroll(enrollToken);
  if (getJwt()) {
    try { return await loadDashboard(); }
    catch { clearSession(); }
  }
  // Warm start: no JWT but the browser still has the refresh cookie from a
  // prior session. Delegate to tryRefresh() so we share the in-flight
  // dedupe and the CSRF-header wiring with fetch.js.
  if (hasRefreshSession()) {
    if (await tryRefresh()) {
      try { return await loadDashboard(); }
      catch { clearSession(); }
    } else {
      clearSession();
    }
  }
  renderLogin();
}

function renderLogin() {
  // Pre-auth pages wrap their card in <main> so the page has a landmark
  // (axe `landmark-one-main`). The <h1> here is both the brand and the
  // page heading — only one h1 in the document, which is correct.
  $('#app').innerHTML = `
    <main>
      <div class="card center">
        <h1>Precision <strong>SR&amp;ED</strong></h1>
        <p class="muted">Sign in with your passkey.</p>
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="username webauthn" class="w-full">
        <p class="actions">
          <button id="login-btn">Sign in with passkey</button>
        </p>
        <p class="error" id="login-error"></p>
        <p class="muted">
          <a href="#" id="recover-link">Lost your passkey?</a>
        </p>
      </div>
    </main>
  `;
  $('#login-btn').addEventListener('click', login);
  $('#recover-link').addEventListener('click', e => { e.preventDefault(); requestRecovery(); });
  $('#email').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
}

async function login() {
  const email = $('#email').value.trim();
  const errEl = $('#login-error');
  errEl.textContent = '';
  try {
    const opts = await api('POST', '/api/webauthn/login/start', { email });
    const assertion = await startAuthentication({ optionsJSON: opts });
    const d = await api('POST', '/api/webauthn/login/finish', { assertion });
    setSession({ token: d.token, refresh_token: d.refresh_token });
    await loadDashboard();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

async function requestRecovery() {
  const email = $('#email').value.trim();
  if (!email) { $('#login-error').textContent = 'Enter your email above first.'; return; }
  try {
    await api('POST', '/api/recovery', { email });
    $('#login-error').textContent = '';
    $('#app').querySelector('.center').innerHTML +=
      `<p class="muted mt-lg">If <strong>${esc(email)}</strong> is registered, a recovery link has been emailed.</p>`;
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
}

function renderEnroll(token) {
  $('#app').innerHTML = `
    <main>
      <div class="card center">
        <h1>Welcome to Precision <strong>SR&amp;ED</strong></h1>
        <p class="muted">Set up your passkey to access the tracker.</p>
        <p class="actions"><button id="enroll-btn">Set up passkey</button></p>
        <p class="error" id="enroll-error"></p>
      </div>
    </main>
  `;
  $('#enroll-btn').addEventListener('click', () => enroll(token));
}

async function enroll(token) {
  const errEl = $('#enroll-error');
  errEl.textContent = '';
  try {
    const opts = await api('POST', '/api/webauthn/register/start', { token });
    const attestation = await startRegistration({ optionsJSON: opts });
    const d = await api('POST', '/api/webauthn/register/finish', {
      token, attestation, label: navigator.platform || 'Device',
    });
    setSession({ token: d.token, refresh_token: d.refresh_token });
    history.replaceState(null, '', location.pathname);
    await loadDashboard();
  } catch (e) {
    errEl.textContent = e.message;
  }
}

async function loadDashboard() {
  const me = await api('GET', '/api/me');
  const ctx = { me, signOut };
  if (me.user.role === 'admin') renderAdmin(ctx);
  else renderEmployee(ctx);
}

async function signOut() {
  // V-11: the refresh cookie is HttpOnly + path-scoped to /api/auth/refresh,
  // so JS can't read it and the browser won't attach it to /api/logout. The
  // server clears the cookie via Set-Cookie on the response and revokes any
  // refresh token presented in the body (older clients still send it; the
  // current code-path doesn't, which is fine — the cookie clear is what
  // matters for V-11).
  try { await api('POST', '/api/logout'); }
  catch { /* best effort */ }
  clearSession();
  location.assign('/');
}
