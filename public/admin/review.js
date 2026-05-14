import { api, esc, cents, onSubmit } from '../api.js';

export async function render(main, ctx) {
  main.innerHTML = '<p class="empty">Loading review queue…</p>';
  const [labour, expenses] = await Promise.all([
    api('GET', '/api/labour?status=pending'),
    api('GET', '/api/expenses?status=pending'),
  ]);
  main.innerHTML = `
    <div class="card">
      <h2>Pending labour (${labour.items.length})</h2>
      ${labour.items.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Employee</th><th>Hours</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${labour.items.map(e => `
          <tr>
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
          <tr id="reject-row-labour-${e.id}" hidden><td colspan="6"></td></tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>Pending expenses (${expenses.items.length})</h2>
      ${expenses.items.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Employee</th><th>Category</th><th>Amount</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${expenses.items.map(e => `
          <tr>
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
          <tr id="reject-row-expense-${e.id}" hidden><td colspan="7"></td></tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `;
  bindReviewActions(main, ctx);
}

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
