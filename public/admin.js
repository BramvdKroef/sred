import { api, $, esc, cents, currentWeek, weekBars, chartHtml, activityHtml } from './api.js';

const state = {
  me: null,
  signOut: null,
  tab: 'overview',
  claimants: [],
  claimantId: null,
  periods: [],
  projects: [],
  users: [],
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

function shell() {
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
    </nav>
    <main id="main"></main>
  `;
  $('#signout').addEventListener('click', state.signOut);
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); });
  });
}

const tabBtn = (key, label) =>
  `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${esc(label)}</button>`;

async function reloadAll() {
  state.claimants = (await api('GET', '/api/claimants')).items;
  if (!state.claimantId && state.claimants[0]) state.claimantId = state.claimants[0].id;
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
  bindCommon();
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
          <button id="new-claimant-toggle" class="secondary small">＋ New</button>
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
      </div>
      <div class="card compact">
        <div class="card-head">
          <h2>Fiscal periods</h2>
          ${state.claimantId ? '<button id="new-period-toggle" class="secondary small">＋ Add</button>' : ''}
        </div>
        ${state.claimantId
          ? renderPeriodsTable() + `
              <div id="new-period-form" hidden style="margin-top: 0.6rem">
                <form id="period-form" class="row">
                  <input type="date" name="start_date" required>
                  <input type="date" name="end_date" required>
                  <button class="small">Add period</button>
                </form>
              </div>`
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
    <thead><tr><th>Title</th><th>Field</th><th>Start</th><th>Status</th></tr></thead>
    <tbody>${state.projects.map(p => `
      <tr data-open-project="${p.id}">
        <td><strong>${esc(p.title)}</strong></td>
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
        <span class="pill">${esc(project.status)}</span>
      </div>
      <div class="row" style="gap:1.5rem; color: var(--text-muted); font-size: 0.9rem">
        <span><strong style="color:var(--text)">${esc(claimant?.legal_name ?? '')}</strong></span>
        <span>${esc(project.field_of_science ?? '—')}</span>
        <span>Started ${esc(project.start_date)}${project.end_date ? ` → ${esc(project.end_date)}` : ''}</span>
      </div>
    </div>

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

    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true })}
    </div>
  `;
  document.getElementById('back-to-projects').addEventListener('click', e => {
    e.preventDefault();
    state.viewingProjectId = null;
    render();
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
            ${u.status === 'disabled'
              ? `<button class="small secondary" data-act-user="reactivate" data-id="${u.id}">Reactivate</button>`
              : `<button class="small secondary" data-enroll="${u.id}">${u.status === 'pending' ? 'Send invite' : 'Add device'}</button>
                 ${u.id === state.me.user.id
                   ? ''
                   : `<button class="small danger" data-act-user="deactivate" data-id="${u.id}" data-name="${esc(u.name)}">Deactivate</button>`}`}
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
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
              <a href="/api/exports/${x.id}/download?format=md" data-jwt-dl>md</a>
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

  // Row-click → open project detail
  document.querySelectorAll('[data-open-project]').forEach(tr => {
    tr.addEventListener('click', () => {
      state.viewingProjectId = Number(tr.dataset.openProject);
      render();
    });
  });

  // Toggle new-claimant / new-period / new-project forms
  const toggles = [
    ['new-claimant-toggle', 'new-claimant-form'],
    ['new-period-toggle',   'new-period-form'],
    ['new-project-toggle',  'new-project-form'],
  ];
  for (const [btnId, formId] of toggles) {
    const btn = document.getElementById(btnId);
    const form = document.getElementById(formId);
    if (btn && form) btn.addEventListener('click', () => { form.hidden = !form.hidden; });
  }

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
    await api('POST', `/api/claimants/${state.claimantId}/projects`, {
      title: fd.get('title'),
      field_of_science: fd.get('field_of_science') || null,
      start_date: fd.get('start_date'),
      status: fd.get('status'),
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
      role: 'employee',
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
