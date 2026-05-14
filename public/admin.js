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
  // Active claimant scope. `null` means "All claimants" (the sentinel).
  // Source of truth for every tab; persisted to localStorage.
  // Today only Projects + Exports actually consult it — Review / Audit /
  // Overview will start honoring it in steps 3-4.
  activeClaimantId: null,
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

export const ALLOWED_TABS = ['overview', 'claimants', 'users', 'review', 'exports', 'audit', 'preferences'];

// --- Active-claimant persistence (pure helpers, unit-tested) ---------------

const ACTIVE_CLAIMANT_KEY = 'sred-active-claimant';

// Read the persisted active-claimant id and validate it against the current
// claimants list. Returns the id (number) or `null` for "all claimants".
// Anything unparseable, missing, or referring to a claimant no longer in the
// list falls back to `null` — never throws.
export function readActiveClaimantId(claimantList, storage = globalThis.localStorage) {
  if (!storage) return null;
  let raw;
  try { raw = storage.getItem(ACTIVE_CLAIMANT_KEY); }
  catch { return null; }
  if (raw === null || raw === '' || raw === 'null') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (!Array.isArray(claimantList) || !claimantList.some(c => c.id === n)) return null;
  return n;
}

// Persist the active-claimant id. `null` (the "All claimants" sentinel) is
// written as the literal string "null" so reads round-trip predictably.
export function writeActiveClaimantId(id, storage = globalThis.localStorage) {
  if (!storage) return;
  try {
    if (id === null || id === undefined) storage.setItem(ACTIVE_CLAIMANT_KEY, 'null');
    else storage.setItem(ACTIVE_CLAIMANT_KEY, String(id));
  } catch { /* localStorage may be disabled (private mode, quota, ...) */ }
}

// Pure parser for the URL hash. Returns { tab, projectId, userId, valid }.
// Exported so tests can verify hash handling without a DOM.
export function parseHashStr(rawHash) {
  const raw = (rawHash ?? '').replace(/^#/, '');
  const [tab, ...rest] = raw.split('/');
  const id = rest[0] ? Number(rest[0]) : null;
  const numId = Number.isInteger(id) ? id : null;
  return {
    tab,
    projectId: tab === 'claimants' ? numId : null,
    userId:    tab === 'users'     ? numId : null,
    valid:     ALLOWED_TABS.includes(tab),
  };
}

export function renderAdmin(ctx) {
  state.me = ctx.me;
  state.signOut = ctx.signOut;
  shell();
  reloadAll();
}

// --- URL hash routing ------------------------------------------------------

function parseHash() {
  return parseHashStr(location.hash);
}

function onHashChange() {
  const { tab, projectId, userId, valid } = parseHash();
  // Unknown hash → revert URL to the current valid tab so URL ≠ view doesn't desync.
  if (!valid) { history.replaceState(null, '', '#' + state.tab); return; }
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
  const { tab, projectId, userId, valid } = parseHash();
  if (valid) {
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
        <select id="header-claimant-select" class="header-claimant-select" aria-label="Active claimant"></select>
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
  bindHeaderClaimantSelect();
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
  // Rehydrate active claimant from localStorage on first load (when nothing
  // is set yet). After that, just validate the current selection still
  // exists — a deleted claimant falls back to "All claimants" (null).
  if (state.activeClaimantId === null) {
    state.activeClaimantId = readActiveClaimantId(state.claimants);
  } else if (!state.claimants.some(c => c.id === state.activeClaimantId)) {
    state.activeClaimantId = null;
    writeActiveClaimantId(null);
  }
  state.managers = (await api('GET', '/api/users?role=manager,admin&status=active')).items;
  if (state.activeClaimantId) {
    state.periods  = (await api('GET', `/api/claimants/${state.activeClaimantId}/periods`)).items;
    state.projects = (await api('GET', `/api/claimants/${state.activeClaimantId}/projects`)).items;
    state.users    = (await api('GET', `/api/users?claimant_id=${state.activeClaimantId}`)).items;
  } else {
    state.periods = state.projects = state.users = [];
  }
  populateHeaderClaimantSelect();
  render();
}

// Render the header's <option> list from the current state.claimants and
// reflect the active selection. Called whenever the claimants list might
// have changed (typically after reloadAll) so a newly-created claimant
// appears immediately.
function populateHeaderClaimantSelect() {
  const sel = document.getElementById('header-claimant-select');
  if (!sel) return;
  const opts = ['<option value="">All claimants</option>']
    .concat(state.claimants.map(c => `<option value="${c.id}">${esc(c.legal_name)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = state.activeClaimantId == null ? '' : String(state.activeClaimantId);
}

function bindHeaderClaimantSelect() {
  const sel = document.getElementById('header-claimant-select');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const v = sel.value;
    state.activeClaimantId = v === '' ? null : Number(v);
    writeActiveClaimantId(state.activeClaimantId);
    // Re-fetch claimant-scoped data and re-render the active tab. This is
    // the SPA's existing pattern (matches the old per-tab selector in
    // projects.js, which also called reloadAll on change).
    reloadAll();
  });
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
  // Jumping to a project from search/anywhere also pins the active claimant
  // to that project's claimant so the header stays consistent.
  if (state.activeClaimantId !== claimant_id) {
    state.activeClaimantId = claimant_id;
    writeActiveClaimantId(claimant_id);
  }
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
