import { api, esc } from '../api.js';

// Cache the "universe" of facet values from the first (unfiltered) fetch.
// Without this, narrowing the filter would shrink the dropdown options
// (a future server change could start filtering facets by the WHERE clause).
let universeFacets = null;

export async function render(main, ctx) {
  main.innerHTML = '<p class="empty">Loading audit log…</p>';
  const f = ctx.state.auditFilter ?? {};
  const qs = new URLSearchParams();
  if (f.entity_type) qs.set('entity_type', f.entity_type);
  if (f.action)      qs.set('action', f.action);
  qs.set('limit', f.limit ?? '100');
  const data = await api('GET', '/api/audit-log?' + qs);

  // First (likely unfiltered) call seeds the dropdown options. Subsequent
  // calls fall back to the cached set so narrowing the filter never strips
  // options. If the user lands on a filter on first load, expand the cache
  // to include the currently-selected value so it doesn't disappear.
  if (!universeFacets) universeFacets = { ...data.facets };
  const facets = {
    entity_types: mergeFacet(universeFacets.entity_types, f.entity_type),
    actions:      mergeFacet(universeFacets.actions,      f.action),
  };

  main.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Audit log <span class="muted" style="font-size:0.85rem; font-weight:500">${data.items.length} most recent</span></h2>
        <div class="row" style="gap:0.4rem">
          <select id="audit-entity-filter">
            <option value="">all entities</option>
            ${facets.entity_types.map(t =>
              `<option value="${t}" ${f.entity_type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <select id="audit-action-filter">
            <option value="">all actions</option>
            ${facets.actions.map(a =>
              `<option value="${a}" ${f.action === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
        </div>
      </div>
      ${data.items.length === 0 ? '<p class="empty">No events.</p>' : `
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Summary</th></tr></thead>
          <tbody>${data.items.map(renderAuditRow).join('')}</tbody>
        </table>`}
    </div>
  `;
  document.getElementById('audit-entity-filter').addEventListener('change', e => {
    ctx.state.auditFilter = { ...(ctx.state.auditFilter ?? {}), entity_type: e.target.value || undefined };
    ctx.render();
  });
  document.getElementById('audit-action-filter').addEventListener('change', e => {
    ctx.state.auditFilter = { ...(ctx.state.auditFilter ?? {}), action: e.target.value || undefined };
    ctx.render();
  });
  document.querySelectorAll('[data-toggle-audit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const details = document.getElementById(`audit-details-${btn.dataset.toggleAudit}`);
      details.hidden = !details.hidden;
      btn.textContent = details.hidden ? 'details' : 'hide';
    });
  });
}

function mergeFacet(values, selected) {
  if (selected && !values.includes(selected)) return [...values, selected].sort();
  return values;
}

function renderAuditRow(it) {
  const before = it.before_json ? JSON.parse(it.before_json) : null;
  const after  = it.after_json  ? JSON.parse(it.after_json)  : null;
  let summary;
  if (!before && after)       summary = '<span class="muted">created</span>';
  else if (before && !after)  summary = '<span class="muted">deleted</span>';
  else if (before && after) {
    const changes = [];
    for (const k of Object.keys({ ...before, ...after })) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes.push(k);
    }
    summary = changes.length
      ? `<span class="muted">changed:</span> ${changes.slice(0, 5).map(esc).join(', ')}${changes.length > 5 ? '…' : ''}`
      : '<span class="muted">(no field changes)</span>';
  } else {
    summary = '<span class="muted">—</span>';
  }
  return `
    <tr>
      <td class="when">${esc(it.created_at)}</td>
      <td>${esc(it.actor_name ?? '(system)')}</td>
      <td><span class="pill">${esc(it.action)}</span></td>
      <td>${esc(it.entity_type)} #${it.entity_id}</td>
      <td>${summary}
        <button class="small secondary" data-toggle-audit="${it.id}" style="margin-left:0.4rem">details</button>
        <pre id="audit-details-${it.id}" class="json" hidden>${esc(JSON.stringify({ before, after }, null, 2))}</pre>
      </td>
    </tr>
  `;
}
