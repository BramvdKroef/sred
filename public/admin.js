import { api, $, esc, cents, currentWeek, weekBars, chartHtml, activityHtml,
         attachInlineEvidence, attachInlineReceipt, bindEvidenceKindToggle } from './api.js';

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
};

export function renderAdmin(ctx) {
  state.me = ctx.me;
  state.signOut = ctx.signOut;
  shell();
  reloadAll();
}

const ALLOWED_TABS = ['overview', 'claimants', 'users', 'review', 'exports', 'audit'];

const TYPE_LABEL  = { sred: 'SR&ED', internal: 'Internal' };
const PHASE_LABEL = { concept: 'Concept', development: 'Development', complete: 'Complete' };

function parseHash() {
  const raw = location.hash.slice(1);
  const [tab, ...rest] = raw.split('/');
  const projectId = rest[0] ? Number(rest[0]) : null;
  return { tab, projectId: Number.isInteger(projectId) ? projectId : null };
}

function shell() {
  const { tab, projectId } = parseHash();
  if (ALLOWED_TABS.includes(tab)) {
    state.tab = tab;
    state.viewingProjectId = (tab === 'claimants') ? projectId : null;
  } else {
    location.hash = state.tab;   // canonicalize URL to match the default
  }

  $('#app').innerHTML = `
    <header>
      <h1>Precision <strong>SR&amp;ED</strong></h1>
      <div class="user">
        <strong>${esc(state.me.user.name)}</strong>
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
  const { tab, projectId } = parseHash();
  if (!ALLOWED_TABS.includes(tab)) return;
  const nextProject = (tab === 'claimants') ? projectId : null;
  if (tab === state.tab && nextProject === state.viewingProjectId) return;
  state.tab = tab;
  state.viewingProjectId = nextProject;
  render();
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
  if (state.tab === 'overview') return renderOverviewTab(main);
  if (state.tab === 'claimants' && state.viewingProjectId) return renderProjectDetail(main);
  if (state.tab === 'claimants') main.innerHTML = renderClaimantsTab();
  else if (state.tab === 'users') main.innerHTML = renderUsersTab();
  else if (state.tab === 'review') return renderReviewTab(main);
  else if (state.tab === 'exports') return renderExportsTab(main);
  else if (state.tab === 'audit') return renderAuditLogTab(main);
  bindCommon();
}

// --- Audit log tab ----------------------------------------------------------

async function renderAuditLogTab(main) {
  main.innerHTML = '<p class="empty">Loading audit log…</p>';
  const f = state.auditFilter ?? {};
  const qs = new URLSearchParams();
  if (f.entity_type) qs.set('entity_type', f.entity_type);
  if (f.action)      qs.set('action', f.action);
  qs.set('limit', f.limit ?? '100');
  const data = await api('GET', '/api/audit-log?' + qs);

  main.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Audit log <span class="muted" style="font-size:0.85rem; font-weight:500">${data.items.length} most recent</span></h2>
        <div class="row" style="gap:0.4rem">
          <select id="audit-entity-filter">
            <option value="">all entities</option>
            ${data.facets.entity_types.map(t =>
              `<option value="${t}" ${f.entity_type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <select id="audit-action-filter">
            <option value="">all actions</option>
            ${data.facets.actions.map(a =>
              `<option value="${a}" ${f.action === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
        </div>
      </div>
      ${data.items.length === 0 ? '<p class="empty">No events.</p>' : `
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Summary</th></tr></thead>
          <tbody>${data.items.map(renderAuditRow).join('')}</tbody>
        </table>`}
    </div>
  `;
  document.getElementById('audit-entity-filter').addEventListener('change', e => {
    state.auditFilter = { ...(state.auditFilter ?? {}), entity_type: e.target.value || undefined };
    render();
  });
  document.getElementById('audit-action-filter').addEventListener('change', e => {
    state.auditFilter = { ...(state.auditFilter ?? {}), action: e.target.value || undefined };
    render();
  });
  document.querySelectorAll('[data-toggle-audit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const details = document.getElementById(`audit-details-${btn.dataset.toggleAudit}`);
      details.hidden = !details.hidden;
      btn.textContent = details.hidden ? 'details' : 'hide';
    });
  });
}

function renderAuditRow(it) {
  const before = it.before_json ? JSON.parse(it.before_json) : null;
  const after  = it.after_json  ? JSON.parse(it.after_json)  : null;
  let summary;
  if (!before && after)       summary = '<span class="muted">created</span>';
  else if (before && !after)  summary = '<span class="muted">deleted</span>';
  else if (before && after) {
    const changes = [];
    for (const k of Object.keys({ ...before, ...after })) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes.push(k);
    }
    summary = changes.length
      ? `<span class="muted">changed:</span> ${changes.slice(0, 5).map(esc).join(', ')}${changes.length > 5 ? '…' : ''}`
      : '<span class="muted">(no field changes)</span>';
  } else {
    summary = '<span class="muted">—</span>';
  }
  return `
    <tr>
      <td class="when">${esc(it.created_at)}</td>
      <td>${esc(it.actor_name ?? '(system)')}</td>
      <td><span class="pill">${esc(it.action)}</span></td>
      <td>${esc(it.entity_type)} #${it.entity_id}</td>
      <td>${summary}
        <button class="small secondary" data-toggle-audit="${it.id}" style="margin-left:0.4rem">details</button>
        <pre id="audit-details-${it.id}" class="json" hidden>${esc(JSON.stringify({ before, after }, null, 2))}</pre>
      </td>
    </tr>
  `;
}

// --- Overview tab ----------------------------------------------------------

async function renderOverviewTab(main) {
  main.innerHTML = '<p class="empty">Loading overview…</p>';
  const week = currentWeek();
  const [weekLabour, pendingLab, pendingExp, activity] = await Promise.all([
    api('GET', `/api/labour?from=${week.from}&to=${week.to}`),
    api('GET', '/api/labour?status=pending'),
    api('GET', '/api/expenses?status=pending'),
    api('GET', '/api/activity?limit=15'),
  ]);
  const nonRejected = weekLabour.items.filter(l => l.status !== 'rejected');
  const totalHours = nonRejected.reduce((s, e) => s + e.hours, 0);
  const bars = weekBars(nonRejected, week.days);
  const contributors = new Set(nonRejected.map(l => l.user_claimant_id)).size;
  main.innerHTML = `
    <div class="card">
      <h2>This week — ${esc(week.from)} → ${esc(week.to)}</h2>
      <div class="metrics">
        <div><div class="metric">${totalHours.toFixed(2)}</div><div class="muted">hours logged (all employees)</div></div>
        <div><div class="metric">${contributors}</div><div class="muted">contributor${contributors === 1 ? '' : 's'}</div></div>
        <div><div class="metric">${pendingLab.items.length}</div><div class="muted">pending labour</div></div>
        <div><div class="metric">${pendingExp.items.length}</div><div class="muted">pending expenses</div></div>
      </div>
      ${chartHtml(bars)}
      <p class="muted" style="margin-top:0.75rem">Hover a bar for the exact total. Rejected entries are excluded.</p>
    </div>
    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true })}
    </div>
  `;
}

// --- Claimants & projects tab ----------------------------------------------

function renderClaimantsTab() {
  return `
    <div class="two-up">
      <div class="card compact">
        <div class="card-head">
          <h2>Claimant</h2>
          <div class="row" style="gap:0.3rem">
            ${state.claimantId ? '<button id="edit-claimant-toggle" class="secondary small">✎ Edit</button>' : ''}
            <button id="new-claimant-toggle" class="secondary small">＋ New</button>
          </div>
        </div>
        <select id="claimant-pick" style="width: 100%">
          <option value="">— select —</option>
          ${state.claimants.map(c =>
            `<option value="${c.id}" ${c.id === state.claimantId ? 'selected' : ''}>${esc(c.legal_name)}</option>`).join('')}
        </select>
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
        ${state.claimantId ? renderEditClaimantForm(state.claimants.find(c => c.id === state.claimantId)) : ''}
      </div>
      <div class="card compact">
        <div class="card-head">
          <h2>Fiscal periods</h2>
          ${state.claimantId ? '<button id="new-period-toggle" class="secondary small">＋ Add</button>' : ''}
        </div>
        ${state.claimantId
          ? renderPeriodsTable() + (() => {
              const c = state.claimants.find(c => c.id === state.claimantId);
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
          : '<p class="empty">Pick a claimant.</p>'}
      </div>
    </div>
    ${state.claimantId ? renderProjectsAndUsers() : '<p class="empty">Pick or create a claimant to continue.</p>'}
  `;
}

function renderProjectsAndUsers() {
  return `
    <div class="card">
      <div class="card-head">
        <h2>Projects</h2>
        <button id="new-project-toggle" class="secondary small">＋ New project</button>
      </div>
      ${renderProjectsTable()}
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
            <div><label>Phase</label>
              <select name="phase">
                <option value="concept" selected>Concept</option>
                <option value="development">Development</option>
                <option value="complete">Complete</option>
              </select>
            </div>
            <div><label>Manager</label>
              <select name="manager_user_id">
                <option value="">— none —</option>
                ${state.managers.map(u =>
                  `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join('')}
              </select>
            </div>
            <div><label>Field of science</label><input name="field_of_science" placeholder="e.g. Computer science"></div>
            <div><label>Start date</label><input type="date" name="start_date" required></div>
            <div><label>Status</label>
              <select name="status"><option>planned</option><option selected>active</option><option>completed</option></select>
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
      ${renderUsersUnderClaimantTable()}
    </div>
  `;
}

function renderPeriodsTable() {
  if (!state.periods.length) return '<p class="empty">No periods yet.</p>';
  return `<table>
    <thead><tr><th>Start</th><th>End</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${state.periods.map(p => `
      <tr>
        <td>${esc(p.start_date)}</td>
        <td>${esc(p.end_date)}</td>
        <td><span class="pill ${p.status}">${esc(p.status)}</span></td>
        <td class="actions">
          ${p.status === 'open'
            ? `<button class="secondary small" data-act="close-period" data-id="${p.id}">Close</button>`
            : `<button class="secondary small" data-act="reopen-period" data-id="${p.id}">Reopen</button>`}
        </td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderProjectsTable() {
  if (!state.projects.length) return '<p class="empty">No projects yet.</p>';
  return `<table class="rows-clickable">
    <thead><tr><th>Title</th><th>Type</th><th>Phase</th><th>Field</th><th>Start</th><th>Status</th></tr></thead>
    <tbody>${state.projects.map(p => `
      <tr data-open-project="${p.id}">
        <td><strong>${esc(p.title)}</strong></td>
        <td><span class="pill kind-${esc(p.type)}">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></td>
        <td><span class="pill phase-${esc(p.phase)}">${esc(PHASE_LABEL[p.phase] ?? p.phase)}</span></td>
        <td>${esc(p.field_of_science ?? '—')}</td>
        <td>${esc(p.start_date)}</td>
        <td><span class="pill">${esc(p.status)}</span></td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderUsersUnderClaimantTable() {
  if (!state.users.length) return '<p class="empty">No users attached to this claimant yet. Invite from the Users tab.</p>';
  return `<table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${state.users.map(u => `
      <tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td><span class="pill ${u.status === 'active' ? 'open' : 'pending'}">${esc(u.status)}</span></td>
      </tr>`).join('')}
    </tbody></table>`;
}

// --- Edit user (inline expansion under the All employees table) -----------

function renderUserEditForm(u) {
  const isSelf = u.id === state.me.user.id;
  const ROLES = ['employee', 'manager', 'admin'];
  const claimantOpts = state.claimants
    .map(c => `<option value="${c.id}">${esc(c.legal_name)}</option>`).join('');
  return `
    <div class="card compact" style="margin: 0.5rem 0">
      <h3 style="margin-top:0">Edit ${esc(u.name)}</h3>

      <form data-form="user-fields" data-user="${u.id}">
        <div class="grid">
          <div><label>Name</label><input name="name" required value="${esc(u.name)}"></div>
          <div><label>Role${isSelf ? ' (locked — you)' : ''}</label>
            <select name="role" ${isSelf ? 'disabled' : ''}>
              ${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="actions"><button class="small">Save user fields</button></div>
      </form>

      <h3>Attachments</h3>
      ${u.attachments.length === 0
        ? '<p class="empty">Not attached to any claimant.</p>'
        : u.attachments.map(a => renderAttachmentEditor(a)).join('')}

      <h3>Add attachment</h3>
      <form data-form="add-attachment" data-user="${u.id}">
        <div class="grid">
          <div><label>Claimant</label><select name="claimant_id" required>${claimantOpts}</select></div>
          <div><label>Title</label><input name="title"></div>
          <div><label>Comp type</label>
            <select name="comp_type"><option>salary</option><option>hourly</option></select>
          </div>
          <div><label>Amount (¢)</label><input type="number" name="amount_cents" min="1" required></div>
          <div><label>Effective from</label><input type="date" name="effective_from" required></div>
          <div><label><input type="checkbox" name="is_specified_employee" style="width:auto"> Specified</label></div>
        </div>
        <div class="actions"><button class="small">Add attachment</button></div>
      </form>
    </div>
  `;
}

function renderAttachmentEditor(a) {
  const compHistory = (a.compensation_history ?? []).map(r =>
    `<li>${esc(r.effective_from)} · ${esc(r.comp_type)} · ${cents(r.amount_cents)} (${r.hours_per_year} h/yr)</li>`
  ).join('');
  return `
    <div class="card" style="background: #f8fafc; padding: 0.75rem 1rem; margin: 0.5rem 0">
      <form data-form="uc-fields" data-uc="${a.id}">
        <div class="row" style="gap:0.6rem; align-items:flex-end; flex-wrap:wrap">
          <div style="flex:1; min-width:14rem">
            <label>${esc(a.claimant_name)} · attachment ${a.id}</label>
            <input name="title" placeholder="Title" value="${esc(a.title ?? '')}">
          </div>
          <div><label style="display:flex; align-items:center; gap:0.4rem; text-transform:none; letter-spacing:0; color:var(--text); font-weight:500"><input type="checkbox" name="is_specified_employee" style="width:auto" ${a.is_specified_employee ? 'checked' : ''}> Specified</label></div>
          <div><label>Status</label>
            <select name="status">
              <option ${a.status === 'active' ? 'selected' : ''}>active</option>
              <option ${a.status === 'inactive' ? 'selected' : ''}>inactive</option>
            </select>
          </div>
          <div><button class="small">Save</button></div>
        </div>
      </form>
      <details style="margin-top:0.5rem">
        <summary class="muted" style="cursor:pointer; font-size:0.85rem">Compensation history (${(a.compensation_history ?? []).length})</summary>
        <ul style="font-size:0.85rem; margin:0.4rem 0 0.6rem 1rem">${compHistory || '<li class="empty">none</li>'}</ul>
        <form data-form="add-comp" data-uc="${a.id}">
          <div class="row" style="gap:0.5rem; align-items:flex-end">
            <div><label>Type</label><select name="comp_type"><option>salary</option><option>hourly</option></select></div>
            <div><label>Amount (¢)</label><input type="number" name="amount_cents" min="1" required style="width:8rem"></div>
            <div><label>Effective from</label><input type="date" name="effective_from" required></div>
            <div><button class="small secondary">＋ Add comp row</button></div>
          </div>
        </form>
      </details>
    </div>
  `;
}

function bindUserEditForm(bundle, row) {
  row.querySelector('[data-form="user-fields"]').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await api('PATCH', `/api/users/${bundle.id}`, {
        name: fd.get('name'),
        role: fd.get('role') || undefined,   // disabled-on-self → null → not sent
      });
      allUsers = (await api('GET', '/api/users')).items;
      redrawAllUsers();
    } catch (err) { alert(err.message); }
  });

  row.querySelectorAll('[data-form="uc-fields"]').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      const ucId = form.dataset.uc;
      try {
        await api('PATCH', `/api/user-claimants/${ucId}`, {
          title: fd.get('title') || null,
          is_specified_employee: fd.get('is_specified_employee') === 'on',
          status: fd.get('status'),
        });
        // Re-render the form with fresh data
        const fresh = await api('GET', `/api/users/${bundle.id}`);
        row.querySelector('td').innerHTML = renderUserEditForm(fresh);
        bindUserEditForm(fresh, row);
      } catch (err) { alert(err.message); }
    });
  });

  row.querySelectorAll('[data-form="add-comp"]').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      const ucId = form.dataset.uc;
      try {
        await api('POST', `/api/user-claimants/${ucId}/compensation`, {
          comp_type: fd.get('comp_type'),
          amount_cents: Number(fd.get('amount_cents')),
          effective_from: fd.get('effective_from'),
        });
        const fresh = await api('GET', `/api/users/${bundle.id}`);
        row.querySelector('td').innerHTML = renderUserEditForm(fresh);
        bindUserEditForm(fresh, row);
      } catch (err) { alert(err.message); }
    });
  });

  const addAttach = row.querySelector('[data-form="add-attachment"]');
  if (addAttach) addAttach.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(addAttach);
    try {
      await api('POST', `/api/users/${bundle.id}/attachments`, {
        claimant_id: Number(fd.get('claimant_id')),
        title: fd.get('title') || null,
        is_specified_employee: fd.get('is_specified_employee') === 'on',
        compensation: {
          comp_type: fd.get('comp_type'),
          amount_cents: Number(fd.get('amount_cents')),
          effective_from: fd.get('effective_from'),
        },
      });
      const fresh = await api('GET', `/api/users/${bundle.id}`);
      row.querySelector('td').innerHTML = renderUserEditForm(fresh);
      bindUserEditForm(fresh, row);
    } catch (err) { alert(err.message); }
  });
}

// --- Project detail subview ------------------------------------------------

async function renderProjectDetail(main) {
  main.innerHTML = '<p class="empty">Loading project…</p>';
  const projectId = state.viewingProjectId;
  const [project, activity] = await Promise.all([
    api('GET', `/api/projects/${projectId}`),
    api('GET', `/api/activity?project_id=${projectId}&limit=25`),
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
      <div class="row" style="gap:1rem; color: var(--text-muted); font-size: 0.9rem">
        <span><strong style="color:var(--text)">${esc(claimant?.legal_name ?? '')}</strong></span>
        <span class="pill kind-${esc(project.type)}">${esc(TYPE_LABEL[project.type] ?? project.type)}</span>
        <span class="pill phase-${esc(project.phase)}">${esc(PHASE_LABEL[project.phase] ?? project.phase)}</span>
        <span>${esc(project.field_of_science ?? '—')}</span>
        <span>Started ${esc(project.start_date)}${project.end_date ? ` → ${esc(project.end_date)}` : ''}</span>
        <span>Manager: <strong style="color:var(--text)">${project.manager ? esc(project.manager.name) : '—'}</strong></span>
      </div>
    </div>

    ${renderEditProjectForm(project)}

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
      <h2>Assigned employees (${project.assignments.length})</h2>
      ${project.assignments.length === 0
        ? '<p class="empty">No assignments yet.</p>'
        : `<table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th></tr></thead>
            <tbody>${project.assignments.map(a => `
              <tr>
                <td>${esc(a.name)}</td>
                <td>${esc(a.email)}</td>
                <td><span class="pill ${a.status === 'active' ? 'open' : 'closed'}">${esc(a.status)}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>`}
    </div>

    ${renderLogOnBehalfCards(project, claimant)}

    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true, showProject: false })}
    </div>
  `;
  document.getElementById('back-to-projects').addEventListener('click', e => {
    e.preventDefault();
    location.hash = 'claimants';
  });
  bindEditProjectForm(project);
  bindLogOnBehalfForms(project);
}

// Smart defaults for the "Add period" form. If the claimant already has
// periods, suggest the next one in sequence (start = last_end + 1 day,
// end = +1 year). Otherwise use the next fiscal-year-end on or after today.
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

function renderEditProjectForm(project) {
  const managerOpts = state.managers.map(u =>
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
          <div><label>Phase</label>
            <select name="phase">
              <option value="concept" ${selected(project.phase,'concept')}>Concept</option>
              <option value="development" ${selected(project.phase,'development')}>Development</option>
              <option value="complete" ${selected(project.phase,'complete')}>Complete</option>
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
              <option ${selected(project.status,'planned')}>planned</option>
              <option ${selected(project.status,'active')}>active</option>
              <option ${selected(project.status,'completed')}>completed</option>
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

function bindEditProjectForm(project) {
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

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const managerRaw = fd.get('manager_user_id');
    const endDate = fd.get('end_date');
    try {
      await api('PATCH', `/api/projects/${project.id}`, {
        title: fd.get('title'),
        field_of_science: fd.get('field_of_science') || null,
        start_date: fd.get('start_date'),
        end_date: endDate || null,
        status: fd.get('status'),
        type: fd.get('type'),
        phase: fd.get('phase'),
        manager_user_id: managerRaw ? Number(managerRaw) : null,
        advancement_sought: fd.get('advancement_sought') || null,
        uncertainties: fd.get('uncertainties') || null,
        work_performed: fd.get('work_performed') || null,
      });
      // Refresh state.projects too so the list view (when user goes back) is current.
      await reloadAll();
    } catch (err) {
      alert(err.message);
    }
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
              <div><label>&nbsp;</label><label style="display:flex; align-items:center; gap:0.4rem; font-size:0.92rem; text-transform:none; letter-spacing:0; color:var(--text); font-weight:500"><input type="checkbox" name="is_overtime" style="width:auto"> Overtime</label></div>
              <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
            </div>
            <details style="margin-top:0.5rem">
              <summary style="cursor:pointer; font-size:0.85rem; color:var(--brand); font-weight:600">＋ Attach evidence (optional)</summary>
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
            <div class="actions" style="margin-top:0.6rem"><button class="small">Save labour</button></div>
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
              <div><label>Amount (cents)</label><input type="number" name="amount_cents" min="1" required></div>
              <div><label>Currency</label><input name="currency" value="${esc(reportingCcy)}" required></div>
              <div><label>FX rate (if not ${esc(reportingCcy)})</label><input type="number" step="0.0001" name="fx_rate"></div>
              <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
            </div>
            <details style="margin-top:0.5rem" open>
              <summary style="cursor:pointer; font-size:0.85rem; color:var(--brand); font-weight:600">＋ Attach receipt (optional, strongly encouraged)</summary>
              <div class="grid" style="margin-top:0.5rem">
                <div style="flex:1"><label>Caption</label><input name="receipt_caption" placeholder="e.g. Invoice #INV-..."></div>
                <div class="full"><label>File</label><input type="file" name="receipt_file"></div>
              </div>
            </details>
            <div class="actions" style="margin-top:0.6rem"><button class="small">Save expense</button></div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function bindLogOnBehalfForms(project) {
  const lTog = document.getElementById('behalf-labour-toggle');
  const lForm = document.getElementById('behalf-labour-form');
  if (lTog && lForm) lTog.addEventListener('click', () => { lForm.hidden = !lForm.hidden; });
  const eTog = document.getElementById('behalf-expense-toggle');
  const eForm = document.getElementById('behalf-expense-form');
  if (eTog && eForm) eTog.addEventListener('click', () => { eForm.hidden = !eForm.hidden; });

  const labourFormEl = document.getElementById('form-behalf-labour');
  if (labourFormEl) {
    bindEvidenceKindToggle(labourFormEl);
    labourFormEl.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(labourFormEl);
      try {
        const entry = await api('POST', '/api/labour', {
          project_id: project.id,
          user_claimant_id: Number(fd.get('user_claimant_id')),
          work_date: fd.get('work_date'),
          hours: Number(fd.get('hours')),
          description: fd.get('description'),
          is_overtime: fd.get('is_overtime') === 'on',
        });
        await attachInlineEvidence(fd, { project_id: entry.project_id, labour_entry_id: entry.id, evidence_date: entry.work_date });
        render();
      } catch (err) { alert(err.message); }
    });
  }

  const expenseFormEl = document.getElementById('form-behalf-expense');
  if (expenseFormEl) expenseFormEl.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(expenseFormEl);
    const body = {
      project_id: project.id,
      user_claimant_id: Number(fd.get('user_claimant_id')),
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: Number(fd.get('amount_cents')),
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    if (fx) body.fx_rate = Number(fx);
    try {
      const entry = await api('POST', '/api/expenses', body);
      await attachInlineReceipt(fd, { project_id: entry.project_id, expense_id: entry.id, evidence_date: entry.expense_date });
      render();
    } catch (err) { alert(err.message); }
  });
}

// --- Users tab -------------------------------------------------------------

function renderUsersTab() {
  const claimantOpts = state.claimants
    .map(c => `<option value="${c.id}" ${c.id === state.claimantId ? 'selected' : ''}>${esc(c.legal_name)}</option>`)
    .join('');
  return `
    <div class="card">
      <h2>Add employee</h2>
      <form id="add-employee-form">
        <div class="grid">
          <div><label>Email</label><input name="email" type="email" required
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
          <div><label>Name</label><input name="name" required
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
          <div><label>Role</label>
            <select name="role">
              <option value="employee" selected>Employee</option>
              <option value="manager">Manager</option>
            </select>
          </div>
          <div><label>Claimant</label><select name="claimant_id">${claimantOpts}</select></div>
          <div><label>Comp type</label>
            <select name="comp_type"><option>salary</option><option>hourly</option></select>
          </div>
          <div><label>Amount (¢/yr or ¢/hr)</label><input name="amount_cents" type="number" min="1" required></div>
          <div><label>Effective from</label><input name="effective_from" type="date" required></div>
          <div><label><input name="is_specified_employee" type="checkbox"> Specified employee</label></div>
        </div>
        <div class="actions"><button>Add</button></div>
        <p class="muted">Creates the employee record only. Click <strong>Send invite</strong> in the table below to email them a passkey enrollment link when ready.</p>
      </form>
    </div>
    <div class="card">
      <h2>All employees</h2>
      ${renderAllUsersTable()}
    </div>
  `;
}

let allUsers = [];
function renderAllUsersTable() {
  // Kick off an async refresh; render a placeholder synchronously so it can
  // be embedded in a template literal without the Promise stringifying.
  api('GET', '/api/users').then(r => { allUsers = r.items; redrawAllUsers(); });
  return '<div id="all-users-table"><p class="empty">Loading…</p></div>';
}
function redrawAllUsers() {
  const el = document.getElementById('all-users-table');
  if (!el) return;
  el.innerHTML = !allUsers.length ? '<p class="empty">No users yet.</p>' : `
    <table>
      <thead><tr><th>ID</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${allUsers.map(u => `
        <tr>
          <td>${u.id}</td>
          <td>${esc(u.email)}</td>
          <td>${esc(u.name)}</td>
          <td>${esc(u.role)}</td>
          <td><span class="pill ${u.status === 'active' ? 'open' : (u.status === 'pending' ? 'pending' : 'closed')}">${esc(u.status)}</span></td>
          <td class="actions">
            <button class="small secondary" data-edit-user="${u.id}">Edit</button>
            ${u.status === 'disabled'
              ? `<button class="small secondary" data-act-user="reactivate" data-id="${u.id}">Reactivate</button>`
              : `<button class="small secondary" data-enroll="${u.id}">${u.status === 'pending' ? 'Send invite' : 'Add device'}</button>
                 ${u.id === state.me.user.id
                   ? ''
                   : `<button class="small danger" data-act-user="deactivate" data-id="${u.id}" data-name="${esc(u.name)}">Deactivate</button>`}`}
          </td>
        </tr>
        <tr id="user-edit-row-${u.id}" hidden><td colspan="6"></td></tr>`).join('')}
      </tbody>
    </table>`;
  el.querySelectorAll('[data-edit-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.editUser);
      const cell = document.querySelector(`#user-edit-row-${id} td`);
      const row  = document.getElementById(`user-edit-row-${id}`);
      if (!row.hidden) { row.hidden = true; return; }
      cell.innerHTML = '<p class="muted">Loading…</p>';
      row.hidden = false;
      try {
        const bundle = await api('GET', `/api/users/${id}`);
        cell.innerHTML = renderUserEditForm(bundle);
        bindUserEditForm(bundle, row);
      } catch (e) { cell.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    });
  });
  el.querySelectorAll('[data-enroll]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.enroll;
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/users/${id}/invite`);
        alert(`Magic link (also emailed):\n\n${r.magic_link}\n\nPurpose: ${r.purpose}\nExpires: ${r.expires_at}`);
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
  el.querySelectorAll('[data-act-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.actUser;
      if (act === 'deactivate') {
        const name = btn.dataset.name || 'this user';
        if (!confirm(`Deactivate ${name}? They will be blocked from signing in and removed from all claimant rosters. Historical labour/expense/evidence rows remain.`)) return;
      }
      btn.disabled = true;
      try {
        await api('POST', `/api/users/${id}/${act}`);
        allUsers = (await api('GET', '/api/users')).items;
        redrawAllUsers();
        // Also refresh the per-claimant attached-users panel if visible.
        if (state.tab === 'users') await reloadAll();
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// --- Review tab ------------------------------------------------------------

async function renderReviewTab(main) {
  main.innerHTML = '<p class="empty">Loading review queue…</p>';
  const params = state.claimantId ? '' : '';
  const periodFilter = '';
  const [labour, expenses] = await Promise.all([
    api('GET', `/api/labour?status=pending${periodFilter}`),
    api('GET', `/api/expenses?status=pending${periodFilter}`),
  ]);
  state.pendingLabour = labour.items;
  state.pendingExpenses = expenses.items;
  main.innerHTML = `
    <div class="card">
      <h2>Pending labour (${state.pendingLabour.length})</h2>
      ${state.pendingLabour.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>UC</th><th>Hours</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${state.pendingLabour.map(e => `
          <tr>
            <td>${esc(e.work_date)}</td>
            <td>${e.project_id}</td>
            <td>${e.user_claimant_id}</td>
            <td>${e.hours}</td>
            <td>${esc(e.description)}</td>
            <td class="actions">
              <button class="small" data-act="approve-labour" data-id="${e.id}">Approve</button>
              <button class="small danger" data-act="reject-labour" data-id="${e.id}">Reject</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>Pending expenses (${state.pendingExpenses.length})</h2>
      ${state.pendingExpenses.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Category</th><th>Amount</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${state.pendingExpenses.map(e => `
          <tr>
            <td>${esc(e.expense_date)}</td>
            <td>${e.project_id}</td>
            <td>${esc(e.category)}</td>
            <td>${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td>${esc(e.description)}</td>
            <td class="actions">
              <button class="small" data-act="approve-expense" data-id="${e.id}">Approve</button>
              <button class="small danger" data-act="reject-expense" data-id="${e.id}">Reject</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `;
  bindCommon();
}

// --- Exports tab -----------------------------------------------------------

async function renderExportsTab(main) {
  if (!state.claimantId) { main.innerHTML = '<p class="empty">Select a claimant first.</p>'; return; }
  const periodOpts = state.periods
    .map(p => `<option value="${p.id}">${esc(p.start_date)} → ${esc(p.end_date)} (${p.status})</option>`).join('');
  const exports = (await api('GET', `/api/exports?claimant_id=${state.claimantId}`)).items;

  main.innerHTML = `
    <div class="card">
      <h2>Generate T661 export</h2>
      <form id="export-form" class="row">
        <select name="fiscal_period_id" required>${periodOpts}</select>
        <label><input type="checkbox" name="draft" checked> draft</label>
        <button>Generate</button>
      </form>
      <p class="muted">Draft means the period need not be closed.</p>
    </div>
    <div class="card">
      <h2>Exports for this claimant</h2>
      ${exports.length === 0 ? '<p class="empty">None yet.</p>' : `
      <table>
        <thead><tr><th>ID</th><th>Period</th><th>Draft</th><th>Generated</th><th>Download</th><th>Audit package</th></tr></thead>
        <tbody>${exports.map(x => `
          <tr>
            <td>${x.id}</td>
            <td>${x.fiscal_period_id}</td>
            <td>${x.is_draft ? 'yes' : 'no'}</td>
            <td>${esc(x.generated_at)}</td>
            <td>
              <a href="/api/exports/${x.id}/download?format=pdf" data-jwt-dl>pdf</a>
              · <a href="/api/exports/${x.id}/download?format=md" data-jwt-dl>md</a>
              · <a href="/api/exports/${x.id}/download?format=csv" data-jwt-dl>csv</a>
              · <a href="/api/exports/${x.id}/download?format=json" data-jwt-dl>json</a>
            </td>
            <td>
              ${x.bundle_path
                ? `<a href="/api/exports/${x.id}/evidence-package" data-jwt-dl>download zip</a>`
                : `<button class="small secondary" data-act="build-bundle" data-id="${x.id}">Build</button>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `;
  bindCommon();
}

// --- Event binding ---------------------------------------------------------

function bindCommon() {
  // Claimant selector
  const cp = document.getElementById('claimant-pick');
  if (cp) cp.addEventListener('change', e => {
    state.claimantId = Number(e.target.value) || null; reloadAll();
  });

  // Row-click → open project detail (drives hash; hashchange triggers render)
  document.querySelectorAll('[data-open-project]').forEach(tr => {
    tr.addEventListener('click', () => {
      location.hash = `claimants/${tr.dataset.openProject}`;
    });
  });

  // Toggle new-claimant / new-period / new-project / edit-claimant forms
  const toggles = [
    ['new-claimant-toggle',  'new-claimant-form'],
    ['new-period-toggle',    'new-period-form'],
    ['new-project-toggle',   'new-project-form'],
    ['edit-claimant-toggle', 'edit-claimant-form'],
  ];
  for (const [btnId, formId] of toggles) {
    const btn = document.getElementById(btnId);
    const form = document.getElementById(formId);
    if (btn && form) btn.addEventListener('click', () => { form.hidden = !form.hidden; });
  }
  const cancelClaim = document.getElementById('cancel-edit-claimant');
  if (cancelClaim) cancelClaim.addEventListener('click', () => {
    document.getElementById('edit-claimant-form').hidden = true;
  });

  bindForm('#form-edit-claimant', async fd => {
    const fye = (fd.get('fye') || '').split('-').map(Number);
    if (fye.length !== 2 || !fye[0] || !fye[1]) throw new Error('Fiscal year end must be MM-DD');
    await api('PATCH', `/api/claimants/${state.claimantId}`, {
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
    await api('POST', `/api/claimants/${state.claimantId}/periods`, {
      start_date: fd.get('start_date'),
      end_date: fd.get('end_date'),
    });
    await reloadAll();
  });

  bindForm('#project-form', async fd => {
    const managerRaw = fd.get('manager_user_id');
    await api('POST', `/api/claimants/${state.claimantId}/projects`, {
      title: fd.get('title'),
      field_of_science: fd.get('field_of_science') || null,
      start_date: fd.get('start_date'),
      status: fd.get('status'),
      type: fd.get('type'),
      phase: fd.get('phase'),
      manager_user_id: managerRaw ? Number(managerRaw) : null,
      advancement_sought: fd.get('advancement_sought') || null,
      uncertainties: fd.get('uncertainties') || null,
      work_performed: fd.get('work_performed') || null,
    });
    await reloadAll();
  });

  bindForm('#add-employee-form', async (fd, form) => {
    const body = {
      email: fd.get('email'),
      name: fd.get('name'),
      role: fd.get('role') || 'employee',
      attachments: [{
        claimant_id: Number(fd.get('claimant_id')),
        is_specified_employee: fd.get('is_specified_employee') === 'on',
        compensation: {
          comp_type: fd.get('comp_type'),
          amount_cents: Number(fd.get('amount_cents')),
          effective_from: fd.get('effective_from'),
        },
      }],
    };
    await api('POST', '/api/users', body);
    form.reset();
    await reloadAll();
  });

  bindForm('#export-form', async fd => {
    await api('POST', '/api/exports/t661', {
      claimant_id: state.claimantId,
      fiscal_period_id: Number(fd.get('fiscal_period_id')),
      draft: fd.get('draft') === 'on',
    });
    render();
  });

  // Generic action buttons
  document.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        switch (btn.dataset.act) {
          case 'close-period':    await api('POST', `/api/periods/${id}/close`); break;
          case 'reopen-period':   await api('POST', `/api/periods/${id}/reopen`); break;
          case 'approve-labour':  await api('POST', `/api/labour/${id}/approve`); break;
          case 'reject-labour': {
            const reason = prompt('Rejection reason?'); if (!reason) return;
            await api('POST', `/api/labour/${id}/reject`, { reason }); break;
          }
          case 'approve-expense': await api('POST', `/api/expenses/${id}/approve`); break;
          case 'reject-expense': {
            const reason = prompt('Rejection reason?'); if (!reason) return;
            await api('POST', `/api/expenses/${id}/reject`, { reason }); break;
          }
          case 'build-bundle':    await api('POST', `/api/exports/${id}/evidence-package`); break;
          case 'assign': {
            const ucId = prompt('user_claimant_id to assign?');
            if (!ucId) return;
            await api('POST', `/api/projects/${id}/assignments`, { user_claimant_id: Number(ucId) });
            break;
          }
        }
        render();
      } catch (e) { alert(e.message); }
    });
  });

  // JWT-authenticated downloads
  document.querySelectorAll('[data-jwt-dl]').forEach(a => {
    a.addEventListener('click', async e => {
      e.preventDefault();
      const r = await fetch(a.getAttribute('href'), { headers: { authorization: `Bearer ${sessionStorage.getItem('sred-jwt')}` } });
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const tmp = document.createElement('a');
      tmp.href = url;
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      tmp.download = m ? m[1] : 'download';
      tmp.click();
      URL.revokeObjectURL(url);
    });
  });
}

function bindForm(selector, handler) {
  const form = document.querySelector(selector);
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try { await handler(new FormData(form), form); }
    catch (err) { alert(err.message); }
  });
}
