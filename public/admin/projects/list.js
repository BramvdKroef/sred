// Projects tab — list view (claimants / periods / projects / attached users
// cards) and the bindings for the list-side forms. Rendered when no project
// is being drilled into.
import { api, esc, bindForm, showTopBanner, statusPill, TYPE_LABEL, STATUS_LABEL } from '../../api.js';

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
  return `
    <div class="card">
      <div class="card-head">
        <h2>Projects</h2>
        <button id="new-project-toggle" class="secondary small">＋ New project</button>
      </div>
      ${renderProjectsTable(state.projects)}
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
  return `<table>
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
    </tbody></table>`;
}

function renderProjectsTable(projects) {
  if (!projects.length) return '<p class="empty">No projects yet.</p>';
  return `<table class="rows-clickable">
    <thead><tr><th>Title</th><th>Type</th><th class="hide-on-narrow">Field</th><th>Start</th><th>Status</th></tr></thead>
    <tbody>${projects.map(p => `
      <tr data-open-project="${p.id}">
        <td><strong>${esc(p.title)}</strong></td>
        <td><span class="pill kind-${esc(p.type)}">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></td>
        <td class="hide-on-narrow">${esc(p.field_of_science ?? '—')}</td>
        <td>${esc(p.start_date)}</td>
        <td><span class="pill status-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span></td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderUsersUnderClaimantTable(users) {
  if (!users.length) return '<p class="empty">No users attached to this claimant yet. Invite from the Employees tab.</p>';
  return `<table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${users.map(u => `
      <tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td>${statusPill(u.status)}</td>
      </tr>`).join('')}
    </tbody></table>`;
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
    });
    await reloadAll();
  });
}
