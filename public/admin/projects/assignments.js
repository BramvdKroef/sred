// Project assignment management — the "＋ Assign" form plus Re-assign /
// Remove (unassign) row actions on the project detail page.
import { api, esc, onSubmit, showTopBanner } from '../../api.js';

export function renderAssignForm(project, users) {
  const activeUcIds = new Set(project.assignments.filter(a => a.status === 'active').map(a => a.user_claimant_id));
  const candidates = (users ?? []).filter(u =>
    u.user_claimant_id && !activeUcIds.has(u.user_claimant_id) && u.attachment_status === 'active'
  );
  if (candidates.length === 0) {
    return `<div id="assign-form" hidden style="margin-bottom:0.6rem">
      <p class="muted" style="font-size:0.88rem">Every active employee attached to this claimant is already assigned. Add an employee to the claimant from the Employees tab to widen the pool.</p>
    </div>`;
  }
  return `<div id="assign-form" hidden style="margin-bottom:0.6rem">
    <form id="form-assign" class="row" style="gap:0.5rem; align-items:flex-end">
      <div class="input-grow"><label>Employee
        <select name="user_claimant_id" required>
          ${candidates.map(u =>
            `<option value="${u.user_claimant_id}">${esc(u.name)} (${esc(u.role)})</option>`).join('')}
        </select>
      </label></div>
      <div><button class="small">Add assignment</button></div>
    </form>
  </div>`;
}

export function bindAssignmentForm(project, ctx) {
  const tg   = document.getElementById('assign-toggle');
  const form = document.getElementById('assign-form');
  if (tg && form) tg.addEventListener('click', () => { form.hidden = !form.hidden; });

  onSubmit(document.getElementById('form-assign'), async fd => {
    await api('POST', `/api/projects/${project.id}/assignments`, {
      user_claimant_id: Number(fd.get('user_claimant_id')),
    });
    ctx.render();
  });

  document.querySelectorAll('[data-unassign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${btn.dataset.name} from this project? Historical labour stays intact.`)) return;
      try {
        await api('DELETE', `/api/projects/${project.id}/assignments/${btn.dataset.unassign}`);
        ctx.render();
      } catch (err) { showTopBanner(err.message); }
    });
  });
  document.querySelectorAll('[data-reassign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/projects/${project.id}/assignments`, {
          user_claimant_id: Number(btn.dataset.reassign),
        });
        ctx.render();
      } catch (err) { showTopBanner(err.message); }
    });
  });
}
