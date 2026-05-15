// Project detail subview — header card + narrative + assignments table +
// on-behalf forms + revisions card + recent activity. Composes the
// per-section render/bind helpers from sibling modules.
import { api, esc, activityHtml, wireActivityDetails, statusPill,
         TYPE_LABEL, STATUS_LABEL } from '../../api.js';
import { renderEditProjectForm, bindEditProjectForm } from './edit.js';
import { renderRevisionsCard, wireRevisionsCard } from './revisions.js';
import { renderLogOnBehalfCards, bindLogOnBehalfForms } from './on-behalf.js';
import { renderAssignForm, bindAssignmentForm } from './assignments.js';

export async function renderProjectDetail(main, ctx) {
  const { state } = ctx;
  main.innerHTML = '<p class="loading">Loading project…</p>';
  const projectId = state.viewingProjectId;
  const [project, activity, revisions] = await Promise.all([
    api('GET', `/api/projects/${projectId}`),
    api('GET', `/api/activity?project_id=${projectId}&limit=25`),
    api('GET', `/api/projects/${projectId}/revisions`),
  ]);
  const claimant = state.claimants.find(c => c.id === project.claimant_id);
  main.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>
          <a href="#" id="back-to-projects" class="muted breadcrumb-link">← Projects</a>
          &nbsp;/&nbsp; ${esc(project.title)}
        </h2>
        <div class="row gap-sm">
          <button id="edit-project-toggle" class="secondary small">✎ Edit</button>
          ${statusPill(project.status)}
        </div>
      </div>
      <div class="row meta-strip">
        <span><strong>${esc(claimant?.legal_name ?? '')}</strong></span>
        <span class="pill kind-${esc(project.type)}">${esc(TYPE_LABEL[project.type] ?? project.type)}</span>
        <span class="pill status-${esc(project.status)}">${esc(STATUS_LABEL[project.status] ?? project.status)}</span>
        <span>${esc(project.field_of_science ?? '—')}</span>
        <span>Started ${esc(project.start_date)}${project.end_date ? ` → ${esc(project.end_date)}` : ''}</span>
        <span>Manager: <strong>${project.manager ? esc(project.manager.name) : '—'}</strong></span>
      </div>
    </div>

    ${renderEditProjectForm(project, state.managers)}

    <div class="card">
      <h2>Narrative</h2>
      <h3>Advancement sought</h3>
      <p>${esc(project.advancement_sought ?? '—')}</p>
      <h3>Uncertainties</h3>
      <p>${esc(project.uncertainties ?? '—')}</p>
      <h3>Work performed</h3>
      <p>${esc(project.work_performed ?? '—')}</p>
    </div>

    <div class="card compact">
      <div class="card-head">
        <h2>Assigned employees (${project.assignments.length})</h2>
        <button id="assign-toggle" class="secondary small">＋ Assign</button>
      </div>
      ${renderAssignForm(project, state.users)}
      ${project.assignments.length === 0
        ? '<p class="empty">No assignments yet.</p>'
        : `<div class="table-scroll"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
            <tbody>${project.assignments.map(a => `
              <tr>
                <td>${esc(a.name)}</td>
                <td>${esc(a.email)}</td>
                <td>${statusPill(a.status)}</td>
                <td class="actions">${a.status === 'active'
                  ? `<button class="small danger" data-unassign="${a.user_claimant_id}" data-name="${esc(a.name)}">Remove</button>`
                  : `<button class="small secondary" data-reassign="${a.user_claimant_id}">Re-assign</button>`}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>`}
    </div>

    ${renderLogOnBehalfCards(project, claimant)}

    ${renderRevisionsCard(revisions.items)}

    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(activity.items, { showActor: true, showProject: false, showOpen: true })}
    </div>
  `;
  wireActivityDetails(main, { currentUser: ctx?.state?.me?.user });
  wireRevisionsCard(main);
  document.getElementById('back-to-projects').addEventListener('click', e => {
    e.preventDefault();
    location.hash = 'projects';
  });
  bindEditProjectForm(project, ctx);
  bindLogOnBehalfForms(project, ctx);
  bindAssignmentForm(project, ctx);
}
