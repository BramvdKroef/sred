// Admin shell: state, hash routing, top-of-page nav + global search,
// dispatch to per-tab modules. Each tab module lives in admin/<name>.js
// and exports an async render(main, ctx).

import { api, $, esc, wireJwtDownloads, renderPreferencesPage, TYPE_LABEL } from './api.js';
import * as overview  from './admin/overview.js';
import * as projects  from './admin/projects.js';
import * as employees from './admin/employees.js';
import * as review    from './admin/review.js';
import * as exportsTab from './admin/exports.js';
import * as audit     from './admin/audit.js';

const state = {
  me: null,
  signOut: null,
  tab: 'overview',
  claimants: [],
  claimantId: null,
  periods: [],
  projects: [],
  users: [],
  managers: [],
  pendingLabour: [],
  pendingExpenses: [],
  exports: [],
  viewingProjectId: null,
  viewingUserId: null,
};

const ALLOWED_TABS = ['overview', 'claimants', 'users', 'review', 'exports', 'audit', 'preferences'];

export function renderAdmin(ctx) {
  state.me = ctx.me;
  state.signOut = ctx.signOut;
  shell();
  reloadAll();
}

// --- URL hash routing ------------------------------------------------------

function parseHash() {
  const raw = location.hash.slice(1);
  const [tab, ...rest] = raw.split('/');
  const id = rest[0] ? Number(rest[0]) : null;
  const numId = Number.isInteger(id) ? id : null;
  return {
    tab,
    projectId: tab === 'claimants' ? numId : null,
    userId:    tab === 'users'     ? numId : null,
  };
}

function onHashChange() {
  const { tab, projectId, userId } = parseHash();
  if (!ALLOWED_TABS.includes(tab)) return;
  const nextProject = (tab === 'claimants') ? projectId : null;
  const nextUser    = (tab === 'users')     ? userId    : null;
  if (tab === state.tab && nextProject === state.viewingProjectId && nextUser === state.viewingUserId) return;
  state.tab = tab;
  state.viewingProjectId = nextProject;
  state.viewingUserId    = nextUser;
  render();
}

// --- Shell render + nav + search ------------------------------------------

function shell() {
  const { tab, projectId, userId } = parseHash();
  if (ALLOWED_TABS.includes(tab)) {
    state.tab = tab;
    state.viewingProjectId = (tab === 'claimants') ? projectId : null;
    state.viewingUserId    = (tab === 'users')     ? userId    : null;
  } else {
    location.hash = state.tab;
  }

  $('#app').innerHTML = `
    <header>
      <h1>Precision <strong>SR&amp;ED</strong></h1>
      <div class="user">
        <strong><a href="#preferences" class="header-link">${esc(state.me.user.name)}</a></strong>
        <span class="role">admin</span>
        <button class="secondary small" id="signout">Sign out</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabBtn('overview', 'Overview')}
      ${tabBtn('claimants', 'Projects')}
      ${tabBtn('users', 'Employees')}
      ${tabBtn('review', 'Review queue')}
      ${tabBtn('exports', 'T661 exports')}
      ${tabBtn('audit', 'Audit log')}
      <div class="project-search-wrap">
        <input id="project-search" type="search" placeholder="Search projects &amp; employees…" autocomplete="off">
        <div id="project-search-results" class="search-results" hidden></div>
      </div>
    </nav>
    <main id="main"></main>
  `;
  $('#signout').addEventListener('click', state.signOut);
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.addEventListener('click', () => { location.hash = b.dataset.tab; });
  });
  window.addEventListener('hashchange', onHashChange);
  bindProjectSearch();
}

const tabBtn = (key, label) =>
  `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${esc(label)}</button>`;

async function reloadAll() {
  state.claimants = (await api('GET', '/api/claimants')).items;
  if (!state.claimantId && state.claimants[0]) state.claimantId = state.claimants[0].id;
  state.managers = (await api('GET', '/api/users?role=manager,admin&status=active')).items;
  if (state.claimantId) {
    state.periods  = (await api('GET', `/api/claimants/${state.claimantId}/periods`)).items;
    state.projects = (await api('GET', `/api/claimants/${state.claimantId}/projects`)).items;
    state.users    = (await api('GET', `/api/users?claimant_id=${state.claimantId}`)).items;
  } else {
    state.periods = state.projects = state.users = [];
  }
  render();
}

function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
  });
  const main = $('#main');
  const ctx = { state, render, reloadAll, selectProject, selectUser };
  switch (state.tab) {
    case 'overview':    return overview.render(main, ctx);
    case 'claimants':   return projects.render(main, ctx);
    case 'users':       return employees.render(main, ctx);
    case 'review':      return review.render(main, ctx);
    case 'exports':     return exportsTab.render(main, ctx);
    case 'audit':       return audit.render(main, ctx);
    case 'preferences': return renderPreferencesPage(main);
  }
}

// --- Cross-tab navigation helpers (used by the search bar + various rows) -

async function selectProject({ id, claimant_id }) {
  state.tab = 'claimants';
  state.claimantId = claimant_id;
  state.viewingProjectId = id;
  state.viewingUserId = null;
  history.replaceState(null, '', `#claimants/${id}`);
  resetSearch();
  await reloadAll();
}

async function selectUser(id) {
  state.tab = 'users';
  state.viewingUserId = id;
  state.viewingProjectId = null;
  history.replaceState(null, '', `#users/${id}`);
  resetSearch();
  render();
}

function resetSearch() {
  const input = document.getElementById('project-search');
  const list  = document.getElementById('project-search-results');
  if (input) input.value = '';
  if (list) { list.hidden = true; list.innerHTML = ''; }
}

// --- Global search (projects + employees) ---------------------------------

function bindProjectSearch() {
  const input = document.getElementById('project-search');
  const list  = document.getElementById('project-search-results');
  if (!input || !list) return;
  let timer = null;
  let lastQuery = '';

  const runSearch = async (q) => {
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    const [projects, users] = await Promise.all([
      api('GET', `/api/projects?q=${encodeURIComponent(q)}&limit=6`),
      api('GET', `/api/users?q=${encodeURIComponent(q)}&limit=6`),
    ]);
    if (q !== lastQuery) return;  // stale
    const sections = [];
    if (projects.items.length) {
      sections.push(`<div class="results-section-head">Projects</div>` +
        projects.items.map(p => `
          <div class="item" data-kind="project" data-pid="${p.id}" data-cid="${p.claimant_id}">
            <div><strong>${esc(p.title)}</strong> <span class="pill kind-${esc(p.type)}" style="margin-left:0.3rem">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></div>
            <div class="claimant">${esc(p.claimant_name)}</div>
          </div>`).join(''));
    }
    if (users.items.length) {
      sections.push(`<div class="results-section-head">Employees</div>` +
        users.items.map(u => `
          <div class="item" data-kind="user" data-uid="${u.id}">
            <div><strong>${esc(u.name)}</strong> <span class="role" style="margin-left:0.3rem">${esc(u.role)}</span></div>
            <div class="claimant">${esc(u.email)}</div>
          </div>`).join(''));
    }
    list.innerHTML = sections.length ? sections.join('') : '<div class="empty-msg">No matches.</div>';
    list.querySelectorAll('[data-kind="project"]').forEach(el => {
      el.addEventListener('click', () => {
        selectProject({ id: Number(el.dataset.pid), claimant_id: Number(el.dataset.cid) });
      });
    });
    list.querySelectorAll('[data-kind="user"]').forEach(el => {
      el.addEventListener('click', () => selectUser(Number(el.dataset.uid)));
    });
    list.hidden = false;
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    lastQuery = q;
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(q), 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; list.hidden = true; input.blur(); }
  });
  document.addEventListener('click', e => {
    if (!list.contains(e.target) && e.target !== input) list.hidden = true;
  });
  input.addEventListener('focus', () => { if (list.innerHTML) list.hidden = false; });
}
