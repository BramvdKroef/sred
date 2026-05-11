// Minimal client glue. WebAuthn ceremony helpers come from @simplewebauthn/browser
// which is loaded from a CDN here to avoid a bundler in the scaffold.
import { startRegistration, startAuthentication } from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/+esm';

const out = (id, value) => {
  document.getElementById(id).textContent =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

document.getElementById('ping').addEventListener('click', async () => {
  const r = await fetch('/api/health').then(r => r.json());
  out('health-out', r);
});

// Enrollment path — triggered when the page is opened with ?token=...
// (Surfaced as a button because WebAuthn ceremonies need a user gesture.)
const params = new URLSearchParams(location.search);
const enrollToken = params.get('token');
if (enrollToken) {
  const btn = document.createElement('button');
  btn.textContent = 'Enroll passkey';
  btn.addEventListener('click', () => enroll(enrollToken).catch(err => out('login-out', String(err))));
  document.getElementById('login').prepend(btn);
}

async function enroll(token) {
  const opts = await api('/api/webauthn/register/start', { token });
  const attestation = await startRegistration({ optionsJSON: opts });
  const { user, token: jwt } = await api('/api/webauthn/register/finish', {
    token, attestation, label: navigator.platform,
  });
  sessionStorage.setItem('jwt', jwt);
  out('login-out', { enrolled: user });
  history.replaceState(null, '', location.pathname);
}

document.getElementById('login-btn').addEventListener('click', async () => {
  try {
    const email = document.getElementById('email').value.trim();
    const opts = await api('/api/webauthn/login/start', { email });
    const assertion = await startAuthentication({ optionsJSON: opts });
    const { user, token } = await api('/api/webauthn/login/finish', { assertion });
    sessionStorage.setItem('jwt', token);
    out('login-out', { signed_in_as: user });
  } catch (e) {
    out('login-out', String(e));
  }
});

async function api(path, body) {
  const jwt = sessionStorage.getItem('jwt');
  const r = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).error?.message || `HTTP ${r.status}`);
  return r.json();
}
