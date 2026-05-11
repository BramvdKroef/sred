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
