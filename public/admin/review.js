import { api, esc, cents, onSubmit } from '../api.js';

// Module-level filter state. Persists across re-renders but resets on tab
// switch / page reload — admin will rarely want week-long filter persistence
// (and the active claimant in the header already covers the heavy hammer).
let filters = { period_id: '', project_id: '', employee_uc_id: '' };

// Pure helper: build a list-endpoint URL from a base path + filter object.
// Only non-empty values are included; the order of keys in the output follows
// `Object.entries(filters)`. Exported so unit tests can pin the URL shape
// without standing up a DOM.
export function buildListUrl(base, params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v == null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `${base}?${parts.join('&')}` : base;
}

export async function render(main, ctx) {
  main.innerHTML = '<p class="empty">Loading review queue…</p>';
  // Scope to the active claimant when one is selected; otherwise show the
  // global queue. The header selector re-runs render() on change, so this
  // refetches whenever the scope changes.
  const claimantId = ctx.state.activeClaimantId;
  const labourParams = { status: 'pending' };
  const expenseParams = { status: 'pending' };
  if (claimantId) {
    labourParams.claimant_id = claimantId;
    expenseParams.claimant_id = claimantId;
  }
  if (filters.period_id) {
    labourParams.period_id = filters.period_id;
    expenseParams.period_id = filters.period_id;
  }
  if (filters.project_id) {
    labourParams.project_id = filters.project_id;
    expenseParams.project_id = filters.project_id;
  }
  if (filters.employee_uc_id) {
    labourParams.user_claimant_id = filters.employee_uc_id;
    expenseParams.user_claimant_id = filters.employee_uc_id;
  }

  const [labour, expenses] = await Promise.all([
    api('GET', buildListUrl('/api/labour', labourParams)),
    api('GET', buildListUrl('/api/expenses', expenseParams)),
  ]);

  const scopeHint = claimantId
    ? ''
    : `<p class="empty" style="margin:0 0 0.6rem">Showing pending items across all claimants — pick a claimant from the header to narrow.</p>`;

  // Employee dropdown is derived from the *currently visible* rows (cheap).
  // Use the user_claimant_id as the value so we can filter precisely.
  const employees = collectEmployees(labour.items, expenses.items);

  main.innerHTML = `
    ${scopeHint}
    ${renderFilterBar(ctx.state, employees, filters)}
    ${renderActionBar(0)}
    <div class="card">
      <h2>Pending labour (${labour.items.length})</h2>
      ${labour.items.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr>
          <th style="width:1.6rem"><input type="checkbox" data-select-all-kind="labour" aria-label="Select all visible labour rows"></th>
          <th>Date</th><th>Project</th><th>Employee</th><th>Hours</th><th>Description</th><th>Actions</th>
        </tr></thead>
        <tbody>${labour.items.map(e => `
          <tr data-kind="labour" data-id="${e.id}">
            <td><input type="checkbox" class="bulk-row" data-kind="labour" data-id="${e.id}" aria-label="Select labour row ${e.id}"></td>
            <td>${esc(e.work_date)}</td>
            <td>${esc(e.project_title ?? `#${e.project_id}`)}</td>
            <td>${esc(e.user_name || e.user_email || `#${e.user_claimant_id}`)}</td>
            <td>${e.hours}</td>
            <td>${esc(e.description)}</td>
            <td class="actions">
              <button class="small" data-act="approve-labour" data-id="${e.id}">Approve</button>
              <button class="small danger" data-act="reject-labour" data-id="${e.id}">Reject</button>
            </td>
          </tr>
          <tr id="reject-row-labour-${e.id}" hidden><td colspan="7"></td></tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>Pending expenses (${expenses.items.length})</h2>
      ${expenses.items.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr>
          <th style="width:1.6rem"><input type="checkbox" data-select-all-kind="expense" aria-label="Select all visible expense rows"></th>
          <th>Date</th><th>Project</th><th>Employee</th><th>Category</th><th>Amount</th><th>Description</th><th>Actions</th>
        </tr></thead>
        <tbody>${expenses.items.map(e => `
          <tr data-kind="expense" data-id="${e.id}">
            <td><input type="checkbox" class="bulk-row" data-kind="expense" data-id="${e.id}" aria-label="Select expense row ${e.id}"></td>
            <td>${esc(e.expense_date)}</td>
            <td>${esc(e.project_title ?? `#${e.project_id}`)}</td>
            <td>${esc(e.user_name || e.user_email || `#${e.user_claimant_id}`)}</td>
            <td>${esc(e.category)}</td>
            <td>${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td>${esc(e.description)}</td>
            <td class="actions">
              <button class="small" data-act="approve-expense" data-id="${e.id}">Approve</button>
              <button class="small danger" data-act="reject-expense" data-id="${e.id}">Reject</button>
            </td>
          </tr>
          <tr id="reject-row-expense-${e.id}" hidden><td colspan="8"></td></tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `;
  bindFilterBar(main, ctx);
  bindActionBar(main, ctx);
  bindBulkCheckboxes(main);
  bindReviewActions(main, ctx);
}

// Build a {uc_id, name} list of distinct employees appearing in the visible
// queue. Sorted by name for predictable dropdown order.
function collectEmployees(labourItems, expenseItems) {
  const seen = new Map();
  for (const it of [...labourItems, ...expenseItems]) {
    const id = it.user_claimant_id;
    if (id == null || seen.has(id)) continue;
    seen.set(id, it.user_name || it.user_email || `#${id}`);
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderFilterBar(state, employees, current) {
  const periodOpt = p =>
    `<option value="${p.id}" ${String(current.period_id) === String(p.id) ? 'selected' : ''}>${esc(p.start_date)} → ${esc(p.end_date)}</option>`;
  const projectOpt = p =>
    `<option value="${p.id}" ${String(current.project_id) === String(p.id) ? 'selected' : ''}>${esc(p.title)}</option>`;
  const employeeOpt = e =>
    `<option value="${e.id}" ${String(current.employee_uc_id) === String(e.id) ? 'selected' : ''}>${esc(e.name)}</option>`;

  return `
    <div class="card" style="padding:0.6rem 0.9rem; margin-bottom:0.6rem">
      <form id="review-filters" class="row" style="gap:0.6rem; align-items:flex-end; flex-wrap:wrap; margin:0">
        <div>
          <label style="display:block; font-size:0.85rem">Period</label>
          <select name="period_id">
            <option value="">Any period</option>
            ${state.periods.map(periodOpt).join('')}
          </select>
        </div>
        <div>
          <label style="display:block; font-size:0.85rem">Project</label>
          <select name="project_id">
            <option value="">Any project</option>
            ${state.projects.map(projectOpt).join('')}
          </select>
        </div>
        <div>
          <label style="display:block; font-size:0.85rem">Employee</label>
          <select name="employee_uc_id">
            <option value="">Any employee</option>
            ${employees.map(employeeOpt).join('')}
          </select>
        </div>
        <button type="button" class="small secondary" data-filter-reset>Reset</button>
      </form>
    </div>
  `;
}

function bindFilterBar(main, ctx) {
  const form = main.querySelector('#review-filters');
  if (!form) return;
  const apply = () => {
    const fd = new FormData(form);
    filters = {
      period_id: fd.get('period_id') || '',
      project_id: fd.get('project_id') || '',
      employee_uc_id: fd.get('employee_uc_id') || '',
    };
    ctx.render();
  };
  form.querySelectorAll('select').forEach(s => s.addEventListener('change', apply));
  form.querySelector('[data-filter-reset]').addEventListener('click', () => {
    filters = { period_id: '', project_id: '', employee_uc_id: '' };
    ctx.render();
  });
}

// --- Bulk action bar -------------------------------------------------------

function renderActionBar(selectedCount) {
  const disabled = selectedCount === 0 ? 'disabled' : '';
  return `
    <div class="card" id="bulk-action-bar"
         style="position:sticky; top:0; z-index:5; padding:0.6rem 0.9rem; margin-bottom:0.6rem;
                display:flex; gap:0.6rem; align-items:center">
      <span><strong data-bulk-count>${selectedCount}</strong> selected</span>
      <button class="small" data-bulk-act="approve" ${disabled}>Approve selected</button>
      <button class="small danger" data-bulk-act="reject" ${disabled}>Reject selected</button>
    </div>
  `;
}

function getSelectedRows(main) {
  return [...main.querySelectorAll('input.bulk-row:checked')].map(cb => ({
    kind: cb.dataset.kind,
    id: cb.dataset.id,
  }));
}

function updateActionBar(main) {
  const selected = getSelectedRows(main);
  const count = selected.length;
  const countEl = main.querySelector('[data-bulk-count]');
  if (countEl) countEl.textContent = String(count);
  main.querySelectorAll('[data-bulk-act]').forEach(btn => {
    btn.disabled = count === 0;
  });
  // Keep header checkboxes consistent with row state per kind.
  for (const kind of ['labour', 'expense']) {
    const all = main.querySelectorAll(`input.bulk-row[data-kind="${kind}"]`);
    const checked = main.querySelectorAll(`input.bulk-row[data-kind="${kind}"]:checked`);
    const head = main.querySelector(`[data-select-all-kind="${kind}"]`);
    if (head) {
      head.checked = all.length > 0 && checked.length === all.length;
      head.indeterminate = checked.length > 0 && checked.length < all.length;
    }
  }
}

function bindBulkCheckboxes(main) {
  main.querySelectorAll('[data-select-all-kind]').forEach(head => {
    head.addEventListener('change', () => {
      const kind = head.dataset.selectAllKind;
      main.querySelectorAll(`input.bulk-row[data-kind="${kind}"]`).forEach(cb => {
        cb.checked = head.checked;
      });
      updateActionBar(main);
    });
  });
  main.querySelectorAll('input.bulk-row').forEach(cb => {
    cb.addEventListener('change', () => updateActionBar(main));
  });
}

function bindActionBar(main, ctx) {
  main.querySelectorAll('[data-bulk-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const selected = getSelectedRows(main);
      if (selected.length === 0) return;
      if (btn.dataset.bulkAct === 'approve') bulkApprove(selected, ctx);
      else if (btn.dataset.bulkAct === 'reject') bulkReject(main, selected, ctx);
    });
  });
}

async function bulkApprove(selected, ctx) {
  if (!confirm(`Approve ${selected.length} selected ${selected.length === 1 ? 'entry' : 'entries'}? This cannot be undone.`)) return;
  const results = await Promise.allSettled(selected.map(({ kind, id }) => {
    const path = kind === 'labour' ? `/api/labour/${id}/approve` : `/api/expenses/${id}/approve`;
    return api('POST', path);
  }));
  reportBulkResult(results);
  ctx.render();
}

function bulkReject(main, selected, ctx) {
  const host = main.querySelector('#bulk-action-bar');
  // Re-render the bar with an inline reason textarea instead of a native
  // prompt — the per-row rejection editor already does the same thing for
  // single rows.
  host.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:0.4rem; width:100%">
      <div><strong>${selected.length}</strong> selected · enter a single rejection reason (applied to all)</div>
      <textarea data-bulk-reason rows="2" style="width:100%; box-sizing:border-box"
                placeholder="Why these entries are being rejected (visible to the submitter)"></textarea>
      <div class="actions">
        <button class="small danger" data-bulk-reject-go>Reject ${selected.length}</button>
        <button class="small secondary" data-bulk-reject-cancel>Cancel</button>
      </div>
    </div>
  `;
  const textarea = host.querySelector('[data-bulk-reason]');
  textarea.focus();
  host.querySelector('[data-bulk-reject-cancel]').addEventListener('click', () => ctx.render());
  host.querySelector('[data-bulk-reject-go]').addEventListener('click', async () => {
    const reason = (textarea.value || '').trim();
    if (!reason) { alert('Rejection reason required'); return; }
    if (!confirm(`Reject ${selected.length} selected ${selected.length === 1 ? 'entry' : 'entries'} with this reason?`)) return;
    const results = await Promise.allSettled(selected.map(({ kind, id }) => {
      const path = kind === 'labour' ? `/api/labour/${id}/reject` : `/api/expenses/${id}/reject`;
      return api('POST', path, { reason });
    }));
    reportBulkResult(results);
    ctx.render();
  });
}

function reportBulkResult(results) {
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  if (fail > 0) {
    const firstErr = results.find(r => r.status === 'rejected')?.reason?.message ?? 'unknown error';
    alert(`${ok} succeeded, ${fail} failed.\nFirst error: ${firstErr}`);
  }
}

// --- per-row actions (unchanged behaviour) ---------------------------------

function bindReviewActions(main, ctx) {
  main.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        switch (btn.dataset.act) {
          case 'approve-labour':  await api('POST', `/api/labour/${id}/approve`); ctx.render(); break;
          case 'approve-expense': await api('POST', `/api/expenses/${id}/approve`); ctx.render(); break;
          case 'reject-labour':   openRejectEditor(main, 'labour',  id, ctx); break;
          case 'reject-expense':  openRejectEditor(main, 'expense', id, ctx); break;
        }
      } catch (e) { alert(e.message); }
    });
  });
}

// Toggle an inline editor under the row so the admin can type a rejection
// reason without a modal dialog. Multiple rows may be open simultaneously
// — admins often want to compose several rejections before committing.
function openRejectEditor(main, kind, id, ctx) {
  const row  = document.getElementById(`reject-row-${kind}-${id}`);
  if (!row) return;
  const cell = row.querySelector('td');
  if (!row.hidden) { row.hidden = true; cell.innerHTML = ''; return; }

  cell.innerHTML = `
    <form data-reject-form="${kind}-${id}" class="reject-editor" style="padding:0.6rem 0.9rem; background:#fafbfc; border:1px solid var(--border); border-radius:4px">
      <label style="display:block; font-size:0.88rem; margin-bottom:0.3rem">Rejection reason</label>
      <textarea name="reason" rows="2" required style="width:100%; box-sizing:border-box" placeholder="Why this entry is being rejected (visible to the submitter)"></textarea>
      <div class="actions" style="margin-top:0.4rem">
        <button type="submit" class="small danger">Submit rejection</button>
        <button type="button" class="small secondary" data-reject-cancel>Cancel</button>
      </div>
    </form>
  `;
  row.hidden = false;
  const form = cell.querySelector('form');
  form.querySelector('textarea').focus();

  cell.querySelector('[data-reject-cancel]').addEventListener('click', () => {
    row.hidden = true;
    cell.innerHTML = '';
  });

  onSubmit(form, async fd => {
    const reason = (fd.get('reason') || '').trim();
    if (!reason) throw new Error('Rejection reason required');
    const url = kind === 'labour'
      ? `/api/labour/${id}/reject`
      : `/api/expenses/${id}/reject`;
    await api('POST', url, { reason });
    ctx.render();
  });
}
