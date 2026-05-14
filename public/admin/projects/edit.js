// Inline edit form for the project detail view. Renders the collapsible
// edit-project card and wires its PATCH submission, including the 409
// conflict banner that fires when another admin saved a newer version.
import { api, esc } from '../../api.js';

export function renderEditProjectForm(project, managers) {
  const managerOpts = managers.map(u =>
    `<option value="${u.id}" ${u.id === project.manager_user_id ? 'selected' : ''}>${esc(u.name)} (${esc(u.role)})</option>`
  ).join('');
  const selected = (a, b) => a === b ? 'selected' : '';
  return `
    <div class="card" id="edit-project-card" hidden>
      <h2>Edit project</h2>
      <form id="form-edit-project">
        <div class="grid">
          <div class="full"><label>Title
            <input name="title" required value="${esc(project.title)}">
          </label></div>
          <div><label>Type
            <select name="type">
              <option value="sred" ${selected(project.type,'sred')}>SR&amp;ED</option>
              <option value="internal" ${selected(project.type,'internal')}>Internal</option>
            </select>
          </label></div>
          <div><label>Manager
            <select name="manager_user_id">
              <option value="" ${!project.manager_user_id ? 'selected' : ''}>— none —</option>
              ${managerOpts}
            </select>
          </label></div>
          <div><label>Field of science
            <input name="field_of_science" value="${esc(project.field_of_science ?? '')}">
          </label></div>
          <div><label>Start date
            <input type="date" name="start_date" required value="${esc(project.start_date)}">
          </label></div>
          <div><label>End date
            <input type="date" name="end_date" value="${esc(project.end_date ?? '')}">
          </label></div>
          <div><label>Status
            <select name="status">
              <option value="concept" ${selected(project.status,'concept')}>Concept</option>
              <option value="development" ${selected(project.status,'development')}>Development</option>
              <option value="complete" ${selected(project.status,'complete')}>Complete</option>
            </select>
          </label></div>
          <div class="full"><label>Advancement sought
            <textarea name="advancement_sought" rows="3">${esc(project.advancement_sought ?? '')}</textarea>
          </label></div>
          <div class="full"><label>Technological uncertainties
            <textarea name="uncertainties" rows="3">${esc(project.uncertainties ?? '')}</textarea>
          </label></div>
          <div class="full"><label>Work performed
            <textarea name="work_performed" rows="4">${esc(project.work_performed ?? '')}</textarea>
          </label></div>
        </div>
        <div class="actions row" style="gap:0.5rem">
          <button>Save project</button>
          <button type="button" class="secondary" id="cancel-edit-project">Cancel</button>
          <span class="muted">Narrative edits create a new revision snapshot.</span>
        </div>
      </form>
    </div>
  `;
}

export function bindEditProjectForm(project, ctx) {
  const toggle = document.getElementById('edit-project-toggle');
  const card   = document.getElementById('edit-project-card');
  const cancel = document.getElementById('cancel-edit-project');
  const form   = document.getElementById('form-edit-project');
  if (!toggle || !card || !form) return;

  toggle.addEventListener('click', () => {
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (cancel) cancel.addEventListener('click', () => { card.hidden = true; });

  // Snapshot the updated_at at form-bind time. We pass it on PATCH so the
  // server can reject (409) if another admin saved a newer version while
  // this form was open. We deliberately don't auto-reload on conflict —
  // the user has typed work they may want to copy out before reloading.
  const loadedUpdatedAt = project.updated_at;

  // Replace the default onSubmit error handler with one that branches on
  // 409 — the rest of the error surface (400, 422, 500) still flows
  // through the inline banner with the server's message.
  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearEditProjectError(form);
    try {
      const fd = new FormData(form);
      const managerRaw = fd.get('manager_user_id');
      const endDate = fd.get('end_date');
      await api('PATCH', `/api/projects/${project.id}`, {
        __updated_at: loadedUpdatedAt,
        title: fd.get('title'),
        field_of_science: fd.get('field_of_science') || null,
        start_date: fd.get('start_date'),
        end_date: endDate || null,
        status: fd.get('status'),
        type: fd.get('type'),
        manager_user_id: managerRaw ? Number(managerRaw) : null,
        advancement_sought: fd.get('advancement_sought') || null,
        uncertainties: fd.get('uncertainties') || null,
        work_performed: fd.get('work_performed') || null,
      });
      await ctx.reloadAll();
    } catch (err) {
      // 409 conflict: prefer the explicit reload-and-retry message over the
      // server's text; the original is still useful but the actionable
      // verb-leading copy belongs to the client.
      if (err && err.status === 409) {
        showEditProjectError(form,
          'This project was modified by another admin since you opened the form. '
          + 'Reload to see the latest version, then re-apply your changes.');
        return;
      }
      showEditProjectError(form, err.message);
    }
  });
}

// Inline-banner helpers scoped to the edit-project form. Mirrors api.js's
// showError/clearError but kept local so the conflict path can target the
// right container without leaking that helper's internals.
function showEditProjectError(form, message) {
  let banner = form.querySelector(':scope > .error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'alert');
    form.insertBefore(banner, form.firstChild);
  }
  banner.textContent = message;
  banner.hidden = false;
}

function clearEditProjectError(form) {
  const banner = form.querySelector(':scope > .error-banner');
  if (banner) { banner.hidden = true; banner.textContent = ''; }
}
