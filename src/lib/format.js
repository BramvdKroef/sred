// Format the computed T661 totals for download.

// T661 line-number map — one place to update if the form revises.
//
// Citation: CRA T661 (v22, valid for tax years ending 2022+). Verify on the
// current form at canada.ca/.../t661.html before relying on these values; the
// numbering can shift between revisions. The line numbers below are the most
// recent set the SRED_DOMAIN_REVIEW (F2) cited and are surfaced here so the
// tax preparer can map each export line to the form without manual lookup.
//
// Notes (low confidence — flagged in SRED_DOMAIN_REVIEW v2/F6):
//   - 305 covers eligible SR&ED salaries or wages (regular).
//   - 306 is cited for "overtime / bonus / other compensation" in the task
//     brief but the domain review (F6) notes there is no T661 line that asks
//     for OT separately on the current form — the renderer surfaces 306 only
//     for the OT hours-bucket rows in the CSV, which is an internal worksheet
//     annotation, not a T661 form field. Reconfirm against the live PDF.
//   - 307 is the specified-employee cap subset.
//   - 320 — materials consumed/transformed. Schema does not split 320 vs 325.
//   - 340 — arms-length contract expenditures.
//   - 345 — third-party payments (approved entities: universities, etc.).
//   - 360 — proxy / overhead (also the traditional overhead bucket).
export const T661_LINES = Object.freeze({
  labour:                'line 305',
  labour_overtime:       'line 306',
  labour_specified_cap:  'line 307',
  materials:             'line 320',
  contract:              'line 340',
  third_party_payment:   'line 345',
  overhead:              'line 360',
});

// Numeric-only variants for CSV / non-prose contexts.
export const T661_LINE_NUMBERS = Object.freeze({
  labour:                305,
  labour_overtime:       306,
  labour_specified_cap:  307,
  materials:             320,
  contract:              340,
  third_party_payment:   345,
  overhead:              360,
});

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
    `| Category | T661 line | Amount |`,
    `| --- | --- | ---: |`,
    `| Labour | ${T661_LINES.labour} | ${dollars(totals.grand_total.labour_cost_cents, c.reporting_currency)} |`,
    `| Materials | ${T661_LINES.materials} | ${dollars(totals.grand_total.materials_cents, c.reporting_currency)} |`,
    `| Contract expenditures | ${T661_LINES.contract} | ${dollars(totals.grand_total.contract_expenditures_cents, c.reporting_currency)} |`,
    `| Third-party payments | ${T661_LINES.third_party_payment} | ${dollars(totals.grand_total.third_party_payments_cents, c.reporting_currency)} |`,
    `| Overhead${c.sred_method === 'proxy' ? ' (proxy, 55% of labour)' : ''} | ${T661_LINES.overhead} | ${dollars(totals.grand_total.overhead_cents, c.reporting_currency)} |`,
    `| **Total** |  | **${dollars(totals.grand_total.total_cents, c.reporting_currency)}** |`,
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
    lines.push(`- **Labour (T661 ${T661_LINES.labour})**: ${dollars(proj.totals.labour_cost_cents, c.reporting_currency)}`);
    lines.push(`- **Materials (T661 ${T661_LINES.materials})**: ${dollars(proj.totals.materials_cents, c.reporting_currency)}`);
    lines.push(`- **Contract (T661 ${T661_LINES.contract})**: ${dollars(proj.totals.contract_expenditures_cents, c.reporting_currency)}`);
    lines.push(`- **Third-party (T661 ${T661_LINES.third_party_payment})**: ${dollars(proj.totals.third_party_payments_cents, c.reporting_currency)}`);
    lines.push(`- **Overhead (T661 ${T661_LINES.overhead})**: ${dollars(proj.totals.overhead_cents, c.reporting_currency)}`);
    lines.push(`- **Total: ${dollars(proj.totals.total_cents, c.reporting_currency)}**`);
    lines.push(``);
    if (proj.labour_worksheet.length) {
      lines.push(`### Labour worksheet`);
      lines.push(``);
      // Surface the OT breakdown only when at least one worksheet row in
      // this project has overtime hours — otherwise the extra columns are
      // just noise. Labour cost is identical with or without the split
      // (overtime hours are billed at the same hourly rate as regular).
      const anyOt = proj.labour_worksheet.some(r => (r.overtime_hours ?? 0) > 0);
      if (anyOt) {
        lines.push(`| Employee | Specified | Hours | Regular | Overtime | Cost | Cap applied |`);
        lines.push(`| --- | :-: | ---: | ---: | ---: | ---: | :-: |`);
        for (const r of proj.labour_worksheet) {
          lines.push(`| ${r.employee_name} | ${r.is_specified_employee ? '✓' : ''} | ${r.total_hours.toFixed(2)} | ${(r.regular_hours ?? r.total_hours).toFixed(2)} | ${(r.overtime_hours ?? 0).toFixed(2)} | ${dollars(r.labour_cost_cents, c.reporting_currency)} | ${r.cap_applied ? '✓' : ''} |`);
        }
      } else {
        lines.push(`| Employee | Specified | Hours | Cost | Cap applied |`);
        lines.push(`| --- | :-: | ---: | ---: | :-: |`);
        for (const r of proj.labour_worksheet) {
          lines.push(`| ${r.employee_name} | ${r.is_specified_employee ? '✓' : ''} | ${r.total_hours.toFixed(2)} | ${dollars(r.labour_cost_cents, c.reporting_currency)} | ${r.cap_applied ? '✓' : ''} |`);
        }
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
    ['line', 'project_id', 'project_title', 't661_line', 'currency', 'amount_cents'],
  ];
  const ccy = totals.claimant.reporting_currency;
  for (const p of totals.projects) {
    rows.push(['labour', p.id, p.title, T661_LINE_NUMBERS.labour, ccy, p.totals.labour_cost_cents]);
    // Surface OT only when there's something to surface — emit hours-bucket
    // rows alongside the cost row (currency column is empty: these are
    // unit-less hour counts, not dollars). Skipped entirely if the project
    // has no overtime in the period. The OT bucket is tagged with line 306
    // as a worksheet annotation (see T661_LINES comment about F6 — not a
    // CRA-confirmed form field on the current T661).
    if ((p.totals.labour_hours_overtime ?? 0) > 0) {
      rows.push(['labour_regular_hours',  p.id, p.title, T661_LINE_NUMBERS.labour,          '', p.totals.labour_hours_regular]);
      rows.push(['labour_overtime_hours', p.id, p.title, T661_LINE_NUMBERS.labour_overtime, '', p.totals.labour_hours_overtime]);
    }
    rows.push(['materials',           p.id, p.title, T661_LINE_NUMBERS.materials,           ccy, p.totals.materials_cents]);
    rows.push(['contract',            p.id, p.title, T661_LINE_NUMBERS.contract,            ccy, p.totals.contract_expenditures_cents]);
    rows.push(['third_party_payment', p.id, p.title, T661_LINE_NUMBERS.third_party_payment, ccy, p.totals.third_party_payments_cents]);
    rows.push(['overhead',            p.id, p.title, T661_LINE_NUMBERS.overhead,            ccy, p.totals.overhead_cents]);
    rows.push(['project_total',       p.id, p.title, '',                                    ccy, p.totals.total_cents]);
  }
  rows.push(['grand_total', '', '', '', ccy, totals.grand_total.total_cents]);
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
  totalsRow(doc, `Labour (T661 ${T661_LINES.labour})`,                                                       cents(g.labour_cost_cents));
  totalsRow(doc, `Materials (T661 ${T661_LINES.materials})`,                                                 cents(g.materials_cents));
  totalsRow(doc, `Contract expenditures (T661 ${T661_LINES.contract})`,                                      cents(g.contract_expenditures_cents));
  totalsRow(doc, `Third-party payments (T661 ${T661_LINES.third_party_payment})`,                            cents(g.third_party_payments_cents));
  totalsRow(doc, `Overhead${c.sred_method === 'proxy' ? ' (proxy 55%)' : ''} (T661 ${T661_LINES.overhead})`, cents(g.overhead_cents));
  doc.moveDown(0.2);
  totalsRow(doc, 'Total',                                                                                    cents(g.total_cents), true);
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
    totalsRow(doc, `Labour (T661 ${T661_LINES.labour})`,                  cents(proj.totals.labour_cost_cents));
    totalsRow(doc, `Materials (T661 ${T661_LINES.materials})`,            cents(proj.totals.materials_cents));
    totalsRow(doc, `Contract (T661 ${T661_LINES.contract})`,              cents(proj.totals.contract_expenditures_cents));
    totalsRow(doc, `Third-party (T661 ${T661_LINES.third_party_payment})`, cents(proj.totals.third_party_payments_cents));
    totalsRow(doc, `Overhead (T661 ${T661_LINES.overhead})`,              cents(proj.totals.overhead_cents));
    totalsRow(doc, 'Project total',                                       cents(proj.totals.total_cents), true);
    doc.moveDown(0.6);

    if (proj.labour_worksheet.length) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND).text('Labour worksheet'); doc.fillColor('black');
      doc.fontSize(9).font('Helvetica');
      // Same conditional split as the markdown formatter — only surface the
      // OT breakdown when there's something to surface.
      const anyOt = proj.labour_worksheet.some(r => (r.overtime_hours ?? 0) > 0);
      for (const r of proj.labour_worksheet) {
        const flags = [r.is_specified_employee ? 'specified' : null, r.cap_applied ? 'cap applied' : null].filter(Boolean).join(', ');
        const tail  = flags ? `  [${flags}]` : '';
        const hoursStr = anyOt
          ? `${r.total_hours.toFixed(2)}h (reg ${(r.regular_hours ?? r.total_hours).toFixed(2)} / OT ${(r.overtime_hours ?? 0).toFixed(2)})`
          : `${r.total_hours.toFixed(2)}h`;
        doc.text(`  ${r.employee_name}: ${hoursStr}  ·  ${cents(r.labour_cost_cents)}${tail}`);
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
    [`Labour (T661 ${T661_LINES.labour})`,                                                       'labour_cost_cents'],
    [`Materials (T661 ${T661_LINES.materials})`,                                                 'materials_cents'],
    [`Contract expenditures (T661 ${T661_LINES.contract})`,                                      'contract_expenditures_cents'],
    [`Third-party payments (T661 ${T661_LINES.third_party_payment})`,                            'third_party_payments_cents'],
    [`Overhead${c.sred_method === 'proxy' ? ' (proxy 55%)' : ''} (T661 ${T661_LINES.overhead})`, 'overhead_cents'],
    ['**Total**',                                                                                'total_cents'],
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
      lines.push(`- Labour (T661 ${T661_LINES.labour}) (B): ${dollars(p.b.labour_cost_cents, ccy)}`);
      lines.push(`- Total (B): ${dollars(p.b.total_cents, ccy)}`);
      lines.push(``);
      continue;
    }
    if (p.missing_from === 'b') {
      lines.push(`_Missing from period B — present in period A only._`);
      lines.push(``);
      lines.push(`- Labour (T661 ${T661_LINES.labour}) (A): ${dollars(p.a.labour_cost_cents, ccy)}`);
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
  // Per-line spec: label, field, T661 line number ('' for the `total` rollup
  // since the form doesn't have a single line for it). Shared between
  // grand-total and per-project blocks below.
  const compareRowSpec = [
    ['labour',              'labour_cost_cents',           T661_LINE_NUMBERS.labour],
    ['materials',           'materials_cents',             T661_LINE_NUMBERS.materials],
    ['contract',            'contract_expenditures_cents', T661_LINE_NUMBERS.contract],
    ['third_party_payment', 'third_party_payments_cents',  T661_LINE_NUMBERS.third_party_payment],
    ['overhead',            'overhead_cents',              T661_LINE_NUMBERS.overhead],
    ['total',               'total_cents',                 ''],
  ];
  const rows = [
    ['scope', 'project_id', 'project_title', 'line', 't661_line', 'currency',
     `a_cents (${labelA})`, `b_cents (${labelB})`, 'delta_cents', 'delta_pct'],
  ];
  for (const [label, field, t661Line] of compareRowSpec) {
    const d = diff.grand_total[field];
    rows.push([
      'grand_total', '', '', label, t661Line, ccy,
      a.grand_total[field], b.grand_total[field],
      d.delta_cents,
      d.delta_pct === null ? '' : d.delta_pct.toFixed(4),
    ]);
  }
  for (const p of diff.projects) {
    if (p.missing_from === 'a') {
      // Only side B has values; emit one row per line with empty A.
      for (const [label, field, t661Line] of compareRowSpec) {
        rows.push(['project_missing_from_a', p.project_id, p.title, label, t661Line, ccy,
          '', p.b[field], '', '']);
      }
      continue;
    }
    if (p.missing_from === 'b') {
      for (const [label, field, t661Line] of compareRowSpec) {
        rows.push(['project_missing_from_b', p.project_id, p.title, label, t661Line, ccy,
          p.a[field], '', '', '']);
      }
      continue;
    }
    for (const [label, field, t661Line] of compareRowSpec) {
      const d = p.diff[field];
      rows.push(['project', p.project_id, p.title, label, t661Line, ccy,
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
    [`Labour (T661 ${T661_LINES.labour})`,                                                       'labour_cost_cents'],
    [`Materials (T661 ${T661_LINES.materials})`,                                                 'materials_cents'],
    [`Contract (T661 ${T661_LINES.contract})`,                                                   'contract_expenditures_cents'],
    [`Third-party (T661 ${T661_LINES.third_party_payment})`,                                     'third_party_payments_cents'],
    [`Overhead${c.sred_method === 'proxy' ? ' (proxy 55%)' : ''} (T661 ${T661_LINES.overhead})`, 'overhead_cents'],
    ['Total',                                                                                    'total_cents'],
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
      doc.text(`Labour (T661 ${T661_LINES.labour}) (B only): ${cents(p.b.labour_cost_cents)}`);
      doc.text(`Total (B only):  ${cents(p.b.total_cents)}`);
      doc.moveDown(0.8);
      continue;
    }
    if (p.missing_from === 'b') {
      doc.text(`Labour (T661 ${T661_LINES.labour}) (A only): ${cents(p.a.labour_cost_cents)}`);
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
