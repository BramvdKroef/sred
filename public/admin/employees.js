import { api, esc, cents, dollarsToCents, bindForm, onSubmit, activityHtml,
         wireActivityDetails, showTopBanner, TYPE_LABEL, STATUS_LABEL } from '../api.js';

export async function render(main, ctx) {
  if (ctx.state.viewingUserId) return renderUserDetail(main, ctx);
  main.innerHTML = '<p class="empty">Loading employees…</p>';
  // Match the pattern used by review.js / overview.js: await the fetch inside
  // render() and write the full HTML once. Previously this tab rendered a
  // placeholder synchronously and resolved the user list via .then(), which
  // raced with tab switches and a module-level `allUsers` cache.
  const users = (await api('GET', '/api/users')).items;
  main.innerHTML = renderUsersTab(ctx, users);
  bindList(ctx, users);
}

// --- List view (Add employee + All employees) ------------------------------

// SR&ED-specific terminology that admins repeatedly bump into; hover help
// keeps the labels short while still defining the term where it's used. Plain
// `title=` attribute — good enough for desktop, accessible to screen readers,
// and zero CSS/JS cost.
const TIP_SPECIFIED = 'Hourly rate is capped at the per-year specified-employee cap on T661 line 307. Flag for owners, partners, and people earning above the cap.';
const TIP_COMP_TYPE = 'Salary = annual; hourly = per-hour. The amount input flips to match.';

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
          <div><label title="${esc(TIP_COMP_TYPE)}">Comp type</label>
            <select name="comp_type" data-comp-type-for="add-employee" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select>
          </div>
          <div><label>Amount <span class="muted" data-comp-unit-for="add-employee">($/yr)</span></label><input name="amount" type="number" step="0.01" min="0" placeholder="e.g. 95000.00" required></div>
          <div><label>Effective from</label><input name="effective_from" type="date"></div>
          <div><label title="${esc(TIP_SPECIFIED)}"><input name="is_specified_employee" type="checkbox" title="${esc(TIP_SPECIFIED)}"> Specified employee</label></div>
        </div>
        <div id="add-employee-existing" class="muted" hidden style="margin:0.4rem 0; padding:0.5rem; border:1px solid var(--accent, #bbb); border-radius:4px"></div>
        <div class="actions"><button data-submit-label>Add</button></div>
        <p class="muted">Creates the employee record only. Click <strong>Send invite</strong> in the table below to email them a passkey enrollment link when ready. If <em>Effective from</em> is left blank we default it from <em>Employment start date</em>.</p>
      </form>
      <div id="attach-existing-form-wrap" hidden style="margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid rgba(0,0,0,0.08)">
        <h3 style="margin-top:0">Attach existing employee to claimant</h3>
        <p class="muted" style="margin-top:0">Use this when the person already exists under another claimant. Enter their email, fill in the per-claimant details, and submit.</p>
        <form id="attach-existing-form">
          <div class="grid">
            <div><label>Email</label><input name="email" type="email" required
              autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
            <div><label>Claimant</label><select name="claimant_id">${claimantOpts}</select></div>
            <div><label>Title</label><input name="title"
              autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>
            <div><label>Employment start date</label><input name="employment_start_date" type="date"></div>
            <div><label title="${esc(TIP_COMP_TYPE)}">Comp type</label>
              <select name="comp_type" data-comp-type-for="attach-existing" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select>
            </div>
            <div><label>Amount <span class="muted" data-comp-unit-for="attach-existing">($/yr)</span></label><input name="amount" type="number" step="0.01" min="0" placeholder="e.g. 95000.00" required></div>
            <div><label>Effective from</label><input name="effective_from" type="date"></div>
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
    <table>
      <thead><tr><th class="hide-on-narrow">ID</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${users.map(u => `
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
}

function bindList(ctx, users) {
  bindAddEmployeeForm(ctx);
  bindAttachExistingForm(ctx);
  bindUserRowActions(document.getElementById('all-users-table'), ctx, users);
}

// UC-A3 step 3 / alt flow A3.a — top-level entry point for attaching an
// existing user (from another claimant) to the current one without going
// through the Add-employee form's email-blur lookup or the edit-user
// drill-in. Hidden by default behind a button next to "Add employee".
function bindAttachExistingForm(ctx) {
  const toggle = document.getElementById('attach-existing-toggle');
  const wrap   = document.getElementById('attach-existing-form-wrap');
  const form   = document.getElementById('attach-existing-form');
  if (!toggle || !wrap || !form) return;

  toggle.addEventListener('click', () => {
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) form.querySelector('input[name="email"]').focus();
  });

  // Same $/yr ↔ $/hr suffix flip as the Add-employee form.
  const compTypeSel = form.querySelector('[data-comp-type-for="attach-existing"]');
  const compUnitEl  = form.querySelector('[data-comp-unit-for="attach-existing"]');
  if (compTypeSel && compUnitEl) {
    const sync = () => { compUnitEl.textContent = compTypeSel.value === 'hourly' ? '($/hr)' : '($/yr)'; };
    compTypeSel.addEventListener('change', sync);
    sync();
  }

  onSubmit(form, async (fd) => {
    const email = (fd.get('email') || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('Enter a valid email.');

    // Look up by email — same endpoint the blur-trigger uses. If no match,
    // surface the inline error spec'd by UC-A3 alt flow.
    const r = await api('GET', `/api/users?q=${encodeURIComponent(email)}`);
    const match = (r.items || []).find(u => (u.email || '').toLowerCase() === email);
    if (!match) {
      throw new Error('No user with that email. Use the Add employee form to create them first.');
    }

    const employmentStart = fd.get('employment_start_date') || null;
    const effectiveFrom = fd.get('effective_from') || employmentStart;
    if (!effectiveFrom)
      throw new Error('Provide an employment start date or an effective-from date for the first comp row.');

    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 95000 or 95000.00).');

    await api('POST', `/api/users/${match.id}/attachments`, {
      claimant_id: Number(fd.get('claimant_id')),
      title: fd.get('title') || null,
      is_specified_employee: fd.get('is_specified_employee') === 'on',
      employment_start_date: employmentStart,
      compensation: {
        comp_type: fd.get('comp_type'),
        amount_cents: amountCents,
        effective_from: effectiveFrom,
      },
    });
    form.reset();
    wrap.hidden = true;
    await ctx.reloadAll();
  });
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

// --- Invite-link modal ----------------------------------------------------

// Renders a small <dialog> showing invite metadata (target user, purpose,
// relative expiry, delivery status). The raw magic link is intentionally
// NOT shown — V-06's fix removed it from the API response body so an admin
// can't silently mint a sign-in link for another admin. When SMTP is
// disabled the link is logged to stderr; when enabled it's emailed straight
// to the target.
//
// <dialog> over a custom overlay because the SPA has zero existing modal
// CSS, and <dialog> ships native ::backdrop, focus-trap, and Esc-to-close.
// Browser support is fine for an admin-only tool (Chrome/Edge/Safari/Firefox
// all ship `showModal()` since 2022); the fallback path (`.show()`) is
// non-modal but still visible if `showModal` is somehow unavailable.
function showInviteModal(response, target) {
  // Reuse a single modal element across clicks so we don't pile them up.
  let dlg = document.getElementById('invite-modal');
  if (dlg) dlg.remove();

  const email = target?.email || 'the user';
  const name  = target?.name  || 'User';
  const purposeLabel = response.purpose === 'invite' ? 'Invite (first passkey)' : 'Add device (additional passkey)';
  const expiresRel   = relativeExpiry(response.expires_at);
  const deliveryLine = response.delivered
    ? `Sent to <strong>${esc(email)}</strong>`
    : 'Email delivery is disabled. The magic link was logged to the server console — check stderr.';

  dlg = document.createElement('dialog');
  dlg.id = 'invite-modal';
  dlg.style.cssText = 'border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; padding: 1.25rem 1.4rem; max-width: 28rem; box-shadow: 0 10px 30px rgba(0,0,0,0.15);';
  dlg.innerHTML = `
    <h3 style="margin:0 0 0.6rem">${esc(purposeLabel)}</h3>
    <p style="margin:0.2rem 0"><strong>${esc(name)}</strong> &lt;${esc(email)}&gt;</p>
    <p style="margin:0.2rem 0" class="muted">Expires in ${esc(expiresRel)}</p>
    <p style="margin:0.6rem 0">${deliveryLine}</p>
    <div class="actions" style="margin-top:0.8rem"><button type="button" class="small" data-close>Close</button></div>
  `;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.show?.();
}

// "expires in 24 hours" / "in 7 minutes" / "in the past" — coarse-grained
// because the invite endpoint already names a fixed TTL and admins just
// want a sanity check, not precision.
function relativeExpiry(iso) {
  if (!iso) return 'an unknown time';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return 'an unknown time';
  if (ms <= 0) return 'the past';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
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
          <div><label title="${esc(TIP_COMP_TYPE)}">Comp type</label>
            <select name="comp_type" data-comp-type-for="add-att-${u.id}" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select>
          </div>
          <div><label>Amount <span class="muted" data-comp-unit-for="add-att-${u.id}">($/yr)</span></label><input type="number" step="0.01" min="0" name="amount" placeholder="e.g. 95000.00" required></div>
          <div><label>Effective from</label><input type="date" name="effective_from" required></div>
          <div><label title="${esc(TIP_SPECIFIED)}"><input type="checkbox" name="is_specified_employee" title="${esc(TIP_SPECIFIED)}"> Specified</label></div>
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
          <div><label class="checkbox-label" title="${esc(TIP_SPECIFIED)}"><input type="checkbox" name="is_specified_employee" ${a.is_specified_employee ? 'checked' : ''} title="${esc(TIP_SPECIFIED)}"> Specified</label></div>
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
            <div><label title="${esc(TIP_COMP_TYPE)}">Type</label><select name="comp_type" data-comp-type-for="add-comp-${a.id}" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select></div>
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
    // Re-render the whole tab so the list reflects the new name/role
    // (the previous module-level cache + redraw is gone).
    ctx.render();
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
