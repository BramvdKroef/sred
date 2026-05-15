// Unit tests for the narrative-checks rule engine. Covers each red-flag
// pattern (positive + negative), each missing-element check, the
// word-count thresholds, and the all-clean case (using the realistic
// seed-etc narratives as the "looks clean" oracle).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkNarrative,
  FIELDS,
  RED_FLAG_PATTERNS,
  REQUIRED_ELEMENTS,
  WORD_COUNT_THRESHOLDS,
} from '../../public/lib/narrative-checks.js';

// Convenience: build a fields object that's "clean" for every field but
// the one we want to vary. Each clean narrative was lifted from seed-etc.js
// and is meant to pass every rule.
const CLEAN = {
  advancement_sought:
    'A yield-forecasting model that fuses greenhouse environmental telemetry with regional weather inputs ' +
    'to predict harvest dates within 48 hours for novel cultivars where no prior production history exists, ' +
    'improving on existing ensemble approaches that degrade non-linearly under 25% missing inputs.',
  uncertainties:
    'No published technique cleanly handles the cold-start problem of new cultivars while remaining robust ' +
    'to bursty missing-sensor data; whether streaming graph inference can converge fast enough to be ' +
    'operationally useful is unproven and could not be predicted from existing literature.',
  work_performed:
    'Built a hybrid architecture (gradient-boosted trees over telemetry-derived features and an RNN over weather ' +
    'sequences); iterated on imputation strategies (last-known, forward-filled, masked-attention); measured ' +
    'prediction error across three pilot greenhouses in the Niagara region and found that error dropped 18%.',
};

function findingsFor(fieldOverrides) {
  return checkNarrative({ ...CLEAN, ...fieldOverrides }).findings;
}

function findingsOnField(findings, field) {
  return findings.filter(f => f.field === field);
}

function hasRule(findings, ruleId, field) {
  return findings.some(f => f.ruleId === ruleId && (!field || f.field === field));
}

// ---------------------------------------------------------------------------
// "Looks clean" baseline — seed-etc narratives should produce zero findings.
// ---------------------------------------------------------------------------

test('CLEAN seed-etc narrative produces zero findings', () => {
  const { findings } = checkNarrative(CLEAN);
  assert.deepEqual(
    findings,
    [],
    `Expected zero findings, got:\n${findings.map(f => `  ${f.field}: ${f.ruleId} — ${f.message}`).join('\n')}`,
  );
});

test('checkNarrative returns the documented shape', () => {
  const out = checkNarrative({});
  assert.ok(Array.isArray(out.findings));
  assert.ok(out.findings.every(f =>
    typeof f.field === 'string' &&
    ['error', 'warn', 'info'].includes(f.severity) &&
    typeof f.message === 'string' &&
    typeof f.hint === 'string',
  ));
});

// ---------------------------------------------------------------------------
// Red-flag patterns: positive (matches) + negative (doesn't false-fire).
// ---------------------------------------------------------------------------

test('marketing-copy: matches "revolutionary", "world-class", "state of the art"', () => {
  const f1 = findingsFor({ uncertainties: 'We took a revolutionary new approach to ' + CLEAN.uncertainties });
  assert.ok(hasRule(f1, 'marketing-copy', 'uncertainties'));
  const f2 = findingsFor({ uncertainties: 'A world-class system for ' + CLEAN.uncertainties });
  assert.ok(hasRule(f2, 'marketing-copy', 'uncertainties'));
  const f3 = findingsFor({ uncertainties: 'state-of-the-art techniques like ' + CLEAN.uncertainties });
  assert.ok(hasRule(f3, 'marketing-copy', 'uncertainties'));
});

test('marketing-copy: does not false-fire on plain technical text', () => {
  // The clean baseline contains no marketing copy.
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'marketing-copy'));
});

test('business-framing: matches "save customers time", "user experience"', () => {
  const f1 = findingsFor({ advancement_sought: 'We wanted to save customers time and ' + CLEAN.advancement_sought });
  assert.ok(hasRule(f1, 'business-framing', 'advancement_sought'));
  const f2 = findingsFor({ advancement_sought: 'Improving user experience by ' + CLEAN.advancement_sought });
  assert.ok(hasRule(f2, 'business-framing', 'advancement_sought'));
});

test('future-tense: matches "we will", "going to", "we plan to" with error severity', () => {
  const { findings } = checkNarrative({ ...CLEAN, work_performed: 'We will build a prototype and ' + CLEAN.work_performed });
  const ft = findings.find(f => f.ruleId === 'future-tense');
  assert.ok(ft, 'expected future-tense finding');
  assert.equal(ft.severity, 'error');
});

test('future-tense: does not false-fire on past-tense work', () => {
  // CLEAN uses "Built", "iterated", "measured" — all past.
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'future-tense'));
});

test('routine-engineering: matches "best practices" / "industry standard"', () => {
  const f1 = findingsFor({ uncertainties: 'We followed best practices, ' + CLEAN.uncertainties });
  assert.ok(hasRule(f1, 'routine-engineering', 'uncertainties'));
  const f2 = findingsFor({ uncertainties: 'Used industry standard tooling. ' + CLEAN.uncertainties });
  assert.ok(hasRule(f2, 'routine-engineering', 'uncertainties'));
});

test('product-framing: matches "our product" only in advancement_sought', () => {
  const fAdv = findingsFor({ advancement_sought: 'Our product needed ' + CLEAN.advancement_sought });
  assert.ok(hasRule(fAdv, 'product-framing', 'advancement_sought'));
  // Same phrase in work_performed should NOT trip the rule.
  const fWork = findingsFor({ work_performed: 'Our product was instrumented and ' + CLEAN.work_performed });
  assert.ok(!hasRule(fWork, 'product-framing'));
});

test('easy-language: matches "easy", "simple", "quick" with error severity', () => {
  const { findings } = checkNarrative({ ...CLEAN, uncertainties: 'It was a simple problem. ' + CLEAN.uncertainties });
  const r = findings.find(f => f.ruleId === 'easy-language');
  assert.ok(r);
  assert.equal(r.severity, 'error');
});

test('easy-language: does not match "simplify" or "simpler" (whole-word boundary)', () => {
  const { findings } = checkNarrative({ ...CLEAN, uncertainties: CLEAN.uncertainties + ' We did not try to simplify the system.' });
  // "simplify" should not match \bsimple\b — but it does match the longer
  // word boundary because "simple" is a strict prefix. Confirm we DON'T
  // false-fire on the longer word.
  assert.ok(!findings.some(f => f.ruleId === 'easy-language'));
});

test('vague-many: matches "various approaches" as info', () => {
  const { findings } = checkNarrative({ ...CLEAN, work_performed: CLEAN.work_performed + ' We tried various approaches.' });
  const r = findings.find(f => f.ruleId === 'vague-many');
  assert.ok(r);
  assert.equal(r.severity, 'info');
});

test('first-person-marketing: matches "we are proud" / "excited"', () => {
  const f1 = findingsFor({ advancement_sought: "We're excited to announce " + CLEAN.advancement_sought });
  assert.ok(hasRule(f1, 'first-person-marketing'));
});

test('every RED_FLAG_PATTERN has the documented shape', () => {
  for (const r of RED_FLAG_PATTERNS) {
    assert.ok(typeof r.id === 'string', `rule missing id: ${JSON.stringify(r)}`);
    assert.ok(r.pattern instanceof RegExp);
    assert.ok(['error', 'warn', 'info'].includes(r.severity), `bad severity ${r.severity} on ${r.id}`);
    assert.ok(typeof r.message === 'string');
    assert.ok(typeof r.hint === 'string');
  }
});

// ---------------------------------------------------------------------------
// Missing-element checks: each fires when absent, passes when present.
// ---------------------------------------------------------------------------

test('advancement-needs-measurable: fires when no number-bearing token', () => {
  const text = 'A yield-forecasting model that fuses greenhouse environmental telemetry with regional weather inputs ' +
               'to predict harvest dates for novel cultivars where no prior production history exists, ' +
               'improving on existing ensemble approaches.';
  // No "%", "X hours", "Y times" — should fire.
  const { findings } = checkNarrative({ ...CLEAN, advancement_sought: text });
  assert.ok(hasRule(findings, 'advancement-needs-measurable', 'advancement_sought'));
});

test('advancement-needs-measurable: passes with "within 48 hours" / "25%"', () => {
  // CLEAN has both. Should NOT fire.
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'advancement-needs-measurable'));
});

test('advancement-needs-baseline: fires when no baseline phrase', () => {
  const text = 'A 48-hour forecast model for novel cultivars, achieving within ±2 days accuracy.';
  const { findings } = checkNarrative({ ...CLEAN, advancement_sought: text });
  assert.ok(hasRule(findings, 'advancement-needs-baseline', 'advancement_sought'));
});

test('advancement-needs-baseline: passes with "existing" / "previously" / "prior art"', () => {
  // CLEAN says "improving on existing ensemble approaches" — should pass.
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'advancement-needs-baseline'));
});

test('uncertainties-needs-hypothesis: fires when no hypothesis phrase', () => {
  const text = 'The problem is hard and there are many edge cases in the data pipeline that affect modelling.';
  const { findings } = checkNarrative({ ...CLEAN, uncertainties: text });
  assert.ok(hasRule(findings, 'uncertainties-needs-hypothesis', 'uncertainties'));
});

test('uncertainties-needs-hypothesis: passes with "whether" / "unproven"', () => {
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'uncertainties-needs-hypothesis'));
});

test('work-needs-experimental-verb: fires when no experimental verb', () => {
  const text = 'Our code base now has the new module deployed and integrated with the rest of the system for production, ' +
               'serving users at the regional pilot locations including Niagara and surrounding counties.';
  const { findings } = checkNarrative({ ...CLEAN, work_performed: text });
  assert.ok(hasRule(findings, 'work-needs-experimental-verb', 'work_performed'));
});

test('work-needs-experimental-verb: passes with "built", "iterated", "measured"', () => {
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'work-needs-experimental-verb'));
});

test('work-needs-measurable-outcome: fires when no outcome words/numbers', () => {
  const text = 'We attempted three different scheduler designs and discussed them at the team meetings on a regular basis ' +
               'throughout the engineering effort during the claim period and afterwards in retrospectives held weekly.';
  const { findings } = checkNarrative({ ...CLEAN, work_performed: text });
  assert.ok(hasRule(findings, 'work-needs-measurable-outcome', 'work_performed'));
});

test('every REQUIRED_ELEMENTS entry has the documented shape', () => {
  for (const c of REQUIRED_ELEMENTS) {
    assert.ok(typeof c.id === 'string');
    assert.ok(Array.isArray(c.fields) && c.fields.length > 0);
    assert.ok(['error', 'warn', 'info'].includes(c.severity));
    assert.ok(typeof c.test === 'function');
  }
});

// ---------------------------------------------------------------------------
// Word-count signals.
// ---------------------------------------------------------------------------

test('word-count-thin: fires at < 30 words', () => {
  // 10-word advancement — definitely under threshold.
  const text = 'A forecasting model for cultivars to predict within hours something useful.';
  const { findings } = checkNarrative({ ...CLEAN, advancement_sought: text });
  const w = findings.find(f => f.ruleId === 'word-count-thin' && f.field === 'advancement_sought');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

test('word-count-thin: does NOT fire at >= 30 words', () => {
  // CLEAN narratives are all > 30 words.
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'word-count-thin'));
});

test('word-performed-too-short: fires at < 100 chars with error severity', () => {
  const text = 'Built a thing. Tested. Done.';
  assert.ok(text.length < WORD_COUNT_THRESHOLDS.work_performed_min_chars);
  const { findings } = checkNarrative({ ...CLEAN, work_performed: text });
  const e = findings.find(f => f.ruleId === 'work-performed-too-short');
  assert.ok(e);
  assert.equal(e.severity, 'error');
});

test('word-performed-too-short: does NOT fire at >= 100 chars', () => {
  const { findings } = checkNarrative(CLEAN);
  assert.ok(!findings.some(f => f.ruleId === 'work-performed-too-short'));
});

// ---------------------------------------------------------------------------
// Empty-field handling and span shape.
// ---------------------------------------------------------------------------

test('empty fields: produce one "empty-field" info finding each, nothing else', () => {
  const { findings } = checkNarrative({ advancement_sought: '', uncertainties: '', work_performed: '' });
  assert.equal(findings.length, 3);
  for (const f of findings) {
    assert.equal(f.ruleId, 'empty-field');
    assert.equal(f.severity, 'info');
  }
  // One per field.
  assert.deepEqual(findings.map(f => f.field).sort(), [...FIELDS].sort());
});

test('span: red-flag findings include valid {start, end} offsets into the field text', () => {
  const adv = 'We will build a revolutionary system. ' + CLEAN.advancement_sought;
  const { findings } = checkNarrative({ ...CLEAN, advancement_sought: adv });
  for (const f of findings.filter(x => x.field === 'advancement_sought' && x.span)) {
    assert.ok(f.span.start >= 0 && f.span.end > f.span.start);
    assert.ok(f.span.end <= adv.length);
    // The substring at the span should be non-empty.
    assert.ok(adv.slice(f.span.start, f.span.end).length > 0);
  }
});

test('missing-element findings have span === null', () => {
  const { findings } = checkNarrative({
    advancement_sought: 'A forecasting model that helps with cultivars by improving things in the greenhouse data pipeline today.',
    uncertainties: CLEAN.uncertainties,
    work_performed: CLEAN.work_performed,
  });
  const missing = findings.find(f => f.ruleId === 'advancement-needs-measurable');
  assert.ok(missing);
  assert.equal(missing.span, null);
});

// ---------------------------------------------------------------------------
// Integration sanity: every seed-etc narrative passes cleanly.
// ---------------------------------------------------------------------------

const SEED_NARRATIVES = [
  {
    name: 'ET Grow',
    advancement_sought:
      'A yield-forecasting model that fuses greenhouse environmental telemetry with regional weather inputs ' +
      'to predict harvest dates within 48 hours for novel cultivars where no prior production history exists.',
    uncertainties:
      'No published technique cleanly handles the cold-start problem of new cultivars while remaining robust ' +
      'to bursty missing-sensor data; existing ensemble approaches degrade non-linearly when more than 25% of ' +
      'training inputs are imputed.',
    work_performed:
      'Built a hybrid architecture (gradient-boosted trees over telemetry-derived features + RNN over weather ' +
      'sequences); iterated on imputation strategies (last-known, forward-filled, masked-attention); measured ' +
      'prediction error across three pilot greenhouses in the Niagara region.',
  },
  {
    name: 'ET Fusion',
    advancement_sought:
      'Sub-second correlation of ISP equipment events with customer-visible outages across a multi-tenant ' +
      'utility deployment, supporting both temporal and topological inference without an externally-maintained ' +
      'dependency graph, improving on existing event-correlation engines.',
    uncertainties:
      'Existing event-correlation engines either require a manually-curated topology (brittle, costly) or use ' +
      'causality heuristics that produce too many false positives at scale. Whether streaming graph inference ' +
      'can converge fast enough to be operationally useful is unproven.',
    work_performed:
      'Designed a Flink-based pipeline that derives topology from packet-level metadata in a five-minute sliding ' +
      'window; prototyped a deduplication layer; measured precision/recall against a labelled incident corpus ' +
      'supplied by a partner utility.',
  },
  {
    name: 'NWIC',
    advancement_sought:
      'A bandwidth-shaping algorithm for rural fixed-wireless mesh nodes that maintains fairness across ' +
      'customers when the backhaul itself varies by 30% or more (atmospheric ducting, line-of-sight obstructions) ' +
      'and node count changes daily, improving on existing fair-queueing assumptions.',
    uncertainties:
      'Standard fair-queueing assumes a stable upstream capacity. Whether a token-bucket variant with online ' +
      'capacity estimation can converge under correlated churn is an open question — preliminary trials ' +
      'oscillated under high load.',
    work_performed:
      'Implemented two scheduler variants (drift-aware DRR and a deadline-based EDF hybrid); instrumented a ' +
      'small testbed in the Niagara region; ran A/B comparisons during peak evening hours and observed ' +
      'fairness within 5% across customers.',
  },
  {
    name: 'Field tech CRDT',
    advancement_sought:
      'A conflict-free synchronisation layer for the field-technician mobile workflow that lets technicians work ' +
      'through 8-hour disconnections in cellular dead zones and merge inventory, work-order, and time-log ' +
      'changes deterministically when reconnected, improving on existing CRDT libraries.',
    uncertainties:
      "Off-the-shelf CRDT libraries cover counters and last-writer-wins maps, but the hierarchical inventory " +
      "and shared work-order semantics required here don't map onto any single published CRDT. Whether a " +
      "composite scheme converges to operator-meaningful state after long partitions is an open question.",
    work_performed:
      'Prototyped two CRDT compositions (move-aware tree + delta-state ORMap); ran property-based tests for ' +
      'convergence across simulated 8-hour offline windows; profiled merge cost on mid-range Android devices ' +
      'and found that the move-aware variant converged faster.',
  },
];

for (const seed of SEED_NARRATIVES) {
  test(`seed narrative "${seed.name}" produces zero findings`, () => {
    const { findings } = checkNarrative(seed);
    assert.deepEqual(
      findings,
      [],
      `Seed "${seed.name}" tripped rules:\n${findings.map(f => `  ${f.field}: ${f.ruleId} — ${f.message}`).join('\n')}`,
    );
  });
}
