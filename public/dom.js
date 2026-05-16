// DOM helpers + shared rendering primitives.
//
// Pure, presentation-only utilities used across both shells: HTML-escape,
// money formatting, status-pill class mapping, form-submit binding, and
// inline/top-banner error renderers. No fetch, no session state.

// Project enum display labels. Stored values are lowercase; UI shows these.
export const TYPE_LABEL   = { sred: 'SR&ED', internal: 'Internal' };
export const STATUS_LABEL = { concept: 'Concept', development: 'Development', complete: 'Complete' };

// Tiny DOM helpers.
export const esc = s => s == null ? '' : String(s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Reject `javascript:` / `data:` / `vbscript:` URLs so user-supplied link
// evidence can't smuggle script execution into an admin's session.
export const safeHref = u => {
  try {
    const x = new URL(u);
    return ['http:', 'https:', 'mailto:'].includes(x.protocol) ? x.href : '#';
  } catch {
    return '#';
  }
};

export const cents = n => (n == null) ? '' : (n / 100).toFixed(2);

// Parse a dollar-string input (e.g. "95000", "95,000", "1234.56") into
// integer cents. Returns null on empty/blank, NaN on unparseable. Throws on
// negative. Used by dollar-denominated inputs so users no longer have to
// hand-multiply by 100 (people were typing 9500000 for $95k salaries).
export function dollarsToCents(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[,\s$]/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (Number.isNaN(n)) return NaN;
  if (n < 0) throw new Error('amount cannot be negative');
  return Math.round(n * 100);
}

// Render a dollars-denominated <input type="number"> with step=0.01 and a
// non-negative min. Use this (or hand-roll equivalent markup) for any form
// field that previously took raw cents. The submit handler should call
// dollarsToCents(fd.get(name)) to convert back to integer cents before
// hitting the API; the stored field name stays `*_cents`.
export function dollarInput(name, valueCents, opts = {}) {
  const v = valueCents != null ? (valueCents / 100).toFixed(2) : '';
  const required = opts.required ? 'required' : '';
  const step = opts.step ?? '0.01';
  const placeholder = opts.placeholder ?? '';
  const extra = opts.extraAttrs ?? '';
  return `<input type="number" step="${step}" min="0" name="${name}" value="${v}" placeholder="${placeholder}" ${required} ${extra}>`;
}

// Reason a labour/expense row can't be edited, or null if it's editable.
// Mirrors the server's assertEditable (route-helpers.js): approved entries
// or entries in a closed period are locked. `period` is the matching
// fiscal_periods row (or undefined). The entry may also expose
// `period_status` directly (added by some list endpoints).
export function lockReason(entry, period) {
  if (entry?.status === 'approved') return 'approved';
  const periodStatus = period?.status ?? entry?.period_status;
  if (periodStatus === 'closed') return 'period closed';
  return null;
}

// Canonical "status → pill class" mapping. Used everywhere a raw status
// value is rendered as a coloured pill (user.status, attachment.status,
// labour/expense.status, period.status, project.status, etc.). Previously
// each renderer wrote its own ad-hoc ternary; the mapping drifted four
// different ways (see VISUAL_DESIGN_REVIEW.md #6 / TODO P2 status-pill
// mapping inconsistency).
//
// Returns a class name to use *together* with `pill`, e.g.
//   <span class="pill ${pillClassFor(value)}">${value}</span>
//
// Mapping (canonical):
//   active / open / approved              → success (green)
//   pending / concept                     → warning (yellow)
//   rejected                              → error (red)
//   inactive / disabled / closed/complete → neutral (grey)
//   development                           → brand-status (blue)
//   anything unknown                      → no modifier (plain pill)
export function pillClassFor(value) {
  switch (value) {
    case 'active':
    case 'open':
    case 'approved':
      return 'open';
    case 'pending':
      return 'pending';
    case 'rejected':
      return 'rejected';
    case 'inactive':
    case 'disabled':
    case 'closed':
      return 'closed';
    case 'concept':
      return 'status-concept';
    case 'development':
      return 'status-development';
    case 'complete':
      return 'status-complete';
    default:
      return '';
  }
}

// Convenience: render a fully-formed status pill from a raw value.
// Falls back to a plain (uncoloured) pill if the value isn't mapped — keeps
// the existing audit-log "pill with action verb" rendering working.
export function statusPill(value) {
  const cls = pillClassFor(value);
  return `<span class="pill${cls ? ' ' + cls : ''}">${esc(value)}</span>`;
}

// Attach a submit handler that preventDefaults, hands you a FormData,
// renders an inline error banner on error, and otherwise gets out of the
// way. Use bindForm(sel,…) when you have a selector, onSubmit(formEl,…)
// when you already have the element.
export function onSubmit(form, handler) {
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearError(form);
    try { await handler(new FormData(form), form); }
    catch (err) { showError(form, err.message); }
  });
}

export function bindForm(selector, handler) {
  onSubmit(document.querySelector(selector), handler);
}

// Wire the ev-kind toggle on a form (shows file vs url input).
export function bindEvidenceKindToggle(form) {
  const sel = form.querySelector('select.ev-kind');
  if (!sel) return;
  const update = () => {
    const f = form.querySelector('.ev-file'); if (f) f.hidden = sel.value !== 'file';
    const u = form.querySelector('.ev-url');  if (u) u.hidden = sel.value !== 'link';
  };
  sel.addEventListener('change', update);
  update();
}

// Render or clear an inline error banner inside a form (or any container).
// The banner is appended once and reused on subsequent errors — kept above
// the rest of the container so the user sees it without scrolling. Pairs
// with the .error-banner class in style.css.
export function showError(container, message) {
  if (!container) return;
  let banner = container.querySelector(':scope > .error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'alert');
    container.insertBefore(banner, container.firstChild);
  }
  banner.textContent = message;
  banner.hidden = false;
}

export function clearError(container) {
  const banner = container?.querySelector(':scope > .error-banner');
  if (banner) { banner.hidden = true; banner.textContent = ''; }
}

// Page-level error banner — for per-row table actions (Approve, Reject,
// Close-period, Delete, etc.) where there's no obvious form-shaped
// container to mount on. Prefers the admin shell's #app-banner-host (which
// already sits between <nav> and <main>); falls back to inserting a host
// just above <main>. Auto-dismisses after 6s so the page doesn't stay
// permanently red after a transient failure.
let topBannerTimer = null;
export function showTopBanner(message) {
  let host = document.getElementById('app-banner-host');
  if (!host) {
    const main = document.getElementById('main');
    if (!main || !main.parentNode) return;
    host = document.createElement('div');
    host.id = 'app-banner-host';
    main.parentNode.insertBefore(host, main);
  }
  host.innerHTML = `
    <div class="app-banner error-banner" role="alert">
      <span></span>
      <button type="button" aria-label="Dismiss" data-banner-dismiss>&times;</button>
    </div>
  `;
  host.querySelector('span').textContent = message;
  host.querySelector('[data-banner-dismiss]').addEventListener('click', () => {
    host.innerHTML = '';
    if (topBannerTimer) { clearTimeout(topBannerTimer); topBannerTimer = null; }
  });
  if (topBannerTimer) clearTimeout(topBannerTimer);
  topBannerTimer = setTimeout(() => { host.innerHTML = ''; topBannerTimer = null; }, 6000);
}

export const $ = sel => document.querySelector(sel);
export const $$ = sel => document.querySelectorAll(sel);
