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

async function reload() {
  const [projects, labour, expenses, evidence, activityFeed] = await Promise.all([
    api('GET', '/api/me/projects'),
    api('GET', '/api/labour'),
    api('GET', '/api/expenses'),
    api('GET', '/api/evidence'),
    api('GET', '/api/activity?limit=15'),
  ]);
  state.projects = projects.items;
  state.labour = labour.items;
  state.expenses = expenses.items;
  state.evidence = evidence.items;
  state.activity = activityFeed.items;
  render();
}

function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
  });
  const main = $('#main');
  const ctx = { state, render, reload };
  switch (state.tab) {
    case 'overview':    return overview.render(main, ctx);
    case 'activity':    return activity.render(main, ctx);
    case 'labour':      return forms.renderLabour(main, ctx);
    case 'evidence':    return forms.renderEvidence(main, ctx);
    case 'expense':     return forms.renderExpense(main, ctx);
    case 'preferences': return renderPreferencesPage(main);
  }
}
