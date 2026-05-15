import { api, esc, cents, dollarsToCents, onSubmit, wireJwtDownloads, safeHref, lockReason, statusPill } from '../api.js';

// Pure reducer over the three lists currently in state. Sums approved-vs-
// pending hours, expense amounts (in cents, grouped per-currency since FX
// rates aren't always populated and currencies don't add up at face value),
// and an evidence row count. Exported for unit tests.
export function periodTotals(labour, expenses, evidence) {
  const hours = { approved: 0, pending: 0 };
  for (const l of labour ?? []) {
    if (l.status === 'approved')      hours.approved += Number(l.hours) || 0;
    else if (l.status === 'pending')  hours.pending  += Number(l.hours) || 0;
  }
  // amount_cents bucketed by currency. mixed-currency totals are surfaced
  // per-currency rather than fudged through an FX conversion — claimant
  // reporting_currency lives on the claimant, but FX is per-expense and may
  // be null on pending entries.
  const amountByCurrency = {};
  for (const e of expenses ?? []) {
    if (e.status !== 'approved' && e.status !== 'pending') continue;
    const cur = e.currency || 'CAD';
    if (!amountByCurrency[cur]) amountByCurrency[cur] = { approved: 0, pending: 0 };
    if (e.status === 'approved') amountByCurrency[cur].approved += Number(e.amount_cents) || 0;
    else                         amountByCurrency[cur].pending  += Number(e.amount_cents) || 0;
  }
  return {
    hours,
    amountByCurrency,
    evidenceCount: (evidence ?? []).length,
  };
}

export function render(main, ctx) {
  const { state } = ctx;
  const projTitle = id => state.projects.find(p => p.id === id)?.title ?? `#${id}`;
  main.innerHTML = `
    <div class="card">
      <h2>Assigned projects</h2>
      ${state.projects.length === 0 ? '<p class="empty">No project assignments yet — ask your admin.</p>' : `
      <table class="table-stack">
        <thead><tr><th>Project</th><th>Claimant</th><th>Status</th></tr></thead>
        <tbody>${state.projects.map(p => `
          <tr><td data-label="Project">${esc(p.title)}</td><td data-label="Claimant">${esc(p.claimant_name)}</td><td data-label="Status">${statusPill(p.status)}</td></tr>
        `).join('')}</tbody>
      </table>`}
    </div>
    ${periodSelectorCard(state)}
    ${totalsCard(state)}
    <div class="card">
      <h2>My labour (${state.labour.length})</h2>
      ${state.labour.length === 0 ? '<p class="empty">No entries.</p>' : `
      <table class="table-stack">
        <thead><tr><th>Date</th><th>Project</th><th>Claimant</th><th>Hours</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${state.labour.map(e => {
          const reason = lockReason(e);
          const editable = reason === null;
          return `
          <tr>
            <td data-label="Date">${esc(e.work_date)}</td>
            <td data-label="Project">${esc(projTitle(e.project_id))}</td>
            <td data-label="Claimant">${esc(e.claimant_name ?? '')}</td>
            <td data-label="Hours">${e.hours}${e.is_overtime ? ' <span class="pill overtime">OT</span>' : ''}</td>
            <td data-label="Description">${esc(e.description)}</td>
            <td data-label="Status">${statusPill(e.status)}${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
            <td class="actions">${editable ? `<button class="small secondary" data-edit-labour="${e.id}">Edit</button>` : lockPill(reason)}</td>
          </tr>
          ${editable ? `<tr id="row-edit-labour-${e.id}" hidden><td colspan="7">${labourEditForm(e)}</td></tr>` : ''}
          `;
        }).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My expenses (${state.expenses.length})</h2>
      ${state.expenses.length === 0 ? '<p class="empty">None.</p>' : `
      <table class="table-stack">
        <thead><tr><th>Date</th><th>Project</th><th>Claimant</th><th>Category</th><th>Amount</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${state.expenses.map(e => {
          const reason = lockReason(e);
          const editable = reason === null;
          return `
          <tr>
            <td data-label="Date">${esc(e.expense_date)}</td>
            <td data-label="Project">${esc(projTitle(e.project_id))}</td>
            <td data-label="Claimant">${esc(e.claimant_name ?? '')}</td>
            <td data-label="Category">${esc(e.category)}</td>
            <td data-label="Amount">${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td data-label="Description">${esc(e.description)}</td>
            <td data-label="Status">${statusPill(e.status)}${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
            <td class="actions">${editable ? `<button class="small secondary" data-edit-expense="${e.id}">Edit</button>` : lockPill(reason)}</td>
          </tr>
          ${editable ? `<tr id="row-edit-expense-${e.id}" hidden><td colspan="8">${expenseEditForm(e)}</td></tr>` : ''}
          `;
        }).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My evidence (${state.evidence.length})</h2>
      ${state.evidence.length === 0 ? '<p class="empty">None.</p>' : `
      <table class="table-stack">
        <thead><tr><th>Date</th><th>Project</th><th>Claimant</th><th>Kind</th><th>Caption</th><th>Reference</th><th></th></tr></thead>
        <tbody>${state.evidence.map(e => `
          <tr>
            <td data-label="Date">${esc(e.evidence_date)}</td>
            <td data-label="Project">${esc(projTitle(e.project_id))}</td>
            <td data-label="Claimant">${esc(e.claimant_name ?? '')}</td>
            <td data-label="Kind">${esc(e.kind)}</td>
            <td data-label="Caption">${esc(e.caption)}</td>
            <td data-label="Reference">${e.kind === 'file'
                  ? `<a href="/api/evidence/${e.id}/download" data-jwt-dl>${esc(e.file_path)}</a>`
                  : e.kind === 'link' ? `<a href="${esc(safeHref(e.url))}" target="_blank" rel="noopener">${esc(e.url)}</a>`
                  : `<span class="muted">${esc(e.note_text)}</span>`}</td>
            <td class="actions"><button class="small secondary" data-edit-evidence="${e.id}">Edit</button></td>
          </tr>
          <tr id="row-edit-evidence-${e.id}" hidden><td colspan="7">${evidenceEditForm(e)}</td></tr>
          `).join('')}
        </tbody>
      </table>`}
    </div>
  `;
  bindActivity(main, ctx);
  wireJwtDownloads(main);
}

// Render a "why this row is read-only" pill. Uses .pill.approved /
// .pill.closed colour tokens that already exist in style.css.
function lockPill(reason) {
  if (reason === 'approved')      return '<span class="pill approved">approved</span>';
  if (reason === 'period closed') return '<span class="pill closed">period closed</span>';
  return '<span class="muted">locked</span>';
}

// --- Period selector + totals card ---------------------------------------

// Single source of truth: one <select> drives the labour, expense, and
// evidence tables. Periods are grouped by claimant via <optgroup> so a
// multi-claimant employee can tell which fiscal year is which.
function periodSelectorCard(state) {
  if (!state.periods || state.periods.length === 0) {
    // No periods at all (likely no claimant attachments). Skip the card.
    return '';
  }
  // Group periods by claimant_name preserving insertion order.
  const byClaimant = new Map();
  for (const p of state.periods) {
    const key = p.claimant_name ?? `Claimant #${p.claimant_id}`;
    if (!byClaimant.has(key)) byClaimant.set(key, []);
    byClaimant.get(key).push(p);
  }
  const selected = state.periodFilter;
  const groups = [...byClaimant.entries()].map(([cname, periods]) => `
    <optgroup label="${esc(cname)}">
      ${periods.map(p => `
        <option value="${p.id}" ${selected === p.id ? 'selected' : ''}>
          ${esc(p.start_date)} → ${esc(p.end_date)}${p.status === 'closed' ? ' (closed)' : ''}
        </option>`).join('')}
    </optgroup>
  `).join('');
  return `
    <div class="card">
      <div class="row gap-lg wrap">
        <label for="period-filter"><strong>Period</strong></label>
        <select id="period-filter">
          <option value="">All periods</option>
          ${groups}
        </select>
        <span class="muted">Filters labour, expenses, and evidence below.</span>
      </div>
    </div>`;
}

// Compact metrics card above the labour table. Hours and amount split into
// approved/pending sub-figures; expense totals are per-currency since the
// data set may contain entries in different currencies (CAD vs USD etc.).
function totalsCard(state) {
  // Skip if there are zero periods (i.e. the selector wasn't rendered).
  if (!state.periods || state.periods.length === 0) return '';
  const t = periodTotals(state.labour, state.expenses, state.evidence);
  const scopeLabel = state.periodFilter
    ? (() => {
        const p = state.periods.find(p => p.id === state.periodFilter);
        return p ? `${p.start_date} → ${p.end_date}` : `period #${state.periodFilter}`;
      })()
    : 'all periods';
  const currencies = Object.keys(t.amountByCurrency);
  const amountBlocks = currencies.length === 0
    ? `<div><div class="metric">0.00</div><div class="muted">expenses</div></div>`
    : currencies.map(cur => {
        const v = t.amountByCurrency[cur];
        return `<div>
          <div class="metric">${(v.approved / 100).toFixed(2)} <span class="ccy-suffix">${esc(cur)}</span></div>
          <div class="muted">expenses approved${v.pending ? ` · ${(v.pending / 100).toFixed(2)} pending` : ''}</div>
        </div>`;
      }).join('');
  return `
    <div class="card">
      <h2>Totals — <span class="muted totals-scope">${esc(scopeLabel)}</span></h2>
      <div class="metrics">
        <div>
          <div class="metric">${t.hours.approved.toFixed(2)}</div>
          <div class="muted">hours approved${t.hours.pending ? ` · ${t.hours.pending.toFixed(2)} pending` : ''}</div>
        </div>
        ${amountBlocks}
        <div>
          <div class="metric">${t.evidenceCount}</div>
          <div class="muted">evidence item${t.evidenceCount === 1 ? '' : 's'}</div>
        </div>
      </div>
    </div>`;
}

// --- Inline row-edit forms (one per type) ---------------------------------

function labourEditForm(e) {
  return `<form data-form-edit-labour="${e.id}" class="row gap-md inline-edit-row">
    <div><label>Date <input type="date" name="work_date" value="${esc(e.work_date)}" required></label></div>
    <div><label>Hours <input type="number" name="hours" step="0.25" min="0.25" max="24" value="${e.hours}" required class="w-hours"></label></div>
    <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime" ${e.is_overtime ? 'checked' : ''}> Overtime</label></div>
    <div class="input-grow"><label>Description <input name="description" value="${esc(e.description)}" required></label></div>
    <div><label>&nbsp;</label><div class="row gap-sm"><button class="small">Save labour entry</button><button type="button" class="small secondary" data-cancel-labour="${e.id}">Cancel</button></div></div>
  </form>`;
}

function expenseEditForm(e) {
  const cats = ['material','contract','third_party_payment','overhead'];
  return `<form data-form-edit-expense="${e.id}" class="row gap-md inline-edit-row wrap">
    <div><label>Date <input type="date" name="expense_date" value="${esc(e.expense_date)}" required></label></div>
    <div><label>Category <select name="category">${cats.map(c =>
      `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
    <div><label>Amount <span class="muted">(${esc(e.currency)})</span> <input type="number" step="0.01" min="0" name="amount" value="${(e.amount_cents / 100).toFixed(2)}" required class="w-amount"></label></div>
    <div><label>Currency <input name="currency" value="${esc(e.currency)}" required class="w-ccy"></label></div>
    <div><label>FX rate <input type="number" step="0.0001" name="fx_rate" value="${e.fx_rate ?? ''}" class="w-hours"></label></div>
    <div class="input-grow"><label>Description <input name="description" value="${esc(e.description)}" required></label></div>
    <div><label>&nbsp;</label><div class="row gap-sm"><button class="small">Save expense</button><button type="button" class="small secondary" data-cancel-expense="${e.id}">Cancel</button></div></div>
  </form>`;
}

function evidenceEditForm(e) {
  return `<form data-form-edit-evidence="${e.id}" class="row gap-md inline-edit-row wrap">
    <div><label>Date <input type="date" name="evidence_date" value="${esc(e.evidence_date)}" required></label></div>
    <div class="input-grow"><label>Caption <input name="caption" value="${esc(e.caption)}" required></label></div>
    ${e.kind === 'link' ? `<div class="input-grow"><label>URL <input type="url" name="url" value="${esc(e.url ?? '')}" required></label></div>` : ''}
    ${e.kind === 'note' ? `<div class="flex-full"><label>Note <textarea name="note_text" rows="2" required>${esc(e.note_text ?? '')}</textarea></label></div>` : ''}
    ${e.kind === 'file' ? `<div><label>&nbsp;</label><span class="muted">file content not editable</span></div>` : ''}
    <div><label>&nbsp;</label><div class="row gap-sm"><button class="small">Save evidence</button><button type="button" class="small secondary" data-cancel-evidence="${e.id}">Cancel</button></div></div>
  </form>`;
}

// --- Bindings: row-edit toggles + form submits ----------------------------

function bindActivity(main, ctx) {
  const sel = main.querySelector('#period-filter');
  if (sel) sel.addEventListener('change', () => {
    const v = sel.value;
    ctx.setPeriodFilter(v === '' ? null : Number(v));
  });

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
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 1234.56).');
    const body = {
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: amountCents,
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
