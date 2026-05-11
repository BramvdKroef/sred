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

export function activityHtml(items, { showActor = true } = {}) {
  if (!items.length) return '<p class="empty">No activity yet.</p>';
  return `<table class="activity">
    <thead><tr>
      <th>When</th><th>Type</th>${showActor ? '<th>Who</th>' : ''}<th>Project</th><th>Details</th>
    </tr></thead>
    <tbody>${items.map(it => activityRow(it, showActor)).join('')}</tbody>
  </table>`;
}

function activityRow(it, showActor) {
  const when = String(it.created_at).slice(0, 16).replace('T', ' ');
  const typePill = `<span class="pill type-${it.type}">${it.type}</span>`;
  const actor = showActor ? `<td>${esc(it.actor_name)}</td>` : '';
  return `<tr>
    <td class="when">${esc(when)}</td>
    <td>${typePill}</td>
    ${actor}
    <td>${esc(it.project_title)}</td>
    <td>${activityDetails(it)}</td>
  </tr>`;
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
