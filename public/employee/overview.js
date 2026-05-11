import { esc, currentWeek, weekBars, chartHtml, activityHtml } from '../api.js';

export function render(main, ctx) {
  const { state } = ctx;
  const week = currentWeek();
  const thisWeek = state.labour.filter(l =>
    l.work_date >= week.from && l.work_date <= week.to && l.status !== 'rejected');
  const totalHours = thisWeek.reduce((s, e) => s + e.hours, 0);
  const pendingMine = state.labour.filter(l => l.status === 'pending').length;
  const rejectedMine = state.labour.filter(l => l.status === 'rejected').length;
  const bars = weekBars(thisWeek, week.days);
  main.innerHTML = `
    <div class="card">
      <h2>This week — ${esc(week.from)} → ${esc(week.to)}</h2>
      <div class="metrics">
        <div><div class="metric">${totalHours.toFixed(2)}</div><div class="muted">hours logged</div></div>
        <div><div class="metric">${pendingMine}</div><div class="muted">pending review</div></div>
        ${rejectedMine ? `<div><div class="metric">${rejectedMine}</div><div class="muted">to fix</div></div>` : ''}
        <div><div class="metric">${state.projects.length}</div><div class="muted">assigned project${state.projects.length === 1 ? '' : 's'}</div></div>
      </div>
      ${chartHtml(bars)}
      <p class="muted" style="margin-top:0.75rem">Use “Log labour” to add to today, or jump to “My activity” to review history.</p>
    </div>
    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(state.activity, { showActor: false })}
    </div>
  `;
}
