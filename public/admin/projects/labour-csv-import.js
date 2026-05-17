// CSV bulk-import modal for the labour-log "log on behalf" card.
// Opens a <dialog> with a paste-CSV textarea + Submit button. On success
// closes and invokes the caller's onSuccess hook (which refetches the
// labour list and shows a confirmation banner). On per-row validation
// failure, renders the row-level error list inline and keeps the dialog
// open so the admin can fix the CSV without losing their paste.
//
// Reuses the <dialog>-based modal idiom from invite-modal.js — there is
// no shared modal helper.

import { api, esc } from '../../api.js';

const SAMPLE_CSV =
`date,user_claimant_id,project_id,hours,description
2025-03-15,1,1,4.5,Prototype experiment for new sorting algorithm
2025-03-16,1,1,8,"Debugging, profiling, and memory analysis"
2025-03-17,2,1,6.25,Pair-review of the experimental branch
`;

export function showLabourCsvImportModal({ onSuccess } = {}) {
  // Reuse a single modal element across clicks so we don't pile them up.
  let dlg = document.getElementById('labour-csv-import-modal');
  if (dlg) dlg.remove();

  dlg = document.createElement('dialog');
  dlg.id = 'labour-csv-import-modal';
  dlg.className = 'modal';
  dlg.innerHTML = `
    <h3 class="modal-title">Import labour CSV</h3>
    <p class="modal-line muted">
      Paste a CSV with a header row of:
      <code>date,user_claimant_id,project_id,hours,description</code>
      (any column order).
      <a href="#" data-sample>Use sample</a>
    </p>
    <form data-import-form>
      <label class="full">
        CSV
        <textarea name="csv" rows="10" required style="width:100%;font-family:monospace;font-size:0.85rem;"></textarea>
      </label>
      <div data-row-errors hidden></div>
      <div class="actions mt-md row gap-sm">
        <button type="submit" class="small">Import</button>
        <button type="button" class="small secondary" data-close>Cancel</button>
      </div>
    </form>
  `;
  document.body.appendChild(dlg);

  const form     = dlg.querySelector('[data-import-form]');
  const textarea = dlg.querySelector('textarea[name="csv"]');
  const errorsEl = dlg.querySelector('[data-row-errors]');
  const closeBtn = dlg.querySelector('[data-close]');
  const sampleLink = dlg.querySelector('[data-sample]');

  closeBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());

  sampleLink.addEventListener('click', (e) => {
    e.preventDefault();
    textarea.value = SAMPLE_CSV;
    textarea.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';

    const csv = textarea.value;
    try {
      const res = await api('POST', '/api/labour-logs/import', { csv });
      dlg.close();
      if (typeof onSuccess === 'function') await onSuccess(res.imported ?? 0);
    } catch (err) {
      // The `api()` helper throws an Error carrying status/code/details from
      // the server's error envelope (see public/fetch.js). The csv_invalid
      // response mirrors its row list onto details.rows for exactly this
      // path; fall back to a single-error rendering otherwise.
      const rows = err?.details?.rows;
      if (Array.isArray(rows) && rows.length) {
        renderRowErrors(errorsEl, rows);
      } else {
        renderRowErrors(errorsEl, [{ row: 0, reason: err.message || 'import failed' }]);
      }
    }
  });

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.show?.();
}

function renderRowErrors(host, rows) {
  host.hidden = false;
  host.className = 'error-banner';
  host.setAttribute('role', 'alert');
  host.innerHTML = `
    <strong>Could not import — fix these rows and retry:</strong>
    <ul style="margin:0.4rem 0 0 1.2rem;padding:0;">
      ${rows.map(r => `<li>${r.row ? `Row ${esc(String(r.row))}: ` : ''}${esc(r.reason)}</li>`).join('')}
    </ul>
  `;
}
