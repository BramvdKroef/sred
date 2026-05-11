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
