import { api, esc, cents, bindForm, onSubmit, activityHtml,
         wireActivityDetails, TYPE_LABEL, PHASE_LABEL } from '../api.js';

let allUsers = [];

export async function render(main, ctx) {
  if (ctx.state.viewingUserId) return renderUserDetail(main, ctx);
  main.innerHTML = renderUsersTab(ctx);
  bindList(ctx);
}

// --- List view (Add employee + All employees) ------------------------------

function renderUsersTab(ctx) {
  const claimantOpts = ctx.state.claimants
    .map(c => `<option value="${c.id}" ${c.id === ctx.state.activeClaimantId ? 'selected' : ''}>${esc(c.legal_name)}</option>`)
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

function renderAllUsersTable() {
  api('GET', '/api/users').then(r => { allUsers = r.items; redrawAllUsers(); });
  return '<div id="all-users-table"><p class="empty">Loading…</p></div>';
}

function redrawAllUsers(ctx) {
  // ctx may be undefined when called from the fetch callback in renderAllUsersTable;
  // we recover it via the currently-stashed value.
  ctx = ctx || currentCtx;
  const el = document.getElementById('all-users-table');
  if (!el) return;
  el.innerHTML = !allUsers.length ? '<p class="empty">No users yet.</p>' : `
    <table>
      <thead><tr><th>ID</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${allUsers.map(u => `
        <tr>
          <td>${u.id}</td>
          <td>${esc(u.email)}</td>
          <td><a href="#users/${u.id}"><strong>${esc(u.name)}</strong></a></td>
          <td>${esc(u.role)}</td>
          <td><span class="pill ${u.status === 'active' ? 'open' : (u.status === 'pending' ? 'pending' : 'closed')}">${esc(u.status)}</span></td>
          <td class="actions">
            <button class="small secondary" data-edit-user="${u.id}">Edit</button>
            ${u.status === 'disabled'
              ? `<button class="small secondary" data-act-user="reactivate" data-id="${u.id}">Reactivate</button>`
              : `<button class="small secondary" data-enroll="${u.id}">${u.status === 'pending' ? 'Send invite' : 'Add device'}</button>
                 ${u.id === ctx.state.me.user.id
                   ? ''
                   : `<button class="small danger" data-act-user="deactivate" data-id="${u.id}" data-name="${esc(u.name)}">Deactivate</button>`}`}
          </td>
        </tr>
        <tr id="user-edit-row-${u.id}" hidden><td colspan="6"></td></tr>`).join('')}
      </tbody>
    </table>`;
  bindUserRowActions(el, ctx);
}

let currentCtx;   // captured each time the list renders so the fetch callback can use it

function bindList(ctx) {
  currentCtx = ctx;

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
    await ctx.reloadAll();
  });
}

function bindUserRowActions(el, ctx) {
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
        cell.innerHTML = renderUserEditForm(bundle, ctx);
        bindUserEditForm(bundle, row, ctx);
      } catch (e) { cell.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    });
  });
  el.querySelectorAll('[data-enroll]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.enroll;
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/users/${id}/invite`);
        // The raw magic link is no longer returned by the API (it would let
        // any admin silently mint a sign-in link for another admin). Surface
        // delivery status instead. When SMTP is disabled the link is logged
        // to the server console.
        const target = allUsers.find(u => String(u.id) === String(id));
        const email = target?.email || 'the user';
        const where = r.delivered
          ? `Sent to ${email}`
          : 'Logged to server console (SMTP disabled)';
        alert(`${where}\n\nPurpose: ${r.purpose}\nExpires: ${r.expires_at}`);
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
        redrawAllUsers(ctx);
        if (ctx.state.tab === 'users') await ctx.reloadAll();
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// --- Edit user (inline expansion under the All employees table) -----------

function renderUserEditForm(u, ctx) {
  const isSelf = u.id === ctx.state.me.user.id;
  const ROLES = ['employee', 'manager', 'admin'];
  const claimantOpts = ctx.state.claimants
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
          <div><label><input type="checkbox" name="is_specified_employee"> Specified</label></div>
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
    <div class="sub-card">
      <form data-form="uc-fields" data-uc="${a.id}">
        <div class="row" style="gap:0.6rem; align-items:flex-end; flex-wrap:wrap">
          <div class="input-grow">
            <label>${esc(a.claimant_name)} · attachment ${a.id}</label>
            <input name="title" placeholder="Title" value="${esc(a.title ?? '')}">
          </div>
          <div><label class="checkbox-label"><input type="checkbox" name="is_specified_employee" ${a.is_specified_employee ? 'checked' : ''}> Specified</label></div>
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

function bindUserEditForm(bundle, row, ctx) {
  const reRender = async () => {
    const fresh = await api('GET', `/api/users/${bundle.id}`);
    row.querySelector('td').innerHTML = renderUserEditForm(fresh, ctx);
    bindUserEditForm(fresh, row, ctx);
  };

  onSubmit(row.querySelector('[data-form="user-fields"]'), async fd => {
    await api('PATCH', `/api/users/${bundle.id}`, {
      name: fd.get('name'),
      role: fd.get('role') || undefined,
    });
    allUsers = (await api('GET', '/api/users')).items;
    redrawAllUsers(ctx);
  });

  row.querySelectorAll('[data-form="uc-fields"]').forEach(form => onSubmit(form, async fd => {
    await api('PATCH', `/api/user-claimants/${form.dataset.uc}`, {
      title: fd.get('title') || null,
      is_specified_employee: fd.get('is_specified_employee') === 'on',
      status: fd.get('status'),
    });
    await reRender();
  }));

  row.querySelectorAll('[data-form="add-comp"]').forEach(form => onSubmit(form, async fd => {
    await api('POST', `/api/user-claimants/${form.dataset.uc}/compensation`, {
      comp_type: fd.get('comp_type'),
      amount_cents: Number(fd.get('amount_cents')),
      effective_from: fd.get('effective_from'),
    });
    await reRender();
  }));

  onSubmit(row.querySelector('[data-form="add-attachment"]'), async fd => {
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
    await reRender();
  });
}

// --- User detail subview --------------------------------------------------

async function renderUserDetail(main, ctx) {
  main.innerHTML = '<p class="empty">Loading employee…</p>';
  const userId = ctx.state.viewingUserId;
  const [bundle, activity] = await Promise.all([
    api('GET', `/api/users/${userId}`),
    api('GET', `/api/activity?user_id=${userId}&limit=25`),
  ]);
  const statusPillClass = bundle.status === 'active' ? 'open' : bundle.status === 'pending' ? 'pending' : 'closed';
  main.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>
          <a href="#users" class="muted" style="text-decoration:none">← Employees</a>
          &nbsp;/&nbsp; ${esc(bundle.name)}
        </h2>
        <div class="row" style="gap:0.4rem">
          <span class="role">${esc(bundle.role)}</span>
          <span class="pill ${statusPillClass}">${esc(bundle.status)}</span>
        </div>
      </div>
      <div class="row meta-strip">
        <span><strong>${esc(bundle.email)}</strong></span>
        <span>Created ${esc(bundle.created_at)}</span>
        <span>${bundle.attachments.length} attachment${bundle.attachments.length === 1 ? '' : 's'}</span>
        <span>${bundle.projects.length} active project${bundle.projects.length === 1 ? '' : 's'}</span>
      </div>
    </div>

    <div class="card compact">
      <h2>Claimant attachments</h2>
      ${bundle.attachments.length === 0
        ? '<p class="empty">Not attached to any claimant.</p>'
        : `<table>
            <thead><tr><th>Claimant</th><th>Title</th><th>Specified</th><th>Status</th><th>Latest compensation</th></tr></thead>
            <tbody>${bundle.attachments.map(a => {
              const latest = (a.compensation_history ?? [])[0];
              const compStr = latest
                ? `${cents(latest.amount_cents)} ${latest.comp_type === 'salary' ? '/yr' : '/hr'}  <span class="muted">from ${esc(latest.effective_from)}</span>`
                : '<span class="muted">none</span>';
              return `<tr>
                <td>${esc(a.claimant_name)}</td>
                <td>${esc(a.title ?? '—')}</td>
                <td>${a.is_specified_employee ? '✓' : ''}</td>
                <td><span class="pill ${a.status === 'active' ? 'open' : 'closed'}">${esc(a.status)}</span></td>
                <td>${compStr}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>`}
    </div>

    <div class="card compact">
      <h2>Active project assignments (${bundle.projects.length})</h2>
      ${bundle.projects.length === 0
        ? '<p class="empty">Not assigned to any active projects.</p>'
        : `<table class="rows-clickable">
            <thead><tr><th>Project</th><th>Claimant</th><th>Type</th><th>Phase</th><th>Status</th></tr></thead>
            <tbody>${bundle.projects.map(p => `
              <tr data-open-project="${p.id}" data-cid="${p.claimant_id}">
                <td><strong>${esc(p.title)}</strong></td>
                <td>${esc(p.claimant_name)}</td>
                <td><span class="pill kind-${esc(p.type)}">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></td>
                <td><span class="pill phase-${esc(p.phase)}">${esc(PHASE_LABEL[p.phase] ?? p.phase)}</span></td>
                <td><span class="pill">${esc(p.status)}</span></td>
              </tr>`).join('')}</tbody>
          </table>`}
    </div>

    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: false, showProject: true, showOpen: true })}
    </div>
  `;
  wireActivityDetails(main);
  document.querySelectorAll('[data-open-project]').forEach(tr => {
    tr.addEventListener('click', () => {
      ctx.selectProject({ id: Number(tr.dataset.openProject), claimant_id: Number(tr.dataset.cid) });
    });
  });
}
