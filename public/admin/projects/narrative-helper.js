// SPA panel for the narrative helper. Mounts an <aside class="narrative-
// helper"> next to a project create/edit form, debounces input on the
// three narrative textareas (advancement_sought / uncertainties /
// work_performed), and re-renders findings grouped by field.
//
// Phase 1 constraints:
//   - No LLM. No network. No persistence.
//   - Never disables submit; the helper is advisory.
//   - Dismissals last until the page reloads (in-memory Set per panel).
//
// Public surface:
//   mountNarrativeHelper(formEl, fields?) → unmount fn
// where `fields` is an optional list of field-name overrides (defaults
// to the canonical FIELDS list).

import { checkNarrative, FIELDS, FIELD_LABELS } from '../../lib/narrative-checks.js';

const DEBOUNCE_MS = 400;

// Escape user-supplied text for safe insertion into innerHTML. Mirrors
// the convention in public/api.js (which has its own esc()), kept local
// to avoid a dependency on the api module from the lib subtree.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mount the narrative helper next to the given form.
 *
 * @param {HTMLElement} formEl — the <form> containing the three textareas.
 * @param {string[]} [fields] — override field list (defaults to FIELDS).
 * @returns {() => void} unmount function (removes the aside, cancels timer).
 */
export function mountNarrativeHelper(formEl, fields = FIELDS) {
  if (!formEl) return () => {};
  // Don't double-mount if called twice (e.g. on re-render).
  const existing = formEl.parentElement?.querySelector(':scope > .narrative-helper');
  if (existing) existing.remove();

  const aside = document.createElement('aside');
  aside.className = 'narrative-helper';
  aside.setAttribute('aria-label', 'Narrative quality checks');
  aside.innerHTML = renderShell();

  // Insert the aside as a sibling of the form, then wrap form + aside
  // together in a layout container so the right-rail breakpoint works
  // without touching the surrounding card. If the form is already inside
  // a `.narrative-helper-layout` (re-mount), reuse it.
  let layout = formEl.closest('.narrative-helper-layout');
  if (!layout) {
    layout = document.createElement('div');
    layout.className = 'narrative-helper-layout';
    formEl.parentNode.insertBefore(layout, formEl);
    layout.appendChild(formEl);
  }
  layout.appendChild(aside);

  const dismissed = new Set(); // Set<`${field}:${ruleId}:${start}-${end}`>
  let debounceTimer = null;

  function readFields() {
    const out = {};
    for (const name of fields) {
      const el = formEl.elements?.namedItem?.(name) ?? formEl.querySelector(`[name="${name}"]`);
      out[name] = el ? (el.value ?? '') : '';
    }
    // Migration 016: pass `hypothesis` through to the checker even though
    // it isn't one of the three primary narrative fields. The checker uses
    // its presence to soften the "uncertainties needs a hypothesis-shaped
    // phrase" rule (the hypothesis now lives in its own field, so requiring
    // it inside `uncertainties` produces false noise).
    if (!('hypothesis' in out)) {
      const hypEl = formEl.elements?.namedItem?.('hypothesis') ?? formEl.querySelector('[name="hypothesis"]');
      if (hypEl) out.hypothesis = hypEl.value ?? '';
    }
    return out;
  }

  function render() {
    const { findings } = checkNarrative(readFields());
    const visible = findings.filter(f => !dismissed.has(findingKey(f)));
    const fieldsText = readFields();

    const body = aside.querySelector('.nh-body');
    body.innerHTML = fields.map(field => renderFieldSection(field, fieldsText[field], visible)).join('');

    // Wire dismiss buttons (event delegation would also work, but the
    // panel re-renders fully every input so direct binding is simple).
    body.querySelectorAll('button.nh-dismiss').forEach(btn => {
      btn.addEventListener('click', () => {
        dismissed.add(btn.dataset.key);
        render();
      });
    });
  }

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, DEBOUNCE_MS);
  }

  // Attach listeners on each textarea. We use 'input' for live typing
  // and 'change' as a safety net for paste / programmatic value sets.
  const listenerOff = [];
  // Also watch the migration-016 `hypothesis` field if it's present, so
  // editing it triggers a re-check (which toggles the
  // uncertainties-needs-hypothesis carve-out).
  const watchNames = fields.includes('hypothesis') ? fields : [...fields, 'hypothesis'];
  for (const name of watchNames) {
    const el = formEl.elements?.namedItem?.(name) ?? formEl.querySelector(`[name="${name}"]`);
    if (!el) continue;
    const onInput = () => schedule();
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    listenerOff.push(() => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onInput);
    });
  }

  // Manual "Check now" button — useful when the panel is collapsed/scrolled.
  aside.querySelector('.nh-recheck').addEventListener('click', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    render();
  });

  // Initial render so the panel isn't empty on mount.
  render();

  return function unmount() {
    if (debounceTimer) clearTimeout(debounceTimer);
    listenerOff.forEach(off => off());
    aside.remove();
    // Unwrap the layout if the form is the only remaining child.
    if (layout.children.length === 1 && layout.firstChild === formEl) {
      layout.parentNode.insertBefore(formEl, layout);
      layout.remove();
    }
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderShell() {
  return `
    <div class="nh-head">
      <h3>Narrative check</h3>
      <button type="button" class="nh-recheck secondary small" aria-label="Re-check now">Re-check</button>
    </div>
    <p class="nh-blurb muted">
      Advisory only. Findings don't block submit and aren't saved.
    </p>
    <div class="nh-body"></div>
  `;
}

function renderFieldSection(field, text, allFindings) {
  const fieldFindings = allFindings.filter(f => f.field === field);
  const label = FIELD_LABELS[field] || field;
  const isEmpty = !text || !text.trim();
  // "Looks clean" only counts when the field has content AND no findings.
  const looksClean = !isEmpty && fieldFindings.length === 0;

  let content;
  if (looksClean) {
    content = `<p class="nh-clean">✓ Looks clean</p>`;
  } else if (isEmpty && fieldFindings.length === 0) {
    content = `<p class="nh-empty muted">No content yet.</p>`;
  } else {
    content = `<ul class="nh-findings">${fieldFindings.map(f => renderFinding(f, text)).join('')}</ul>`;
  }

  return `
    <section class="nh-field nh-field-${esc(field)}">
      <h4>${esc(label)}</h4>
      ${content}
    </section>
  `;
}

function renderFinding(f, text) {
  const sevLabel = { error: 'Error', warn: 'Warning', info: 'Info' }[f.severity] || f.severity;
  const quote = f.span && text
    ? `<blockquote class="nh-quote">${esc(text.slice(f.span.start, f.span.end))}</blockquote>`
    : '';
  const key = findingKey(f);
  // Suggest-rewrite slot exists per the Phase 2 reservation. Hidden in
  // Phase 1 (no backend to call). Kept in the DOM so the panel doesn't
  // shift when Phase 2 enables it.
  return `
    <li class="nh-finding nh-sev-${esc(f.severity)}" data-rule="${esc(f.ruleId)}">
      <div class="nh-finding-head">
        <span class="nh-sev-pill nh-sev-pill-${esc(f.severity)}">${esc(sevLabel)}</span>
        <button type="button" class="nh-dismiss" data-key="${esc(key)}" aria-label="Dismiss this finding">×</button>
      </div>
      <p class="nh-message">${esc(f.message)}</p>
      ${quote}
      <p class="nh-hint"><strong>Hint:</strong> ${esc(f.hint)}</p>
      <button type="button" class="nh-suggest" hidden disabled aria-hidden="true">Suggest rewrite</button>
    </li>
  `;
}

function findingKey(f) {
  const s = f.span ? `${f.span.start}-${f.span.end}` : 'whole';
  return `${f.field}:${f.ruleId}:${s}`;
}
