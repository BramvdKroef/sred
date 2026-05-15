import { api, esc, bindForm, wireJwtDownloads } from '../api.js';

export async function render(main, ctx) {
  const { state } = ctx;
  if (!state.activeClaimantId) { main.innerHTML = '<p class="empty">Pick a claimant from the header first.</p>'; return; }
  const periodOpts = state.periods
    .map(p => `<option value="${p.id}">${esc(p.start_date)} → ${esc(p.end_date)} (${p.status})</option>`).join('');
  const exports = (await api('GET', `/api/exports?claimant_id=${state.activeClaimantId}`)).items;
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
        <select name="fiscal_period_id" required aria-label="Fiscal period">${periodOpts}</select>
        <label><input type="checkbox" name="draft" checked> draft</label>
        <button>Generate export</button>
      </form>
      <p class="muted">Draft means the period need not be closed.</p>
    </div>
    <div class="card">
      <h2>Compare two periods</h2>
      <p class="muted">Side-by-side T661 totals for continuity narratives. Not persisted — re-runs are cheap.</p>
      <form id="compare-form" class="row">
        <label>Period A <select name="period_a_id" required>${periodOpts}</select></label>
        <label>Period B <select name="period_b_id" required>${periodOpts}</select></label>
        <label>Format
          <select name="format">
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="md" selected>Markdown</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        <button>Generate comparison</button>
      </form>
      <div id="compare-result"></div>
    </div>
    <div class="card">
      <h2>Exports for this claimant</h2>
      ${exports.length === 0 ? '<p class="empty">None yet.</p>' : `
      <div class="table-scroll">
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
      </table>
      </div>`}
    </div>
  `;

  bindForm('#export-form', async fd => {
    await api('POST', '/api/exports/t661', {
      claimant_id: state.activeClaimantId,
      fiscal_period_id: Number(fd.get('fiscal_period_id')),
      draft: fd.get('draft') === 'on',
    });
    ctx.render();
  });

  bindForm('#compare-form', async fd => {
    const periodA = Number(fd.get('period_a_id'));
    const periodB = Number(fd.get('period_b_id'));
    const format = fd.get('format') || 'md';
    const result = await api('POST', '/api/exports/t661/compare', {
      claimant_id: state.activeClaimantId,
      period_a_id: periodA,
      period_b_id: periodB,
    });
    // Render a tiny summary + a download link for each format. Using the
    // POST response avoids a second compute on the server when the user
    // just wants the numbers in the UI.
    const ccy = result.a.claimant.reporting_currency;
    const fmt = c => `${(c / 100).toFixed(2)} ${ccy}`;
    const fmtPct = p => p === null ? 'n/a' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
    const fmtSigned = c => `${c >= 0 ? '+' : '-'}${(Math.abs(c) / 100).toFixed(2)} ${ccy}`;
    const g = result.diff.grand_total;
    const baseQs = `claimant_id=${state.activeClaimantId}&period_a=${periodA}&period_b=${periodB}`;
    const out = main.querySelector('#compare-result');
    out.innerHTML = `
      <h3>Grand totals</h3>
      <div class="table-scroll">
      <table>
        <thead><tr><th>Line</th><th>A</th><th>B</th><th>Δ</th><th>Δ%</th></tr></thead>
        <tbody>
          ${[
            ['Labour', 'labour_cost_cents'],
            ['Materials', 'materials_cents'],
            ['Contract', 'contract_expenditures_cents'],
            ['Third-party', 'third_party_payments_cents'],
            ['Overhead', 'overhead_cents'],
            ['<strong>Total</strong>', 'total_cents'],
          ].map(([label, f]) => `
            <tr>
              <td>${label}</td>
              <td>${fmt(result.a.grand_total[f])}</td>
              <td>${fmt(result.b.grand_total[f])}</td>
              <td>${fmtSigned(g[f].delta_cents)}</td>
              <td>${fmtPct(g[f].delta_pct)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
      <p>
        Download:
        <a href="/api/exports/compare/download?${baseQs}&format=${esc(format)}" data-jwt-dl>${esc(format)}</a>
        · <a href="/api/exports/compare/download?${baseQs}&format=json" data-jwt-dl>json</a>
        · <a href="/api/exports/compare/download?${baseQs}&format=csv" data-jwt-dl>csv</a>
        · <a href="/api/exports/compare/download?${baseQs}&format=md" data-jwt-dl>md</a>
        · <a href="/api/exports/compare/download?${baseQs}&format=pdf" data-jwt-dl>pdf</a>
      </p>
    `;
    wireJwtDownloads(out);
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
