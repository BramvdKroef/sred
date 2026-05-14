// Reads the audit JSON, aggregates findings, and prints structured output
// the human (and the reviewer) can use to write RENDER_REVIEW.md.
//
// Usage: node tools/analyze-audit.mjs ./RENDER_REVIEW_ARTIFACTS/audit.json

import fs from 'node:fs/promises';

const inPath = process.argv[2] || './RENDER_REVIEW_ARTIFACTS/audit.json';
const audit = JSON.parse(await fs.readFile(inPath, 'utf8'));

const sev = ['critical', 'serious', 'moderate', 'minor'];
const sevCounts = Object.fromEntries(sev.map(s => [s, 0]));     // counted by node
const violCounts = Object.fromEntries(sev.map(s => [s, 0]));    // counted by violation
const byRule = new Map();   // ruleId -> { id, impact, help, helpUrl, totalNodes, pages: Map<page, count> }

for (const r of audit.results) {
  if (!Array.isArray(r.axe)) continue;
  for (const v of r.axe) {
    sevCounts[v.impact] = (sevCounts[v.impact] || 0) + v.nodeCount;
    violCounts[v.impact] = (violCounts[v.impact] || 0) + 1;
    if (!byRule.has(v.id)) {
      byRule.set(v.id, {
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        totalNodes: 0, pages: new Map(), exampleNodes: [],
      });
    }
    const entry = byRule.get(v.id);
    entry.totalNodes += v.nodeCount;
    const key = `${r.viewport} ${r.role}-${r.label}`;
    entry.pages.set(key, (entry.pages.get(key) || 0) + v.nodeCount);
    if (entry.exampleNodes.length < 3 && v.nodes && v.nodes.length) {
      for (const n of v.nodes) {
        if (entry.exampleNodes.length >= 3) break;
        entry.exampleNodes.push({
          page: key,
          target: n.target,
          html: n.html ? n.html.slice(0, 200) : null,
          failureSummary: n.failureSummary ? n.failureSummary.slice(0, 240) : null,
        });
      }
    }
  }
}

// Overflows
const overflowByViewport = {};
const overflowExamples = new Map(); // selector -> { selector, examples: [{page, viewport, overflow}] }
let totalOverflows = 0;
for (const r of audit.results) {
  if (!r.overflows) continue;
  for (const o of r.overflows) {
    overflowByViewport[r.viewport] = (overflowByViewport[r.viewport] || 0) + 1;
    totalOverflows++;
    const key = o.selector;
    if (!overflowExamples.has(key)) overflowExamples.set(key, { selector: key, hits: [] });
    overflowExamples.get(key).hits.push({
      page: `${r.role}-${r.label}`,
      viewport: r.viewport,
      overflow: o.overflow,
      scrollWidth: o.scrollWidth,
      clientWidth: o.clientWidth,
    });
  }
}

// Console / network
const consoleEvents = audit.console || [];
const networkEvents = audit.network || [];
const consoleByType = { error: 0, warning: 0, pageerror: 0 };
for (const e of consoleEvents) consoleByType[e.type] = (consoleByType[e.type] || 0) + 1;

// Computed styles: collect distinct h1 sizes / pill backgrounds / primary button colors.
const sampleAgg = new Map(); // `${vp}|${sel}` -> set of "color|bg|size"
for (const r of audit.results) {
  if (!r.styles) continue;
  for (const s of r.styles) {
    const k = `${r.viewport}|${s.sel}`;
    if (!sampleAgg.has(k)) sampleAgg.set(k, new Map());
    const sig = `${s.styles.color}|${s.styles.backgroundColor}|${s.styles.fontSize}|${s.styles.fontWeight}|${s.styles.padding}`;
    sampleAgg.get(k).set(sig, (sampleAgg.get(k).get(sig) || 0) + 1);
  }
}

// Pretty print
console.log('# stats');
console.log(JSON.stringify({
  results: audit.results.length,
  ok: audit.results.filter(r => r.ok).length,
  viewports: audit.viewports,
  totalConsoleEvents: consoleEvents.length,
  consoleByType,
  totalNetworkEvents: networkEvents.length,
  totalAxeViolationsByNode: sevCounts,
  totalAxeViolationsByRuleHit: violCounts,
  totalOverflows,
  overflowByViewport,
}, null, 2));

console.log('\n# axe rules (sorted by severity then total nodes)');
const ordering = { critical: 0, serious: 1, moderate: 2, minor: 3, null: 9, undefined: 9 };
const rules = [...byRule.values()].sort((a, b) =>
  (ordering[a.impact] - ordering[b.impact]) || (b.totalNodes - a.totalNodes));
for (const r of rules) {
  const pages = [...r.pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`- ${r.impact?.toUpperCase()} ${r.id} (${r.totalNodes} nodes)  ${r.help}`);
  console.log(`    pages: ${pages.map(([p, n]) => `${p}×${n}`).join('; ')}`);
  if (r.exampleNodes.length) {
    console.log(`    sample target: ${r.exampleNodes[0].target}`);
    if (r.exampleNodes[0].failureSummary)
      console.log(`    failure: ${r.exampleNodes[0].failureSummary.replace(/\n/g, ' ')}`);
  }
}

console.log('\n# overflow hot-spots (top 20 distinct selectors)');
const overflows = [...overflowExamples.values()].sort((a, b) => b.hits.length - a.hits.length).slice(0, 20);
for (const o of overflows) {
  const worst = o.hits.reduce((a, b) => (a.overflow > b.overflow ? a : b));
  const vps = [...new Set(o.hits.map(h => h.viewport))].sort();
  const pgs = [...new Set(o.hits.map(h => h.page))];
  console.log(`- ${o.selector} (${o.hits.length} hits, worst ${worst.overflow}px @ ${worst.viewport} on ${worst.page})`);
  console.log(`    viewports: ${vps.join(', ')}; pages: ${pgs.slice(0, 6).join(', ')}${pgs.length>6?` (+${pgs.length-6})`:''}`);
}

console.log('\n# console events grouped by message+page');
const conGroups = new Map();
for (const c of consoleEvents) {
  const k = `${c.type} | ${c.text.slice(0, 120)}`;
  if (!conGroups.has(k)) conGroups.set(k, { type: c.type, text: c.text, pages: new Set() });
  conGroups.get(k).pages.add(c.page);
}
for (const g of [...conGroups.values()].sort((a, b) => b.pages.size - a.pages.size).slice(0, 40)) {
  console.log(`- [${g.type}] ${g.text}`);
  console.log(`    on: ${[...g.pages].slice(0, 10).join(', ')}${g.pages.size > 10 ? ' (+ more)' : ''}`);
}

console.log('\n# network 4xx/5xx');
const netGroups = new Map();
for (const n of networkEvents) {
  const k = `${n.status} ${n.method} ${n.url.replace(/\d+/g, 'N')}`;
  if (!netGroups.has(k)) netGroups.set(k, { ...n, pages: new Set() });
  netGroups.get(k).pages.add(n.page);
}
for (const g of [...netGroups.values()].sort((a, b) => b.pages.size - a.pages.size).slice(0, 30)) {
  console.log(`- ${g.status} ${g.method} ${g.url}`);
  console.log(`    on: ${[...g.pages].slice(0, 10).join(', ')}${g.pages.size > 10 ? ' (+ more)' : ''}`);
}

console.log('\n# computed-style sampling — drift highlights');
// For each selector, list the distinct signatures at 1440x900.
for (const [key, sigs] of sampleAgg) {
  if (!key.startsWith('1440x900|')) continue;
  if (sigs.size <= 1) continue; // no drift
  const sel = key.split('|')[1];
  console.log(`- ${sel}: ${sigs.size} distinct style signatures at 1440x900`);
  for (const [sig, n] of sigs) {
    console.log(`    × ${n}: ${sig}`);
  }
}

console.log('\n# finalHash sanity (any redirected?)');
for (const r of audit.results) {
  if (r.viewport !== '1440x900') continue;
  if (r.hash && r.hash !== r.finalHash && !(r.hash === '' && (!r.finalHash || r.finalHash === ''))) {
    console.log(`- ${r.role}-${r.label} requested ${r.hash || '(root)'} but ended on ${r.finalHash || '(root)'}`);
  }
}

console.log('\n# focus-ring sample (1440x900)');
for (const r of audit.results) {
  if (r.viewport !== '1440x900' || !r.focus) continue;
  for (const f of r.focus) {
    if (f.boxShadow !== 'none' || (f.outlineWidth && f.outlineWidth !== '0px')) continue;
    console.log(`- ${r.role}-${r.label}: ${f.sel} has no visible focus ring (outline=${f.outline}, box-shadow=${f.boxShadow})`);
  }
}
