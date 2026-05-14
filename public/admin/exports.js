import { api, esc, bindForm, wireJwtDownloads } from '../api.js';

export async function render(main, ctx) {
  const { state } = ctx;
  if (!state.claimantId) { main.innerHTML = '<p class="empty">Select a claimant first.</p>'; return; }
  const periodOpts = state.periods
    .map(p => `<option value="${p.id}">${esc(p.start_date)} → ${esc(p.end_date)} (${p.status})</option>`).join('');
  const exports = (await api('GET', `/api/exports?claimant_id=${state.claimantId}`)).items;
  // Client-side lookup: state.periods is already loaded for this claimant
  // and is small. Cheaper than adding a join on the list endpoint.
  const periodsById = new Map(state.periods.map(p => [p.id, p]));
  const periodLabel = id => {
    const p = periodsById.get(id);
    return p ? `${esc(p.start_date)} → ${esc(p.end_date)}` : `#${id}`;
  };

  main.innerHTML = `
    <div class="card">
      <h2>Generate T661 export</h2>
      <form id="export-form" class="row">
        <select name="fiscal_period_id" required>${periodOpts}</select>
        <label><input type="checkbox" name="draft" checked> draft</label>
        <button>Generate</button>
      </form>
      <p class="muted">Draft means the period need not be closed.</p>
    </div>
    <div class="card">
      <h2>Exports for this claimant</h2>
      ${exports.length === 0 ? '<p class="empty">None yet.</p>' : `
      <table>
        <thead><tr><th>ID</th><th>Period</th><th>Draft</th><th>Generated</th><th>Download</th><th>Audit package</th></tr></thead>
        <tbody>${exports.map(x => `
          <tr>
            <td>${x.id}</td>
            <td>${periodLabel(x.fiscal_period_id)}</td>
            <td>${x.is_draft ? 'yes' : 'no'}</td>
            <td>${esc(x.generated_at)}</td>
            <td>
              <a href="/api/exports/${x.id}/download?format=pdf" data-jwt-dl>pdf</a>
              · <a href="/api/exports/${x.id}/download?format=md" data-jwt-dl>md</a>
              · <a href="/api/exports/${x.id}/download?format=csv" data-jwt-dl>csv</a>
              · <a href="/api/exports/${x.id}/download?format=json" data-jwt-dl>json</a>
            </td>
            <td>
              ${x.bundle_path
                ? `<a href="/api/exports/${x.id}/evidence-package" data-jwt-dl>download zip</a>`
                : `<button class="small secondary" data-build-bundle="${x.id}">Build</button>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `;

  bindForm('#export-form', async fd => {
    await api('POST', '/api/exports/t661', {
      claimant_id: state.claimantId,
      fiscal_period_id: Number(fd.get('fiscal_period_id')),
      draft: fd.get('draft') === 'on',
    });
    ctx.render();
  });

  main.querySelectorAll('[data-build-bundle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Building…';
      try {
        await api('POST', `/api/exports/${btn.dataset.buildBundle}/evidence-package`);
        ctx.render();
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  wireJwtDownloads(main);
}
