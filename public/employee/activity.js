import { api, esc, cents, onSubmit, wireJwtDownloads, safeHref } from '../api.js';

export function render(main, ctx) {
  const { state } = ctx;
  const projTitle = id => state.projects.find(p => p.id === id)?.title ?? `#${id}`;
  main.innerHTML = `
    <div class="card">
      <h2>Assigned projects</h2>
      ${state.projects.length === 0 ? '<p class="empty">No project assignments yet — ask your admin.</p>' : `
      <table>
        <thead><tr><th>Project</th><th>Claimant</th><th>Status</th></tr></thead>
        <tbody>${state.projects.map(p => `
          <tr><td>${esc(p.title)}</td><td>${esc(p.claimant_name)}</td><td><span class="pill">${esc(p.status)}</span></td></tr>
        `).join('')}</tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My labour (${state.labour.length})</h2>
      ${state.labour.length === 0 ? '<p class="empty">No entries.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Hours</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${state.labour.map(e => {
          const editable = e.status !== 'approved';
          return `
          <tr>
            <td>${esc(e.work_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${e.hours}${e.is_overtime ? ' <span class="pill overtime">OT</span>' : ''}</td>
            <td>${esc(e.description)}</td>
            <td><span class="pill ${e.status}">${esc(e.status)}</span>${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
            <td class="actions">${editable ? `<button class="small secondary" data-edit-labour="${e.id}">Edit</button>` : '<span class="muted">locked</span>'}</td>
          </tr>
          ${editable ? `<tr id="row-edit-labour-${e.id}" hidden><td colspan="6">${labourEditForm(e)}</td></tr>` : ''}
          `;
        }).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My expenses (${state.expenses.length})</h2>
      ${state.expenses.length === 0 ? '<p class="empty">None.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Category</th><th>Amount</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${state.expenses.map(e => {
          const editable = e.status !== 'approved';
          return `
          <tr>
            <td>${esc(e.expense_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${esc(e.category)}</td>
            <td>${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td>${esc(e.description)}</td>
            <td><span class="pill ${e.status}">${esc(e.status)}</span>${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
            <td class="actions">${editable ? `<button class="small secondary" data-edit-expense="${e.id}">Edit</button>` : '<span class="muted">locked</span>'}</td>
          </tr>
          ${editable ? `<tr id="row-edit-expense-${e.id}" hidden><td colspan="7">${expenseEditForm(e)}</td></tr>` : ''}
          `;
        }).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My evidence (${state.evidence.length})</h2>
      ${state.evidence.length === 0 ? '<p class="empty">None.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Kind</th><th>Caption</th><th>Reference</th><th></th></tr></thead>
        <tbody>${state.evidence.map(e => `
          <tr>
            <td>${esc(e.evidence_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${esc(e.kind)}</td>
            <td>${esc(e.caption)}</td>
            <td>${e.kind === 'file'
                  ? `<a href="/api/evidence/${e.id}/download" data-jwt-dl>${esc(e.file_path)}</a>`
                  : e.kind === 'link' ? `<a href="${esc(safeHref(e.url))}" target="_blank" rel="noopener">${esc(e.url)}</a>`
                  : `<span class="muted">${esc(e.note_text)}</span>`}</td>
            <td class="actions"><button class="small secondary" data-edit-evidence="${e.id}">Edit</button></td>
          </tr>
          <tr id="row-edit-evidence-${e.id}" hidden><td colspan="6">${evidenceEditForm(e)}</td></tr>
          `).join('')}
        </tbody>
      </table>`}
    </div>
  `;
  bindActivity(main, ctx);
  wireJwtDownloads(main);
}

// --- Inline row-edit forms (one per type) ---------------------------------

function labourEditForm(e) {
  return `<form data-form-edit-labour="${e.id}" class="row" style="gap:0.5rem; align-items:flex-start; padding:0.5rem 0">
    <div><label>Date</label><input type="date" name="work_date" value="${esc(e.work_date)}" required></div>
    <div><label>Hours</label><input type="number" name="hours" step="0.25" min="0.25" max="24" value="${e.hours}" required style="width:6rem"></div>
    <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime" ${e.is_overtime ? 'checked' : ''}> Overtime</label></div>
    <div class="input-grow"><label>Description</label><input name="description" value="${esc(e.description)}" required></div>
    <div><label>&nbsp;</label><div class="row" style="gap:0.4rem"><button class="small">Save</button><button type="button" class="small secondary" data-cancel-labour="${e.id}">Cancel</button></div></div>
  </form>`;
}

function expenseEditForm(e) {
  const cats = ['material','contract','third_party_payment','overhead'];
  return `<form data-form-edit-expense="${e.id}" class="row" style="gap:0.5rem; align-items:flex-start; padding:0.5rem 0; flex-wrap:wrap">
    <div><label>Date</label><input type="date" name="expense_date" value="${esc(e.expense_date)}" required></div>
    <div><label>Category</label><select name="category">${cats.map(c =>
      `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div><label>Amount (cents)</label><input type="number" name="amount_cents" min="1" value="${e.amount_cents}" required style="width:8rem"></div>
    <div><label>Currency</label><input name="currency" value="${esc(e.currency)}" required style="width:5rem"></div>
    <div><label>FX rate</label><input type="number" step="0.0001" name="fx_rate" value="${e.fx_rate ?? ''}" style="width:6rem"></div>
    <div class="input-grow"><label>Description</label><input name="description" value="${esc(e.description)}" required></div>
    <div><label>&nbsp;</label><div class="row" style="gap:0.4rem"><button class="small">Save</button><button type="button" class="small secondary" data-cancel-expense="${e.id}">Cancel</button></div></div>
  </form>`;
}

function evidenceEditForm(e) {
  return `<form data-form-edit-evidence="${e.id}" class="row" style="gap:0.5rem; align-items:flex-start; padding:0.5rem 0; flex-wrap:wrap">
    <div><label>Date</label><input type="date" name="evidence_date" value="${esc(e.evidence_date)}" required></div>
    <div class="input-grow"><label>Caption</label><input name="caption" value="${esc(e.caption)}" required></div>
    ${e.kind === 'link' ? `<div class="input-grow"><label>URL</label><input type="url" name="url" value="${esc(e.url ?? '')}" required></div>` : ''}
    ${e.kind === 'note' ? `<div style="flex:1 1 100%"><label>Note</label><textarea name="note_text" rows="2" required>${esc(e.note_text ?? '')}</textarea></div>` : ''}
    ${e.kind === 'file' ? `<div><label>&nbsp;</label><span class="muted">file content not editable</span></div>` : ''}
    <div><label>&nbsp;</label><div class="row" style="gap:0.4rem"><button class="small">Save</button><button type="button" class="small secondary" data-cancel-evidence="${e.id}">Cancel</button></div></div>
  </form>`;
}

// --- Bindings: row-edit toggles + form submits ----------------------------

function bindActivity(main, ctx) {
  for (const kind of ['labour', 'expense', 'evidence']) {
    main.querySelectorAll(`[data-edit-${kind}]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset[`edit${kind.charAt(0).toUpperCase()}${kind.slice(1)}`];
        document.getElementById(`row-edit-${kind}-${id}`).hidden = false;
      });
    });
    main.querySelectorAll(`[data-cancel-${kind}]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset[`cancel${kind.charAt(0).toUpperCase()}${kind.slice(1)}`];
        document.getElementById(`row-edit-${kind}-${id}`).hidden = true;
      });
    });
  }

  main.querySelectorAll('[data-form-edit-labour]').forEach(form => onSubmit(form, async fd => {
    await api('PATCH', `/api/labour/${form.dataset.formEditLabour}`, {
      work_date: fd.get('work_date'),
      hours: Number(fd.get('hours')),
      description: fd.get('description'),
      is_overtime: fd.get('is_overtime') === 'on',
    });
    await ctx.reload();
  }));

  main.querySelectorAll('[data-form-edit-expense]').forEach(form => onSubmit(form, async fd => {
    const body = {
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: Number(fd.get('amount_cents')),
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    body.fx_rate = fx ? Number(fx) : null;
    await api('PATCH', `/api/expenses/${form.dataset.formEditExpense}`, body);
    await ctx.reload();
  }));

  main.querySelectorAll('[data-form-edit-evidence]').forEach(form => onSubmit(form, async fd => {
    const body = {
      evidence_date: fd.get('evidence_date'),
      caption: fd.get('caption'),
    };
    if (fd.get('url') !== null)       body.url = fd.get('url');
    if (fd.get('note_text') !== null) body.note_text = fd.get('note_text');
    await api('PATCH', `/api/evidence/${form.dataset.formEditEvidence}`, body);
    await ctx.reload();
  }));
}
