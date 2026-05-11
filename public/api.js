const JWT_KEY = 'sred-jwt';

export const getJwt   = () => sessionStorage.getItem(JWT_KEY);
export const setJwt   = t  => sessionStorage.setItem(JWT_KEY, t);
export const clearJwt = () => sessionStorage.removeItem(JWT_KEY);

export async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const jwt = getJwt();
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(path, init);
  if (r.status === 204) return null;
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data;
}

export async function apiUpload(path, formData) {
  const headers = {};
  const jwt = getJwt();
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const r = await fetch(path, { method: 'POST', headers, body: formData });
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data;
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
