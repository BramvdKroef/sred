// Per-feature renderers + form helpers.
//
// Shared across both shells (admin + employee):
//   - Activity-feed table + expandable detail panel (labour/expense/evidence)
//   - Inline labour/expense edit forms (used by activity-feed expansion AND
//     the employee SPA's row-edit affordance)
//   - Evidence-attach inline helpers (file or link, evidence_date passthrough)
//   - Preferences page (account + passkey list/add/remove)
//   - Week-of-Mon→Sun helpers + weekly hours chart
//   - JWT-authenticated download click interceptor
//
// All depend on api/apiUpload (fetch.js), DOM helpers (dom.js), and read the
// JWT directly only in `wireJwtDownloads`.

import { api, apiUpload } from './fetch.js';
import {
  esc, cents, safeHref, statusPill, dollarsToCents,
  onSubmit, bindEvidenceKindToggle, showTopBanner,
} from './dom.js';

// After creating a labour entry, attach optional evidence (file or link)
// from the same form. Reads fd['ev_kind' | 'ev_file' | 'ev_url' | 'ev_caption'].
export async function attachInlineEvidence(fd, { project_id, labour_entry_id, evidence_date }) {
  const kind = fd.get('ev_kind');
  const caption = fd.get('ev_caption');
  if (kind === 'file') {
    const file = fd.get('ev_file');
    if (file && file.size > 0) {
      const ef = new FormData();
      ef.append('project_id', String(project_id));
      ef.append('labour_entry_id', String(labour_entry_id));
      ef.append('kind', 'file');
      ef.append('caption', caption || file.name);
      ef.append('evidence_date', evidence_date);
      ef.append('file', file);
      await apiUpload('/api/evidence', ef);
    }
  } else if (kind === 'link') {
    const url = fd.get('ev_url');
    if (url) {
      await api('POST', '/api/evidence', {
        project_id, labour_entry_id, kind: 'link',
        caption: caption || url, evidence_date, url,
      });
    }
  }
}

// After creating an expense, attach an optional receipt (always file).
export async function attachInlineReceipt(fd, { project_id, expense_id, evidence_date }) {
  const file = fd.get('receipt_file');
  if (!file || !file.size) return;
  const caption = fd.get('receipt_caption') || file.name;
  const ef = new FormData();
  ef.append('project_id', String(project_id));
  ef.append('expense_id', String(expense_id));
  ef.append('kind', 'file');
  ef.append('caption', caption);
  ef.append('evidence_date', evidence_date);
  ef.append('file', file);
  await apiUpload('/api/evidence', ef);
}

// Preferences page (shared between admin and employee shells).
export async function renderPreferencesPage(main) {
  main.innerHTML = '<p class="loading">Loading…</p>';
  await refreshPrefs(main);
}

async function refreshPrefs(main) {
  const me   = await api('GET', '/api/me');
  const data = await api('GET', '/api/me/credentials');
  main.innerHTML = `
    <div class="card">
      <h2>Account</h2>
      <div class="grid">
        <div><label>Name</label><div>${esc(me.user.name)}</div></div>
        <div><label>Email</label><div>${esc(me.user.email)}</div></div>
        <div><label>Role</label><div><span class="role">${esc(me.user.role)}</span></div></div>
        <div><label>Status</label><div>${statusPill(me.user.status)}</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Your passkeys (${data.items.length})</h2>
        <button id="add-passkey-toggle" class="secondary small">＋ Add a passkey</button>
      </div>
      <div id="add-passkey-form" class="mb-md" hidden>
        <form id="form-add-passkey" class="row gap-md align-end">
          <div class="input-grow"><label>Device label
            <input name="label" placeholder="${esc(navigator.platform || 'Device')}">
          </label></div>
          <div><button class="small">Add passkey</button></div>
        </form>
        <p class="caption mt-xs">
          Your browser will prompt you to use a passkey on this device.
        </p>
      </div>
      ${data.items.length === 0
        ? '<p class="empty">No passkeys registered yet.</p>'
        : `<div class="table-scroll"><table>
            <thead><tr><th>Label</th><th>Transports</th><th>Registered</th><th>Last used</th><th></th></tr></thead>
            <tbody>${data.items.map(c => `
              <tr>
                <td>${esc(c.label ?? '(unlabeled)')}</td>
                <td>${esc((c.transports ?? []).join(', ') || '—')}</td>
                <td>${esc(c.created_at)}</td>
                <td>${esc(c.last_used_at ?? 'never')}</td>
                <td class="actions">${data.items.length > 1
                  ? `<button class="small danger" data-cred-remove="${c.id}" data-label="${esc(c.label ?? c.id)}">Remove</button>`
                  : '<span class="muted">cannot remove the last one</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>`}
    </div>
  `;
  bindPrefs(main);
}

function bindPrefs(main) {
  const tg = main.querySelector('#add-passkey-toggle');
  const form = main.querySelector('#add-passkey-form');
  if (tg && form) tg.addEventListener('click', () => { form.hidden = !form.hidden; });

  onSubmit(main.querySelector('#form-add-passkey'), async fd => {
    const label = fd.get('label') || navigator.platform || 'Device';
    const { startRegistration } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11/+esm');
    const options = await api('POST', '/api/webauthn/register/start', {});
    const attestation = await startRegistration({ optionsJSON: options });
    await api('POST', '/api/webauthn/register/finish', { attestation, label });
    await refreshPrefs(main);
  });

  main.querySelectorAll('[data-cred-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove "${btn.dataset.label}"? You won't be able to sign in with this device.`)) return;
      try {
        await api('DELETE', `/api/me/credentials/${btn.dataset.credRemove}`);
        await refreshPrefs(main);
      } catch (err) { showTopBanner(err.message); }
    });
  });
}

// Can the currently-signed-in admin edit this labour/expense entry?
// Mirrors the server's assertEditable rules in src/lib/route-helpers.js:
//   - pending / rejected entries: editable
//   - approved entries: editable ONLY by the admin who approved them
//                       (so they can fix their own auto-approved typos)
//   - closed period: never editable
// `currentUser` must be the admin's `me.user` (carries id + role).
// Non-admins always get false here — employees use their own inline editor
// in the employee SPA, not the activity-feed expansion. Returns false on
// missing inputs so callers can guard the affordance unconditionally.
export function canAdminEdit(entry, currentUser) {
  if (!entry || !currentUser || currentUser.role !== 'admin') return false;
  if (entry.period_status === 'closed') return false;
  if (entry.status === 'approved') {
    return entry.reviewed_by_user_id === currentUser.id;
  }
  // pending or rejected → admin can edit (rejected PATCH reverts to pending,
  // approved-self PATCH also reverts to pending — both handled server-side).
  return entry.status === 'pending' || entry.status === 'rejected';
}

// Inline edit-form markup for labour entries. Used by both the employee SPA
// row-edit (one form per row) AND by the admin activity-feed expansion
// (one form per opened detail panel). The form name is intentionally
// configurable so callers can scope event delegation by id; default matches
// the employee SPA's existing `data-form-edit-labour="<id>"` selector.
export function labourEditFormHtml(e, opts = {}) {
  const attr = opts.formAttr ?? `data-form-edit-labour="${e.id}"`;
  return `<form ${attr} class="row gap-md inline-edit-row">
    <div><label>Date <input type="date" name="work_date" value="${esc(e.work_date)}" required></label></div>
    <div><label>Hours <input type="number" name="hours" step="0.25" min="0.25" max="24" value="${e.hours}" required class="w-hours"></label></div>
    <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime" ${e.is_overtime ? 'checked' : ''}> Overtime</label></div>
    <div class="input-grow"><label>Description <input name="description" value="${esc(e.description)}" required></label></div>
    <div><label>&nbsp;</label><div class="row gap-sm"><button class="small">Save labour entry</button>${opts.cancelAttr ? `<button type="button" class="small secondary" ${opts.cancelAttr}>Cancel</button>` : ''}</div></div>
  </form>`;
}

// Inline edit-form markup for expense entries. See labourEditFormHtml for
// the configurability rationale.
//
// Overhead fields (migration 014 / SRED_DOMAIN_REVIEW F5): when the row is
// (or becomes) category='overhead' we expose a subcategory <select> and an
// allocation-basis <input>. Migration 015 (P3) adds three more conditional
// groups: a `material_disposition` select (visible when material), a
// `contract_arms_length` select (visible when contract), and a
// `fx_rate_source` text input (visible whenever fx_rate is populated).
// Each group's wrapper div carries a data-*-only attribute so
// bindExpenseOverheadToggle can show/hide it on a category-change /
// fx-rate-input listener. Initial visibility follows the row's saved
// category + fx_rate.
export function expenseEditFormHtml(e, opts = {}) {
  const cats = ['material','contract','third_party_payment','overhead'];
  const subcats = ['rent','utilities','maintenance','supporting_salaries','other'];
  const dispositions = ['consumed','transformed'];
  const attr = opts.formAttr ?? `data-form-edit-expense="${e.id}"`;
  const isOverhead = e.category === 'overhead';
  const isMaterial = e.category === 'material';
  const isContract = e.category === 'contract';
  const hasFx      = e.fx_rate != null && Number(e.fx_rate) > 0;
  const armsLengthValue = e.contract_arms_length;     // 0 | 1 | null
  return `<form ${attr} class="row gap-md inline-edit-row wrap">
    <div><label>Date <input type="date" name="expense_date" value="${esc(e.expense_date)}" required></label></div>
    <div><label>Category <select name="category" data-expense-category>${cats.map(c =>
      `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
    <div><label>Amount <span class="muted">(${esc(e.currency)})</span> <input type="number" step="0.01" min="0" name="amount" value="${(e.amount_cents / 100).toFixed(2)}" required class="w-amount"></label></div>
    <div><label>Currency <input name="currency" value="${esc(e.currency)}" required class="w-ccy"></label></div>
    <div><label>FX rate <input type="number" step="0.0001" name="fx_rate" value="${e.fx_rate ?? ''}" class="w-hours" data-fx-rate-input></label></div>
    <div class="input-grow"><label>Description <input name="description" value="${esc(e.description)}" required></label></div>
    <div data-overhead-only ${isOverhead ? '' : 'hidden'}><label>Overhead type <select name="overhead_subcategory">${subcats.map(s =>
      `<option value="${s}" ${s === e.overhead_subcategory ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
    <div class="input-grow" data-overhead-only ${isOverhead ? '' : 'hidden'}><label>Allocation basis <input name="allocation_basis" value="${esc(e.allocation_basis ?? '')}" placeholder="e.g. 30% of total floor area"></label></div>
    <div data-material-only ${isMaterial ? '' : 'hidden'}><label>Disposition <select name="material_disposition">${dispositions.map(d =>
      `<option value="${d}" ${d === e.material_disposition ? 'selected' : ''}>${d}</option>`).join('')}</select></label></div>
    <div data-contract-only ${isContract ? '' : 'hidden'}><label>Arm's-length <select name="contract_arms_length">
      <option value="1" ${armsLengthValue === 1 ? 'selected' : ''}>yes — arm's length</option>
      <option value="0" ${armsLengthValue === 0 ? 'selected' : ''}>no — non-arm's-length</option>
    </select></label></div>
    <div class="input-grow" data-fx-rate-source-only ${hasFx ? '' : 'hidden'}><label>FX-rate source <input name="fx_rate_source" value="${esc(e.fx_rate_source ?? '')}" placeholder="e.g. Bank of Canada noon rate, 2026-03-15"></label></div>
    <div><label>&nbsp;</label><div class="row gap-sm"><button class="small">Save expense</button>${opts.cancelAttr ? `<button type="button" class="small secondary" ${opts.cancelAttr}>Cancel</button>` : ''}</div></div>
  </form>`;
}

// Wire the category <select> + fx-rate <input> in an expense-edit form to
// toggle the category-conditional wrappers. Idempotent — safe to call
// after every render. Mirrors the pattern in employee/forms.js and
// admin/projects/on-behalf.js.
//
// Migration 014 added overhead; 015 (P3) added material disposition,
// contract arm's-length, and fx-rate source. The first three are
// category-conditional, the fourth is fx-rate-conditional.
export function bindExpenseOverheadToggle(form) {
  const sel = form.querySelector('[data-expense-category]');
  if (!sel) return;
  const fxInput      = form.querySelector('[data-fx-rate-input]');
  const overheadDivs = form.querySelectorAll('[data-overhead-only]');
  const materialDivs = form.querySelectorAll('[data-material-only]');
  const contractDivs = form.querySelectorAll('[data-contract-only]');
  const fxSourceDivs = form.querySelectorAll('[data-fx-rate-source-only]');
  const syncCategory = () => {
    const c = sel.value;
    overheadDivs.forEach(d => { d.hidden = c !== 'overhead'; });
    materialDivs.forEach(d => { d.hidden = c !== 'material'; });
    contractDivs.forEach(d => { d.hidden = c !== 'contract'; });
  };
  const syncFx = () => {
    const has = fxInput && fxInput.value && Number(fxInput.value) > 0;
    fxSourceDivs.forEach(d => { d.hidden = !has; });
  };
  sel.addEventListener('change', syncCategory);
  if (fxInput) fxInput.addEventListener('input', syncFx);
  syncCategory();
  syncFx();
}

// Submit a PATCH /api/labour/:id from a FormData built off labourEditFormHtml.
// Pure helper so both shells (employee row-edit + admin activity expansion)
// hit the same wire format. Throws on validation errors so the calling
// onSubmit wrapper renders the inline banner.
export async function submitLabourEdit(id, fd) {
  return api('PATCH', `/api/labour/${id}`, {
    work_date: fd.get('work_date'),
    hours: Number(fd.get('hours')),
    description: fd.get('description'),
    is_overtime: fd.get('is_overtime') === 'on',
  });
}

// Submit a PATCH /api/expenses/:id from a FormData built off
// expenseEditFormHtml. See submitLabourEdit for the rationale.
//
// Overhead fields (migration 014): when category='overhead' we pass through
// the subcategory + basis from the form. When category is anything else, we
// explicitly send `null` for both so the server clears any stale values
// from a row that was previously overhead — the server route also
// auto-nulls these, but sending the explicit clear keeps the wire payload
// self-describing.
export async function submitExpenseEdit(id, fd) {
  const amountCents = dollarsToCents(fd.get('amount'));
  if (amountCents == null || Number.isNaN(amountCents))
    throw new Error('Enter the amount in dollars (e.g. 1234.56).');
  const category = fd.get('category');
  const body = {
    expense_date: fd.get('expense_date'),
    category,
    amount_cents: amountCents,
    currency: fd.get('currency') || 'CAD',
    description: fd.get('description'),
  };
  const fx = fd.get('fx_rate');
  body.fx_rate = fx ? Number(fx) : null;
  // Migration 015 P3.3: pass-through fx_rate_source when fx_rate is set;
  // explicitly null when fx_rate is cleared so the server clears any stale
  // source attribution (the server auto-nulls too, but sending the
  // explicit clear keeps the wire payload self-describing — matches the
  // overhead-fields convention immediately below).
  body.fx_rate_source = (body.fx_rate != null) ? (fd.get('fx_rate_source') || null) : null;
  if (category === 'overhead') {
    body.overhead_subcategory = fd.get('overhead_subcategory') || null;
    body.allocation_basis     = fd.get('allocation_basis') || null;
  } else {
    body.overhead_subcategory = null;
    body.allocation_basis     = null;
  }
  // Migration 015 P3.1: material_disposition only on material rows.
  if (category === 'material') {
    body.material_disposition = fd.get('material_disposition') || null;
  } else {
    body.material_disposition = null;
  }
  // Migration 015 P3.2: contract_arms_length only on contract rows.
  // The <select> emits string "0" / "1" — coerce to numeric so the server
  // sees the canonical wire form.
  if (category === 'contract') {
    const v = fd.get('contract_arms_length');
    body.contract_arms_length = v === '1' ? 1 : v === '0' ? 0 : null;
  } else {
    body.contract_arms_length = null;
  }
  return api('PATCH', `/api/expenses/${id}`, body);
}

// Local YYYY-MM-DD without UTC drift.
const localDate = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Monday-Sunday for the calendar week containing today, in local time.
export function currentWeek() {
  const now = new Date();
  const day = now.getDay();                 // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day;  // shift back to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + offset);
  monday.setHours(0, 0, 0, 0);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = localDate(new Date());
  const days = labels.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const date = localDate(d);
    return { date, label, isToday: date === today };
  });
  return { from: days[0].date, to: days[6].date, today, days };
}

// Bucket labour entries by work_date, return per-day rows with % of max for bar height.
export function weekBars(entries, days) {
  const byDate = {};
  for (const e of entries) byDate[e.work_date] = (byDate[e.work_date] || 0) + e.hours;
  const maxHours = Math.max(8, ...Object.values(byDate), 0);
  return days.map(d => ({
    label: d.label,
    date: d.date,
    isToday: !!d.isToday,
    hours: byDate[d.date] || 0,
    pct: ((byDate[d.date] || 0) / maxHours) * 100,
  }));
}

export function activityHtml(items, { showActor = true, showProject = true, showOpen = false } = {}) {
  if (!items.length) return '<p class="empty">No activity yet.</p>';
  return `<div class="table-scroll"><table class="activity">
    <thead><tr>
      <th>When</th><th>Type</th>${showActor ? '<th>Who</th>' : ''}${showProject ? '<th>Project</th>' : ''}<th>Details</th>${showOpen ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${items.map(it => activityRow(it, { showActor, showProject, showOpen })).join('')}</tbody>
  </table></div>`;
}

function activityRow(it, { showActor, showProject, showOpen }) {
  const when = String(it.created_at).slice(0, 16).replace('T', ' ');
  const typePill = `<span class="pill type-${it.type}">${it.type}</span>`;
  const actor = showActor ? `<td>${esc(it.actor_name)}</td>` : '';
  const project = showProject ? `<td>${esc(it.project_title)}</td>` : '';
  const cols = 3 + (showActor ? 1 : 0) + (showProject ? 1 : 0) + (showOpen ? 1 : 0);
  const openBtn = showOpen
    ? `<td class="actions"><button class="small secondary" data-open-activity="${it.type}-${it.id}" data-act-type="${it.type}" data-act-id="${it.id}">Open</button></td>`
    : '';
  const expansion = showOpen
    ? `<tr id="activity-detail-${it.type}-${it.id}" hidden><td colspan="${cols}"></td></tr>`
    : '';
  return `<tr>
    <td class="when">${esc(when)}</td>
    <td>${typePill}</td>
    ${actor}
    ${project}
    <td>${activityDetails(it)}</td>
    ${openBtn}
  </tr>${expansion}`;
}

// Wire Open buttons in any container that has activityHtml({ showOpen: true }).
// `opts.currentUser` (optional) enables the admin inline-edit affordance for
// labour/expense rows: when the signed-in admin is the approving admin (or
// the entry is pending/rejected) AND the period is open, the expansion shows
// a "✎ Edit fields" details block that PATCHes the entry on submit.
export function wireActivityDetails(root, opts = {}) {
  root.querySelectorAll('[data-open-activity]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.actType;
      const id   = btn.dataset.actId;
      const tr   = document.getElementById(`activity-detail-${type}-${id}`);
      const cell = tr.querySelector('td');
      if (!tr.hidden) { tr.hidden = true; btn.textContent = 'Open'; return; }
      tr.hidden = false;
      btn.textContent = 'Close';
      cell.innerHTML = '<p class="muted">Loading…</p>';
      try { await renderAndWireDetail(cell, type, id, opts); }
      catch (e) { cell.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    });
  });
}

async function renderAndWireDetail(cell, type, id, opts = {}) {
  cell.innerHTML = await fetchActivityDetail(type, id, opts);
  wireJwtDownloads(cell);
  wireAttachForm(cell, type, id, opts);
  wireInlineEditForm(cell, type, id, opts);
}

// Wire the admin inline-edit form (if rendered). The form re-renders the
// whole expansion on success so the freshly-PATCHed values + audit log
// appear without a page reload — same pattern wireAttachForm uses.
function wireInlineEditForm(cell, type, id, opts) {
  const form = cell.querySelector('[data-inline-edit-form]');
  if (!form) return;
  // Expense forms get the overhead-fields toggle wired; safe no-op for
  // labour forms (no data-expense-category present).
  if (type === 'expense') bindExpenseOverheadToggle(form);
  onSubmit(form, async fd => {
    if (type === 'labour')       await submitLabourEdit(id, fd);
    else if (type === 'expense') await submitExpenseEdit(id, fd);
    else return;
    await renderAndWireDetail(cell, type, id, opts);
  });
}

function wireAttachForm(cell, type, id, opts = {}) {
  const form = cell.querySelector('[data-attach-form]');
  if (!form) return;
  bindEvidenceKindToggle(form);
  onSubmit(form, async fd => {
    const projectId = Number(form.dataset.projectId);
    const date = fd.get('evidence_date') || form.dataset.entryDate;
    const caption = fd.get('caption') || 'Attached evidence';
    const linkKey = type === 'labour' ? 'labour_entry_id' : 'expense_id';
    if (fd.get('ev_kind') === 'file') {
      const efd = new FormData();
      efd.append('project_id', String(projectId));
      efd.append(linkKey, String(id));
      efd.append('kind', 'file');
      efd.append('caption', caption);
      efd.append('evidence_date', date);
      const file = fd.get('ev_file');
      if (!file || !file.size) throw new Error('Select a file to upload');
      efd.append('file', file);
      await apiUpload('/api/evidence', efd);
    } else if (fd.get('ev_kind') === 'link') {
      const url = fd.get('ev_url');
      if (!url) throw new Error('URL required');
      await api('POST', '/api/evidence', {
        project_id: projectId, [linkKey]: id, kind: 'link',
        caption, evidence_date: date, url,
      });
    } else {
      throw new Error('Pick a kind');
    }
    await renderAndWireDetail(cell, type, id, opts);
  });
}

export async function fetchActivityDetail(type, id, opts = {}) {
  const auditType = type === 'labour' ? 'labour_entry' : type === 'expense' ? 'expense' : 'evidence_item';
  const entityUrl = type === 'labour' ? `/api/labour/${id}` : type === 'expense' ? `/api/expenses/${id}` : `/api/evidence/${id}`;
  const linkedUrl = type === 'labour' ? `/api/evidence?labour_entry_id=${id}` : type === 'expense' ? `/api/evidence?expense_id=${id}` : null;
  const tasks = [api('GET', entityUrl), api('GET', `/api/audit-log?entity_type=${auditType}&entity_id=${id}&limit=20`)];
  if (linkedUrl) tasks.push(api('GET', linkedUrl));
  const [entity, audit, linked] = await Promise.all(tasks);
  return renderActivityDetail(type, entity, audit.items, (linked?.items ?? []), opts);
}

export function renderActivityDetail(type, e, auditItems, linkedEv, opts = {}) {
  const head = `<div class="grid activity-detail-grid">`;
  let body = head;
  if (type === 'labour') {
    body += `
      <div><strong>Work date:</strong> ${esc(e.work_date)}</div>
      <div><strong>Hours:</strong> ${e.hours}${e.is_overtime ? ' <span class="pill overtime">OT</span>' : ''}</div>
      <div><strong>Status:</strong> <span class="pill ${e.status}">${esc(e.status)}</span></div>
      <div><strong>Period:</strong> #${e.fiscal_period_id}</div>
      <div class="full"><strong>Description:</strong> ${esc(e.description)}</div>
      ${e.reviewed_at ? `<div class="full muted"><strong>Reviewed</strong> ${esc(e.reviewed_at)} (user #${e.reviewed_by_user_id})</div>` : ''}
      ${e.rejection_reason ? `<div class="full"><strong>Rejection reason:</strong> <span class="muted">${esc(e.rejection_reason)}</span></div>` : ''}
    `;
  } else if (type === 'expense') {
    // Migration 014/015: surface the category sub-classification inline
    // (e.g. "overhead · rent", "material · consumed", "contract · arm's
    // length") and an extra row for the allocation basis / fx-rate source
    // when present. Keeps the detail panel a quick-glance summary without
    // forcing the user to open the edit form to see them.
    let catLabel = esc(e.category);
    if (e.category === 'overhead' && e.overhead_subcategory)
      catLabel = `${esc(e.category)} · ${esc(e.overhead_subcategory)}`;
    else if (e.category === 'material' && e.material_disposition)
      catLabel = `${esc(e.category)} · ${esc(e.material_disposition)}`;
    else if (e.category === 'contract' && (e.contract_arms_length === 0 || e.contract_arms_length === 1))
      catLabel = `${esc(e.category)} · ${e.contract_arms_length === 1 ? "arm's length" : "non-arm's-length"}`;
    body += `
      <div><strong>Date:</strong> ${esc(e.expense_date)}</div>
      <div><strong>Category:</strong> ${catLabel}</div>
      <div><strong>Amount:</strong> ${(e.amount_cents/100).toFixed(2)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</div>
      <div><strong>Status:</strong> <span class="pill ${e.status}">${esc(e.status)}</span></div>
      <div class="full"><strong>Description:</strong> ${esc(e.description)}</div>
      ${e.category === 'overhead' && e.allocation_basis ? `<div class="full"><strong>Allocation basis:</strong> ${esc(e.allocation_basis)}</div>` : ''}
      ${e.fx_rate && e.fx_rate_source ? `<div class="full"><strong>FX-rate source:</strong> ${esc(e.fx_rate_source)}</div>` : ''}
      ${e.reviewed_at ? `<div class="full muted"><strong>Reviewed</strong> ${esc(e.reviewed_at)} (user #${e.reviewed_by_user_id})</div>` : ''}
      ${e.rejection_reason ? `<div class="full"><strong>Rejection reason:</strong> <span class="muted">${esc(e.rejection_reason)}</span></div>` : ''}
    `;
  } else if (type === 'evidence') {
    body += `
      <div><strong>Date:</strong> ${esc(e.evidence_date)}</div>
      <div><strong>Kind:</strong> ${esc(e.kind)}</div>
      <div class="full"><strong>Caption:</strong> ${esc(e.caption)}</div>
      ${e.kind === 'file' ? `<div class="full"><strong>File:</strong> <a href="/api/evidence/${e.id}/download" data-jwt-dl>${esc(e.file_path)}</a> (${e.file_size ?? '?'} bytes, ${esc(e.file_mime ?? '')})</div>` : ''}
      ${e.kind === 'link' ? `<div class="full"><strong>URL:</strong> <a href="${esc(safeHref(e.url))}" target="_blank" rel="noopener">${esc(e.url)}</a></div>` : ''}
      ${e.kind === 'note' ? `<div class="full"><strong>Note:</strong> ${esc(e.note_text)}</div>` : ''}
      ${e.labour_entry_id ? `<div><strong>Linked to:</strong> labour entry #${e.labour_entry_id}</div>` : ''}
      ${e.expense_id ? `<div><strong>Linked to:</strong> expense #${e.expense_id}</div>` : ''}
    `;
  }
  body += `</div>`;

  if (type === 'labour' || type === 'expense') {
    body += `<h4 class="activity-detail-subhead">Linked evidence (${linkedEv.length})</h4>`;
    if (linkedEv.length) {
      body += `<ul class="activity-detail-list">${linkedEv.map(ev =>
        `<li><span class="pill type-evidence">${esc(ev.kind)}</span> ${esc(ev.caption)} ${
          ev.kind === 'file' ? `· <a href="/api/evidence/${ev.id}/download" data-jwt-dl>${esc(ev.file_path)}</a>` :
          ev.kind === 'link' ? `· <a href="${esc(safeHref(ev.url))}" target="_blank" rel="noopener">${esc(ev.url)}</a>` :
          `· <span class="muted">${esc((ev.note_text ?? '').slice(0, 120))}</span>`
        }</li>`).join('')}</ul>`;
    }
    // Admin inline-edit affordance: only when the signed-in admin is allowed
    // to PATCH this entry per the same rules the server enforces in
    // assertEditable. Renders above the attach-evidence form so the order
    // matches the natural "fix data, then attach evidence" workflow.
    if (canAdminEdit(e, opts.currentUser)) {
      const formHtml = type === 'labour'
        ? labourEditFormHtml(e, { formAttr: 'data-inline-edit-form' })
        : expenseEditFormHtml(e, { formAttr: 'data-inline-edit-form' });
      body += `
        <details class="mt-sm">
          <summary class="summary-link">✎ Edit fields</summary>
          <div class="mt-sm">${formHtml}</div>
        </details>`;
    }
    const entryDate = type === 'labour' ? e.work_date : e.expense_date;
    body += `
      <details class="mt-sm">
        <summary class="summary-link">＋ Attach evidence</summary>
        <form data-attach-form="${type}-${e.id}" data-project-id="${e.project_id}" data-entry-date="${esc(entryDate)}" class="row gap-md mt-sm align-end wrap">
          <div><label>Kind
            <select name="ev_kind" class="ev-kind">
              <option value="file">File</option>
              <option value="link">Link</option>
            </select>
          </label></div>
          <div><label>Date <input type="date" name="evidence_date" value="${esc(entryDate)}"></label></div>
          <div class="input-grow"><label>Caption <input name="caption" placeholder="What this shows"></label></div>
          <div class="full ev-file"><label>File <input type="file" name="ev_file"></label></div>
          <div class="full ev-url" hidden><label>URL <input type="url" name="ev_url" placeholder="https://…"></label></div>
          <div><button class="small">Add evidence</button></div>
        </form>
      </details>`;
  }
  if (auditItems.length) {
    body += `<details class="mt-md"><summary class="caption summary-toggle">Audit log (${auditItems.length})</summary>
      <ul class="activity-audit-list">${auditItems.map(a =>
        `<li>${esc(a.created_at)} · <strong>${esc(a.action)}</strong> by ${esc(a.actor_name ?? '(system)')}</li>`).join('')}</ul></details>`;
  }
  return `<div class="card-inset">${body}</div>`;
}

// JWT-authenticated download interceptor, reusable across shells.
//
// Reads the JWT directly from sessionStorage to avoid pulling session.js
// internals into the public re-export surface — this is the only place
// outside session.js that touches the storage key.
export function wireJwtDownloads(root) {
  root.querySelectorAll('[data-jwt-dl]').forEach(a => {
    if (a.dataset.jwtBound) return;
    a.dataset.jwtBound = '1';
    a.addEventListener('click', async e => {
      e.preventDefault();
      const r = await fetch(a.getAttribute('href'), {
        headers: { authorization: `Bearer ${sessionStorage.getItem('sred-jwt')}` },
      });
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const tmp = document.createElement('a');
      tmp.href = url;
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      tmp.download = m ? m[1] : 'download';
      tmp.click();
      URL.revokeObjectURL(url);
    });
  });
}

function activityDetails(it) {
  if (it.type === 'labour') {
    const ot = it.is_overtime ? ' <span class="pill overtime">OT</span>' : '';
    return `<strong>${it.hours}h</strong>${ot} — ${esc(it.description)} `
      + `<span class="pill ${it.status}">${esc(it.status)}</span>`;
  }
  if (it.type === 'expense') {
    const fx = it.fx_rate ? ` @ ${it.fx_rate}` : '';
    return `<strong>${cents(it.amount_cents)} ${esc(it.currency)}${fx}</strong> `
      + `<span class="pill type-${it.type}">${esc(it.category)}</span> — ${esc(it.description)} `
      + `<span class="pill ${it.status}">${esc(it.status)}</span>`;
  }
  if (it.type === 'evidence') {
    return `<strong>${esc(it.evidence_kind)}</strong> — ${esc(it.caption)}`;
  }
  return '';
}

export function chartHtml(bars) {
  return `
    <div class="chart">
      ${bars.map(b => `
        <div class="col${b.isToday ? ' today' : ''}" title="${b.date} — ${b.hours.toFixed(2)} h">
          <div class="bar-wrap">
            <div class="bar" style="height: ${b.pct}%">
              ${b.hours > 0 ? `<span class="bar-value">${b.hours.toFixed(1)}</span>` : ''}
            </div>
          </div>
          <div class="bar-label">
            ${b.label}<br><span class="muted">${b.date.slice(5)}</span>
            ${b.isToday ? '<div class="today-mark">TODAY</div>' : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
}
