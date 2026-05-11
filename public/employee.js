import { api, apiUpload, $, esc, cents, currentWeek, weekBars, chartHtml, activityHtml } from './api.js';

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

function shell() {
  $('#app').innerHTML = `
    <header>
      <h1>Precision <strong>SR&amp;ED</strong></h1>
      <div class="user">
        <strong>${esc(state.me.user.name)}</strong>
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
    b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); });
  });
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
        <thead><tr><th>Date</th><th>Project</th><th>Hours</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>${state.labour.map(e => `
          <tr>
            <td>${esc(e.work_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${e.hours}</td>
            <td>${esc(e.description)}</td>
            <td><span class="pill ${e.status}">${esc(e.status)}</span>${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My expenses (${state.expenses.length})</h2>
      ${state.expenses.length === 0 ? '<p class="empty">None.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Category</th><th>Amount</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>${state.expenses.map(e => `
          <tr>
            <td>${esc(e.expense_date)}</td>
            <td>${esc(projTitle(e.project_id))}</td>
            <td>${esc(e.category)}</td>
            <td>${cents(e.amount_cents)} ${esc(e.currency)}${e.fx_rate ? ` @ ${e.fx_rate}` : ''}</td>
            <td>${esc(e.description)}</td>
            <td><span class="pill ${e.status}">${esc(e.status)}</span>${e.rejection_reason ? `<div class="muted">${esc(e.rejection_reason)}</div>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>My evidence (${state.evidence.length})</h2>
      ${state.evidence.length === 0 ? '<p class="empty">None.</p>' : `
      <table>
        <thead><tr><th>Date</th><th>Project</th><th>Kind</th><th>Caption</th><th>Reference</th></tr></thead>
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
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `;
}

const projectSelect = () => state.projects.length === 0
  ? '<p class="empty">No assigned projects.</p>'
  : `<select name="project_id" required>${state.projects.map(p =>
      `<option value="${p.id}">${esc(p.title)} (${esc(p.claimant_name)})</option>`).join('')}</select>`;

// --- Labour form -----------------------------------------------------------

function renderLabourForm() {
  return `<div class="card">
    <h2>Log labour</h2>
    <form id="labour-form">
      <div class="grid">
        <div><label>Project</label>${projectSelect()}</div>
        <div><label>Date</label><input type="date" name="work_date" required></div>
        <div><label>Hours</label><input type="number" name="hours" step="0.25" min="0.25" max="24" required></div>
        <div class="full"><label>Description</label><textarea name="description" rows="2" required></textarea></div>
      </div>
      <div class="actions"><button>Save</button></div>
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
      <div class="actions"><button>Save</button></div>
    </form>
  </div>`;
}

// --- Event binding ---------------------------------------------------------

function bind() {
  bindForm('#labour-form', async fd => {
    await api('POST', '/api/labour', {
      project_id: Number(fd.get('project_id')),
      work_date: fd.get('work_date'),
      hours: Number(fd.get('hours')),
      description: fd.get('description'),
    });
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
    await api('POST', '/api/expenses', body);
    state.tab = 'activity'; await reload();
  });

  const evKind = document.getElementById('ev-kind');
  if (evKind) evKind.addEventListener('change', () => {
    const k = evKind.value;
    document.getElementById('ev-file').hidden = k !== 'file';
    document.getElementById('ev-url').hidden  = k !== 'link';
    document.getElementById('ev-note').hidden = k !== 'note';
  });

  const evForm = document.getElementById('evidence-form');
  if (evForm) evForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(evForm);
    try {
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
    } catch (err) { alert(err.message); }
  });

  // JWT-authenticated downloads
  document.querySelectorAll('[data-jwt-dl]').forEach(a => {
    a.addEventListener('click', async e => {
      e.preventDefault();
      const r = await fetch(a.getAttribute('href'), { headers: { authorization: `Bearer ${sessionStorage.getItem('sred-jwt')}` } });
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

function bindForm(selector, handler) {
  const form = document.querySelector(selector);
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try { await handler(new FormData(form)); }
    catch (err) { alert(err.message); }
  });
}
