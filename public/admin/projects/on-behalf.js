// Admin "log on behalf" cards on the project detail page — labour and
// expense forms that record entries against an active assignee. Entries
// created here skip the review queue (admin actor → approved).
import { api, esc, onSubmit, dollarsToCents,
         attachInlineEvidence, attachInlineReceipt, bindEvidenceKindToggle } from '../../api.js';

export function renderLogOnBehalfCards(project, claimant) {
  const activeAssignees = project.assignments.filter(a => a.status === 'active');
  if (activeAssignees.length === 0) {
    return `<div class="card compact"><p class="empty">Assign an active employee to this project before logging labour or expenses on their behalf.</p></div>`;
  }
  const employeeOpts = activeAssignees
    .map(a => `<option value="${a.user_claimant_id}">${esc(a.name)}</option>`).join('');
  const reportingCcy = claimant?.reporting_currency ?? 'CAD';
  return `
    <div class="two-up">
      <div class="card compact">
        <div class="card-head">
          <h2>Log labour</h2>
          <button id="behalf-labour-toggle" class="secondary small">＋ New</button>
        </div>
        <div id="behalf-labour-form" hidden>
          <form id="form-behalf-labour">
            <div class="grid">
              <div class="full"><label>Employee
                <select name="user_claimant_id" required>${employeeOpts}</select>
              </label></div>
              <div><label>Date <input type="date" name="work_date" required></label></div>
              <div><label>Hours <input type="number" name="hours" step="0.25" min="0.25" max="24" required></label></div>
              <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime"> Overtime</label></div>
              <div class="full"><label>Description <textarea name="description" rows="2" required></textarea></label></div>
            </div>
            <details class="mt-sm">
              <summary class="summary-link">＋ Attach evidence (optional)</summary>
              <div class="grid mt-sm">
                <div><label>Kind
                  <select name="ev_kind" class="ev-kind">
                    <option value="">— none —</option>
                    <option value="file">File</option>
                    <option value="link">Link</option>
                  </select>
                </label></div>
                <div class="flex-1"><label>Caption <input name="ev_caption"></label></div>
                <div class="full ev-file" hidden><label>File <input type="file" name="ev_file"></label></div>
                <div class="full ev-url"  hidden><label>URL <input type="url" name="ev_url" placeholder="https://…"></label></div>
              </div>
            </details>
            <p class="muted approval-note"><span class="pill approved">As an admin, this entry will be saved as approved and skip the review queue.</span></p>
            <div class="actions mt-xs"><button class="small">Add labour entry</button></div>
          </form>
        </div>
      </div>
      <div class="card compact">
        <div class="card-head">
          <h2>Submit expense</h2>
          <button id="behalf-expense-toggle" class="secondary small">＋ New</button>
        </div>
        <div id="behalf-expense-form" hidden>
          <form id="form-behalf-expense">
            <div class="grid">
              <div class="full"><label>Employee
                <select name="user_claimant_id" required>${employeeOpts}</select>
              </label></div>
              <div><label>Date <input type="date" name="expense_date" required></label></div>
              <div><label>Category
                <select name="category" data-expense-category>
                  <option value="material">material</option>
                  <option value="contract">contract</option>
                  <option value="third_party_payment">third-party payment</option>
                  <option value="overhead">overhead</option>
                </select>
              </label></div>
              <div><label>Amount <span class="muted">(${esc(reportingCcy)})</span> <input type="number" step="0.01" name="amount" min="0" placeholder="e.g. 1234.56" required></label></div>
              <div><label>Currency <input name="currency" value="${esc(reportingCcy)}" required data-currency-input></label></div>
              <div><label>FX rate (if not ${esc(reportingCcy)}) <input type="number" step="0.0001" name="fx_rate" data-fx-rate-input></label></div>
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
            <details class="mt-sm" open>
              <summary class="summary-link">＋ Attach receipt (optional, strongly encouraged)</summary>
              <div class="grid mt-sm">
                <div class="flex-1"><label>Caption <input name="receipt_caption" placeholder="e.g. Invoice #INV-..."></label></div>
                <div class="full"><label>File <input type="file" name="receipt_file"></label></div>
              </div>
            </details>
            <p class="muted approval-note"><span class="pill approved">As an admin, this entry will be saved as approved and skip the review queue.</span></p>
            <div class="actions mt-xs"><button class="small">Add expense</button></div>
          </form>
        </div>
      </div>
    </div>
  `;
}

export function bindLogOnBehalfForms(project, ctx) {
  const lTog = document.getElementById('behalf-labour-toggle');
  const lForm = document.getElementById('behalf-labour-form');
  if (lTog && lForm) lTog.addEventListener('click', () => { lForm.hidden = !lForm.hidden; });
  const eTog = document.getElementById('behalf-expense-toggle');
  const eForm = document.getElementById('behalf-expense-form');
  if (eTog && eForm) eTog.addEventListener('click', () => { eForm.hidden = !eForm.hidden; });

  const labourFormEl = document.getElementById('form-behalf-labour');
  if (labourFormEl) {
    bindEvidenceKindToggle(labourFormEl);
    onSubmit(labourFormEl, async fd => {
      const entry = await api('POST', '/api/labour', {
        project_id: project.id,
        user_claimant_id: Number(fd.get('user_claimant_id')),
        work_date: fd.get('work_date'),
        hours: Number(fd.get('hours')),
        description: fd.get('description'),
        is_overtime: fd.get('is_overtime') === 'on',
      });
      await attachInlineEvidence(fd, { project_id: entry.project_id, labour_entry_id: entry.id, evidence_date: entry.work_date });
      ctx.render();
    });
  }

  const expenseFormEl = document.getElementById('form-behalf-expense');
  if (expenseFormEl) bindOverheadFieldsToggle(expenseFormEl);

  onSubmit(expenseFormEl, async fd => {
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 1234.56).');
    const category = fd.get('category');
    const body = {
      project_id: project.id,
      user_claimant_id: Number(fd.get('user_claimant_id')),
      expense_date: fd.get('expense_date'),
      category,
      amount_cents: amountCents,
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    if (fx) {
      body.fx_rate = Number(fx);
      // Migration 015 P3.3: fx_rate_source is required by the API when
      // fx_rate is set. Pass through the user's free-text attribution.
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
      // Wire format is a numeric 0/1 (see coerceArmsLengthFlag in the
      // expenses route). The <select> emits a string "0" / "1" which the
      // server coerces — sending the canonical int form anyway is more
      // self-describing.
      const v = fd.get('contract_arms_length');
      body.contract_arms_length = v === '1' ? 1 : v === '0' ? 0 : null;
    }
    const entry = await api('POST', '/api/expenses', body);
    await attachInlineReceipt(fd, { project_id: entry.project_id, expense_id: entry.id, evidence_date: entry.expense_date });
    ctx.render();
  });
}

// Show/hide the category-conditional fields based on the category select +
// fx-rate input. Mirrors bindEvidenceKindToggle: the caller marks the form
// with `data-expense-category` on the category <select>, `data-fx-rate-input`
// on the FX <input>, and `data-overhead-only` / `data-material-only` /
// `data-contract-only` / `data-fx-rate-source-only` on the wrapping divs
// of each conditional field group. Hidden = visually gone AND submitted
// fields are gated by the server-side category check (the route ignores
// stale values for the wrong category).
//
// Migration 015 (P3) added the material / contract / fx-rate-source groups.
function bindOverheadFieldsToggle(form) {
  const sel = form.querySelector('[data-expense-category]');
  const fxInput = form.querySelector('[data-fx-rate-input]');
  if (!sel) return;
  const overheadDivs    = form.querySelectorAll('[data-overhead-only]');
  const materialDivs    = form.querySelectorAll('[data-material-only]');
  const contractDivs    = form.querySelectorAll('[data-contract-only]');
  const fxSourceDivs    = form.querySelectorAll('[data-fx-rate-source-only]');
  const syncCategory = () => {
    const c = sel.value;
    overheadDivs.forEach(d => { d.hidden = c !== 'overhead'; });
    materialDivs.forEach(d => { d.hidden = c !== 'material'; });
    contractDivs.forEach(d => { d.hidden = c !== 'contract'; });
  };
  const syncFx = () => {
    const has = fxInput && fxInput.value && Number(fxInput.value) > 0;
    fxSourceDivs.forEach(d => { d.hidden = !has; });
  };
  sel.addEventListener('change', syncCategory);
  if (fxInput) fxInput.addEventListener('input', syncFx);
  syncCategory();
  syncFx();
}
