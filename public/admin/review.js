import { api, esc, cents } from '../api.js';

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
        <thead><tr><th>Date</th><th>Project</th><th>UC</th><th>Hours</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${labour.items.map(e => `
          <tr>
            <td>${esc(e.work_date)}</td>
            <td>${e.project_id}</td>
            <td>${e.user_claimant_id}</td>
            <td>${e.hours}</td>
            <td>${esc(e.description)}</td>
            <td class="actions">
              <button class="small" data-act="approve-labour" data-id="${e.id}">Approve</button>
              <button class="small danger" data-act="reject-labour" data-id="${e.id}">Reject</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>Pending expenses (${expenses.items.length})</h2>
      ${expenses.items.length === 0 ? '<p class="empty">Nothing pending.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Category</th><th>Amount</th><th>Description</th><th>Actions</th></tr></thead>
        <tbody>${expenses.items.map(e => `
          <tr>
            <td>${esc(e.expense_date)}</td>
            <td>${e.project_id}</td>
            <td>${esc(e.category)}</td>
            <td>${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td>${esc(e.description)}</td>
            <td class="actions">
              <button class="small" data-act="approve-expense" data-id="${e.id}">Approve</button>
              <button class="small danger" data-act="reject-expense" data-id="${e.id}">Reject</button>
            </td>
          </tr>`).join('')}
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
          case 'approve-labour':  await api('POST', `/api/labour/${id}/approve`); break;
          case 'reject-labour': {
            const reason = prompt('Rejection reason?'); if (!reason) return;
            await api('POST', `/api/labour/${id}/reject`, { reason }); break;
          }
          case 'approve-expense': await api('POST', `/api/expenses/${id}/approve`); break;
          case 'reject-expense': {
            const reason = prompt('Rejection reason?'); if (!reason) return;
            await api('POST', `/api/expenses/${id}/reject`, { reason }); break;
          }
        }
        ctx.render();
      } catch (e) { alert(e.message); }
    });
  });
}
