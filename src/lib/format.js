// Format the computed T661 totals for download.

function dollars(cents, currency = 'CAD') {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function toMarkdown(totals) {
  const c = totals.claimant;
  const p = totals.fiscal_period;
  const lines = [
    `# T661 export — ${c.legal_name}`,
    ``,
    `Business number: ${c.business_number ?? '_(not set)_'}`,
    `Fiscal period:   ${p.start_date} → ${p.end_date} (${p.status})`,
    `SR&ED method:    ${c.sred_method}`,
    `Reporting:       ${c.reporting_currency}`,
    `Generated:       ${totals.generated_at}`,
    ``,
    `## Grand totals`,
    ``,
    `| Line | Amount |`,
    `| --- | ---: |`,
    `| Labour | ${dollars(totals.grand_total.labour_cost_cents, c.reporting_currency)} |`,
    `| Materials | ${dollars(totals.grand_total.materials_cents, c.reporting_currency)} |`,
    `| Contract expenditures | ${dollars(totals.grand_total.contract_expenditures_cents, c.reporting_currency)} |`,
    `| Third-party payments | ${dollars(totals.grand_total.third_party_payments_cents, c.reporting_currency)} |`,
    `| Overhead${c.sred_method === 'proxy' ? ' (proxy, 55% of labour)' : ''} | ${dollars(totals.grand_total.overhead_cents, c.reporting_currency)} |`,
    `| **Total** | **${dollars(totals.grand_total.total_cents, c.reporting_currency)}** |`,
    ``,
  ];

  for (const proj of totals.projects) {
    lines.push(`## ${proj.title} (id ${proj.id})`);
    lines.push(``);
    lines.push(`*Field*: ${proj.field_of_science ?? '_(unset)_'}`);
    lines.push(`*Period*: ${proj.start_date}${proj.end_date ? ' → ' + proj.end_date : ''}  *Status*: ${proj.status}`);
    lines.push(``);
    lines.push(`### Narrative`);
    lines.push(``);
    lines.push(`**Advancement sought:** ${proj.narrative.advancement_sought ?? '_(unset)_'}`);
    lines.push(``);
    lines.push(`**Uncertainties:** ${proj.narrative.uncertainties ?? '_(unset)_'}`);
    lines.push(``);
    lines.push(`**Work performed:** ${proj.narrative.work_performed ?? '_(unset)_'}`);
    lines.push(``);
    lines.push(`### Totals`);
    lines.push(``);
    lines.push(`- Labour: ${dollars(proj.totals.labour_cost_cents, c.reporting_currency)}`);
    lines.push(`- Materials: ${dollars(proj.totals.materials_cents, c.reporting_currency)}`);
    lines.push(`- Contract: ${dollars(proj.totals.contract_expenditures_cents, c.reporting_currency)}`);
    lines.push(`- Third-party: ${dollars(proj.totals.third_party_payments_cents, c.reporting_currency)}`);
    lines.push(`- Overhead: ${dollars(proj.totals.overhead_cents, c.reporting_currency)}`);
    lines.push(`- **Total: ${dollars(proj.totals.total_cents, c.reporting_currency)}**`);
    lines.push(``);
    if (proj.labour_worksheet.length) {
      lines.push(`### Labour worksheet`);
      lines.push(``);
      lines.push(`| Employee | Specified | Hours | Cost | Cap applied |`);
      lines.push(`| --- | :-: | ---: | ---: | :-: |`);
      for (const r of proj.labour_worksheet) {
        lines.push(`| ${r.employee_name} | ${r.is_specified_employee ? '✓' : ''} | ${r.total_hours.toFixed(2)} | ${dollars(r.labour_cost_cents, c.reporting_currency)} | ${r.cap_applied ? '✓' : ''} |`);
      }
      lines.push(``);
    }
    if (proj.expense_lines.length) {
      lines.push(`### Expenses`);
      lines.push(``);
      lines.push(`| Date | Category | Amount | Currency | FX | In ${c.reporting_currency} | Description |`);
      lines.push(`| --- | --- | ---: | --- | ---: | ---: | --- |`);
      for (const e of proj.expense_lines) {
        lines.push(`| ${e.expense_date} | ${e.category} | ${(e.amount_cents/100).toFixed(2)} | ${e.currency} | ${e.fx_rate ?? '1'} | ${(e.reporting_amount_cents/100).toFixed(2)} | ${e.description} |`);
      }
      lines.push(``);
    }
  }
  return lines.join('\n');
}

export function toCsv(totals) {
  const rows = [
    ['line', 'project_id', 'project_title', 'currency', 'amount_cents'],
  ];
  for (const p of totals.projects) {
    rows.push(['labour', p.id, p.title, totals.claimant.reporting_currency, p.totals.labour_cost_cents]);
    rows.push(['materials', p.id, p.title, totals.claimant.reporting_currency, p.totals.materials_cents]);
    rows.push(['contract', p.id, p.title, totals.claimant.reporting_currency, p.totals.contract_expenditures_cents]);
    rows.push(['third_party_payment', p.id, p.title, totals.claimant.reporting_currency, p.totals.third_party_payments_cents]);
    rows.push(['overhead', p.id, p.title, totals.claimant.reporting_currency, p.totals.overhead_cents]);
    rows.push(['project_total', p.id, p.title, totals.claimant.reporting_currency, p.totals.total_cents]);
  }
  rows.push(['grand_total', '', '', totals.claimant.reporting_currency, totals.grand_total.total_cents]);
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';

// PDF rendering uses pdfkit. The output is a readable stream the export
// route can pipe straight to the response.
export function toPdf(totals) {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 60, bottom: 60, left: 60, right: 60 } });
  const out = new PassThrough();
  doc.pipe(out);

  const c = totals.claimant;
  const p = totals.fiscal_period;
  const ccy = c.reporting_currency;
  const cents = (n) => `${(n / 100).toFixed(2)} ${ccy}`;
  const BRAND = '#0078b5';
  const MUTED = '#6b7480';

  // ── Header ──────────────────────────────────────────────────────────
  doc.fillColor(BRAND).fontSize(22).font('Helvetica-Bold').text('T661 export');
  doc.fillColor('black').fontSize(16).font('Helvetica').text(c.legal_name);
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor(MUTED);
  metaLine(doc, 'Business number', c.business_number ?? '(not set)');
  metaLine(doc, 'Fiscal period',   `${p.start_date} → ${p.end_date}  (${p.status})`);
  metaLine(doc, 'SR&ED method',    c.sred_method);
  metaLine(doc, 'Reporting',       ccy);
  metaLine(doc, 'Generated',       totals.generated_at);
  doc.fillColor('black').moveDown(1);

  // ── Grand totals ────────────────────────────────────────────────────
  sectionHeader(doc, 'Grand totals', BRAND);
  const g = totals.grand_total;
  totalsRow(doc, 'Labour',                                                       cents(g.labour_cost_cents));
  totalsRow(doc, 'Materials',                                                    cents(g.materials_cents));
  totalsRow(doc, 'Contract expenditures',                                        cents(g.contract_expenditures_cents));
  totalsRow(doc, 'Third-party payments',                                         cents(g.third_party_payments_cents));
  totalsRow(doc, `Overhead${c.sred_method === 'proxy' ? ' (proxy 55%)' : ''}`,   cents(g.overhead_cents));
  doc.moveDown(0.2);
  totalsRow(doc, 'Total',                                                        cents(g.total_cents), true);
  doc.moveDown(1.5);

  // ── Per project ─────────────────────────────────────────────────────
  for (const proj of totals.projects) {
    if (doc.y > 640) doc.addPage();
    sectionHeader(doc, proj.title, BRAND);
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(
      `Project #${proj.id}  ·  ${proj.field_of_science ?? '(field unset)'}  ·  ` +
      `Status: ${proj.status}  ·  ${proj.start_date}${proj.end_date ? ` → ${proj.end_date}` : ''}`
    );
    doc.fillColor('black').moveDown(0.5);

    narrativeBlock(doc, 'Advancement sought', proj.narrative.advancement_sought);
    narrativeBlock(doc, 'Technological uncertainties', proj.narrative.uncertainties);
    narrativeBlock(doc, 'Work performed', proj.narrative.work_performed);

    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND).text('Totals'); doc.fillColor('black');
    doc.fontSize(9).font('Helvetica');
    totalsRow(doc, 'Labour',         cents(proj.totals.labour_cost_cents));
    totalsRow(doc, 'Materials',      cents(proj.totals.materials_cents));
    totalsRow(doc, 'Contract',       cents(proj.totals.contract_expenditures_cents));
    totalsRow(doc, 'Third-party',    cents(proj.totals.third_party_payments_cents));
    totalsRow(doc, 'Overhead',       cents(proj.totals.overhead_cents));
    totalsRow(doc, 'Project total',  cents(proj.totals.total_cents), true);
    doc.moveDown(0.6);

    if (proj.labour_worksheet.length) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND).text('Labour worksheet'); doc.fillColor('black');
      doc.fontSize(9).font('Helvetica');
      for (const r of proj.labour_worksheet) {
        const flags = [r.is_specified_employee ? 'specified' : null, r.cap_applied ? 'cap applied' : null].filter(Boolean).join(', ');
        const tail  = flags ? `  [${flags}]` : '';
        doc.text(`  ${r.employee_name}: ${r.total_hours.toFixed(2)}h  ·  ${cents(r.labour_cost_cents)}${tail}`);
      }
      doc.moveDown(0.4);
    }

    if (proj.expense_lines.length) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND).text('Expenses'); doc.fillColor('black');
      doc.fontSize(9).font('Helvetica');
      for (const e of proj.expense_lines) {
        const fx = e.fx_rate ? ` @ ${e.fx_rate}` : '';
        doc.text(`  ${e.expense_date}  ·  ${e.category}  ·  ${(e.amount_cents/100).toFixed(2)} ${e.currency}${fx}  (${cents(e.reporting_amount_cents)})  — ${e.description}`);
      }
      doc.moveDown(0.4);
    }
    doc.moveDown(0.8);
  }

  doc.end();
  return out;
}

function metaLine(doc, k, v) {
  doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
  doc.font('Helvetica').text(v);
}

// --- Comparative two-period helpers ---------------------------------------
//
// Build a diff object for two computed-totals payloads `a` and `b` (both the
// shape produced by `computeT661`). Per-field deltas are simple subtraction;
// `delta_pct` is `null` when the base side (`a`) is 0 so consumers don't have
// to special-case division-by-zero. Per-project diffs use the union of project
// ids in both periods — a project that's missing from one side is reported
// with `missing_from: 'a' | 'b'` and the other side's totals untouched.

const COMPARABLE_FIELDS = [
  'labour_cost_cents',
  'materials_cents',
  'contract_expenditures_cents',
  'third_party_payments_cents',
  'overhead_cents',
  'total_cents',
];

function diffPair(aCents, bCents) {
  const delta = bCents - aCents;
  const pct = aCents === 0 ? null : (delta / aCents) * 100;
  return { delta_cents: delta, delta_pct: pct };
}

function diffTotals(aTotals, bTotals) {
  const out = {};
  for (const f of COMPARABLE_FIELDS) {
    out[f] = diffPair(aTotals[f] ?? 0, bTotals[f] ?? 0);
  }
  return out;
}

// Public: build the diff payload bundled into the compare response.
export function buildCompareDiff(a, b) {
  const grand = diffTotals(a.grand_total, b.grand_total);

  const aById = new Map(a.projects.map(p => [p.id, p]));
  const bById = new Map(b.projects.map(p => [p.id, p]));
  const allIds = new Set([...aById.keys(), ...bById.keys()]);

  const projects = Array.from(allIds).sort((x, y) => x - y).map(id => {
    const pa = aById.get(id);
    const pb = bById.get(id);
    if (!pa) {
      return {
        project_id: id,
        title: pb.title,
        missing_from: 'a',
        a: null,
        b: pb.totals,
        diff: null,
      };
    }
    if (!pb) {
      return {
        project_id: id,
        title: pa.title,
        missing_from: 'b',
        a: pa.totals,
        b: null,
        diff: null,
      };
    }
    return {
      project_id: id,
      title: pb.title || pa.title,
      missing_from: null,
      a: pa.totals,
      b: pb.totals,
      diff: diffTotals(pa.totals, pb.totals),
    };
  });

  return { grand_total: grand, projects };
}

function signedDollars(cents, currency = 'CAD') {
  const sign = cents > 0 ? '+' : (cents < 0 ? '-' : '');
  return `${sign}${Math.abs(cents / 100).toFixed(2)} ${currency}`;
}

function pctStr(pct) {
  if (pct === null || pct === undefined) return 'n/a';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function periodLabel(t) {
  return `${t.fiscal_period.start_date} → ${t.fiscal_period.end_date}`;
}

export function toMarkdownCompare(a, b, diff) {
  const c = a.claimant; // both sides share the claimant (validated upstream)
  const ccy = c.reporting_currency;
  const labelA = periodLabel(a);
  const labelB = periodLabel(b);
  const lines = [
    `# T661 comparative export — ${c.legal_name}`,
    ``,
    `Business number: ${c.business_number ?? '_(not set)_'}`,
    `Period A:        ${labelA} (${a.fiscal_period.status})`,
    `Period B:        ${labelB} (${b.fiscal_period.status})`,
    `SR&ED method:    ${c.sred_method}`,
    `Reporting:       ${ccy}`,
    `Generated:       ${new Date().toISOString()}`,
    ``,
    `## Grand totals`,
    ``,
    `| Line | A (${labelA}) | B (${labelB}) | Δ | Δ% |`,
    `| --- | ---: | ---: | ---: | ---: |`,
  ];
  const rowSpec = [
    ['Labour',                'labour_cost_cents'],
    ['Materials',             'materials_cents'],
    ['Contract expenditures', 'contract_expenditures_cents'],
    ['Third-party payments',  'third_party_payments_cents'],
    [`Overhead${c.sred_method === 'proxy' ? ' (proxy 55%)' : ''}`, 'overhead_cents'],
    ['**Total**',             'total_cents'],
  ];
  for (const [label, field] of rowSpec) {
    const av = a.grand_total[field];
    const bv = b.grand_total[field];
    const d = diff.grand_total[field];
    lines.push(
      `| ${label} | ${dollars(av, ccy)} | ${dollars(bv, ccy)} | ${signedDollars(d.delta_cents, ccy)} | ${pctStr(d.delta_pct)} |`
    );
  }
  lines.push(``);
  lines.push(`## Per-project comparison`);
  lines.push(``);
  if (diff.projects.length === 0) {
    lines.push(`_(no projects in either period)_`);
    lines.push(``);
    return lines.join('\n');
  }
  for (const p of diff.projects) {
    lines.push(`### ${p.title} (id ${p.project_id})`);
    lines.push(``);
    if (p.missing_from === 'a') {
      lines.push(`_Missing from period A — present in period B only._`);
      lines.push(``);
      lines.push(`- Labour (B): ${dollars(p.b.labour_cost_cents, ccy)}`);
      lines.push(`- Total (B): ${dollars(p.b.total_cents, ccy)}`);
      lines.push(``);
      continue;
    }
    if (p.missing_from === 'b') {
      lines.push(`_Missing from period B — present in period A only._`);
      lines.push(``);
      lines.push(`- Labour (A): ${dollars(p.a.labour_cost_cents, ccy)}`);
      lines.push(`- Total (A): ${dollars(p.a.total_cents, ccy)}`);
      lines.push(``);
      continue;
    }
    lines.push(`| Line | A | B | Δ | Δ% |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: |`);
    for (const [label, field] of rowSpec) {
      const av = p.a[field];
      const bv = p.b[field];
      const d = p.diff[field];
      lines.push(
        `| ${label} | ${dollars(av, ccy)} | ${dollars(bv, ccy)} | ${signedDollars(d.delta_cents, ccy)} | ${pctStr(d.delta_pct)} |`
      );
    }
    lines.push(``);
  }
  return lines.join('\n');
}

export function toCsvCompare(a, b, diff) {
  const ccy = a.claimant.reporting_currency;
  const labelA = periodLabel(a);
  const labelB = periodLabel(b);
  const rows = [
    ['scope', 'project_id', 'project_title', 'line', 'currency',
     `a_cents (${labelA})`, `b_cents (${labelB})`, 'delta_cents', 'delta_pct'],
  ];
  for (const [label, field] of [
    ['labour', 'labour_cost_cents'],
    ['materials', 'materials_cents'],
    ['contract', 'contract_expenditures_cents'],
    ['third_party_payment', 'third_party_payments_cents'],
    ['overhead', 'overhead_cents'],
    ['total', 'total_cents'],
  ]) {
    const d = diff.grand_total[field];
    rows.push([
      'grand_total', '', '', label, ccy,
      a.grand_total[field], b.grand_total[field],
      d.delta_cents,
      d.delta_pct === null ? '' : d.delta_pct.toFixed(4),
    ]);
  }
  for (const p of diff.projects) {
    if (p.missing_from === 'a') {
      // Only side B has values; emit one row per line with empty A.
      for (const [label, field] of [
        ['labour', 'labour_cost_cents'],
        ['materials', 'materials_cents'],
        ['contract', 'contract_expenditures_cents'],
        ['third_party_payment', 'third_party_payments_cents'],
        ['overhead', 'overhead_cents'],
        ['total', 'total_cents'],
      ]) {
        rows.push(['project_missing_from_a', p.project_id, p.title, label, ccy,
          '', p.b[field], '', '']);
      }
      continue;
    }
    if (p.missing_from === 'b') {
      for (const [label, field] of [
        ['labour', 'labour_cost_cents'],
        ['materials', 'materials_cents'],
        ['contract', 'contract_expenditures_cents'],
        ['third_party_payment', 'third_party_payments_cents'],
        ['overhead', 'overhead_cents'],
        ['total', 'total_cents'],
      ]) {
        rows.push(['project_missing_from_b', p.project_id, p.title, label, ccy,
          p.a[field], '', '', '']);
      }
      continue;
    }
    for (const [label, field] of [
      ['labour', 'labour_cost_cents'],
      ['materials', 'materials_cents'],
      ['contract', 'contract_expenditures_cents'],
      ['third_party_payment', 'third_party_payments_cents'],
      ['overhead', 'overhead_cents'],
      ['total', 'total_cents'],
    ]) {
      const d = p.diff[field];
      rows.push(['project', p.project_id, p.title, label, ccy,
        p.a[field], p.b[field], d.delta_cents,
        d.delta_pct === null ? '' : d.delta_pct.toFixed(4)]);
    }
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}

export function toPdfCompare(a, b, diff) {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 60, bottom: 60, left: 60, right: 60 } });
  const out = new PassThrough();
  doc.pipe(out);

  const c = a.claimant;
  const ccy = c.reporting_currency;
  const cents = n => `${(n / 100).toFixed(2)} ${ccy}`;
  const labelA = periodLabel(a);
  const labelB = periodLabel(b);
  const BRAND = '#0078b5';
  const MUTED = '#6b7480';

  doc.fillColor(BRAND).fontSize(22).font('Helvetica-Bold').text('T661 comparative export');
  doc.fillColor('black').fontSize(16).font('Helvetica').text(c.legal_name);
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor(MUTED);
  metaLine(doc, 'Business number', c.business_number ?? '(not set)');
  metaLine(doc, 'Period A',        `${labelA} (${a.fiscal_period.status})`);
  metaLine(doc, 'Period B',        `${labelB} (${b.fiscal_period.status})`);
  metaLine(doc, 'SR&ED method',    c.sred_method);
  metaLine(doc, 'Reporting',       ccy);
  metaLine(doc, 'Generated',       new Date().toISOString());
  doc.fillColor('black').moveDown(1);

  sectionHeader(doc, 'Grand totals', BRAND);
  const rowSpec = [
    ['Labour',                'labour_cost_cents'],
    ['Materials',             'materials_cents'],
    ['Contract',              'contract_expenditures_cents'],
    ['Third-party',           'third_party_payments_cents'],
    [`Overhead${c.sred_method === 'proxy' ? ' (proxy 55%)' : ''}`, 'overhead_cents'],
    ['Total',                 'total_cents'],
  ];
  for (const [label, field] of rowSpec) {
    const av = a.grand_total[field];
    const bv = b.grand_total[field];
    const d = diff.grand_total[field];
    const isTotal = field === 'total_cents';
    compareRow(doc, label,
      cents(av), cents(bv),
      `${d.delta_cents >= 0 ? '+' : '-'}${(Math.abs(d.delta_cents) / 100).toFixed(2)}`,
      pctStr(d.delta_pct), isTotal);
  }
  doc.moveDown(1.2);

  for (const p of diff.projects) {
    if (doc.y > 600) doc.addPage();
    sectionHeader(doc, p.title, BRAND);
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(
      `Project #${p.project_id}` +
      (p.missing_from ? `  ·  missing from period ${p.missing_from.toUpperCase()}` : '')
    );
    doc.fillColor('black').moveDown(0.5);
    doc.fontSize(9).font('Helvetica');
    if (p.missing_from === 'a') {
      doc.text(`Labour (B only): ${cents(p.b.labour_cost_cents)}`);
      doc.text(`Total (B only):  ${cents(p.b.total_cents)}`);
      doc.moveDown(0.8);
      continue;
    }
    if (p.missing_from === 'b') {
      doc.text(`Labour (A only): ${cents(p.a.labour_cost_cents)}`);
      doc.text(`Total (A only):  ${cents(p.a.total_cents)}`);
      doc.moveDown(0.8);
      continue;
    }
    for (const [label, field] of rowSpec) {
      const av = p.a[field];
      const bv = p.b[field];
      const d = p.diff[field];
      const isTotal = field === 'total_cents';
      compareRow(doc, label,
        cents(av), cents(bv),
        `${d.delta_cents >= 0 ? '+' : '-'}${(Math.abs(d.delta_cents) / 100).toFixed(2)}`,
        pctStr(d.delta_pct), isTotal);
    }
    doc.moveDown(0.8);
  }

  doc.end();
  return out;
}

// 4-column row: label · A · B · Δ · Δ%. We use fixed column offsets from the
// left margin so the figures line up. Total rows render bold.
function compareRow(doc, label, aVal, bVal, deltaVal, pctVal, isTotal = false) {
  doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usable = right - left;
  const y = doc.y;
  // Roughly: label 30%, then four columns of 17.5% each.
  doc.text(label, left, y, { width: usable * 0.30 });
  doc.text(aVal,     left + usable * 0.30, y, { width: usable * 0.175, align: 'right' });
  doc.text(bVal,     left + usable * 0.475, y, { width: usable * 0.175, align: 'right' });
  doc.text(deltaVal, left + usable * 0.650, y, { width: usable * 0.175, align: 'right' });
  doc.text(pctVal,   left + usable * 0.825, y, { width: usable * 0.175, align: 'right' });
}

function sectionHeader(doc, text, brand) {
  doc.fontSize(13).font('Helvetica-Bold').fillColor(brand).text(text);
  // Underline accent
  const y = doc.y + 1;
  doc.save().moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + 40, y)
     .lineWidth(2).stroke(brand).restore();
  doc.fillColor('black').moveDown(0.4);
}

function totalsRow(doc, label, value, isTotal = false) {
  if (isTotal) doc.font('Helvetica-Bold');
  else doc.font('Helvetica');
  doc.fontSize(9.5);
  const x = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const y = doc.y;
  doc.text(label, x, y, { continued: false });
  doc.text(value, x, y, { width: right - x, align: 'right' });
}

function narrativeBlock(doc, label, value) {
  doc.fontSize(9.5).font('Helvetica-Bold').text(label);
  doc.font('Helvetica').text(value ?? '(unset)');
  doc.moveDown(0.3);
}
