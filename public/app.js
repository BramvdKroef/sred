import { startRegistration, startAuthentication }
  from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/+esm';
import { api, getJwt, setJwt, clearJwt, $, esc } from './api.js';
import { renderAdmin } from './admin.js';
import { renderEmployee } from './employee.js';

window.addEventListener('DOMContentLoaded', main);

async function main() {
  const params = new URLSearchParams(location.search);
  const enrollToken = params.get('token');
  if (enrollToken) return renderEnroll(enrollToken);
  if (getJwt()) {
    try { return await loadDashboard(); }
    catch { clearJwt(); }
  }
  renderLogin();
}

function renderLogin() {
  $('#app').innerHTML = `
    <div class="card center">
      <h1>Precision <strong>SR&amp;ED</strong></h1>
      <p class="muted">Sign in with your passkey.</p>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username webauthn" style="width: 100%">
      <p class="actions">
        <button id="login-btn">Sign in with passkey</button>
      </p>
      <p class="error" id="login-error"></p>
      <p class="muted">
        <a href="#" id="recover-link">Lost your passkey?</a>
      </p>
    </div>
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
    const { token } = await api('POST', '/api/webauthn/login/finish', { assertion });
    setJwt(token);
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
      `<p class="muted" style="margin-top:1rem">If <strong>${esc(email)}</strong> is registered, a recovery link has been emailed.</p>`;
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
}

function renderEnroll(token) {
  $('#app').innerHTML = `
    <div class="card center">
      <h1>Welcome to Precision <strong>SR&amp;ED</strong></h1>
      <p class="muted">Set up your passkey to access the tracker.</p>
      <p class="actions"><button id="enroll-btn">Set up passkey</button></p>
      <p class="error" id="enroll-error"></p>
    </div>
  `;
  $('#enroll-btn').addEventListener('click', () => enroll(token));
}

async function enroll(token) {
  const errEl = $('#enroll-error');
  errEl.textContent = '';
  try {
    const opts = await api('POST', '/api/webauthn/register/start', { token });
    const attestation = await startRegistration({ optionsJSON: opts });
    const { token: jwt } = await api('POST', '/api/webauthn/register/finish', {
      token, attestation, label: navigator.platform || 'Device',
    });
    setJwt(jwt);
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

function signOut() {
  clearJwt();
  location.assign('/');
}
