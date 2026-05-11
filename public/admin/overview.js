import { api, esc, currentWeek, weekBars, chartHtml, activityHtml, wireActivityDetails } from '../api.js';

export async function render(main) {
  main.innerHTML = '<p class="empty">Loading overview…</p>';
  const week = currentWeek();
  const [weekLabour, pendingLab, pendingExp, activity] = await Promise.all([
    api('GET', `/api/labour?from=${week.from}&to=${week.to}`),
    api('GET', '/api/labour?status=pending'),
    api('GET', '/api/expenses?status=pending'),
    api('GET', '/api/activity?limit=15'),
  ]);
  const nonRejected = weekLabour.items.filter(l => l.status !== 'rejected');
  const totalHours = nonRejected.reduce((s, e) => s + e.hours, 0);
  const bars = weekBars(nonRejected, week.days);
  const contributors = new Set(nonRejected.map(l => l.user_claimant_id)).size;
  main.innerHTML = `
    <div class="card">
      <h2>This week — ${esc(week.from)} → ${esc(week.to)}</h2>
      <div class="metrics">
        <div><div class="metric">${totalHours.toFixed(2)}</div><div class="muted">hours logged (all employees)</div></div>
        <div><div class="metric">${contributors}</div><div class="muted">contributor${contributors === 1 ? '' : 's'}</div></div>
        <div><div class="metric">${pendingLab.items.length}</div><div class="muted">pending labour</div></div>
        <div><div class="metric">${pendingExp.items.length}</div><div class="muted">pending expenses</div></div>
      </div>
      ${chartHtml(bars)}
      <p class="muted" style="margin-top:0.75rem">Hover a bar for the exact total. Rejected entries are excluded.</p>
    </div>
    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true, showOpen: true })}
    </div>
  `;
  wireActivityDetails(main);
}
