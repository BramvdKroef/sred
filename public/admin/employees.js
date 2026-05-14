import { api, esc, cents, dollarsToCents, bindForm, onSubmit, activityHtml,
         wireActivityDetails, TYPE_LABEL, STATUS_LABEL } from '../api.js';

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
  // The form has two modes:
  //   - 'create' (default): collect name+role and POST /api/users (which also
  //     inserts the first attachment via the `attachments` array).
  //   - 'attach': collected when the typed email matches an existing user.
  //     name/role are hidden; submit POSTs to /api/users/:id/attachments.
  // UC-A3 step 1 spec: "name, email, employment start date" — both Title (UC
  // step 2) and Employment start date are now first-class fields on this form.
  return `
    <div class="card">
      <h2>Add employee</h2>
      <form id="add-employee-form" data-mode="create">
        <div class="grid">
          <div><label>Email</label><input name="email" type="email" required
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
          <div data-only-create><label>Name</label><input name="name"
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
          <div data-only-create><label>Role</label>
            <select name="role">
              <option value="employee" selected>Employee</option>
              <option value="manager">Manager</option>
            </select>
          </div>
          <div><label>Claimant</label><select name="claimant_id">${claimantOpts}</select></div>
          <div><label>Title</label><input name="title"
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
          <div><label>Employment start date</label><input name="employment_start_date" type="date"></div>
          <div><label>Comp type</label>
            <select name="comp_type" data-comp-type-for="add-employee"><option>salary</option><option>hourly</option></select>
          </div>
          <div><label>Amount <span class="muted" data-comp-unit-for="add-employee">($/yr)</span></label><input name="amount" type="number" step="0.01" min="0" placeholder="e.g. 95000.00" required></div>
          <div><label>Effective from</label><input name="effective_from" type="date"></div>
          <div><label><input name="is_specified_employee" type="checkbox"> Specified employee</label></div>
        </div>
        <div id="add-employee-existing" class="muted" hidden style="margin:0.4rem 0; padding:0.5rem; border:1px solid var(--accent, #bbb); border-radius:4px"></div>
        <div class="actions"><button data-submit-label>Add</button></div>
        <p class="muted">Creates the employee record only. Click <strong>Send invite</strong> in the table below to email them a passkey enrollment link when ready. If <em>Effective from</em> is left blank we default it from <em>Employment start date</em>.</p>
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
      <thead><tr><th class="hide-on-narrow">ID</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${allUsers.map(u => `
        <tr>
          <td class="hide-on-narrow">${u.id}</td>
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
  bindAddEmployeeForm(ctx);
}

// UC-A3: when an admin types an email that already belongs to a user, surface
// the match and offer to switch the form into "attach to claimant" mode
// (alt flow A3.a — cross-claimant onboarding). The server already rejects
// duplicate emails (UNIQUE constraint on users.email + 409 in
// src/routes/users.js), so without this UX the admin gets an unhelpful
// "email already exists" error and no path forward.
function bindAddEmployeeForm(ctx) {
  const form = document.getElementById('add-employee-form');
  if (!form) return;
  const emailInput = form.querySelector('input[name="email"]');
  const notice     = form.querySelector('#add-employee-existing');
  const submitBtn  = form.querySelector('[data-submit-label]');
  let existingUserId = null;   // populated when admin opts into attach mode

  const setMode = (mode, user) => {
    form.dataset.mode = mode;
    existingUserId = mode === 'attach' ? user.id : null;
    form.querySelectorAll('[data-only-create]').forEach(el => {
      el.hidden = mode === 'attach';
      el.querySelectorAll('input, select').forEach(i => { i.disabled = mode === 'attach'; });
    });
    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput) nameInput.required = mode === 'create';
    submitBtn.textContent = mode === 'attach' ? 'Attach' : 'Add';
  };

  const lookupEmail = async () => {
    const email = (emailInput.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      notice.hidden = true; notice.innerHTML = ''; setMode('create');
      return;
    }
    try {
      const r = await api('GET', `/api/users?q=${encodeURIComponent(email)}`);
      const match = (r.items || []).find(u => (u.email || '').toLowerCase() === email);
      if (!match) {
        notice.hidden = true; notice.innerHTML = ''; setMode('create');
        return;
      }
      notice.hidden = false;
      notice.innerHTML =
        `User <strong>${esc(match.name)}</strong> (${esc(match.email)}) already exists.
         Switch to attach-to-claimant mode?
         <button type="button" class="small" data-attach-yes>Yes</button>
         <button type="button" class="small secondary" data-attach-no>No</button>`;
      notice.querySelector('[data-attach-yes]').addEventListener('click', () => {
        setMode('attach', match);
        notice.innerHTML =
          `Attach to claimant — creating a new attachment under
           <strong>${esc(match.name)}</strong>. Submit POSTs to the existing user.`;
      });
      notice.querySelector('[data-attach-no]').addEventListener('click', () => {
        notice.hidden = true; notice.innerHTML = ''; setMode('create');
      });
    } catch {
      // search failed — degrade silently to create mode; the server will
      // reject a duplicate email on submit with a clear 409.
      notice.hidden = true; notice.innerHTML = ''; setMode('create');
    }
  };

  // Trigger on blur. Debounced keyup is also reasonable but blur is the
  // simpler model: admin types a complete email, tabs out, sees the prompt.
  emailInput.addEventListener('blur', lookupEmail);

  // Comp-type dropdown flips the unit suffix on the dollar input ($/yr vs $/hr).
  // The stored field still posts as amount_cents — only the label changes.
  const compTypeSel = form.querySelector('[data-comp-type-for="add-employee"]');
  const compUnitEl  = form.querySelector('[data-comp-unit-for="add-employee"]');
  if (compTypeSel && compUnitEl) {
    const sync = () => { compUnitEl.textContent = compTypeSel.value === 'hourly' ? '($/hr)' : '($/yr)'; };
    compTypeSel.addEventListener('change', sync);
    sync();
  }

  onSubmit(form, async (fd) => {
    const employmentStart = fd.get('employment_start_date') || null;
    // Effective_from defaults to employment start date when blank (UC-A3
    // step 1 spec lists employment start date as the primary field; the
    // first comp row should inherit it unless the admin overrides).
    const effectiveFrom = fd.get('effective_from') || employmentStart;
    if (!effectiveFrom)
      throw new Error('Provide an employment start date or an effective-from date for the first comp row.');

    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 95000 or 95000.00).');

    const attachment = {
      claimant_id: Number(fd.get('claimant_id')),
      title: fd.get('title') || null,
      is_specified_employee: fd.get('is_specified_employee') === 'on',
      employment_start_date: employmentStart,
      compensation: {
        comp_type: fd.get('comp_type'),
        amount_cents: amountCents,
        effective_from: effectiveFrom,
      },
    };

    if (form.dataset.mode === 'attach' && existingUserId) {
      await api('POST', `/api/users/${existingUserId}/attachments`, attachment);
    } else {
      await api('POST', '/api/users', {
        email: fd.get('email'),
        name: fd.get('name'),
        role: fd.get('role') || 'employee',
        attachments: [attachment],
      });
    }
    notice.hidden = true; notice.innerHTML = '';
    form.reset();
    setMode('create');
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
            <select name="comp_type" data-comp-type-for="add-att-${u.id}"><option>salary</option><option>hourly</option></select>
          </div>
          <div><label>Amount <span class="muted" data-comp-unit-for="add-att-${u.id}">($/yr)</span></label><input type="number" step="0.01" min="0" name="amount" placeholder="e.g. 95000.00" required></div>
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
            <div><label>Type</label><select name="comp_type" data-comp-type-for="add-comp-${a.id}"><option>salary</option><option>hourly</option></select></div>
            <div><label>Amount <span class="muted" data-comp-unit-for="add-comp-${a.id}">($/yr)</span></label><input type="number" step="0.01" name="amount" min="0" placeholder="e.g. 95000.00" required style="width:9rem"></div>
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
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 95000 or 95000.00).');
    await api('POST', `/api/user-claimants/${form.dataset.uc}/compensation`, {
      comp_type: fd.get('comp_type'),
      amount_cents: amountCents,
      effective_from: fd.get('effective_from'),
    });
    await reRender();
  }));

  onSubmit(row.querySelector('[data-form="add-attachment"]'), async fd => {
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 95000 or 95000.00).');
    await api('POST', `/api/users/${bundle.id}/attachments`, {
      claimant_id: Number(fd.get('claimant_id')),
      title: fd.get('title') || null,
      is_specified_employee: fd.get('is_specified_employee') === 'on',
      compensation: {
        comp_type: fd.get('comp_type'),
        amount_cents: amountCents,
        effective_from: fd.get('effective_from'),
      },
    });
    await reRender();
  });

  // Flip $/yr ↔ $/hr suffix to match each comp-type dropdown.
  row.querySelectorAll('[data-comp-type-for]').forEach(sel => {
    const key = sel.dataset.compTypeFor;
    const unitEl = row.querySelector(`[data-comp-unit-for="${key}"]`);
    if (!unitEl) return;
    const sync = () => { unitEl.textContent = sel.value === 'hourly' ? '($/hr)' : '($/yr)'; };
    sel.addEventListener('change', sync);
    sync();
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
            <thead><tr><th>Project</th><th>Claimant</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>${bundle.projects.map(p => `
              <tr data-open-project="${p.id}" data-cid="${p.claimant_id}">
                <td><strong>${esc(p.title)}</strong></td>
                <td>${esc(p.claimant_name)}</td>
                <td><span class="pill kind-${esc(p.type)}">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></td>
                <td><span class="pill status-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span></td>
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
