// All-employees list view: the Add-employee + Attach-existing forms (markup
// only — handlers in ./add.js and ./attach.js) plus the employees table
// with per-row actions (edit, send invite / add device, deactivate /
// reactivate). The edit-row expansion is wired through ./attachment.js.

import { api, esc, showTopBanner, statusPill } from '../../api.js';
import { TIP_SPECIFIED, TIP_COMP_TYPE } from './tips.js';
import { bindAddEmployeeForm } from './add.js';
import { bindAttachExistingForm } from './attach.js';
import { showInviteModal } from './invite-modal.js';
import { renderUserEditForm, bindUserEditForm } from './attachment.js';

export async function renderList(main, ctx) {
  main.innerHTML = '<p class="empty">Loading employees…</p>';
  // Match the pattern used by review.js / overview.js: await the fetch inside
  // render() and write the full HTML once. Previously this tab rendered a
  // placeholder synchronously and resolved the user list via .then(), which
  // raced with tab switches and a module-level `allUsers` cache.
  const users = (await api('GET', '/api/users')).items;
  main.innerHTML = renderUsersTab(ctx, users);
  bindList(ctx, users);
}

function renderUsersTab(ctx, users) {
  const claimantOpts = ctx.state.claimants
    .map(c => `<option value="${c.id}" ${c.id === ctx.state.activeClaimantId ? 'selected' : ''}>${esc(c.legal_name)}</option>`)
    .join('');
  // The Add-employee form has two modes:
  //   - 'create' (default): collect name+role and POST /api/users (which also
  //     inserts the first attachment via the `attachments` array).
  //   - 'attach': collected when the typed email matches an existing user.
  //     name/role are hidden; submit POSTs to /api/users/:id/attachments.
  // UC-A3 step 1 spec: "name, email, employment start date" — both Title (UC
  // step 2) and Employment start date are now first-class fields on this form.
  //
  // UC-A3 step 3 / alt flow A3.a: a separate explicit entry point for
  // cross-claimant attachment (without having to discover the blur-trigger
  // email lookup, or drill into edit-user). The markup duplicates the
  // per-claimant fields rather than extracting a helper — the two forms have
  // diverged enough (no name/role on attach; no mode toggle either) that a
  // shared helper would cost more than the duplication.
  return `
    <div class="card">
      <div class="card-head">
        <h2>Add employee</h2>
        <button type="button" id="attach-existing-toggle" class="secondary small">＋ Attach existing employee to claimant</button>
      </div>
      <form id="add-employee-form" data-mode="create">
        <div class="grid">
          <div><label>Email <input name="email" type="email" required
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></label></div>
          <div data-only-create><label>Name <input name="name"
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></label></div>
          <div data-only-create><label>Role
            <select name="role">
              <option value="employee" selected>Employee</option>
              <option value="manager">Manager</option>
            </select>
          </label></div>
          <div><label>Claimant <select name="claimant_id">${claimantOpts}</select></label></div>
          <div><label>Title <input name="title"
            autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></label></div>
          <div><label>Employment start date <input name="employment_start_date" type="date"></label></div>
          <div><label title="${esc(TIP_COMP_TYPE)}">Comp type
            <select name="comp_type" data-comp-type-for="add-employee" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select>
          </label></div>
          <div><label>Amount <span class="muted" data-comp-unit-for="add-employee">($/yr)</span> <input name="amount" type="number" step="0.01" min="0" placeholder="e.g. 95000.00" required></label></div>
          <div><label>Effective from <input name="effective_from" type="date"></label></div>
          <div><label title="${esc(TIP_SPECIFIED)}"><input name="is_specified_employee" type="checkbox" title="${esc(TIP_SPECIFIED)}"> Specified employee</label></div>
        </div>
        <div id="add-employee-existing" class="muted add-employee-existing" hidden></div>
        <div class="actions"><button data-submit-label>Add</button></div>
        <p class="muted">Creates the employee record only. Click <strong>Send invite</strong> in the table below to email them a passkey enrollment link when ready. If <em>Effective from</em> is left blank we default it from <em>Employment start date</em>.</p>
      </form>
      <div id="attach-existing-form-wrap" class="attach-existing-wrap" hidden>
        <h3 class="mt-0">Attach existing employee to claimant</h3>
        <p class="muted mt-0">Use this when the person already exists under another claimant. Enter their email, fill in the per-claimant details, and submit.</p>
        <form id="attach-existing-form">
          <div class="grid">
            <div><label>Email <input name="email" type="email" required
              autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></label></div>
            <div><label>Claimant <select name="claimant_id">${claimantOpts}</select></label></div>
            <div><label>Title <input name="title"
              autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></label></div>
            <div><label>Employment start date <input name="employment_start_date" type="date"></label></div>
            <div><label title="${esc(TIP_COMP_TYPE)}">Comp type
              <select name="comp_type" data-comp-type-for="attach-existing" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select>
            </label></div>
            <div><label>Amount <span class="muted" data-comp-unit-for="attach-existing">($/yr)</span> <input name="amount" type="number" step="0.01" min="0" placeholder="e.g. 95000.00" required></label></div>
            <div><label>Effective from <input name="effective_from" type="date"></label></div>
            <div><label title="${esc(TIP_SPECIFIED)}"><input name="is_specified_employee" type="checkbox" title="${esc(TIP_SPECIFIED)}"> Specified employee</label></div>
          </div>
          <div class="actions"><button class="small">Attach</button></div>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>All employees</h2>
      <div id="all-users-table">${renderAllUsersTable(ctx, users)}</div>
    </div>
  `;
}

function renderAllUsersTable(ctx, users) {
  if (!users.length) return '<p class="empty">No users yet.</p>';
  return `
    <div class="table-scroll">
    <table>
      <thead><tr><th class="hide-on-narrow">ID</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td class="hide-on-narrow">${u.id}</td>
          <td>${esc(u.email)}</td>
          <td><a href="#users/${u.id}"><strong>${esc(u.name)}</strong></a></td>
          <td>${esc(u.role)}</td>
          <td>${statusPill(u.status)}</td>
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
    </table>
    </div>`;
}

function bindList(ctx, users) {
  bindAddEmployeeForm(ctx);
  bindAttachExistingForm(ctx);
  bindUserRowActions(document.getElementById('all-users-table'), ctx, users);
}

function bindUserRowActions(el, ctx, users) {
  if (!el) return;
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
        const target = users.find(u => String(u.id) === String(id));
        showInviteModal(r, target);
      } catch (e) {
        showTopBanner(e.message);
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
        // Re-render the whole tab via the shell's render() (matches what
        // other tab modules do after a mutation — see review.js's
        // ctx.render() after approve/reject).
        if (ctx.state.tab === 'users') await ctx.reloadAll();
        else ctx.render();
      } catch (e) {
        showTopBanner(e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}
