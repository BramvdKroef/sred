// User detail subview — opened when the URL hash is #employees/<id>. Shows
// the employee header (name, role, status, email, counts), their claimant
// attachments with latest compensation, their active project assignments,
// and a slice of recent activity. Click-through on a project row jumps to
// #projects/<id> via ctx.selectProject.

import { api, esc, cents, activityHtml, wireActivityDetails, statusPill,
         TYPE_LABEL, STATUS_LABEL } from '../../api.js';

export async function renderUserDetail(main, ctx) {
  main.innerHTML = '<p class="empty">Loading employee…</p>';
  const userId = ctx.state.viewingUserId;
  const [bundle, activity] = await Promise.all([
    api('GET', `/api/users/${userId}`),
    api('GET', `/api/activity?user_id=${userId}&limit=25`),
  ]);
  main.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>
          <a href="#users" class="muted breadcrumb-link">← Employees</a>
          &nbsp;/&nbsp; ${esc(bundle.name)}
        </h2>
        <div class="row gap-sm">
          <span class="role">${esc(bundle.role)}</span>
          ${statusPill(bundle.status)}
        </div>
      </div>
      <div class="row meta-strip">
        <span><strong>${esc(bundle.email)}</strong></span>
        <span>Created ${esc(bundle.created_at)}</span>
        <span>${bundle.attachments.length} attachment${bundle.attachments.length === 1 ? '' : 's'}</span>
        <span>${bundle.projects.length} active project${bundle.projects.length === 1 ? '' : 's'}</span>
      </div>
    </div>

    <div class="card compact">
      <h2>Claimant attachments</h2>
      ${bundle.attachments.length === 0
        ? '<p class="empty">Not attached to any claimant.</p>'
        : `<table>
            <thead><tr><th>Claimant</th><th>Title</th><th>Specified</th><th>Status</th><th>Latest compensation</th></tr></thead>
            <tbody>${bundle.attachments.map(a => {
              const latest = (a.compensation_history ?? [])[0];
              const compStr = latest
                ? `${cents(latest.amount_cents)} ${latest.comp_type === 'salary' ? '/yr' : '/hr'}  <span class="muted">from ${esc(latest.effective_from)}</span>`
                : '<span class="muted">none</span>';
              return `<tr>
                <td>${esc(a.claimant_name)}</td>
                <td>${esc(a.title ?? '—')}</td>
                <td>${a.is_specified_employee ? '✓' : ''}</td>
                <td>${statusPill(a.status)}</td>
                <td>${compStr}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>`}
    </div>

    <div class="card compact">
      <h2>Active project assignments (${bundle.projects.length})</h2>
      ${bundle.projects.length === 0
        ? '<p class="empty">Not assigned to any active projects.</p>'
        : `<table class="rows-clickable">
            <thead><tr><th>Project</th><th>Claimant</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>${bundle.projects.map(p => `
              <tr data-open-project="${p.id}" data-cid="${p.claimant_id}">
                <td><strong>${esc(p.title)}</strong></td>
                <td>${esc(p.claimant_name)}</td>
                <td><span class="pill kind-${esc(p.type)}">${esc(TYPE_LABEL[p.type] ?? p.type)}</span></td>
                <td><span class="pill status-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span></td>
              </tr>`).join('')}</tbody>
          </table>`}
    </div>

    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: false, showProject: true, showOpen: true })}
    </div>
  `;
  wireActivityDetails(main);
  document.querySelectorAll('[data-open-project]').forEach(tr => {
    tr.addEventListener('click', () => {
      ctx.selectProject({ id: Number(tr.dataset.openProject), claimant_id: Number(tr.dataset.cid) });
    });
  });
}
