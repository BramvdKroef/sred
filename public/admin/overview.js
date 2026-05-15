import { api, esc, currentWeek, weekBars, chartHtml, activityHtml, wireActivityDetails } from '../api.js';

export async function render(main, ctx) {
  if (ctx && ctx.state && ctx.state.claimants.length === 0) {
    renderFirstRunChecklist(main);
    return;
  }
  main.innerHTML = '<p class="loading">Loading overview…</p>';
  const week = currentWeek();
  // Honour the page-header claimant selector (hoist step 4). When set, every
  // panel below shows only that claimant's data; null = cross-claimant.
  const activeClaimantId = ctx && ctx.state ? (ctx.state.activeClaimantId ?? null) : null;
  const scope = activeClaimantId !== null ? `&claimant_id=${activeClaimantId}` : '';
  const [weekLabour, pendingLab, pendingExp, activity] = await Promise.all([
    api('GET', `/api/labour?from=${week.from}&to=${week.to}${scope}`),
    api('GET', `/api/labour?status=pending${scope}`),
    api('GET', `/api/expenses?status=pending${scope}`),
    api('GET', `/api/activity?limit=15${scope}`),
  ]);
  const nonRejected = weekLabour.items.filter(l => l.status !== 'rejected');
  const totalHours = nonRejected.reduce((s, e) => s + e.hours, 0);
  const bars = weekBars(nonRejected, week.days);
  const contributors = new Set(nonRejected.map(l => l.user_claimant_id)).size;
  const scopeName = activeClaimantId === null
    ? 'All claimants'
    : (ctx.state.claimants.find(c => c.id === activeClaimantId)?.legal_name ?? `#${activeClaimantId}`);
  main.innerHTML = `
    <div class="card">
      <h2>This week — ${esc(week.from)} → ${esc(week.to)}</h2>
      <p class="caption scope-label">${esc(scopeName)}</p>
      <div class="metrics">
        <div><div class="metric">${totalHours.toFixed(2)}</div><div class="muted">hours logged (all employees)</div></div>
        <div><div class="metric">${contributors}</div><div class="muted">contributor${contributors === 1 ? '' : 's'}</div></div>
        <div><div class="metric">${pendingLab.items.length}</div><div class="muted">pending labour</div></div>
        <div><div class="metric">${pendingExp.items.length}</div><div class="muted">pending expenses</div></div>
      </div>
      ${chartHtml(bars)}
      <p class="muted mt-md">Hover a bar for the exact total. Rejected entries are excluded.</p>
    </div>
    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true, showOpen: true })}
    </div>
  `;
  wireActivityDetails(main, { currentUser: ctx?.state?.me?.user });
}

function renderFirstRunChecklist(main) {
  main.innerHTML = `
    <div class="card">
      <h2>Welcome to Precision SR&amp;ED</h2>
      <p class="muted">Get set up in five steps. Each step links to the relevant tab.</p>
      <ol class="checklist-ol">
        <li>
          <strong>Create your first claimant</strong> — your company or one you're filing for.
          &nbsp;<a href="#projects" class="summary-link">Add claimant</a>
        </li>
        <li>
          <strong>Add a fiscal period</strong> — typically your fiscal year.
          &nbsp;<a href="#projects" class="summary-link">Add period</a>
        </li>
        <li>
          <strong>Invite employees</strong> — they'll enrol via magic link.
          &nbsp;<a href="#employees" class="summary-link">Add employee</a>
        </li>
        <li>
          <strong>Create projects</strong> — the SR&amp;ED work being claimed.
          &nbsp;<a href="#projects" class="summary-link">Add project</a>
        </li>
        <li>
          <strong>Generate your T661</strong> — once labour, expenses, and evidence are logged.
          &nbsp;<a href="#exports" class="summary-link">Generate</a>
        </li>
      </ol>
    </div>
  `;
}
