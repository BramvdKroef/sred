// Narrative revisions card (UC-A4). Rendered inside the project detail view.
import { esc, TYPE_LABEL } from '../../api.js';

export function renderRevisionsCard(items) {
  const count = items.length;
  if (count === 0) {
    return `
      <div class="card compact">
        <h2>Narrative revisions (0)</h2>
        <p class="empty">No narrative edits yet.</p>
      </div>`;
  }
  // Newest first; assign v<N> counting down from total so the most recent
  // edit reads as the highest version number.
  const rows = items.map((r, i) => {
    const v = count - i;
    const when = String(r.revised_at ?? '').slice(0, 10);
    const reviser = r.revised_by_name ?? '—';
    return `
      <tr>
        <td>${esc(when)}</td>
        <td><span class="pill">v${v}</span></td>
        <td>${esc(reviser)}</td>
        <td>${esc(r.title ?? '')}</td>
        <td class="actions">
          <button class="small secondary" data-open-revision="${r.id}">Open</button>
        </td>
      </tr>
      <tr id="revision-detail-${r.id}" hidden>
        <td colspan="5">${renderRevisionDetail(r)}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card compact">
      <h2>Narrative revisions (${count})</h2>
      <table>
        <thead><tr>
          <th>Date</th><th>Version</th><th>Revised by</th><th>Title</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderRevisionDetail(r) {
  const managerName = r.manager_name ?? (r.manager_user_id ? `user #${r.manager_user_id}` : '—');
  return `
    <div class="grid" style="gap:0.4rem; font-size:0.92rem">
      <div><strong>Title:</strong> ${esc(r.title ?? '—')}</div>
      <div><strong>Type:</strong> <span class="pill kind-${esc(r.type ?? '')}">${esc(TYPE_LABEL[r.type] ?? r.type ?? '—')}</span></div>
      <div><strong>Field of science:</strong> ${esc(r.field_of_science ?? '—')}</div>
      <div><strong>Manager:</strong> ${esc(managerName)}</div>
      <div class="full"><strong>Advancement sought:</strong><br>${esc(r.advancement_sought ?? '—')}</div>
      <div class="full"><strong>Uncertainties:</strong><br>${esc(r.uncertainties ?? '—')}</div>
      <div class="full"><strong>Work performed:</strong><br>${esc(r.work_performed ?? '—')}</div>
    </div>`;
}

export function wireRevisionsCard(root) {
  root.querySelectorAll('[data-open-revision]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.openRevision;
      const tr = document.getElementById(`revision-detail-${id}`);
      if (!tr) return;
      const isOpening = tr.hidden;
      tr.hidden = !tr.hidden;
      btn.textContent = isOpening ? 'Close' : 'Open';
    });
  });
}
