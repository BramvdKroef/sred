// Inline edit-user expansion that appears under a row in the All-employees
// table when an admin clicks "Edit". Contains three sub-forms:
//   - user-fields (name + role)
//   - one uc-fields form per attachment (title, specified, status)
//   - add-attachment (claimant + title + initial compensation)
// Plus a per-attachment "Add comp row" form nested in the comp-history
// <details>. All forms share the same $/yr ↔ $/hr unit-suffix flip.
//
// `bindUserEditForm` re-binds itself after every successful sub-form submit
// (via `reRender`) so the latest server state is always reflected — no
// optimistic mutations, no module-level cache.

import { api, esc, cents, dollarsToCents, onSubmit } from '../../api.js';
import { TIP_SPECIFIED, TIP_COMP_TYPE } from './tips.js';

export function renderUserEditForm(u, ctx) {
  const isSelf = u.id === ctx.state.me.user.id;
  const ROLES = ['employee', 'manager', 'admin'];
  const claimantOpts = ctx.state.claimants
    .map(c => `<option value="${c.id}">${esc(c.legal_name)}</option>`).join('');
  return `
    <div class="card compact edit-user-card">
      <h3 class="mt-0">Edit ${esc(u.name)}</h3>

      <form data-form="user-fields" data-user="${u.id}">
        <div class="grid">
          <div><label>Name <input name="name" required value="${esc(u.name)}"></label></div>
          <div><label>Role${isSelf ? ' (locked — you)' : ''}
            <select name="role" ${isSelf ? 'disabled' : ''}>
              ${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </label></div>
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
          <div><label>Claimant <select name="claimant_id" required>${claimantOpts}</select></label></div>
          <div><label>Title <input name="title"></label></div>
          <div><label title="${esc(TIP_COMP_TYPE)}">Comp type
            <select name="comp_type" data-comp-type-for="add-att-${u.id}" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select>
          </label></div>
          <div><label>Amount <span class="muted" data-comp-unit-for="add-att-${u.id}">($/yr)</span> <input type="number" step="0.01" min="0" name="amount" placeholder="e.g. 95000.00" required></label></div>
          <div><label>Effective from <input type="date" name="effective_from" required></label></div>
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
        <div class="row gap-lg align-end wrap">
          <div class="input-grow">
            <label>${esc(a.claimant_name)} · attachment ${a.id}
              <input name="title" placeholder="Title" value="${esc(a.title ?? '')}">
            </label>
          </div>
          <div><label class="checkbox-label" title="${esc(TIP_SPECIFIED)}"><input type="checkbox" name="is_specified_employee" ${a.is_specified_employee ? 'checked' : ''} title="${esc(TIP_SPECIFIED)}"> Specified</label></div>
          <div><label>Status
            <select name="status">
              <option ${a.status === 'active' ? 'selected' : ''}>active</option>
              <option ${a.status === 'inactive' ? 'selected' : ''}>inactive</option>
            </select>
          </label></div>
          <div><button class="small">Save</button></div>
        </div>
      </form>
      <details class="mt-sm">
        <summary class="muted summary-toggle caption-sm">Compensation history (${(a.compensation_history ?? []).length})</summary>
        <ul class="comp-history-list">${compHistory || '<li class="empty">none</li>'}</ul>
        <form data-form="add-comp" data-uc="${a.id}">
          <div class="row gap-md align-end">
            <div><label title="${esc(TIP_COMP_TYPE)}">Type <select name="comp_type" data-comp-type-for="add-comp-${a.id}" title="${esc(TIP_COMP_TYPE)}"><option>salary</option><option>hourly</option></select></label></div>
            <div><label>Amount <span class="muted" data-comp-unit-for="add-comp-${a.id}">($/yr)</span> <input type="number" step="0.01" name="amount" min="0" placeholder="e.g. 95000.00" required class="w-amount"></label></div>
            <div><label>Effective from <input type="date" name="effective_from" required></label></div>
            <div><button class="small secondary">＋ Add comp row</button></div>
          </div>
        </form>
      </details>
    </div>
  `;
}

export function bindUserEditForm(bundle, row, ctx) {
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
