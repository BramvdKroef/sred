// Visual audit driver. Walks the SR&ED SPA across four viewport widths,
// minted JWTs for an admin and an employee. Saves full-page screenshots,
// runs axe-core scans, captures console/network noise, samples computed
// styles on representative elements, and emits a JSON artifact that the
// report writer consumes.
//
// Usage:
//   node tools/visual-audit.mjs \
//       --admin-jwt $ADMIN_JWT \
//       --employee-jwt $EMPLOYEE_JWT \
//       --base http://localhost:3057 \
//       --out ./RENDER_REVIEW_ARTIFACTS/audit.json
//
// The agent doing this audit has no system Chromium installed by Playwright;
// it falls back to /usr/bin/google-chrome via `executablePath`.

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const BASE         = arg('base', 'http://localhost:3057');
const ADMIN_JWT    = arg('admin-jwt');
const EMPLOYEE_JWT = arg('employee-jwt');
const OUT_PATH     = arg('out', './RENDER_REVIEW_ARTIFACTS/audit.json');
const SHOT_ROOT    = arg('shots', './screenshots');
const EXEC_PATH    = arg('exec', '/usr/bin/google-chrome');

if (!ADMIN_JWT || !EMPLOYEE_JWT) {
  console.error('mint admin/employee JWTs and pass with --admin-jwt / --employee-jwt');
  process.exit(1);
}

const VIEWPORTS = [
  { name: '1440x900',  width: 1440, height: 900 },
  { name: '1024x768',  width: 1024, height: 768 },
  { name: '768x1024',  width: 768,  height: 1024 },
  { name: '375x667',   width: 375,  height: 667 },
];

// Each entry: { role, jwt, hash, label }
// Labels are zero-padded so screenshots sort in narrative order.
const PAGES = [
  // --- pre-auth ---
  { role: 'preauth',  jwt: null,         hash: '',                label: '00-login' },

  // --- admin shell ---
  { role: 'admin',    jwt: 'admin',      hash: '#overview',       label: '01-overview' },
  { role: 'admin',    jwt: 'admin',      hash: '#projects',       label: '02-projects' },
  { role: 'admin',    jwt: 'admin',      hash: '#projects/1',     label: '03-project-detail' },
  { role: 'admin',    jwt: 'admin',      hash: '#review',         label: '04-review' },
  { role: 'admin',    jwt: 'admin',      hash: '#exports',        label: '05-exports' },
  { role: 'admin',    jwt: 'admin',      hash: '#employees',      label: '06-employees' },
  { role: 'admin',    jwt: 'admin',      hash: '#employees/2',    label: '07-employee-detail' },
  { role: 'admin',    jwt: 'admin',      hash: '#audit',          label: '08-audit' },
  { role: 'admin',    jwt: 'admin',      hash: '#preferences',    label: '09-preferences' },

  // --- employee shell ---
  { role: 'employee', jwt: 'employee',   hash: '#overview',       label: '20-overview' },
  { role: 'employee', jwt: 'employee',   hash: '#activity',       label: '21-activity' },
  { role: 'employee', jwt: 'employee',   hash: '#log-labour',     label: '22-log-labour' },
  { role: 'employee', jwt: 'employee',   hash: '#submit-expense', label: '23-submit-expense' },
  { role: 'employee', jwt: 'employee',   hash: '#add-evidence',   label: '24-add-evidence' },
  { role: 'employee', jwt: 'employee',   hash: '#preferences',    label: '25-preferences' },
];

function tokenFor(jwtKind) {
  if (jwtKind === 'admin') return ADMIN_JWT;
  if (jwtKind === 'employee') return EMPLOYEE_JWT;
  return null;
}

// Sample selectors that we want computed styles for. These are conservative
// (used across the app per a quick grep of style.css and the shells).
const STYLE_SAMPLES = [
  { sel: 'h1',                    note: 'page heading' },
  { sel: 'h2',                    note: 'section heading' },
  { sel: 'button.primary',        note: 'primary button' },
  { sel: 'button.danger',         note: 'danger button' },
  { sel: '.pill',                 note: 'pill (any variant)' },
  { sel: 'table th',              note: 'table header cell' },
  { sel: 'table td',              note: 'table body cell' },
  { sel: 'nav a',                 note: 'nav link' },
  { sel: 'input',                 note: 'text input' },
];

async function dismissOverlays(page) {
  // Most modals close on Escape; if any are open at audit time, send a few
  // escapes so the screenshot reflects the canonical screen.
  await page.keyboard.press('Escape').catch(() => {});
}

async function gotoPage(page, baseUrl, hash, token) {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  if (token) {
    await page.evaluate(t => { sessionStorage.setItem('sred-jwt', t); }, token);
  } else {
    await page.evaluate(() => { sessionStorage.removeItem('sred-jwt'); });
  }
  const target = baseUrl + '/' + (hash || '');
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  // Let the SPA wire up + finish its initial XHRs.
  try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
  // tiny settle
  await page.waitForTimeout(250);
  await dismissOverlays(page);
}

async function sampleComputedStyles(page) {
  return page.evaluate((samples) => {
    const props = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'padding', 'fontFamily', 'borderRadius'];
    const out = [];
    for (const { sel, note } of samples) {
      const els = Array.from(document.querySelectorAll(sel));
      if (!els.length) continue;
      const el = els[0];
      const cs = getComputedStyle(el);
      const sample = { sel, note, count: els.length, styles: {} };
      for (const p of props) sample.styles[p] = cs[p];
      // If multiple, capture a second representative
      if (els.length > 1) {
        const cs2 = getComputedStyle(els[els.length - 1]);
        sample.lastStyles = {};
        for (const p of props) sample.lastStyles[p] = cs2[p];
      }
      out.push(sample);
    }
    return out;
  }, STYLE_SAMPLES);
}

async function detectOverflows(page) {
  // Walk the DOM. Skip elements inside known scroll containers. Flag any
  // element whose scrollWidth exceeds its clientWidth — that's content that
  // wants to spill horizontally.
  return page.evaluate(() => {
    const SCROLL_OK = ['table-scroll', 'search-results'];
    const TAG_OK = new Set(['PRE', 'CODE', 'TEXTAREA']);
    const out = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (TAG_OK.has(el.tagName)) continue;
      let p = el;
      let inOk = false;
      while (p) {
        if (p.classList && SCROLL_OK.some(c => p.classList.contains(c))) { inOk = true; break; }
        p = p.parentElement;
      }
      if (inOk) continue;
      const sw = el.scrollWidth, cw = el.clientWidth;
      if (sw > cw + 1 && cw > 0) {
        // Skip tiny inline elements where the discrepancy is sub-pixel.
        if (sw - cw < 4) continue;
        // Capture a short selector for a human reviewer.
        const tag = el.tagName.toLowerCase();
        const cls = (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '';
        const id = el.id ? '#' + el.id : '';
        out.push({
          selector: `${tag}${id}${cls}`.slice(0, 120),
          scrollWidth: sw,
          clientWidth: cw,
          overflow: sw - cw,
        });
      }
    }
    // De-dupe by selector; keep the worst case.
    const map = new Map();
    for (const r of out) {
      const k = r.selector;
      const prev = map.get(k);
      if (!prev || r.overflow > prev.overflow) map.set(k, r);
    }
    return [...map.values()].sort((a, b) => b.overflow - a.overflow).slice(0, 50);
  });
}

async function focusRingCheck(page) {
  // Focus a sample of interactive elements and capture computed outline/box-shadow.
  return page.evaluate(() => {
    const sels = ['button', 'input', 'a[href]', 'select', 'textarea'];
    const out = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.focus();
      const cs = getComputedStyle(el);
      out.push({
        sel,
        outline: cs.outline,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        outlineOffset: cs.outlineOffset,
        boxShadow: cs.boxShadow,
        activeMatchesFocusVisible: el.matches(':focus-visible'),
      });
    }
    // Blur the last so subsequent screenshots aren't biased.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return out;
  });
}

async function runAxe(page) {
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ['violations'] })
    .analyze();
  // Trim down to the bits the reporter needs.
  return results.violations.map(v => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, 5).map(n => ({
      target: n.target.join(' '),
      html: n.html.slice(0, 240),
      failureSummary: n.failureSummary,
    })),
    nodeCount: v.nodes.length,
  }));
}

async function main() {
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.mkdir(SHOT_ROOT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const audit = {
    base: BASE,
    startedAt: new Date().toISOString(),
    viewports: VIEWPORTS.map(v => v.name),
    pagesPlanned: PAGES.length * VIEWPORTS.length,
    results: [],
    notes: [],
  };

  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        // Ignore HTTPS cert problems (we're on http anyway)
        ignoreHTTPSErrors: true,
      });
      const page = await ctx.newPage();

      // Capture console + network noise per viewport, then attribute to the
      // currently-loading page label.
      let currentLabel = '__init__';
      const consoleLog = [];
      const networkLog = [];

      page.on('console', msg => {
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
          consoleLog.push({
            page: currentLabel,
            type,
            text: msg.text().slice(0, 400),
            location: msg.location().url ? `${msg.location().url}:${msg.location().lineNumber}` : null,
          });
        }
      });
      page.on('pageerror', err => {
        consoleLog.push({
          page: currentLabel,
          type: 'pageerror',
          text: String(err && err.message || err).slice(0, 400),
        });
      });
      page.on('response', resp => {
        const status = resp.status();
        if (status >= 400) {
          networkLog.push({
            page: currentLabel,
            status,
            method: resp.request().method(),
            url: resp.url(),
          });
        }
      });

      for (const def of PAGES) {
        currentLabel = `${def.role}-${def.label}`;
        const token = tokenFor(def.jwt);
        const dir = path.join(SHOT_ROOT, vp.name);
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${def.role}-${def.label}.png`);
        const result = {
          viewport: vp.name,
          role: def.role,
          hash: def.hash,
          label: def.label,
          file,
          ok: false,
        };
        try {
          await gotoPage(page, BASE, def.hash, token);
          await page.screenshot({ path: file, fullPage: true });
          // Don't re-run axe per viewport for the same page on small viewports
          // — keep cost down — but DO run it on at least two: 1440 + 375.
          const runAxeHere = vp.name === '1440x900' || vp.name === '375x667';
          if (runAxeHere) {
            try { result.axe = await runAxe(page); } catch (e) { result.axeError = String(e.message || e); }
          }
          try { result.styles    = await sampleComputedStyles(page); } catch (e) { result.stylesError    = String(e.message || e); }
          try { result.overflows = await detectOverflows(page);      } catch (e) { result.overflowsError = String(e.message || e); }
          try { result.focus     = await focusRingCheck(page);       } catch (e) { result.focusError     = String(e.message || e); }
          result.title = await page.title().catch(() => null);
          // What hash did we actually end up on? (catch silent redirects.)
          result.finalHash = await page.evaluate(() => location.hash);
          result.ok = true;
        } catch (e) {
          result.error = String(e.message || e);
        }
        audit.results.push(result);
        process.stdout.write(`[${vp.name}] ${def.role}-${def.label} ${result.ok ? 'ok' : 'FAIL'}\n`);
      }

      audit.console = (audit.console || []).concat(consoleLog);
      audit.network = (audit.network || []).concat(networkLog);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  audit.finishedAt = new Date().toISOString();
  await fs.writeFile(OUT_PATH, JSON.stringify(audit, null, 2));
  console.log(`audit written to ${OUT_PATH}`);
  console.log(`screenshots under ${SHOT_ROOT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
