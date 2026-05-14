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
            <details style="margin-top:0.5rem">
              <summary class="summary-link">＋ Attach evidence (optional)</summary>
              <div class="grid" style="margin-top:0.5rem">
                <div><label>Kind
                  <select name="ev_kind" class="ev-kind">
                    <option value="">— none —</option>
                    <option value="file">File</option>
                    <option value="link">Link</option>
                  </select>
                </label></div>
                <div style="flex:1"><label>Caption <input name="ev_caption"></label></div>
                <div class="full ev-file" hidden><label>File <input type="file" name="ev_file"></label></div>
                <div class="full ev-url"  hidden><label>URL <input type="url" name="ev_url" placeholder="https://…"></label></div>
              </div>
            </details>
            <p class="muted" style="margin:0.7rem 0 0.3rem"><span class="pill approved">As an admin, this entry will be saved as approved and skip the review queue.</span></p>
            <div class="actions" style="margin-top:0.3rem"><button class="small">Add labour entry</button></div>
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
                <select name="category">
                  <option value="material">material</option>
                  <option value="contract">contract</option>
                  <option value="third_party_payment">third-party payment</option>
                  <option value="overhead">overhead</option>
                </select>
              </label></div>
              <div><label>Amount <span class="muted">(${esc(reportingCcy)})</span> <input type="number" step="0.01" name="amount" min="0" placeholder="e.g. 1234.56" required></label></div>
              <div><label>Currency <input name="currency" value="${esc(reportingCcy)}" required></label></div>
              <div><label>FX rate (if not ${esc(reportingCcy)}) <input type="number" step="0.0001" name="fx_rate"></label></div>
              <div class="full"><label>Description <textarea name="description" rows="2" required></textarea></label></div>
            </div>
            <details style="margin-top:0.5rem" open>
              <summary class="summary-link">＋ Attach receipt (optional, strongly encouraged)</summary>
              <div class="grid" style="margin-top:0.5rem">
                <div style="flex:1"><label>Caption <input name="receipt_caption" placeholder="e.g. Invoice #INV-..."></label></div>
                <div class="full"><label>File <input type="file" name="receipt_file"></label></div>
              </div>
            </details>
            <p class="muted" style="margin:0.7rem 0 0.3rem"><span class="pill approved">As an admin, this entry will be saved as approved and skip the review queue.</span></p>
            <div class="actions" style="margin-top:0.3rem"><button class="small">Add expense</button></div>
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

  onSubmit(document.getElementById('form-behalf-expense'), async fd => {
    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 1234.56).');
    const body = {
      project_id: project.id,
      user_claimant_id: Number(fd.get('user_claimant_id')),
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: amountCents,
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    if (fx) body.fx_rate = Number(fx);
    const entry = await api('POST', '/api/expenses', body);
    await attachInlineReceipt(fd, { project_id: entry.project_id, expense_id: entry.id, evidence_date: entry.expense_date });
    ctx.render();
  });
}
