import { api, apiUpload, $, esc, cents, currentWeek, weekBars, chartHtml, activityHtml,
         attachInlineEvidence, attachInlineReceipt, bindEvidenceKindToggle,
         wireJwtDownloads, renderPreferencesPage, bindForm, onSubmit } from './api.js';

const state = {
  me: null,
  signOut: null,
  tab: 'overview',
  projects: [],
  labour: [],
  expenses: [],
  evidence: [],
  activity: [],
};

export async function renderEmployee(ctx) {
  state.me = ctx.me;
  state.signOut = ctx.signOut;
  shell();
  await reload();
}

const ALLOWED_TABS = ['overview', 'activity', 'labour', 'evidence', 'expense', 'preferences'];

function shell() {
  const initial = location.hash.slice(1);
  if (ALLOWED_TABS.includes(initial)) state.tab = initial;
  else location.hash = state.tab;

  $('#app').innerHTML = `
    <header>
      <h1>Precision <strong>SR&amp;ED</strong></h1>
      <div class="user">
        <strong><a href="#preferences" class="header-link">${esc(state.me.user.name)}</a></strong>
        <span class="role">employee</span>
        <button class="secondary small" id="signout">Sign out</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabBtn('overview', 'Overview')}
      ${tabBtn('activity', 'My activity')}
      ${tabBtn('labour', 'Log labour')}
      ${tabBtn('evidence', 'Add evidence')}
      ${tabBtn('expense', 'Submit expense')}
    </nav>
    <main id="main"></main>
  `;
  $('#signout').addEventListener('click', state.signOut);
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.addEventListener('click', () => { location.hash = b.dataset.tab; });
  });
  window.addEventListener('hashchange', onHashChange);
}

function onHashChange() {
  const tab = location.hash.slice(1);
  if (ALLOWED_TABS.includes(tab) && tab !== state.tab) {
    state.tab = tab;
    render();
  }
}

const tabBtn = (key, label) =>
  `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${esc(label)}</button>`;

async function reload() {
  const [projects, labour, expenses, evidence, activity] = await Promise.all([
    api('GET', '/api/me/projects'),
    api('GET', '/api/labour'),
    api('GET', '/api/expenses'),
    api('GET', '/api/evidence'),
    api('GET', '/api/activity?limit=15'),
  ]);
  state.projects = projects.items;
  state.labour = labour.items;
  state.expenses = expenses.items;
  state.evidence = evidence.items;
  state.activity = activity.items;
  render();
}

function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
  });
  const main = $('#main');
  if (state.tab === 'overview') main.innerHTML = renderOverview();
  else if (state.tab === 'preferences') return renderPreferencesPage(main);
  else if (state.tab === 'activity') main.innerHTML = renderActivity();
  else if (state.tab === 'labour') main.innerHTML = renderLabourForm();
  else if (state.tab === 'evidence') main.innerHTML = renderEvidenceForm();
  else if (state.tab === 'expense') main.innerHTML = renderExpenseForm();
  bind();
}

// --- Overview tab ----------------------------------------------------------

function renderOverview() {
  const week = currentWeek();
  const thisWeek = state.labour.filter(l =>
    l.work_date >= week.from && l.work_date <= week.to && l.status !== 'rejected');
  const totalHours = thisWeek.reduce((s, e) => s + e.hours, 0);
  const pendingMine = state.labour.filter(l => l.status === 'pending').length;
  const rejectedMine = state.labour.filter(l => l.status === 'rejected').length;
  const bars = weekBars(thisWeek, week.days);
  return `
    <div class="card">
      <h2>This week — ${esc(week.from)} → ${esc(week.to)}</h2>
      <div class="metrics">
        <div><div class="metric">${totalHours.toFixed(2)}</div><div class="muted">hours logged</div></div>
        <div><div class="metric">${pendingMine}</div><div class="muted">pending review</div></div>
        ${rejectedMine ? `<div><div class="metric">${rejectedMine}</div><div class="muted">to fix</div></div>` : ''}
        <div><div class="metric">${state.projects.length}</div><div class="muted">assigned project${state.projects.length === 1 ? '' : 's'}</div></div>
      </div>
      ${chartHtml(bars)}
      <p class="muted" style="margin-top:0.75rem">Use “Log labour” to add to today, or jump to “My activity” to review history.</p>
    </div>
    <div class="card">
      <h2>Recent activity</h2>
      ${activityHtml(state.activity, { showActor: false })}
    </div>
  `;
}

// --- Activity tab ----------------------------------------------------------

function renderActivity() {
  const projTitle = id => state.projects.find(p => p.id === id)?.title ?? `#${id}`;
  return `
    <div class="card">
      <h2>Assigned projects</h2>
      ${state.projects.length === 0 ? '<p class="empty">No project assignments yet — ask your admin.</p>' : `
      <table>
        <thead><tr><th>Project</th><th>Claimant</th><th>Status</th></tr></thead>
        <tbody>${state.projects.map(p => `
          <tr><td>${esc(p.title)}</td><td>${esc(p.claimant_name)}</td><td><span class="pill">${esc(p.status)}</span></td></tr>
        `).join('')}</tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My labour (${state.labour.length})</h2>
      ${state.labour.length === 0 ? '<p class="empty">No entries.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Hours</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${state.labour.map(e => {
          const editable = e.status !== 'approved';
          return `
          <tr>
            <td>${esc(e.work_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${e.hours}${e.is_overtime ? ' <span class="pill overtime">OT</span>' : ''}</td>
            <td>${esc(e.description)}</td>
            <td><span class="pill ${e.status}">${esc(e.status)}</span>${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
            <td class="actions">${editable ? `<button class="small secondary" data-edit-labour="${e.id}">Edit</button>` : '<span class="muted">locked</span>'}</td>
          </tr>
          ${editable ? `<tr id="row-edit-labour-${e.id}" hidden><td colspan="6">${labourEditForm(e)}</td></tr>` : ''}
          `;
        }).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My expenses (${state.expenses.length})</h2>
      ${state.expenses.length === 0 ? '<p class="empty">None.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Category</th><th>Amount</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${state.expenses.map(e => {
          const editable = e.status !== 'approved';
          return `
          <tr>
            <td>${esc(e.expense_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${esc(e.category)}</td>
            <td>${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td>${esc(e.description)}</td>
            <td><span class="pill ${e.status}">${esc(e.status)}</span>${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
            <td class="actions">${editable ? `<button class="small secondary" data-edit-expense="${e.id}">Edit</button>` : '<span class="muted">locked</span>'}</td>
          </tr>
          ${editable ? `<tr id="row-edit-expense-${e.id}" hidden><td colspan="7">${expenseEditForm(e)}</td></tr>` : ''}
          `;
        }).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My evidence (${state.evidence.length})</h2>
      ${state.evidence.length === 0 ? '<p class="empty">None.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Kind</th><th>Caption</th><th>Reference</th><th></th></tr></thead>
        <tbody>${state.evidence.map(e => `
          <tr>
            <td>${esc(e.evidence_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${esc(e.kind)}</td>
            <td>${esc(e.caption)}</td>
            <td>${e.kind === 'file'
                  ? `<a href="/api/evidence/${e.id}/download" data-jwt-dl>${esc(e.file_path)}</a>`
                  : e.kind === 'link' ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>`
                  : `<span class="muted">${esc(e.note_text)}</span>`}</td>
            <td class="actions"><button class="small secondary" data-edit-evidence="${e.id}">Edit</button></td>
          </tr>
          <tr id="row-edit-evidence-${e.id}" hidden><td colspan="6">${evidenceEditForm(e)}</td></tr>
          `).join('')}
        </tbody>
      </table>`}
    </div>
  `;
}

const projectSelect = () => state.projects.length === 0
  ? '<p class="empty">No assigned projects.</p>'
  : `<select name="project_id" required>${state.projects.map(p =>
      `<option value="${p.id}">${esc(p.title)} (${esc(p.claimant_name)})</option>`).join('')}</select>`;

// --- Inline edit forms for My-activity rows -------------------------------

function labourEditForm(e) {
  return `<form data-form-edit-labour="${e.id}" class="row" style="gap:0.5rem; align-items:flex-start; padding:0.5rem 0">
    <div><label>Date</label><input type="date" name="work_date" value="${esc(e.work_date)}" required></div>
    <div><label>Hours</label><input type="number" name="hours" step="0.25" min="0.25" max="24" value="${e.hours}" required style="width:6rem"></div>
    <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime" ${e.is_overtime ? 'checked' : ''}> Overtime</label></div>
    <div class="input-grow"><label>Description</label><input name="description" value="${esc(e.description)}" required></div>
    <div><label>&nbsp;</label><div class="row" style="gap:0.4rem"><button class="small">Save</button><button type="button" class="small secondary" data-cancel-labour="${e.id}">Cancel</button></div></div>
  </form>`;
}

function expenseEditForm(e) {
  const cats = ['material','contract','third_party_payment','overhead'];
  return `<form data-form-edit-expense="${e.id}" class="row" style="gap:0.5rem; align-items:flex-start; padding:0.5rem 0; flex-wrap:wrap">
    <div><label>Date</label><input type="date" name="expense_date" value="${esc(e.expense_date)}" required></div>
    <div><label>Category</label><select name="category">${cats.map(c =>
      `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div><label>Amount (cents)</label><input type="number" name="amount_cents" min="1" value="${e.amount_cents}" required style="width:8rem"></div>
    <div><label>Currency</label><input name="currency" value="${esc(e.currency)}" required style="width:5rem"></div>
    <div><label>FX rate</label><input type="number" step="0.0001" name="fx_rate" value="${e.fx_rate ?? ''}" style="width:6rem"></div>
    <div class="input-grow"><label>Description</label><input name="description" value="${esc(e.description)}" required></div>
    <div><label>&nbsp;</label><div class="row" style="gap:0.4rem"><button class="small">Save</button><button type="button" class="small secondary" data-cancel-expense="${e.id}">Cancel</button></div></div>
  </form>`;
}

function evidenceEditForm(e) {
  return `<form data-form-edit-evidence="${e.id}" class="row" style="gap:0.5rem; align-items:flex-start; padding:0.5rem 0; flex-wrap:wrap">
    <div><label>Date</label><input type="date" name="evidence_date" value="${esc(e.evidence_date)}" required></div>
    <div class="input-grow"><label>Caption</label><input name="caption" value="${esc(e.caption)}" required></div>
    ${e.kind === 'link' ? `<div class="input-grow"><label>URL</label><input type="url" name="url" value="${esc(e.url ?? '')}" required></div>` : ''}
    ${e.kind === 'note' ? `<div style="flex:1 1 100%"><label>Note</label><textarea name="note_text" rows="2" required>${esc(e.note_text ?? '')}</textarea></div>` : ''}
    ${e.kind === 'file' ? `<div><label>&nbsp;</label><span class="muted">file content not editable</span></div>` : ''}
    <div><label>&nbsp;</label><div class="row" style="gap:0.4rem"><button class="small">Save</button><button type="button" class="small secondary" data-cancel-evidence="${e.id}">Cancel</button></div></div>
  </form>`;
}

// --- Labour form -----------------------------------------------------------

function renderLabourForm() {
  return `<div class="card">
    <h2>Log labour</h2>
    <form id="labour-form">
      <div class="grid">
        <div><label>Project</label>${projectSelect()}</div>
        <div><label>Date</label><input type="date" name="work_date" required></div>
        <div><label>Hours</label><input type="number" name="hours" step="0.25" min="0.25" max="24" required></div>
        <div><label>&nbsp;</label><label class="checkbox-label"><input type="checkbox" name="is_overtime"> Overtime</label></div>
        <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
      </div>
      <details class="attach-block" style="margin-top:0.6rem">
        <summary class="summary-link">＋ Attach evidence (optional)</summary>
        <div class="grid" style="margin-top:0.6rem">
          <div><label>Kind</label>
            <select name="ev_kind" class="ev-kind">
              <option value="">— none —</option>
              <option value="file">File</option>
              <option value="link">Link</option>
            </select>
          </div>
          <div style="flex:1"><label>Caption</label><input name="ev_caption" placeholder="What this evidence shows"></div>
          <div class="full ev-file" hidden><label>File</label><input type="file" name="ev_file"></div>
          <div class="full ev-url"  hidden><label>URL</label><input type="url" name="ev_url" placeholder="https://…"></div>
        </div>
      </details>
      <div class="actions" style="margin-top:0.8rem"><button>Save</button></div>
    </form>
  </div>`;
}

// --- Evidence form ---------------------------------------------------------

function renderEvidenceForm() {
  return `<div class="card">
    <h2>Add evidence</h2>
    <form id="evidence-form">
      <div class="grid">
        <div><label>Project</label>${projectSelect()}</div>
        <div><label>Date</label><input type="date" name="evidence_date" required></div>
        <div><label>Kind</label>
          <select name="kind" id="ev-kind">
            <option value="file">File</option>
            <option value="link">Link</option>
            <option value="note">Note</option>
          </select>
        </div>
        <div class="full"><label>Caption</label><input name="caption" required></div>
        <div class="full" id="ev-file"><label>File</label><input type="file" name="file"></div>
        <div class="full" id="ev-url" hidden><label>URL</label><input type="url" name="url" placeholder="https://…"></div>
        <div class="full" id="ev-note" hidden><label>Note</label><textarea name="note_text" rows="3"></textarea></div>
      </div>
      <div class="actions"><button>Save</button></div>
    </form>
  </div>`;
}

// --- Expense form ----------------------------------------------------------

function renderExpenseForm() {
  return `<div class="card">
    <h2>Submit expense</h2>
    <form id="expense-form">
      <div class="grid">
        <div><label>Project</label>${projectSelect()}</div>
        <div><label>Date</label><input type="date" name="expense_date" required></div>
        <div><label>Category</label>
          <select name="category">
            <option value="material">material</option>
            <option value="contract">contract</option>
            <option value="third_party_payment">third-party payment</option>
            <option value="overhead">overhead</option>
          </select>
        </div>
        <div><label>Amount (cents)</label><input type="number" name="amount_cents" min="1" required></div>
        <div><label>Currency</label><input name="currency" value="CAD"></div>
        <div><label>FX rate (if not reporting currency)</label><input type="number" step="0.0001" name="fx_rate"></div>
        <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
      </div>
      <details class="attach-block" style="margin-top:0.6rem" open>
        <summary class="summary-link">＋ Attach receipt (optional, strongly encouraged)</summary>
        <div class="grid" style="margin-top:0.6rem">
          <div style="flex:1"><label>Caption</label><input name="receipt_caption" placeholder="e.g. Invoice #INV-2026-0312"></div>
          <div class="full"><label>File</label><input type="file" name="receipt_file"></div>
        </div>
      </details>
      <div class="actions" style="margin-top:0.8rem"><button>Save</button></div>
    </form>
  </div>`;
}

// --- Event binding ---------------------------------------------------------

function bind() {
  bindForm('#labour-form', async fd => {
    const entry = await api('POST', '/api/labour', {
      project_id: Number(fd.get('project_id')),
      work_date: fd.get('work_date'),
      hours: Number(fd.get('hours')),
      description: fd.get('description'),
      is_overtime: fd.get('is_overtime') === 'on',
    });
    await attachInlineEvidence(fd, { project_id: entry.project_id, labour_entry_id: entry.id, evidence_date: entry.work_date });
    state.tab = 'activity'; await reload();
  });

  bindForm('#expense-form', async fd => {
    const body = {
      project_id: Number(fd.get('project_id')),
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: Number(fd.get('amount_cents')),
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    if (fx) body.fx_rate = Number(fx);
    const entry = await api('POST', '/api/expenses', body);
    await attachInlineReceipt(fd, { project_id: entry.project_id, expense_id: entry.id, evidence_date: entry.expense_date });
    state.tab = 'activity'; await reload();
  });

  // ev_kind change toggles file vs url input on each form that has the section.
  document.querySelectorAll('form').forEach(bindEvidenceKindToggle);

  const evKind = document.getElementById('ev-kind');
  if (evKind) evKind.addEventListener('change', () => {
    const k = evKind.value;
    document.getElementById('ev-file').hidden = k !== 'file';
    document.getElementById('ev-url').hidden  = k !== 'link';
    document.getElementById('ev-note').hidden = k !== 'note';
  });

  onSubmit(document.getElementById('evidence-form'), async fd => {
    if (fd.get('kind') === 'file') {
      await apiUpload('/api/evidence', fd);
    } else {
      const body = {
        project_id: Number(fd.get('project_id')),
        kind: fd.get('kind'),
        caption: fd.get('caption'),
        evidence_date: fd.get('evidence_date'),
      };
      if (body.kind === 'link') body.url = fd.get('url');
      if (body.kind === 'note') body.note_text = fd.get('note_text');
      await api('POST', '/api/evidence', body);
    }
    state.tab = 'activity'; await reload();
  });

  // Inline row-edit toggles for labour / expense / evidence
  for (const kind of ['labour', 'expense', 'evidence']) {
    document.querySelectorAll(`[data-edit-${kind}]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset[`edit${kind.charAt(0).toUpperCase()}${kind.slice(1)}`];
        document.getElementById(`row-edit-${kind}-${id}`).hidden = false;
      });
    });
    document.querySelectorAll(`[data-cancel-${kind}]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset[`cancel${kind.charAt(0).toUpperCase()}${kind.slice(1)}`];
        document.getElementById(`row-edit-${kind}-${id}`).hidden = true;
      });
    });
  }

  document.querySelectorAll('[data-form-edit-labour]').forEach(form => onSubmit(form, async fd => {
    await api('PATCH', `/api/labour/${form.dataset.formEditLabour}`, {
      work_date: fd.get('work_date'),
      hours: Number(fd.get('hours')),
      description: fd.get('description'),
      is_overtime: fd.get('is_overtime') === 'on',
    });
    await reload();
  }));

  document.querySelectorAll('[data-form-edit-expense]').forEach(form => onSubmit(form, async fd => {
    const body = {
      expense_date: fd.get('expense_date'),
      category: fd.get('category'),
      amount_cents: Number(fd.get('amount_cents')),
      currency: fd.get('currency') || 'CAD',
      description: fd.get('description'),
    };
    const fx = fd.get('fx_rate');
    body.fx_rate = fx ? Number(fx) : null;
    await api('PATCH', `/api/expenses/${form.dataset.formEditExpense}`, body);
    await reload();
  }));

  document.querySelectorAll('[data-form-edit-evidence]').forEach(form => onSubmit(form, async fd => {
    const body = {
      evidence_date: fd.get('evidence_date'),
      caption: fd.get('caption'),
    };
    if (fd.get('url') !== null)       body.url = fd.get('url');
    if (fd.get('note_text') !== null) body.note_text = fd.get('note_text');
    await api('PATCH', `/api/evidence/${form.dataset.formEditEvidence}`, body);
    await reload();
  }));

  wireJwtDownloads(document);
}

