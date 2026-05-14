// Employee shell: state, hash routing, top-of-page nav, dispatch to per-tab
// modules in employee/. The preferences route is shared with admin.

import { api, $, esc, renderPreferencesPage } from './api.js';
import * as overview from './employee/overview.js';
import * as activity from './employee/activity.js';
import * as forms    from './employee/forms.js';

const state = {
  me: null,
  signOut: null,
  tab: 'overview',
  projects: [],
  periods: [],          // flat list across all claimants the user is attached to
  periodFilter: null,   // selected fiscal_period_id, or null for "All periods"
  labour: [],
  expenses: [],
  evidence: [],
  activity: [],
};

const ALLOWED_TABS = ['overview', 'activity', 'labour', 'evidence', 'expense', 'preferences'];

export async function renderEmployee(ctx) {
  state.me = ctx.me;
  state.signOut = ctx.signOut;
  shell();
  await reload();
}

function shell() {
  const initial = location.hash.slice(1);
  if (ALLOWED_TABS.includes(initial)) state.tab = initial;
  else location.hash = state.tab;

  $('#app').innerHTML = `
    <header>
      <h1>Precision <strong>SR&amp;ED</strong></h1>
      <div class="user">
        <strong><a href="#preferences" class="header-link">${esc(state.me.user.name)}</a></strong>
        <span class="role">employee</span>
        <button class="secondary small" id="signout">Sign out</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabBtn('overview', 'Overview')}
      ${tabBtn('activity', 'My activity')}
      ${tabBtn('labour', 'Log labour')}
      ${tabBtn('evidence', 'Add evidence')}
      ${tabBtn('expense', 'Submit expense')}
    </nav>
    <main id="main"></main>
  `;
  $('#signout').addEventListener('click', state.signOut);
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.addEventListener('click', () => { location.hash = b.dataset.tab; });
  });
  window.addEventListener('hashchange', onHashChange);
}

function onHashChange() {
  const tab = location.hash.slice(1);
  if (ALLOWED_TABS.includes(tab) && tab !== state.tab) {
    state.tab = tab;
    render();
  }
}

const tabBtn = (key, label) =>
  `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${esc(label)}</button>`;

// Re-fetch labour / expenses / evidence honouring state.periodFilter.
// state.projects, state.periods, and state.activity don't depend on the
// period selector, so they aren't refetched here.
async function reloadEntries() {
  const q = state.periodFilter ? `?period_id=${state.periodFilter}` : '';
  const [labour, expenses, evidence] = await Promise.all([
    api('GET', `/api/labour${q}`),
    api('GET', `/api/expenses${q}`),
    api('GET', `/api/evidence${q}`),
  ]);
  state.labour = labour.items;
  state.expenses = expenses.items;
  state.evidence = evidence.items;
}

async function reload() {
  const [projects, periods, activityFeed] = await Promise.all([
    api('GET', '/api/me/projects'),
    api('GET', '/api/me/periods'),
    api('GET', '/api/activity?limit=15'),
  ]);
  state.projects = projects.items;
  state.periods = periods.items;
  state.activity = activityFeed.items;

  // Default-period heuristic, applied once: if exactly one period is
  // currently "open" across all the user's claimants, preselect it.
  // Otherwise fall back to "All periods". Once the user makes a choice,
  // state.periodFilter is preserved on subsequent reloads.
  if (!state._defaulted) {
    const openPeriods = state.periods.filter(p => p.status === 'open');
    if (openPeriods.length === 1) state.periodFilter = openPeriods[0].id;
    state._defaulted = true;
  }

  await reloadEntries();
  render();
}

// Called by the activity tab when the period <select> changes. Lives on the
// employee shell so the totals card and three tables stay in sync.
async function setPeriodFilter(periodId) {
  state.periodFilter = periodId;
  await reloadEntries();
  render();
}

function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
  });
  const main = $('#main');
  const ctx = { state, render, reload, setPeriodFilter };
  switch (state.tab) {
    case 'overview':    return overview.render(main, ctx);
    case 'activity':    return activity.render(main, ctx);
    case 'labour':      return forms.renderLabour(main, ctx);
    case 'evidence':    return forms.renderEvidence(main, ctx);
    case 'expense':     return forms.renderExpense(main, ctx);
    case 'preferences': return renderPreferencesPage(main);
  }
}
