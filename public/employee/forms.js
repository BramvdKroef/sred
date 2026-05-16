import { api, apiUpload, esc, cents, dollarsToCents, bindForm, onSubmit,
         attachInlineEvidence, attachInlineReceipt, bindEvidenceKindToggle } from '../api.js';

// Render-one + bind-one wrappers. Each entry-form sets state.tab to
// 'activity' after a successful submit so the new row is immediately
// visible.

const projectSelect = (state) => state.projects.length === 0
  ? '<p class="empty">No assigned projects.</p>'
  : `<select name="project_id" required>${state.projects.map(p =>
      `<option value="${p.id}">${esc(p.title)} (${esc(p.claimant_name)})</option>`).join('')}</select>`;

// --- Log labour -----------------------------------------------------------

export function renderLabour(main, ctx) {
  main.innerHTML = `<div class="card">
    <h2>Log labour</h2>
    <form id="labour-form">
      <div class="grid">
        <div><label>Project ${projectSelect(ctx.state)}</label></div>
        <div><label>Date <input type="date" name="work_date" required></label></div>
        <div><label>Hours <input type="number" name="hours" step="0.25" min="0.25" max="24" required></label></div>
        <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime"> Overtime</label></div>
        <div class="full"><label>Description <textarea name="description" rows="2" required></textarea></label></div>
      </div>
      <details class="attach-block mt-sm">
        <summary class="summary-link">＋ Attach evidence (optional)</summary>
        <div class="grid mt-sm">
          <div><label>Kind
            <select name="ev_kind" class="ev-kind">
              <option value="">— none —</option>
              <option value="file">File</option>
              <option value="link">Link</option>
            </select>
          </label></div>
          <div class="flex-1"><label>Caption <input name="ev_caption" placeholder="What this evidence shows"></label></div>
          <div class="full ev-file" hidden><label>File <input type="file" name="ev_file"></label></div>
          <div class="full ev-url"  hidden><label>URL <input type="url" name="ev_url" placeholder="https://…"></label></div>
        </div>
      </details>
      <div class="actions mt-md"><button>Add labour entry</button></div>
    </form>
  </div>`;

  bindForm('#labour-form', async fd => {
    const entry = await api('POST', '/api/labour', {
      project_id: Number(fd.get('project_id')),
      work_date: fd.get('work_date'),
      hours: Number(fd.get('hours')),
      description: fd.get('description'),
      is_overtime: fd.get('is_overtime') === 'on',
    });
    await attachInlineEvidence(fd, { project_id: entry.project_id, labour_entry_id: entry.id, evidence_date: entry.work_date });
    ctx.state.tab = 'activity';
    await ctx.reload();
  });
  document.querySelectorAll('form').forEach(bindEvidenceKindToggle);
}

// --- Add evidence ---------------------------------------------------------

export function renderEvidence(main, ctx) {
  const { state } = ctx;
  const summarize = (s, n = 40) => (s ?? '').length > n ? (s.slice(0, n) + '…') : (s ?? '');
  const labourOpts = state.labour.map(l =>
    `<option value="labour:${l.id}">${esc(l.work_date)} · ${l.hours}h · ${esc(summarize(l.description))}</option>`).join('');
  const expenseOpts = state.expenses.map(e =>
    `<option value="expense:${e.id}">${esc(e.expense_date)} · ${cents(e.amount_cents)} ${esc(e.currency)} · ${esc(summarize(e.description))}</option>`).join('');

  main.innerHTML = `<div class="card">
    <h2>Add evidence</h2>
    <form id="evidence-form">
      <div class="grid">
        <div><label>Project ${projectSelect(state)}</label></div>
        <div><label>Date <input type="date" name="evidence_date" required></label></div>
        <div><label>Kind
          <select name="kind" id="ev-kind">
            <option value="file">File</option>
            <option value="link">Link</option>
            <option value="note">Note</option>
          </select>
        </label></div>
        <div class="full"><label>Caption <input name="caption" required></label></div>
        <div class="full">
          <label>Attach to (optional)
            <select name="attach_to">
              <option value="">— none (project-level) —</option>
              ${labourOpts ? `<optgroup label="Labour entries">${labourOpts}</optgroup>` : ''}
              ${expenseOpts ? `<optgroup label="Expenses">${expenseOpts}</optgroup>` : ''}
            </select>
          </label>
        </div>
        <div class="full" id="ev-file"><label>File <input type="file" name="file"></label></div>
        <div class="full" id="ev-url" hidden><label>URL <input type="url" name="url" placeholder="https://…"></label></div>
        <div class="full" id="ev-note" hidden><label>Note <textarea name="note_text" rows="3"></textarea></label></div>
      </div>
      <div class="actions"><button>Add evidence</button></div>
    </form>
  </div>`;

  const evKind = document.getElementById('ev-kind');
  if (evKind) evKind.addEventListener('change', () => {
    const k = evKind.value;
    document.getElementById('ev-file').hidden = k !== 'file';
    document.getElementById('ev-url').hidden  = k !== 'link';
    document.getElementById('ev-note').hidden = k !== 'note';
  });

  onSubmit(document.getElementById('evidence-form'), async fd => {
    const attach = (fd.get('attach_to') || '').split(':');
    const labourEntryId = attach[0] === 'labour'  ? Number(attach[1]) : null;
    const expenseId     = attach[0] === 'expense' ? Number(attach[1]) : null;

    if (fd.get('kind') === 'file') {
      if (labourEntryId) fd.append('labour_entry_id', String(labourEntryId));
      if (expenseId)     fd.append('expense_id',     String(expenseId));
      await apiUpload('/api/evidence', fd);
    } else {
      const body = {
        project_id: Number(fd.get('project_id')),
        kind: fd.get('kind'),
        caption: fd.get('caption'),
        evidence_date: fd.get('evidence_date'),
      };
      if (labourEntryId) body.labour_entry_id = labourEntryId;
      if (expenseId)     body.expense_id     = expenseId;
      if (body.kind === 'link') body.url = fd.get('url');
      if (body.kind === 'note') body.note_text = fd.get('note_text');
      await api('POST', '/api/evidence', body);
    }
    ctx.state.tab = 'activity';
    await ctx.reload();
  });
}

// --- Submit expense -------------------------------------------------------

export function renderExpense(main, ctx) {
  main.innerHTML = `<div class="card">
    <h2>Submit expense</h2>
    <form id="expense-form">
      <div class="grid">
        <div><label>Project ${projectSelect(ctx.state)}</label></div>
        <div><label>Date <input type="date" name="expense_date" required></label></div>
        <div><label>Category
          <select name="category" data-expense-category>
            <option value="material">material</option>
            <option value="contract">contract</option>
            <option value="third_party_payment">third-party payment</option>
            <option value="overhead">overhead</option>
          </select>
        </label></div>
        <div><label>Amount <span class="muted" data-amount-unit>(CAD)</span> <input type="number" step="0.01" name="amount" min="0" placeholder="e.g. 1234.56" required></label></div>
        <div><label>Currency <input name="currency" value="CAD" data-currency-input></label></div>
        <div><label>FX rate (if not reporting currency) <input type="number" step="0.0001" name="fx_rate" data-fx-rate-input></label></div>
        <div class="full"><label>Description <textarea name="description" rows="2" required></textarea></label></div>
        <div data-overhead-only hidden><label>Overhead type
          <select name="overhead_subcategory">
            <option value="rent">rent</option>
            <option value="utilities">utilities</option>
            <option value="maintenance">maintenance</option>
            <option value="supporting_salaries">supporting salaries</option>
            <option value="other">other</option>
          </select>
        </label></div>
        <div class="full" data-overhead-only hidden><label>Allocation basis <input name="allocation_basis" placeholder="e.g. 30% of total floor area"></label></div>
        <div data-material-only hidden><label>Disposition
          <select name="material_disposition">
            <option value="consumed">consumed (T661 line 320)</option>
            <option value="transformed">transformed into product (T661 line 325)</option>
          </select>
        </label></div>
        <div data-contract-only hidden><label>Arm's-length contractor
          <select name="contract_arms_length">
            <option value="1">yes — arm's length</option>
            <option value="0">no — non-arm's-length</option>
          </select>
        </label></div>
        <div class="full" data-fx-rate-source-only hidden><label>FX-rate source <input name="fx_rate_source" placeholder="e.g. Bank of Canada noon rate, 2026-03-15"></label></div>
      </div>
      <details class="attach-block mt-sm" open>
        <summary class="summary-link">＋ Attach receipt (optional, strongly encouraged)</summary>
        <div class="grid mt-sm">
          <div class="flex-1"><label>Caption <input name="receipt_caption" placeholder="e.g. Invoice #INV-2026-0312"></label></div>
          <div class="full"><label>File <input type="file" name="receipt_file"></label></div>
        </div>
      </details>
      <div class="actions mt-md"><button>Add expense</button></div>
    </form>
  </div>`;

  // Reflect the currency input into the amount-unit suffix.
  const expForm = document.getElementById('expense-form');
  const ccyInput = expForm?.querySelector('[data-currency-input]');
  const unitEl   = expForm?.querySelector('[data-amount-unit]');
  if (ccyInput && unitEl) {
    const sync = () => { unitEl.textContent = `(${(ccyInput.value || 'CAD').toUpperCase()})`; };
    ccyInput.addEventListener('input', sync);
    sync();
  }
  // Toggle the category-conditional fields (overhead / material / contract)
  // when the category select changes, and the fx-rate-source field when the
  // FX rate input gains/loses a value. Migration 014 added overhead; 015
  // added material disposition, contract arms-length flag, and fx-rate
  // attribution.
  const catSel = expForm?.querySelector('[data-expense-category]');
  const fxInput = expForm?.querySelector('[data-fx-rate-input]');
  if (catSel) {
    const overheadDivs = expForm.querySelectorAll('[data-overhead-only]');
    const materialDivs = expForm.querySelectorAll('[data-material-only]');
    const contractDivs = expForm.querySelectorAll('[data-contract-only]');
    const fxSourceDivs = expForm.querySelectorAll('[data-fx-rate-source-only]');
    const syncCategory = () => {
      const c = catSel.value;
      overheadDivs.forEach(d => { d.hidden = c !== 'overhead'; });
      materialDivs.forEach(d => { d.hidden = c !== 'material'; });
      contractDivs.forEach(d => { d.hidden = c !== 'contract'; });
    };
    const syncFx = () => {
      const has = fxInput && fxInput.value && Number(fxInput.value) > 0;
      fxSourceDivs.forEach(d => { d.hidden = !has; });
    };
    catSel.addEventListener('change', syncCategory);
    if (fxInput) fxInput.addEventListener('input', syncFx);
    syncCategory();
    syncFx();
  }

  bindForm('#expense-form', async fd => {
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 1234.56).');
    const category = fd.get('category');
    const body = {
      project_id: Number(fd.get('project_id')),
      expense_date: fd.get('expense_date'),
      category,
      amount_cents: amountCents,
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    if (fx) {
      body.fx_rate = Number(fx);
      // Migration 015 P3.3: fx_rate_source required when fx_rate is set.
      body.fx_rate_source = fd.get('fx_rate_source') || null;
    }
    if (category === 'overhead') {
      body.overhead_subcategory = fd.get('overhead_subcategory') || null;
      body.allocation_basis     = fd.get('allocation_basis') || null;
    }
    if (category === 'material') {
      body.material_disposition = fd.get('material_disposition') || null;
    }
    if (category === 'contract') {
      const v = fd.get('contract_arms_length');
      body.contract_arms_length = v === '1' ? 1 : v === '0' ? 0 : null;
    }
    const entry = await api('POST', '/api/expenses', body);
    await attachInlineReceipt(fd, { project_id: entry.project_id, expense_id: entry.id, evidence_date: entry.expense_date });
    ctx.state.tab = 'activity';
    await ctx.reload();
  });
}
