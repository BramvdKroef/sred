import { api, esc, bindForm, onSubmit, activityHtml, dollarsToCents,
         attachInlineEvidence, attachInlineReceipt, bindEvidenceKindToggle,
         wireActivityDetails, TYPE_LABEL, STATUS_LABEL } from '../api.js';

export async function render(main, ctx) {
  if (ctx.state.viewingProjectId) return renderProjectDetail(main, ctx);
  main.innerHTML = renderClaimantsTab(ctx);
  bindList(ctx);
}

// --- List view -------------------------------------------------------------

function renderClaimantsTab(ctx) {
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
          <div class="row" style="gap:0.3rem">
            ${activeId ? '<button id="edit-claimant-toggle" class="secondary small">✎ Edit</button>' : ''}
            <button id="new-claimant-toggle" class="secondary small">＋ New</button>
          </div>
        </div>
        ${activeId
          ? `<p class="muted" style="margin:0">${esc(state.claimants.find(c => c.id === activeId)?.legal_name ?? '')}</p>`
          : '<p class="empty" style="margin:0">Pick a claimant from the header to manage it.</p>'}
        <div id="new-claimant-form" hidden style="margin-top: 0.75rem">
          <form id="claimant-form">
            <div class="grid">
              <div><label>Legal name</label><input name="legal_name" required></div>
              <div><label>Business number</label><input name="business_number"></div>
              <div><label>Fiscal year end (MM-DD)</label><input name="fye" placeholder="12-31" required></div>
              <div><label>Reporting currency</label><input name="reporting_currency" value="CAD"></div>
              <div class="full"><label>SR&amp;ED method (locked once set)</label>
                <select name="sred_method"><option>proxy</option><option>traditional</option></select>
              </div>
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
              <div id="new-period-form" hidden style="margin-top: 0.6rem">
                <form id="period-form" class="row">
                  <input type="date" name="start_date" required value="${start}">
                  <input type="date" name="end_date" required value="${end}">
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
      <div id="new-project-form" hidden style="margin-top: 1rem">
        <form id="project-form">
          <div class="grid">
            <div class="full"><label>Title</label><input name="title" required></div>
            <div><label>Type</label>
              <select name="type">
                <option value="sred" selected>SR&amp;ED</option>
                <option value="internal">Internal</option>
              </select>
            </div>
            <div><label>Manager</label>
              <select name="manager_user_id">
                <option value="">— none —</option>
                ${managerOpts}
              </select>
            </div>
            <div><label>Field of science</label><input name="field_of_science" placeholder="e.g. Computer science"></div>
            <div><label>Start date</label><input type="date" name="start_date" required></div>
            <div><label>Status</label>
              <select name="status">
                <option value="concept">Concept</option>
                <option value="development" selected>Development</option>
                <option value="complete">Complete</option>
              </select>
            </div>
            <div class="full"><label>Advancement sought</label>
              <textarea name="advancement_sought" rows="3" placeholder="What technological advancement is this project trying to achieve?"></textarea>
            </div>
            <div class="full"><label>Technological uncertainties</label>
              <textarea name="uncertainties" rows="3" placeholder="What is uncertain or not knowable from existing knowledge?"></textarea>
            </div>
            <div class="full"><label>Work performed</label>
              <textarea name="work_performed" rows="4" placeholder="Systematic investigation: experiments, hypotheses tested, outcomes."></textarea>
            </div>
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
        <td><span class="pill ${p.status}">${esc(p.status)}</span></td>
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
        <td><span class="pill ${u.status === 'active' ? 'open' : 'pending'}">${esc(u.status)}</span></td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderEditClaimantForm(c) {
  if (!c) return '';
  const fye = `${String(c.fiscal_year_end_month).padStart(2,'0')}-${String(c.fiscal_year_end_day).padStart(2,'0')}`;
  return `
    <div id="edit-claimant-form" hidden style="margin-top: 0.75rem">
      <form id="form-edit-claimant">
        <div class="grid">
          <div class="full"><label>Legal name</label><input name="legal_name" required value="${esc(c.legal_name)}"></div>
          <div><label>Business number</label><input name="business_number" value="${esc(c.business_number ?? '')}"></div>
          <div><label>Fiscal year end (MM-DD)</label><input name="fye" required value="${esc(fye)}" pattern="\\d{2}-\\d{2}"></div>
          <div><label>Reporting currency</label><input name="reporting_currency" required value="${esc(c.reporting_currency)}"></div>
          <div><label>SR&amp;ED method (locked)</label><input value="${esc(c.sred_method)}" disabled></div>
        </div>
        <div class="actions row" style="gap:0.4rem">
          <button class="small">Save</button>
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

function bindList(ctx) {
  const { state, reloadAll } = ctx;

  // The claimant selector now lives in the page header (public/admin.js).
  // We just read state.activeClaimantId here.

  // Row-click → drilldown (drive hash; hashchange triggers render)
  document.querySelectorAll('[data-open-project]').forEach(tr => {
    tr.addEventListener('click', () => {
      location.hash = `claimants/${tr.dataset.openProject}`;
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
      } catch (e) { alert(e.message); }
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

// --- Project detail subview ------------------------------------------------

async function renderProjectDetail(main, ctx) {
  const { state } = ctx;
  main.innerHTML = '<p class="empty">Loading project…</p>';
  const projectId = state.viewingProjectId;
  const [project, activity, revisions] = await Promise.all([
    api('GET', `/api/projects/${projectId}`),
    api('GET', `/api/activity?project_id=${projectId}&limit=25`),
    api('GET', `/api/projects/${projectId}/revisions`),
  ]);
  const claimant = state.claimants.find(c => c.id === project.claimant_id);
  main.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>
          <a href="#" id="back-to-projects" class="muted" style="text-decoration:none">← Projects</a>
          &nbsp;/&nbsp; ${esc(project.title)}
        </h2>
        <div class="row" style="gap:0.4rem">
          <button id="edit-project-toggle" class="secondary small">✎ Edit</button>
          <span class="pill">${esc(project.status)}</span>
        </div>
      </div>
      <div class="row meta-strip">
        <span><strong>${esc(claimant?.legal_name ?? '')}</strong></span>
        <span class="pill kind-${esc(project.type)}">${esc(TYPE_LABEL[project.type] ?? project.type)}</span>
        <span class="pill status-${esc(project.status)}">${esc(STATUS_LABEL[project.status] ?? project.status)}</span>
        <span>${esc(project.field_of_science ?? '—')}</span>
        <span>Started ${esc(project.start_date)}${project.end_date ? ` → ${esc(project.end_date)}` : ''}</span>
        <span>Manager: <strong>${project.manager ? esc(project.manager.name) : '—'}</strong></span>
      </div>
    </div>

    ${renderEditProjectForm(project, state.managers)}

    <div class="card">
      <h2>Narrative</h2>
      <h3>Advancement sought</h3>
      <p>${esc(project.advancement_sought ?? '—')}</p>
      <h3>Uncertainties</h3>
      <p>${esc(project.uncertainties ?? '—')}</p>
      <h3>Work performed</h3>
      <p>${esc(project.work_performed ?? '—')}</p>
    </div>

    <div class="card compact">
      <div class="card-head">
        <h2>Assigned employees (${project.assignments.length})</h2>
        <button id="assign-toggle" class="secondary small">＋ Assign</button>
      </div>
      ${renderAssignForm(project, state.users)}
      ${project.assignments.length === 0
        ? '<p class="empty">No assignments yet.</p>'
        : `<table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
            <tbody>${project.assignments.map(a => `
              <tr>
                <td>${esc(a.name)}</td>
                <td>${esc(a.email)}</td>
                <td><span class="pill ${a.status === 'active' ? 'open' : 'closed'}">${esc(a.status)}</span></td>
                <td class="actions">${a.status === 'active'
                  ? `<button class="small danger" data-unassign="${a.user_claimant_id}" data-name="${esc(a.name)}">Remove</button>`
                  : `<button class="small secondary" data-reassign="${a.user_claimant_id}">Re-assign</button>`}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}
    </div>

    ${renderLogOnBehalfCards(project, claimant)}

    ${renderRevisionsCard(revisions.items)}

    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true, showProject: false, showOpen: true })}
    </div>
  `;
  wireActivityDetails(main);
  wireRevisionsCard(main);
  document.getElementById('back-to-projects').addEventListener('click', e => {
    e.preventDefault();
    location.hash = 'claimants';
  });
  bindEditProjectForm(project, ctx);
  bindLogOnBehalfForms(project, ctx);
  bindAssignmentForm(project, ctx);
}

function renderEditProjectForm(project, managers) {
  const managerOpts = managers.map(u =>
    `<option value="${u.id}" ${u.id === project.manager_user_id ? 'selected' : ''}>${esc(u.name)} (${esc(u.role)})</option>`
  ).join('');
  const selected = (a, b) => a === b ? 'selected' : '';
  return `
    <div class="card" id="edit-project-card" hidden>
      <h2>Edit project</h2>
      <form id="form-edit-project">
        <div class="grid">
          <div class="full"><label>Title</label>
            <input name="title" required value="${esc(project.title)}">
          </div>
          <div><label>Type</label>
            <select name="type">
              <option value="sred" ${selected(project.type,'sred')}>SR&amp;ED</option>
              <option value="internal" ${selected(project.type,'internal')}>Internal</option>
            </select>
          </div>
          <div><label>Manager</label>
            <select name="manager_user_id">
              <option value="" ${!project.manager_user_id ? 'selected' : ''}>— none —</option>
              ${managerOpts}
            </select>
          </div>
          <div><label>Field of science</label>
            <input name="field_of_science" value="${esc(project.field_of_science ?? '')}">
          </div>
          <div><label>Start date</label>
            <input type="date" name="start_date" required value="${esc(project.start_date)}">
          </div>
          <div><label>End date</label>
            <input type="date" name="end_date" value="${esc(project.end_date ?? '')}">
          </div>
          <div><label>Status</label>
            <select name="status">
              <option value="concept" ${selected(project.status,'concept')}>Concept</option>
              <option value="development" ${selected(project.status,'development')}>Development</option>
              <option value="complete" ${selected(project.status,'complete')}>Complete</option>
            </select>
          </div>
          <div class="full"><label>Advancement sought</label>
            <textarea name="advancement_sought" rows="3">${esc(project.advancement_sought ?? '')}</textarea>
          </div>
          <div class="full"><label>Technological uncertainties</label>
            <textarea name="uncertainties" rows="3">${esc(project.uncertainties ?? '')}</textarea>
          </div>
          <div class="full"><label>Work performed</label>
            <textarea name="work_performed" rows="4">${esc(project.work_performed ?? '')}</textarea>
          </div>
        </div>
        <div class="actions row" style="gap:0.5rem">
          <button>Save changes</button>
          <button type="button" class="secondary" id="cancel-edit-project">Cancel</button>
          <span class="muted">Narrative edits create a new revision snapshot.</span>
        </div>
      </form>
    </div>
  `;
}

function bindEditProjectForm(project, ctx) {
  const toggle = document.getElementById('edit-project-toggle');
  const card   = document.getElementById('edit-project-card');
  const cancel = document.getElementById('cancel-edit-project');
  const form   = document.getElementById('form-edit-project');
  if (!toggle || !card || !form) return;

  toggle.addEventListener('click', () => {
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (cancel) cancel.addEventListener('click', () => { card.hidden = true; });

  onSubmit(form, async fd => {
    const managerRaw = fd.get('manager_user_id');
    const endDate = fd.get('end_date');
    await api('PATCH', `/api/projects/${project.id}`, {
      title: fd.get('title'),
      field_of_science: fd.get('field_of_science') || null,
      start_date: fd.get('start_date'),
      end_date: endDate || null,
      status: fd.get('status'),
      type: fd.get('type'),
      manager_user_id: managerRaw ? Number(managerRaw) : null,
      advancement_sought: fd.get('advancement_sought') || null,
      uncertainties: fd.get('uncertainties') || null,
      work_performed: fd.get('work_performed') || null,
    });
    await ctx.reloadAll();
  });
}

// --- Narrative revisions card (UC-A4) --------------------------------------

function renderRevisionsCard(items) {
  const count = items.length;
  if (count === 0) {
    return `
      <div class="card compact">
        <h2>Narrative revisions (0)</h2>
        <p class="empty">No narrative edits yet.</p>
      </div>`;
  }
  // Newest first; assign v<N> counting down from total so the most recent
  // edit reads as the highest version number.
  const rows = items.map((r, i) => {
    const v = count - i;
    const when = String(r.revised_at ?? '').slice(0, 10);
    const reviser = r.revised_by_name ?? '—';
    return `
      <tr>
        <td>${esc(when)}</td>
        <td><span class="pill">v${v}</span></td>
        <td>${esc(reviser)}</td>
        <td>${esc(r.title ?? '')}</td>
        <td class="actions">
          <button class="small secondary" data-open-revision="${r.id}">Open</button>
        </td>
      </tr>
      <tr id="revision-detail-${r.id}" hidden>
        <td colspan="5">${renderRevisionDetail(r)}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card compact">
      <h2>Narrative revisions (${count})</h2>
      <table>
        <thead><tr>
          <th>Date</th><th>Version</th><th>Revised by</th><th>Title</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderRevisionDetail(r) {
  const managerName = r.manager_name ?? (r.manager_user_id ? `user #${r.manager_user_id}` : '—');
  return `
    <div class="grid" style="gap:0.4rem; font-size:0.92rem">
      <div><strong>Title:</strong> ${esc(r.title ?? '—')}</div>
      <div><strong>Type:</strong> <span class="pill kind-${esc(r.type ?? '')}">${esc(TYPE_LABEL[r.type] ?? r.type ?? '—')}</span></div>
      <div><strong>Field of science:</strong> ${esc(r.field_of_science ?? '—')}</div>
      <div><strong>Manager:</strong> ${esc(managerName)}</div>
      <div class="full"><strong>Advancement sought:</strong><br>${esc(r.advancement_sought ?? '—')}</div>
      <div class="full"><strong>Uncertainties:</strong><br>${esc(r.uncertainties ?? '—')}</div>
      <div class="full"><strong>Work performed:</strong><br>${esc(r.work_performed ?? '—')}</div>
    </div>`;
}

function wireRevisionsCard(root) {
  root.querySelectorAll('[data-open-revision]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.openRevision;
      const tr = document.getElementById(`revision-detail-${id}`);
      if (!tr) return;
      const isOpening = tr.hidden;
      tr.hidden = !tr.hidden;
      btn.textContent = isOpening ? 'Close' : 'Open';
    });
  });
}

function renderLogOnBehalfCards(project, claimant) {
  const activeAssignees = project.assignments.filter(a => a.status === 'active');
  if (activeAssignees.length === 0) {
    return `<div class="card compact"><p class="empty">Assign an active employee to this project before logging labour or expenses on their behalf.</p></div>`;
  }
  const employeeOpts = activeAssignees
    .map(a => `<option value="${a.user_claimant_id}">${esc(a.name)}</option>`).join('');
  const reportingCcy = claimant?.reporting_currency ?? 'CAD';
  return `
    <div class="two-up">
      <div class="card compact">
        <div class="card-head">
          <h2>Log labour</h2>
          <button id="behalf-labour-toggle" class="secondary small">＋ New</button>
        </div>
        <div id="behalf-labour-form" hidden>
          <form id="form-behalf-labour">
            <div class="grid">
              <div class="full"><label>Employee</label>
                <select name="user_claimant_id" required>${employeeOpts}</select>
              </div>
              <div><label>Date</label><input type="date" name="work_date" required></div>
              <div><label>Hours</label><input type="number" name="hours" step="0.25" min="0.25" max="24" required></div>
              <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime"> Overtime</label></div>
              <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
            </div>
            <details style="margin-top:0.5rem">
              <summary class="summary-link">＋ Attach evidence (optional)</summary>
              <div class="grid" style="margin-top:0.5rem">
                <div><label>Kind</label>
                  <select name="ev_kind" class="ev-kind">
                    <option value="">— none —</option>
                    <option value="file">File</option>
                    <option value="link">Link</option>
                  </select>
                </div>
                <div style="flex:1"><label>Caption</label><input name="ev_caption"></div>
                <div class="full ev-file" hidden><label>File</label><input type="file" name="ev_file"></div>
                <div class="full ev-url"  hidden><label>URL</label><input type="url" name="ev_url" placeholder="https://…"></div>
              </div>
            </details>
            <p class="muted" style="margin:0.7rem 0 0.3rem"><span class="pill approved">As an admin, this entry will be saved as approved and skip the review queue.</span></p>
            <div class="actions" style="margin-top:0.3rem"><button class="small">Save labour</button></div>
          </form>
        </div>
      </div>
      <div class="card compact">
        <div class="card-head">
          <h2>Submit expense</h2>
          <button id="behalf-expense-toggle" class="secondary small">＋ New</button>
        </div>
        <div id="behalf-expense-form" hidden>
          <form id="form-behalf-expense">
            <div class="grid">
              <div class="full"><label>Employee</label>
                <select name="user_claimant_id" required>${employeeOpts}</select>
              </div>
              <div><label>Date</label><input type="date" name="expense_date" required></div>
              <div><label>Category</label>
                <select name="category">
                  <option value="material">material</option>
                  <option value="contract">contract</option>
                  <option value="third_party_payment">third-party payment</option>
                  <option value="overhead">overhead</option>
                </select>
              </div>
              <div><label>Amount <span class="muted">(${esc(reportingCcy)})</span></label><input type="number" step="0.01" name="amount" min="0" placeholder="e.g. 1234.56" required></div>
              <div><label>Currency</label><input name="currency" value="${esc(reportingCcy)}" required></div>
              <div><label>FX rate (if not ${esc(reportingCcy)})</label><input type="number" step="0.0001" name="fx_rate"></div>
              <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
            </div>
            <details style="margin-top:0.5rem" open>
              <summary class="summary-link">＋ Attach receipt (optional, strongly encouraged)</summary>
              <div class="grid" style="margin-top:0.5rem">
                <div style="flex:1"><label>Caption</label><input name="receipt_caption" placeholder="e.g. Invoice #INV-..."></div>
                <div class="full"><label>File</label><input type="file" name="receipt_file"></div>
              </div>
            </details>
            <p class="muted" style="margin:0.7rem 0 0.3rem"><span class="pill approved">As an admin, this entry will be saved as approved and skip the review queue.</span></p>
            <div class="actions" style="margin-top:0.3rem"><button class="small">Save expense</button></div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function bindLogOnBehalfForms(project, ctx) {
  const lTog = document.getElementById('behalf-labour-toggle');
  const lForm = document.getElementById('behalf-labour-form');
  if (lTog && lForm) lTog.addEventListener('click', () => { lForm.hidden = !lForm.hidden; });
  const eTog = document.getElementById('behalf-expense-toggle');
  const eForm = document.getElementById('behalf-expense-form');
  if (eTog && eForm) eTog.addEventListener('click', () => { eForm.hidden = !eForm.hidden; });

  const labourFormEl = document.getElementById('form-behalf-labour');
  if (labourFormEl) {
    bindEvidenceKindToggle(labourFormEl);
    onSubmit(labourFormEl, async fd => {
      const entry = await api('POST', '/api/labour', {
        project_id: project.id,
        user_claimant_id: Number(fd.get('user_claimant_id')),
        work_date: fd.get('work_date'),
        hours: Number(fd.get('hours')),
        description: fd.get('description'),
        is_overtime: fd.get('is_overtime') === 'on',
      });
      await attachInlineEvidence(fd, { project_id: entry.project_id, labour_entry_id: entry.id, evidence_date: entry.work_date });
      ctx.render();
    });
  }

  onSubmit(document.getElementById('form-behalf-expense'), async fd => {
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 1234.56).');
    const body = {
      project_id: project.id,
      user_claimant_id: Number(fd.get('user_claimant_id')),
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: amountCents,
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    if (fx) body.fx_rate = Number(fx);
    const entry = await api('POST', '/api/expenses', body);
    await attachInlineReceipt(fd, { project_id: entry.project_id, expense_id: entry.id, evidence_date: entry.expense_date });
    ctx.render();
  });
}

function renderAssignForm(project, users) {
  const activeUcIds = new Set(project.assignments.filter(a => a.status === 'active').map(a => a.user_claimant_id));
  const candidates = (users ?? []).filter(u =>
    u.user_claimant_id && !activeUcIds.has(u.user_claimant_id) && u.attachment_status === 'active'
  );
  if (candidates.length === 0) {
    return `<div id="assign-form" hidden style="margin-bottom:0.6rem">
      <p class="muted" style="font-size:0.88rem">Every active employee attached to this claimant is already assigned. Add an employee to the claimant from the Employees tab to widen the pool.</p>
    </div>`;
  }
  return `<div id="assign-form" hidden style="margin-bottom:0.6rem">
    <form id="form-assign" class="row" style="gap:0.5rem; align-items:flex-end">
      <div class="input-grow"><label>Employee</label>
        <select name="user_claimant_id" required>
          ${candidates.map(u =>
            `<option value="${u.user_claimant_id}">${esc(u.name)} (${esc(u.role)})</option>`).join('')}
        </select>
      </div>
      <div><button class="small">Assign</button></div>
    </form>
  </div>`;
}

function bindAssignmentForm(project, ctx) {
  const tg   = document.getElementById('assign-toggle');
  const form = document.getElementById('assign-form');
  if (tg && form) tg.addEventListener('click', () => { form.hidden = !form.hidden; });

  onSubmit(document.getElementById('form-assign'), async fd => {
    await api('POST', `/api/projects/${project.id}/assignments`, {
      user_claimant_id: Number(fd.get('user_claimant_id')),
    });
    ctx.render();
  });

  document.querySelectorAll('[data-unassign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${btn.dataset.name} from this project? Historical labour stays intact.`)) return;
      try {
        await api('DELETE', `/api/projects/${project.id}/assignments/${btn.dataset.unassign}`);
        ctx.render();
      } catch (err) { alert(err.message); }
    });
  });
  document.querySelectorAll('[data-reassign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/projects/${project.id}/assignments`, {
          user_claimant_id: Number(btn.dataset.reassign),
        });
        ctx.render();
      } catch (err) { alert(err.message); }
    });
  });
}
