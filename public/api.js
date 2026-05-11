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

let sessionEnded = false;
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

function handleAuthFailure() {
  if (sessionEnded) return;
  sessionEnded = true;
  clearSession();
  // Drop the hash so login isn't immediately redirected back to a deep link
  // that triggered the failure (e.g. #exports/12).
  location.assign('/');
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
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
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

// After creating a labour entry, attach optional evidence (file or link)
// from the same form. Reads fd['ev_kind' | 'ev_file' | 'ev_url' | 'ev_caption'].
export async function attachInlineEvidence(fd, { project_id, labour_entry_id, evidence_date }) {
  const kind = fd.get('ev_kind');
  const caption = fd.get('ev_caption');
  if (kind === 'file') {
    const file = fd.get('ev_file');
    if (file && file.size > 0) {
      const ef = new FormData();
      ef.append('project_id', String(project_id));
      ef.append('labour_entry_id', String(labour_entry_id));
      ef.append('kind', 'file');
      ef.append('caption', caption || file.name);
      ef.append('evidence_date', evidence_date);
      ef.append('file', file);
      await apiUpload('/api/evidence', ef);
    }
  } else if (kind === 'link') {
    const url = fd.get('ev_url');
    if (url) {
      await api('POST', '/api/evidence', {
        project_id, labour_entry_id, kind: 'link',
        caption: caption || url, evidence_date, url,
      });
    }
  }
}

// After creating an expense, attach an optional receipt (always file).
export async function attachInlineReceipt(fd, { project_id, expense_id, evidence_date }) {
  const file = fd.get('receipt_file');
  if (!file || !file.size) return;
  const caption = fd.get('receipt_caption') || file.name;
  const ef = new FormData();
  ef.append('project_id', String(project_id));
  ef.append('expense_id', String(expense_id));
  ef.append('kind', 'file');
  ef.append('caption', caption);
  ef.append('evidence_date', evidence_date);
  ef.append('file', file);
  await apiUpload('/api/evidence', ef);
}

// Wire the ev-kind toggle on a form (shows file vs url input).
export function bindEvidenceKindToggle(form) {
  const sel = form.querySelector('select.ev-kind');
  if (!sel) return;
  const update = () => {
    const f = form.querySelector('.ev-file'); if (f) f.hidden = sel.value !== 'file';
    const u = form.querySelector('.ev-url');  if (u) u.hidden = sel.value !== 'link';
  };
  sel.addEventListener('change', update);
  update();
}

// Preferences page (shared between admin and employee shells).
export async function renderPreferencesPage(main) {
  main.innerHTML = '<p class="empty">Loading…</p>';
  await refreshPrefs(main);
}

async function refreshPrefs(main) {
  const me   = await api('GET', '/api/me');
  const data = await api('GET', '/api/me/credentials');
  main.innerHTML = `
    <div class="card">
      <h2>Account</h2>
      <div class="grid">
        <div><label>Name</label><div>${esc(me.user.name)}</div></div>
        <div><label>Email</label><div>${esc(me.user.email)}</div></div>
        <div><label>Role</label><div><span class="role">${esc(me.user.role)}</span></div></div>
        <div><label>Status</label><div><span class="pill ${me.user.status === 'active' ? 'open' : 'pending'}">${esc(me.user.status)}</span></div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Your passkeys (${data.items.length})</h2>
        <button id="add-passkey-toggle" class="secondary small">＋ Add a passkey</button>
      </div>
      <div id="add-passkey-form" hidden style="margin-bottom: 0.8rem">
        <form id="form-add-passkey" class="row" style="gap:0.5rem; align-items:flex-end">
          <div style="flex:1; min-width:14rem"><label>Device label</label>
            <input name="label" placeholder="${esc(navigator.platform || 'Device')}">
          </div>
          <div><button class="small">Register passkey</button></div>
        </form>
        <p class="muted" style="font-size:0.85rem; margin-top:0.4rem">
          Your browser will prompt you to use a passkey on this device.
        </p>
      </div>
      ${data.items.length === 0
        ? '<p class="empty">No passkeys registered yet.</p>'
        : `<table>
            <thead><tr><th>Label</th><th>Transports</th><th>Registered</th><th>Last used</th><th></th></tr></thead>
            <tbody>${data.items.map(c => `
              <tr>
                <td>${esc(c.label ?? '(unlabeled)')}</td>
                <td>${esc((c.transports ?? []).join(', ') || '—')}</td>
                <td>${esc(c.created_at)}</td>
                <td>${esc(c.last_used_at ?? 'never')}</td>
                <td class="actions">${data.items.length > 1
                  ? `<button class="small danger" data-cred-remove="${c.id}" data-label="${esc(c.label ?? c.id)}">Remove</button>`
                  : '<span class="muted">cannot remove the last one</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}
    </div>
  `;
  bindPrefs(main);
}

function bindPrefs(main) {
  const tg = main.querySelector('#add-passkey-toggle');
  const form = main.querySelector('#add-passkey-form');
  if (tg && form) tg.addEventListener('click', () => { form.hidden = !form.hidden; });

  const submit = main.querySelector('#form-add-passkey');
  if (submit) submit.addEventListener('submit', async e => {
    e.preventDefault();
    const label = new FormData(submit).get('label') || navigator.platform || 'Device';
    try {
      const { startRegistration } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/+esm');
      const options = await api('POST', '/api/webauthn/register/start', {});
      const attestation = await startRegistration({ optionsJSON: options });
      await api('POST', '/api/webauthn/register/finish', { attestation, label });
      await refreshPrefs(main);
    } catch (err) { alert(err.message); }
  });

  main.querySelectorAll('[data-cred-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove "${btn.dataset.label}"? You won't be able to sign in with this device.`)) return;
      try {
        await api('DELETE', `/api/me/credentials/${btn.dataset.credRemove}`);
        await refreshPrefs(main);
      } catch (err) { alert(err.message); }
    });
  });
}

// Tiny DOM helpers.
export const esc = s => s == null ? '' : String(s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const cents = n => (n == null) ? '' : (n / 100).toFixed(2);

export const $ = sel => document.querySelector(sel);
export const $$ = sel => document.querySelectorAll(sel);

// Local YYYY-MM-DD without UTC drift.
const localDate = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Monday-Sunday for the calendar week containing today, in local time.
export function currentWeek() {
  const now = new Date();
  const day = now.getDay();                 // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day;  // shift back to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + offset);
  monday.setHours(0, 0, 0, 0);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = localDate(new Date());
  const days = labels.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const date = localDate(d);
    return { date, label, isToday: date === today };
  });
  return { from: days[0].date, to: days[6].date, today, days };
}

// Bucket labour entries by work_date, return per-day rows with % of max for bar height.
export function weekBars(entries, days) {
  const byDate = {};
  for (const e of entries) byDate[e.work_date] = (byDate[e.work_date] || 0) + e.hours;
  const maxHours = Math.max(8, ...Object.values(byDate), 0);
  return days.map(d => ({
    label: d.label,
    date: d.date,
    isToday: !!d.isToday,
    hours: byDate[d.date] || 0,
    pct: ((byDate[d.date] || 0) / maxHours) * 100,
  }));
}

export function activityHtml(items, { showActor = true, showProject = true, showOpen = false } = {}) {
  if (!items.length) return '<p class="empty">No activity yet.</p>';
  return `<table class="activity">
    <thead><tr>
      <th>When</th><th>Type</th>${showActor ? '<th>Who</th>' : ''}${showProject ? '<th>Project</th>' : ''}<th>Details</th>${showOpen ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${items.map(it => activityRow(it, { showActor, showProject, showOpen })).join('')}</tbody>
  </table>`;
}

function activityRow(it, { showActor, showProject, showOpen }) {
  const when = String(it.created_at).slice(0, 16).replace('T', ' ');
  const typePill = `<span class="pill type-${it.type}">${it.type}</span>`;
  const actor = showActor ? `<td>${esc(it.actor_name)}</td>` : '';
  const project = showProject ? `<td>${esc(it.project_title)}</td>` : '';
  const cols = 3 + (showActor ? 1 : 0) + (showProject ? 1 : 0) + (showOpen ? 1 : 0);
  const openBtn = showOpen
    ? `<td class="actions"><button class="small secondary" data-open-activity="${it.type}-${it.id}" data-act-type="${it.type}" data-act-id="${it.id}">Open</button></td>`
    : '';
  const expansion = showOpen
    ? `<tr id="activity-detail-${it.type}-${it.id}" hidden><td colspan="${cols}"></td></tr>`
    : '';
  return `<tr>
    <td class="when">${esc(when)}</td>
    <td>${typePill}</td>
    ${actor}
    ${project}
    <td>${activityDetails(it)}</td>
    ${openBtn}
  </tr>${expansion}`;
}

// Wire Open buttons in any container that has activityHtml({ showOpen: true }).
export function wireActivityDetails(root) {
  root.querySelectorAll('[data-open-activity]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.actType;
      const id   = btn.dataset.actId;
      const tr   = document.getElementById(`activity-detail-${type}-${id}`);
      const cell = tr.querySelector('td');
      if (!tr.hidden) { tr.hidden = true; btn.textContent = 'Open'; return; }
      tr.hidden = false;
      btn.textContent = 'Close';
      cell.innerHTML = '<p class="muted">Loading…</p>';
      try {
        cell.innerHTML = await fetchActivityDetail(type, id);
        wireJwtDownloads(cell);
      } catch (e) {
        cell.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
    });
  });
}

async function fetchActivityDetail(type, id) {
  const auditType = type === 'labour' ? 'labour_entry' : type === 'expense' ? 'expense' : 'evidence_item';
  const entityUrl = type === 'labour' ? `/api/labour/${id}` : type === 'expense' ? `/api/expenses/${id}` : `/api/evidence/${id}`;
  const linkedUrl = type === 'labour' ? `/api/evidence?labour_entry_id=${id}` : type === 'expense' ? `/api/evidence?expense_id=${id}` : null;
  const tasks = [api('GET', entityUrl), api('GET', `/api/audit-log?entity_type=${auditType}&entity_id=${id}&limit=20`)];
  if (linkedUrl) tasks.push(api('GET', linkedUrl));
  const [entity, audit, linked] = await Promise.all(tasks);
  return renderActivityDetail(type, entity, audit.items, (linked?.items ?? []));
}

function renderActivityDetail(type, e, auditItems, linkedEv) {
  const head = `<div class="grid" style="gap:0.4rem; font-size:0.92rem">`;
  let body = head;
  if (type === 'labour') {
    body += `
      <div><strong>Work date:</strong> ${esc(e.work_date)}</div>
      <div><strong>Hours:</strong> ${e.hours}${e.is_overtime ? ' <span class="pill overtime">OT</span>' : ''}</div>
      <div><strong>Status:</strong> <span class="pill ${e.status}">${esc(e.status)}</span></div>
      <div><strong>Period:</strong> #${e.fiscal_period_id}</div>
      <div class="full"><strong>Description:</strong> ${esc(e.description)}</div>
      ${e.reviewed_at ? `<div class="full muted"><strong>Reviewed</strong> ${esc(e.reviewed_at)} (user #${e.reviewed_by_user_id})</div>` : ''}
      ${e.rejection_reason ? `<div class="full"><strong>Rejection reason:</strong> <span class="muted">${esc(e.rejection_reason)}</span></div>` : ''}
    `;
  } else if (type === 'expense') {
    body += `
      <div><strong>Date:</strong> ${esc(e.expense_date)}</div>
      <div><strong>Category:</strong> ${esc(e.category)}</div>
      <div><strong>Amount:</strong> ${(e.amount_cents/100).toFixed(2)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</div>
      <div><strong>Status:</strong> <span class="pill ${e.status}">${esc(e.status)}</span></div>
      <div class="full"><strong>Description:</strong> ${esc(e.description)}</div>
      ${e.reviewed_at ? `<div class="full muted"><strong>Reviewed</strong> ${esc(e.reviewed_at)} (user #${e.reviewed_by_user_id})</div>` : ''}
      ${e.rejection_reason ? `<div class="full"><strong>Rejection reason:</strong> <span class="muted">${esc(e.rejection_reason)}</span></div>` : ''}
    `;
  } else if (type === 'evidence') {
    body += `
      <div><strong>Date:</strong> ${esc(e.evidence_date)}</div>
      <div><strong>Kind:</strong> ${esc(e.kind)}</div>
      <div><strong>Uploaded by:</strong> user #${e.uploaded_by_user_id}</div>
      <div class="full"><strong>Caption:</strong> ${esc(e.caption)}</div>
      ${e.kind === 'file' ? `<div class="full"><strong>File:</strong> <a href="/api/evidence/${e.id}/download" data-jwt-dl>${esc(e.file_path)}</a> (${e.file_size ?? '?'} bytes, ${esc(e.file_mime ?? '')})</div>` : ''}
      ${e.kind === 'link' ? `<div class="full"><strong>URL:</strong> <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a></div>` : ''}
      ${e.kind === 'note' ? `<div class="full"><strong>Note:</strong> ${esc(e.note_text)}</div>` : ''}
      ${e.labour_entry_id ? `<div><strong>Linked to:</strong> labour entry #${e.labour_entry_id}</div>` : ''}
      ${e.expense_id ? `<div><strong>Linked to:</strong> expense #${e.expense_id}</div>` : ''}
    `;
  }
  body += `</div>`;

  if (linkedEv.length) {
    body += `<h4 style="margin:0.8rem 0 0.3rem; font-size:0.92rem">Linked evidence (${linkedEv.length})</h4>
      <ul style="font-size:0.88rem; margin:0; padding-left:1.2rem">${linkedEv.map(ev =>
        `<li><span class="pill type-evidence">${esc(ev.kind)}</span> ${esc(ev.caption)} ${
          ev.kind === 'file' ? `· <a href="/api/evidence/${ev.id}/download" data-jwt-dl>${esc(ev.file_path)}</a>` :
          ev.kind === 'link' ? `· <a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.url)}</a>` :
          `· <span class="muted">${esc((ev.note_text ?? '').slice(0, 120))}</span>`
        }</li>`).join('')}</ul>`;
  }
  if (auditItems.length) {
    body += `<details style="margin-top:0.7rem"><summary class="muted" style="cursor:pointer; font-size:0.88rem">Audit log (${auditItems.length})</summary>
      <ul style="font-size:0.85rem; margin:0.4rem 0 0 1.2rem">${auditItems.map(a =>
        `<li>${esc(a.created_at)} · <strong>${esc(a.action)}</strong> by ${esc(a.actor_name ?? '(system)')}</li>`).join('')}</ul></details>`;
  }
  return `<div style="padding:0.7rem 0.9rem; background:#fafbfc; border:1px solid var(--border); border-radius:4px">${body}</div>`;
}

// JWT-authenticated download interceptor, reusable across shells.
export function wireJwtDownloads(root) {
  root.querySelectorAll('[data-jwt-dl]').forEach(a => {
    if (a.dataset.jwtBound) return;
    a.dataset.jwtBound = '1';
    a.addEventListener('click', async e => {
      e.preventDefault();
      const r = await fetch(a.getAttribute('href'), {
        headers: { authorization: `Bearer ${sessionStorage.getItem('sred-jwt')}` },
      });
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const tmp = document.createElement('a');
      tmp.href = url;
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      tmp.download = m ? m[1] : 'download';
      tmp.click();
      URL.revokeObjectURL(url);
    });
  });
}

function activityDetails(it) {
  if (it.type === 'labour') {
    const ot = it.is_overtime ? ' <span class="pill overtime">OT</span>' : '';
    return `<strong>${it.hours}h</strong>${ot} — ${esc(it.description)} `
      + `<span class="pill ${it.status}">${esc(it.status)}</span>`;
  }
  if (it.type === 'expense') {
    const fx = it.fx_rate ? ` @ ${it.fx_rate}` : '';
    return `<strong>${cents(it.amount_cents)} ${esc(it.currency)}${fx}</strong> `
      + `<span class="pill type-${it.type}">${esc(it.category)}</span> — ${esc(it.description)} `
      + `<span class="pill ${it.status}">${esc(it.status)}</span>`;
  }
  if (it.type === 'evidence') {
    return `<strong>${esc(it.evidence_kind)}</strong> — ${esc(it.caption)}`;
  }
  return '';
}

export function chartHtml(bars) {
  return `
    <div class="chart">
      ${bars.map(b => `
        <div class="col${b.isToday ? ' today' : ''}" title="${b.date} — ${b.hours.toFixed(2)} h">
          <div class="bar-wrap">
            <div class="bar" style="height: ${b.pct}%">
              ${b.hours > 0 ? `<span class="bar-value">${b.hours.toFixed(1)}</span>` : ''}
            </div>
          </div>
          <div class="bar-label">
            ${b.label}<br><span class="muted">${b.date.slice(5)}</span>
            ${b.isToday ? '<div class="today-mark">TODAY</div>' : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
}
