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

export const ALLOWED_TABS = ['overview', 'projects', 'employees', 'review', 'exports', 'audit', 'preferences'];

// Legacy → current hash-key migration. The tab keys were renamed from
// `claimants`/`users` to `projects`/`employees` so the URL matches the visible
// tab labels. Bookmarks and any deep links in third-party emails still use the
// old keys; this helper rewrites them on first load and on every hashchange.
//
// Returns the migrated hash (string, including the leading "#") when the input
// uses a legacy key, or `null` when no migration is needed. Exported so tests
// can pin the migration table without standing up a DOM.
export function migrateLegacyHash(rawHash) {
  if (rawHash == null) return null;
  const raw = String(rawHash).replace(/^#/, '');
  if (raw === '') return null;
  const [head, ...rest] = raw.split('/');
  let mapped;
  if (head === 'claimants') mapped = 'projects';
  else if (head === 'users') mapped = 'employees';
  else return null;
  const tail = rest.length ? '/' + rest.join('/') : '';
  return '#' + mapped + tail;
}

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
    projectId: tab === 'projects'  ? numId : null,
    userId:    tab === 'employees' ? numId : null,
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
  // Legacy hash redirect (#claimants → #projects, #users → #employees). Using
  // location.replace so the legacy URL doesn't sit in the back-button history.
  // The replace fires another hashchange that we then handle normally.
  const migrated = migrateLegacyHash(location.hash);
  if (migrated) { location.replace(migrated); return; }
  const { tab, projectId, userId, valid } = parseHash();
  // Unknown hash → revert URL to the current valid tab so URL ≠ view doesn't desync.
  if (!valid) { history.replaceState(null, '', '#' + state.tab); return; }
  const nextProject = (tab === 'projects')  ? projectId : null;
  const nextUser    = (tab === 'employees') ? userId    : null;
  if (tab === state.tab && nextProject === state.viewingProjectId && nextUser === state.viewingUserId) return;
  state.tab = tab;
  state.viewingProjectId = nextProject;
  state.viewingUserId    = nextUser;
  render();
}

// --- Shell render + nav + search ------------------------------------------

function shell() {
  // First load: rewrite any legacy hash (#claimants / #users) before parsing
  // so a bookmarked URL lands on the right tab. Replace (not assign) keeps the
  // back-button history clean.
  const migrated = migrateLegacyHash(location.hash);
  if (migrated) history.replaceState(null, '', migrated);
  const { tab, projectId, userId, valid } = parseHash();
  if (valid) {
    state.tab = tab;
    state.viewingProjectId = (tab === 'projects')  ? projectId : null;
    state.viewingUserId    = (tab === 'employees') ? userId    : null;
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
      ${tabBtn('projects', 'Projects')}
      ${tabBtn('employees', 'Employees')}
      ${tabBtn('review', 'Review queue')}
      ${tabBtn('exports', 'T661 exports')}
      ${tabBtn('audit', 'Audit log')}
      <div class="project-search-wrap">
        <input id="project-search" type="search" placeholder="Jump to project or employee…" autocomplete="off">
        <div id="project-search-results" class="search-results" hidden></div>
      </div>
    </nav>
    <div id="app-banner-host"></div>
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
  // exists — a deleted claimant falls back to "All claimants" (null) and we
  // surface a one-time banner so the user understands why their selection
  // changed (deep-link from a stale bookmark or a runtime delete).
  if (state.activeClaimantId === null) {
    // Distinguish "nothing stored" from "stored id no longer exists" by
    // peeking at the raw storage value before readActiveClaimantId nulls it
    // out. The helper hides that distinction by design.
    let storedRaw = null;
    try { storedRaw = globalThis.localStorage?.getItem(ACTIVE_CLAIMANT_KEY); }
    catch { /* unavailable */ }
    state.activeClaimantId = readActiveClaimantId(state.claimants);
    if (state.activeClaimantId === null && storedRaw && storedRaw !== 'null' && Number.isInteger(Number(storedRaw))) {
      // Stored a real id, but the claimant is gone. Reset the persisted
      // value so the banner fires once.
      writeActiveClaimantId(null);
      showAppBanner('Selected claimant no longer exists; defaulting to All.');
    }
  } else if (!state.claimants.some(c => c.id === state.activeClaimantId)) {
    state.activeClaimantId = null;
    writeActiveClaimantId(null);
    showAppBanner('Selected claimant no longer exists; defaulting to All.');
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

// Show a dismissable one-time inline notice between the nav and main. Used
// for events the user didn't trigger but should know about (e.g. a stored
// claimant id no longer exists). Replaces any prior banner — at most one is
// shown at a time. No-op if the host element hasn't been rendered yet.
function showAppBanner(message) {
  const host = document.getElementById('app-banner-host');
  if (!host) return;
  host.innerHTML = `
    <div class="app-banner" role="status">
      <span>${esc(message)}</span>
      <button type="button" aria-label="Dismiss" data-banner-dismiss>&times;</button>
    </div>
  `;
  host.querySelector('[data-banner-dismiss]').addEventListener('click', () => {
    host.innerHTML = '';
  });
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
    case 'projects':    return projects.render(main, ctx);
    case 'employees':   return employees.render(main, ctx);
    case 'review':      return review.render(main, ctx);
    case 'exports':     return exportsTab.render(main, ctx);
    case 'audit':       return audit.render(main, ctx);
    case 'preferences': return renderPreferencesPage(main);
  }
}

// --- Cross-tab navigation helpers (used by the search bar + various rows) -

async function selectProject({ id, claimant_id }) {
  state.tab = 'projects';
  // Jumping to a project from search/anywhere also pins the active claimant
  // to that project's claimant so the header stays consistent.
  if (state.activeClaimantId !== claimant_id) {
    state.activeClaimantId = claimant_id;
    writeActiveClaimantId(claimant_id);
  }
  state.viewingProjectId = id;
  state.viewingUserId = null;
  history.replaceState(null, '', `#projects/${id}`);
  resetSearch();
  await reloadAll();
}

async function selectUser(id) {
  state.tab = 'employees';
  state.viewingUserId = id;
  state.viewingProjectId = null;
  history.replaceState(null, '', `#employees/${id}`);
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

// Per-section cap before the "See all <N>" overflow row appears. Clicking the
// footer raises the visible window to EXPANDED_CAP for that section.
const SEARCH_CAP = 6;
const EXPANDED_CAP = 30;

function bindProjectSearch() {
  const input = document.getElementById('project-search');
  const list  = document.getElementById('project-search-results');
  if (!input || !list) return;
  let timer = null;
  let lastQuery = '';
  // Per-section expansion state. Keys are 'project' / 'user'; values are the
  // current visible cap for that section. Reset on each new query.
  let expanded = { project: false, user: false };

  const renderSection = (kind, head, items, renderItem) => {
    const cap = expanded[kind] ? EXPANDED_CAP : SEARCH_CAP;
    const visible = items.slice(0, cap);
    const overflow = items.length > visible.length;
    const overflowRow = overflow
      ? `<div class="item search-more" data-expand="${kind}">See all ${items.length} ${head.toLowerCase()} matches</div>`
      : '';
    return `<div class="results-section-head">${head}</div>` +
      visible.map(renderItem).join('') + overflowRow;
  };

  const runSearch = async (q) => {
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    // Fetch up to EXPANDED_CAP per section so the "See all" expansion is free
    // (no second round-trip). Both /api/projects and /api/users already cap
    // limit server-side, so this stays cheap.
    const [projects, users] = await Promise.all([
      api('GET', `/api/projects?q=${encodeURIComponent(q)}&limit=${EXPANDED_CAP}`),
      api('GET', `/api/users?q=${encodeURIComponent(q)}&limit=${EXPANDED_CAP}`),
    ]);
    if (q !== lastQuery) return;  // stale
    const sections = [];
    if (projects.items.length) {
      sections.push(renderSection('project', 'Projects', projects.items, p => `
          <div class="item" data-kind="project" data-pid="${p.id}" data-cid="${p.claimant_id}">
            <div><strong>${esc(p.title)}</strong> <span class="pill kind-${esc(p.type)}" style="margin-left:0.3rem">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></div>
            <div class="claimant">${esc(p.claimant_name)}</div>
          </div>`));
    }
    if (users.items.length) {
      sections.push(renderSection('user', 'Employees', users.items, u => `
          <div class="item" data-kind="user" data-uid="${u.id}">
            <div><strong>${esc(u.name)}</strong> <span class="role" style="margin-left:0.3rem">${esc(u.role)}</span></div>
            <div class="claimant">${esc(u.email)}</div>
          </div>`));
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
    // "See all <N>" footer: flip the per-section flag and re-render without a
    // second API call. The cached `projects` / `users` are still in scope.
    list.querySelectorAll('[data-expand]').forEach(el => {
      el.addEventListener('click', () => {
        expanded[el.dataset.expand] = true;
        // Re-render synchronously using the already-fetched items.
        const sections2 = [];
        if (projects.items.length) sections2.push(renderSection('project', 'Projects', projects.items, p => `
          <div class="item" data-kind="project" data-pid="${p.id}" data-cid="${p.claimant_id}">
            <div><strong>${esc(p.title)}</strong> <span class="pill kind-${esc(p.type)}" style="margin-left:0.3rem">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></div>
            <div class="claimant">${esc(p.claimant_name)}</div>
          </div>`));
        if (users.items.length) sections2.push(renderSection('user', 'Employees', users.items, u => `
          <div class="item" data-kind="user" data-uid="${u.id}">
            <div><strong>${esc(u.name)}</strong> <span class="role" style="margin-left:0.3rem">${esc(u.role)}</span></div>
            <div class="claimant">${esc(u.email)}</div>
          </div>`));
        list.innerHTML = sections2.join('');
        list.querySelectorAll('[data-kind="project"]').forEach(el => {
          el.addEventListener('click', () => {
            selectProject({ id: Number(el.dataset.pid), claimant_id: Number(el.dataset.cid) });
          });
        });
        list.querySelectorAll('[data-kind="user"]').forEach(el => {
          el.addEventListener('click', () => selectUser(Number(el.dataset.uid)));
        });
      });
    });
    list.hidden = false;
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    lastQuery = q;
    // Each new query starts collapsed again; the user can re-expand if needed.
    expanded = { project: false, user: false };
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
