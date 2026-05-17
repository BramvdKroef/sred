// Projects tab — list view (claimants / periods / projects / attached users
// cards) and the bindings for the list-side forms. Rendered when no project
// is being drilled into.
import { api, esc, bindForm, showTopBanner, statusPill, TYPE_LABEL, STATUS_LABEL } from '../../api.js';
import { mountNarrativeHelper } from './narrative-helper.js';

// Allow-listed filter keys for the projects-list filter bar. Anything outside
// this list is dropped before being written to the URL hash so a hand-edited
// hash can't smuggle arbitrary keys into our state. STATUS / TYPE values are
// derived from the shared label maps in dom.js so the dropdown options stay
// in lockstep with whatever's rendered elsewhere (status pills, kind pills).
const FILTER_KEYS    = ['status', 'type', 'claimant_id', 'manager_user_id'];
const VALID_STATUSES = Object.keys(STATUS_LABEL);
const VALID_TYPES    = Object.keys(TYPE_LABEL);

// Field-name → human label for the filter bar's visible / aria labels.
const FILTER_LABEL = {
  status:          'Status',
  type:            'Type',
  claimant_id:     'Claimant',
  manager_user_id: 'Manager',
};

// Stash for the latest fetched filtered items, keyed by the active filter
// signature. Lets the view re-render synchronously after a hash-driven render
// pass (the renderer reads from here when filters are present).
let filteredProjects = null;
let filteredSignature = '';

function activeFilters(state) {
  const q = state.hashQuery || {};
  const out = {};
  for (const k of FILTER_KEYS) {
    const v = q[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

function filterSignature(filters) {
  return Object.keys(filters).sort().map(k => `${k}=${filters[k]}`).join('&');
}

export function renderClaimantsTab(ctx) {
  const { state } = ctx;
  // The active claimant now comes from the header selector
  // (state.activeClaimantId). When "All claimants" is selected this tab
  // prompts the user to narrow scope, since most actions here are
  // claimant-scoped (create period, create project, edit claimant).
  const activeId = state.activeClaimantId;
  return `
    <div class="two-up">
      <div class="card compact">
        <div class="card-head">
          <h2>Claimant</h2>
          <div class="row gap-xs">
            ${activeId ? '<button id="edit-claimant-toggle" class="secondary small">✎ Edit</button>' : ''}
            <button id="new-claimant-toggle" class="secondary small">＋ New</button>
          </div>
        </div>
        ${activeId
          ? `<p class="muted m-0">${esc(state.claimants.find(c => c.id === activeId)?.legal_name ?? '')}</p>`
          : '<p class="empty m-0">Pick a claimant from the header to manage it.</p>'}
        <div id="new-claimant-form" class="mt-md" hidden>
          <form id="claimant-form">
            <div class="grid">
              <div><label>Legal name <input name="legal_name" required></label></div>
              <div><label>Business number <input name="business_number"></label></div>
              <div><label>Fiscal year end (MM-DD) <input name="fye" placeholder="12-31" required></label></div>
              <div><label title="All T661 figures are reported in this currency. Foreign-currency expenses convert at the entered FX rate.">Reporting currency <input name="reporting_currency" value="CAD" title="All T661 figures are reported in this currency. Foreign-currency expenses convert at the entered FX rate."></label></div>
              <div class="full"><label title="Proxy = 55% of eligible labour is auto-claimed as overhead (no overhead expenses needed). Traditional = you itemise overhead expenses. Locked once set.">SR&amp;ED method (locked once set)
                <select name="sred_method" title="Proxy = 55% of eligible labour is auto-claimed as overhead (no overhead expenses needed). Traditional = you itemise overhead expenses. Locked once set."><option>proxy</option><option>traditional</option></select>
              </label></div>
            </div>
            <div class="actions"><button class="small">Create claimant</button></div>
          </form>
        </div>
        ${activeId ? renderEditClaimantForm(state.claimants.find(c => c.id === activeId)) : ''}
      </div>
      <div class="card compact">
        <div class="card-head">
          <h2>Fiscal periods</h2>
          ${activeId ? '<button id="new-period-toggle" class="secondary small">＋ Add</button>' : ''}
        </div>
        ${activeId
          ? renderPeriodsTable(state.periods) + (() => {
              const c = state.claimants.find(c => c.id === activeId);
              const { start, end } = suggestPeriodDates(c, state.periods);
              return `
              <div id="new-period-form" class="mt-sm" hidden>
                <form id="period-form" class="row">
                  <input type="date" name="start_date" required value="${start}" aria-label="Period start date">
                  <input type="date" name="end_date" required value="${end}" aria-label="Period end date">
                  <button class="small">Add period</button>
                </form>
              </div>`;
            })()
          : '<p class="empty">Pick a claimant from the header.</p>'}
      </div>
    </div>
    ${activeId ? renderProjectsAndUsers(state) : '<p class="empty">Pick a claimant from the header (or create one) to see its projects.</p>'}
  `;
}

function renderProjectsAndUsers(state) {
  const managerOpts = state.managers.map(u =>
    `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join('');
  const filters = activeFilters(state);
  const hasFilters = Object.keys(filters).length > 0;
  // When filters are active, render whatever the last fetch returned for the
  // current signature (set asynchronously by bindList). Until that resolves
  // we show an empty-state placeholder rather than the unfiltered list so
  // the UI doesn't briefly contradict the visible filter values.
  const tableProjects = hasFilters
    ? (filteredSignature === filterSignature(filters) && filteredProjects ? filteredProjects : null)
    : state.projects;
  return `
    <div class="card">
      <div class="card-head">
        <h2>Projects</h2>
        <button id="new-project-toggle" class="secondary small">＋ New project</button>
      </div>
      ${renderProjectsFilterBar(state, filters)}
      ${tableProjects === null
        ? '<p class="empty">Loading…</p>'
        : renderProjectsTable(tableProjects)}
      <div id="new-project-form" class="mt-lg" hidden>
        <form id="project-form">
          <div class="grid">
            <div class="full"><label>Title <input name="title" required></label></div>
            <div><label>Type
              <select name="type">
                <option value="sred" selected>SR&amp;ED</option>
                <option value="internal">Internal</option>
              </select>
            </label></div>
            <div><label>Manager
              <select name="manager_user_id">
                <option value="">— none —</option>
                ${managerOpts}
              </select>
            </label></div>
            <div><label>Field of science <input name="field_of_science" placeholder="e.g. Computer science"></label></div>
            <div><label>Start date <input type="date" name="start_date" required></label></div>
            <div><label>Status
              <select name="status">
                <option value="concept">Concept</option>
                <option value="development" selected>Development</option>
                <option value="complete">Complete</option>
              </select>
            </label></div>
            <div class="full"><label>Advancement sought
              <textarea name="advancement_sought" rows="3" placeholder="What technological advancement is this project trying to achieve?"></textarea>
            </label></div>
            <div class="full"><label>Technological uncertainties
              <textarea name="uncertainties" rows="3" placeholder="What is uncertain or not knowable from existing knowledge?"></textarea>
            </label></div>
            <div class="full"><label>Hypothesis
              <textarea name="hypothesis" rows="3" placeholder="The working hypothesis the team tested to resolve the uncertainty."></textarea>
            </label></div>
            <div><label>Uncertainty identified on
              <input type="date" name="uncertainty_identified_at">
            </label></div>
            <div class="full"><label>Work performed
              <textarea name="work_performed" rows="4" placeholder="Systematic investigation: experiments, hypotheses tested, outcomes."></textarea>
            </label></div>
          </div>
          <div class="actions"><button>Create project</button></div>
        </form>
      </div>
    </div>
    <div class="card compact">
      <h2>Attached employees</h2>
      ${renderUsersUnderClaimantTable(state.users)}
    </div>
  `;
}

function renderPeriodsTable(periods) {
  if (!periods.length) return '<p class="empty">No periods yet.</p>';
  return `<div class="table-scroll"><table>
    <thead><tr><th>Start</th><th>End</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${periods.map(p => `
      <tr>
        <td>${esc(p.start_date)}</td>
        <td>${esc(p.end_date)}</td>
        <td>${statusPill(p.status)}</td>
        <td class="actions">
          ${p.status === 'open'
            ? `<button class="secondary small" data-act-period="close" data-id="${p.id}">Close</button>`
            : `<button class="secondary small" data-act-period="reopen" data-id="${p.id}">Reopen</button>`}
        </td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

// Filter bar above the projects table. Status / type / claimant selects bind
// to query-string params on the URL hash so the filtered view is
// bookmarkable; a "Clear filters" link drops them all. Manager filter is
// included only if state.managers is already loaded (it always is in the
// admin shell, but we guard so the helper degrades gracefully if it isn't).
function renderProjectsFilterBar(state, filters) {
  const sel = (name, current, options) => `
    <label class="label-plain">${esc(FILTER_LABEL[name])}
      <select name="${name}" aria-label="Filter by ${esc(FILTER_LABEL[name].toLowerCase())}">
        <option value="">All</option>
        ${options.map(o =>
          `<option value="${esc(String(o.value))}"${String(current ?? '') === String(o.value) ? ' selected' : ''}>${esc(o.label)}</option>`
        ).join('')}
      </select>
    </label>
  `;
  const statusOpts   = VALID_STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] ?? s }));
  const typeOpts     = VALID_TYPES.map(t    => ({ value: t, label: TYPE_LABEL[t]   ?? t }));
  const claimantOpts = (state.claimants || []).map(c => ({ value: c.id, label: c.legal_name }));
  const managerOpts  = (state.managers  || []).map(m => ({ value: m.id, label: `${m.name} (${m.role})` }));

  const showClear = Object.keys(filters).length > 0;
  return `
    <div class="card filter-bar mt-md">
      <form id="projects-filter-form" class="row gap-lg align-end wrap m-0">
        <div>${sel('status',          filters.status,          statusOpts)}</div>
        <div>${sel('type',            filters.type,            typeOpts)}</div>
        <div>${sel('claimant_id',     filters.claimant_id,     claimantOpts)}</div>
        ${managerOpts.length ? `<div>${sel('manager_user_id', filters.manager_user_id, managerOpts)}</div>` : ''}
        ${showClear
          ? '<button type="button" class="small secondary" data-projects-filter-clear>Clear filters</button>'
          : ''}
      </form>
    </div>
  `;
}

function renderProjectsTable(projects) {
  if (!projects.length) return '<p class="empty">No projects yet.</p>';
  return `<div class="table-scroll"><table class="rows-clickable">
    <thead><tr><th>Title</th><th>Type</th><th class="hide-on-narrow">Field</th><th>Start</th><th>Status</th></tr></thead>
    <tbody>${projects.map(p => `
      <tr data-open-project="${p.id}">
        <td><strong>${esc(p.title)}</strong></td>
        <td><span class="pill kind-${esc(p.type)}">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></td>
        <td class="hide-on-narrow">${esc(p.field_of_science ?? '—')}</td>
        <td>${esc(p.start_date)}</td>
        <td><span class="pill status-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span></td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function renderUsersUnderClaimantTable(users) {
  if (!users.length) return '<p class="empty">No users attached to this claimant yet. Invite from the Employees tab.</p>';
  return `<div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${users.map(u => `
      <tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td>${statusPill(u.status)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function renderEditClaimantForm(c) {
  if (!c) return '';
  const fye = `${String(c.fiscal_year_end_month).padStart(2,'0')}-${String(c.fiscal_year_end_day).padStart(2,'0')}`;
  return `
    <div id="edit-claimant-form" class="mt-md" hidden>
      <form id="form-edit-claimant">
        <div class="grid">
          <div class="full"><label>Legal name <input name="legal_name" required value="${esc(c.legal_name)}"></label></div>
          <div><label>Business number <input name="business_number" value="${esc(c.business_number ?? '')}"></label></div>
          <div><label>Fiscal year end (MM-DD) <input name="fye" required value="${esc(fye)}" pattern="\\d{2}-\\d{2}"></label></div>
          <div><label title="All T661 figures are reported in this currency. Foreign-currency expenses convert at the entered FX rate.">Reporting currency <input name="reporting_currency" required value="${esc(c.reporting_currency)}" title="All T661 figures are reported in this currency. Foreign-currency expenses convert at the entered FX rate."></label></div>
          <div><label title="Proxy = 55% of eligible labour is auto-claimed as overhead (no overhead expenses needed). Traditional = you itemise overhead expenses. Locked once set.">SR&amp;ED method (locked) <input value="${esc(c.sred_method)}" disabled title="Proxy = 55% of eligible labour is auto-claimed as overhead (no overhead expenses needed). Traditional = you itemise overhead expenses. Locked once set."></label></div>
        </div>
        <div class="actions row gap-sm">
          <button class="small">Save claimant</button>
          <button type="button" class="small secondary" id="cancel-edit-claimant">Cancel</button>
        </div>
      </form>
    </div>
  `;
}

// Smart defaults for the "Add period" form. If the claimant already has
// periods, suggest the next one in sequence (start = last_end + 1 day,
// end = +1 year - 1 day). Otherwise use the next fiscal-year-end on or after today.
function suggestPeriodDates(claimant, periods) {
  if (!claimant) return { start: '', end: '' };
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if (periods && periods.length) {
    const latest = periods.reduce((a, b) => (a.end_date > b.end_date ? a : b));
    const prev = new Date(latest.end_date + 'T12:00:00');
    const start = new Date(prev); start.setDate(start.getDate() + 1);
    const end   = new Date(start); end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1);
    return { start: fmt(start), end: fmt(end) };
  }
  const today = new Date(); today.setHours(12, 0, 0, 0);
  let end = new Date(today.getFullYear(), claimant.fiscal_year_end_month - 1, claimant.fiscal_year_end_day);
  if (end < today) end = new Date(today.getFullYear() + 1, claimant.fiscal_year_end_month - 1, claimant.fiscal_year_end_day);
  const start = new Date(end); start.setFullYear(start.getFullYear() - 1); start.setDate(start.getDate() + 1);
  return { start: fmt(start), end: fmt(end) };
}

// --- List-view event bindings ----------------------------------------------

export function bindList(ctx) {
  const { state, reloadAll } = ctx;

  // The claimant selector now lives in the page header (public/admin.js).
  // We just read state.activeClaimantId here.

  bindProjectsFilterBar(ctx);

  // Row-click → drilldown (drive hash; hashchange triggers render)
  document.querySelectorAll('[data-open-project]').forEach(tr => {
    tr.addEventListener('click', () => {
      location.hash = `projects/${tr.dataset.openProject}`;
    });
  });

  // Toggles for collapsible forms
  for (const [btnId, formId] of [
    ['new-claimant-toggle',  'new-claimant-form'],
    ['new-period-toggle',    'new-period-form'],
    ['new-project-toggle',   'new-project-form'],
    ['edit-claimant-toggle', 'edit-claimant-form'],
  ]) {
    const btn = document.getElementById(btnId);
    const form = document.getElementById(formId);
    if (btn && form) btn.addEventListener('click', () => { form.hidden = !form.hidden; });
  }
  const cancelClaim = document.getElementById('cancel-edit-claimant');
  if (cancelClaim) cancelClaim.addEventListener('click', () => {
    document.getElementById('edit-claimant-form').hidden = true;
  });

  // Period close/reopen
  document.querySelectorAll('[data-act-period]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.actPeriod;
      const periodId = Number(btn.dataset.id);
      try {
        if (action === 'close') {
          const period = state.periods.find(p => p.id === periodId);
          if (!period) throw new Error('Period not found');
          const [lab, exp, ev] = await Promise.all([
            api('GET', `/api/labour?period_id=${periodId}`),
            api('GET', `/api/expenses?period_id=${periodId}`),
            api('GET', `/api/evidence?period_id=${periodId}`),
          ]);
          const msg =
            `Close fiscal period ${period.start_date} – ${period.end_date}?\n\n` +
            `This will lock all entries in this period from further edits or deletes:\n` +
            `  • ${lab.items.length} labour entries\n` +
            `  • ${exp.items.length} expenses\n` +
            `  • ${ev.items.length} evidence items\n\n` +
            `Reopen is an admin action and is logged.`;
          if (!confirm(msg)) return;
        }
        await api('POST', `/api/periods/${periodId}/${action}`);
        ctx.render();
      } catch (e) { showTopBanner(e.message); }
    });
  });

  // Forms
  bindForm('#form-edit-claimant', async fd => {
    const fye = (fd.get('fye') || '').split('-').map(Number);
    if (fye.length !== 2 || !fye[0] || !fye[1]) throw new Error('Fiscal year end must be MM-DD');
    await api('PATCH', `/api/claimants/${state.activeClaimantId}`, {
      legal_name: fd.get('legal_name'),
      business_number: fd.get('business_number') || null,
      fiscal_year_end_month: fye[0],
      fiscal_year_end_day: fye[1],
      reporting_currency: fd.get('reporting_currency'),
    });
    await reloadAll();
  });

  bindForm('#claimant-form', async fd => {
    const fye = (fd.get('fye') || '').split('-').map(Number);
    if (fye.length !== 2 || !fye[0] || !fye[1]) throw new Error('Fiscal year end must be MM-DD');
    await api('POST', '/api/claimants', {
      legal_name: fd.get('legal_name'),
      business_number: fd.get('business_number') || null,
      fiscal_year_end_month: fye[0],
      fiscal_year_end_day: fye[1],
      reporting_currency: fd.get('reporting_currency') || 'CAD',
      sred_method: fd.get('sred_method'),
    });
    await reloadAll();
  });

  bindForm('#period-form', async fd => {
    await api('POST', `/api/claimants/${state.activeClaimantId}/periods`, {
      start_date: fd.get('start_date'),
      end_date: fd.get('end_date'),
    });
    await reloadAll();
  });

  // Mount the narrative helper next to the new-project form (if present).
  // The form lives inside a collapsible (`#new-project-form`) that starts
  // hidden — the helper still mounts so it's ready when the form opens.
  const newProjectForm = document.getElementById('project-form');
  if (newProjectForm) mountNarrativeHelper(newProjectForm);

  bindForm('#project-form', async fd => {
    const managerRaw = fd.get('manager_user_id');
    await api('POST', `/api/claimants/${state.activeClaimantId}/projects`, {
      title: fd.get('title'),
      field_of_science: fd.get('field_of_science') || null,
      start_date: fd.get('start_date'),
      status: fd.get('status'),
      type: fd.get('type'),
      manager_user_id: managerRaw ? Number(managerRaw) : null,
      advancement_sought: fd.get('advancement_sought') || null,
      uncertainties: fd.get('uncertainties') || null,
      work_performed: fd.get('work_performed') || null,
      hypothesis: fd.get('hypothesis') || null,
      uncertainty_identified_at: fd.get('uncertainty_identified_at') || null,
    });
    await reloadAll();
  });
}

// Wire the filter bar's selects + Clear-filters link. Each <select> change
// rewrites the URL hash query string (which triggers a re-render via the
// admin shell's hashchange handler); the renderer then issues a single
// `/api/projects?<filters>` fetch and re-renders the table once it lands.
//
// We keep the URL as the single source of truth for filter state so a
// shared link reproduces the same view (the "bookmarkable" requirement).
function bindProjectsFilterBar(ctx) {
  const form = document.getElementById('projects-filter-form');
  if (!form) return;
  const { state } = ctx;

  const writeFiltersToHash = (next) => {
    const base = state.viewingProjectId
      ? `projects/${state.viewingProjectId}`
      : 'projects';
    const params = Object.keys(next)
      .filter(k => FILTER_KEYS.includes(k) && next[k] !== '' && next[k] != null)
      .sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(next[k])}`)
      .join('&');
    const newHash = '#' + base + (params ? '?' + params : '');
    if (location.hash !== newHash) location.hash = newHash;
  };

  form.querySelectorAll('select').forEach(s => {
    s.addEventListener('change', () => {
      const fd = new FormData(form);
      const next = {};
      for (const k of FILTER_KEYS) {
        const v = fd.get(k);
        if (v) next[k] = v;
      }
      writeFiltersToHash(next);
    });
  });

  const clearBtn = form.querySelector('[data-projects-filter-clear]');
  if (clearBtn) clearBtn.addEventListener('click', () => writeFiltersToHash({}));

  // Asynchronously fetch the filtered list when any filter is active and
  // we haven't already cached results for this signature. Render is
  // re-invoked through ctx.render() once the fetch resolves.
  const filters = activeFilters(state);
  const sig = filterSignature(filters);
  if (Object.keys(filters).length === 0) {
    // No filters → ensure stale cache doesn't leak into a subsequent
    // filtered render that hasn't yet completed.
    filteredProjects = null;
    filteredSignature = '';
    return;
  }
  if (sig === filteredSignature && filteredProjects) return;
  // Mark the signature optimistically so concurrent re-renders dedupe.
  filteredSignature = sig;
  const qs = Object.keys(filters)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(filters[k])}`)
    .join('&');
  api('GET', `/api/projects?${qs}&limit=100`).then(r => {
    // Drop stale responses if the user has flipped filters again.
    if (filterSignature(activeFilters(ctx.state)) !== sig) return;
    filteredProjects = r.items;
    ctx.render();
  }).catch(e => showTopBanner(e.message));
}
