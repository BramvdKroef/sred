// Narrative-quality rule engine for SR&ED project narratives. Pure JS, no
// DOM, no network. Drives the right-rail Narrative helper (Phase 1).
//
// Three categories of checks per field:
//   1. Red-flag patterns — marketing copy, business framing, routine
//      engineering, future tense, vague references, prohibited words.
//   2. Missing elements — each field has a CRA-expected shape:
//        advancement_sought needs a measurable capability AND a baseline.
//        uncertainties needs a hypothesis-shaped phrase / stated unknown.
//        work_performed needs an experimental verb AND a measurable outcome.
//   3. Word-count signals — sub-30-word answers flag as too thin;
//      sub-100-char work_performed escalates to error.
//
// Each finding shape: { field, severity, span: { start, end }, message, hint }
// where `severity` is one of 'error' | 'warn' | 'info'.
//
// Severity model:
//   error — would likely be rejected by a CRA reviewer (future tense,
//           "easy" wording, < 100 chars in work_performed).
//   warn  — likely to attract pushback (marketing copy, missing baseline,
//           missing hypothesis, business framing, product framing).
//   info  — soft hints (too thin, missing measurable in a paragraph that's
//           otherwise reasonable, routine-engineering hedge).
//
// The rule list is exported so unit tests can drive the engine without a
// DOM. Each red-flag entry has { id, pattern, severity, message, hint,
// fields? }: when `fields` is set, the rule only applies to listed fields.

export const FIELDS = ['advancement_sought', 'uncertainties', 'work_performed'];

export const FIELD_LABELS = {
  advancement_sought: 'Advancement sought',
  uncertainties: 'Technological uncertainties',
  work_performed: 'Work performed',
};

// ---------------------------------------------------------------------------
// Red-flag patterns. Order matters only for human-scan readability; the
// engine collects every match. Each pattern is a /g regex so we can pick
// up the matched span via exec() in a loop.
// ---------------------------------------------------------------------------

export const RED_FLAG_PATTERNS = [
  {
    id: 'marketing-copy',
    pattern: /\b(revolutionary|world[- ]class|cutting[- ]edge|industry[- ]leading|state[- ]of[- ]the[- ]art|game[- ]changing|next[- ]generation|best[- ]in[- ]class)\b/gi,
    severity: 'warn',
    message: 'Marketing copy — CRA reviewers want the technical content, not the brochure.',
    hint: 'Describe the specific technique or measurable property rather than the superlative.',
  },
  {
    id: 'business-framing',
    pattern: /\b(save (?:our )?customers? time|user experience|business goal|customer satisfaction|market share|competitive advantage|return on investment|increase revenue)\b/gi,
    severity: 'warn',
    message: 'Business framing — focus on the technological advancement, not the business outcome.',
    hint: 'Replace the business outcome with the technical capability that enables it (e.g. latency target, accuracy threshold).',
  },
  {
    id: 'future-tense',
    pattern: /\b(we will|we plan to|going to|in the future|will be (?:built|developed|implemented|tested)|intend to)\b/gi,
    severity: 'error',
    message: 'Future tense — SR&ED claims describe work already performed in the claim period.',
    hint: 'Rewrite in past tense and describe what was actually attempted, measured, or observed.',
  },
  {
    id: 'routine-engineering',
    pattern: /\b(best practices|industry standard|standard approach|we used (?:the )?normal|conventional approach|off[- ]the[- ]shelf solution)\b/gi,
    severity: 'warn',
    message: 'Routine-engineering language — SR&ED requires non-routine investigation.',
    hint: 'Name what was non-obvious: the gap in the standard approach that forced experimentation.',
  },
  {
    id: 'product-framing',
    pattern: /\b(?:our|the) (?:product|platform|application|service|website|app)\b/gi,
    severity: 'warn',
    message: 'Describes the product, not the technological advancement.',
    hint: 'Talk about the underlying technique, algorithm, or system property — not the product surface.',
    fields: ['advancement_sought'],
  },
  {
    id: 'easy-language',
    pattern: /\b(easy|easily|quick(?:ly)?|simple|simply|straightforward|trivial)\b/gi,
    severity: 'error',
    message: 'If it was easy/simple/quick, there was no technological uncertainty.',
    hint: 'Either remove the qualifier or describe why the apparent simplicity hid a real uncertainty.',
  },
  {
    id: 'vague-many',
    pattern: /\b(various|several|many|a lot of|lots of|numerous)\s+(?:things|stuff|approaches|ways|features|improvements|changes)\b/gi,
    severity: 'info',
    message: 'Vague quantifier — name the specific approaches or count them.',
    hint: 'Replace with a concrete list or number (e.g. "three scheduler variants", "four imputation strategies").',
  },
  {
    id: 'first-person-marketing',
    pattern: /\b(?:our|we[' ]re) (?:proud|excited|thrilled|delighted)\b/gi,
    severity: 'warn',
    message: 'Promotional tone — keep the narrative factual.',
    hint: 'Drop the affective verb; CRA reviewers want a technical account, not a pitch.',
  },
];

// ---------------------------------------------------------------------------
// Missing-element checks. Each check returns either null (passed) or a
// finding without a span (whole-field problems don't highlight a span;
// the panel still shows the message + hint).
// ---------------------------------------------------------------------------

// Detects a number-bearing measurable: "25%", "100ms", "3x", "five times",
// "to within 2cm", "± 48 hours", etc. We accept digit-leading and a small
// allow-list of spelled-out small numbers + ratio words.
const MEASURABLE_PATTERN = /\b\d+(?:\.\d+)?\s*[-\s]?\s*(?:%|x|×|ms|sec|seconds?|min|minutes?|hours?|days?|cm|mm|km|gb|mb|kb|hz|khz|mhz|ghz|fps|rpm|kpa|°c|°f|times|orders? of magnitude|standard deviations?)\b|\b(?:within|under|over|by|to)\s+\d+|\bsub[- ](?:second|millisecond|microsecond|minute|hour|\d+)|±\s*\d+|\b\d+\s*(?:to|-)\s*\d+\b|\b\d+[-\s]?(?:hour|minute|second|day|week|month|year|fold)s?\b/i;

const BASELINE_PATTERN = /\b(previously|existing|prior(?:\s+art)?|before|current(?:ly)? best|state of(?:\s+the\s+art)?|baseline|incumbent|published|off[- ]the[- ]shelf|established|known(?:\s+technique)?|literature|standard\s+(?:fair|practice|technique|method)|no published|conventional)\b/i;

const HYPOTHESIS_PATTERN = /\b(whether|we did not know|did not know|didn['']t know|unknown|untested|uncertain(?:ty)?|open question|couldn['']t be (?:predicted|determined|known)|cannot be (?:predicted|determined)|no(?: published)? technique|unproven|unclear|not (?:clear|known)|hypothesi[sz]e|question of|it (?:is|was) not (?:known|clear)|to test if)\b/i;

const EXPERIMENTAL_VERB_PATTERN = /\b(tested|measured|iterated|compared|benchmarked|prototyped|validated|ran experiments?|ran (?:an?\s+)?(?:experiments?|tests?|trials?|A\/B|comparison)|profiled|instrumented|sampled|implemented|designed|built|simulated|trialled?|piloted|evaluated|investigated|explored|analy[sz]ed|monitored|recorded|observed)\b/i;

const MEASURABLE_OUTCOME_PATTERN = /(\b\d+(?:\.\d+)?\s*(?:%|x|×|ms|s|sec|seconds?|min|minutes?|hours?|days?|m|cm|mm|km|gb|mb|kb|hz|khz|mhz|ghz|fps|rpm))|\b(result(?:s|ed|ing)?|observed|found(?:\s+that)?|measured|recorded|showed|demonstrated|converged|diverged|precision|recall|throughput|latenc(?:y|ies)|error rate|accuracy|F\d?|p[- ]?value)\b/i;

// Required-element checks. Each is `{ id, fields, severity, message, hint,
// test(text) }` and produces a finding when `test` returns false.
export const REQUIRED_ELEMENTS = [
  {
    id: 'advancement-needs-measurable',
    fields: ['advancement_sought'],
    severity: 'info',
    message: 'No measurable capability stated — CRA reviewers expect a quantified target.',
    hint: 'Add a target metric: e.g. "within ±48 hours", "<100ms p99", "25% lower error rate".',
    test: text => MEASURABLE_PATTERN.test(text),
  },
  {
    id: 'advancement-needs-baseline',
    fields: ['advancement_sought'],
    severity: 'warn',
    message: 'No baseline reference — reviewers need to know what was knowable before this work.',
    hint: 'Anchor against prior art: "previously…", "existing techniques…", "state of the art was…".',
    test: text => BASELINE_PATTERN.test(text),
  },
  {
    id: 'uncertainties-needs-hypothesis',
    fields: ['uncertainties'],
    severity: 'warn',
    message: 'No hypothesis or stated unknown — uncertainty must be technical, not just hard.',
    hint: 'Frame the unknown: "whether X converges…", "we did not know…", "no published technique…".',
    test: text => HYPOTHESIS_PATTERN.test(text),
  },
  {
    id: 'work-needs-experimental-verb',
    fields: ['work_performed'],
    severity: 'warn',
    message: 'No experimental verb — work-performed should describe systematic investigation.',
    hint: 'Use verbs like "tested", "measured", "benchmarked", "iterated on", "ran A/B comparisons".',
    test: text => EXPERIMENTAL_VERB_PATTERN.test(text),
  },
  {
    id: 'work-needs-measurable-outcome',
    fields: ['work_performed'],
    severity: 'info',
    message: 'No measurable outcome — describe what was observed, measured, or resulted.',
    hint: 'Add the result of the experiment: numbers, observed effects, or words like "found that…".',
    test: text => MEASURABLE_OUTCOME_PATTERN.test(text),
  },
];

// ---------------------------------------------------------------------------
// Word-count signals. Sub-30 words flag as "too thin" (info). work_performed
// under 100 chars escalates to error — that's the most concrete field, and
// a one-sentence answer almost always means the form was rushed.
// ---------------------------------------------------------------------------

// `min_words` is set to 25 not 30. The starter brief suggests < 30, but
// realistic SR&ED narratives (e.g. seed-etc.js's ET Grow advancement_sought
// at 28 words) sit just under that — flagging them produces false noise.
// 25 is still under the "two-sentence" floor a CRA reviewer would push
// back on; 30 is the aspirational target the hint copy still recommends.
export const WORD_COUNT_THRESHOLDS = {
  min_words: 25,
  work_performed_min_chars: 100,
};

function countWords(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run all checks against the three narrative fields and return a flat
 * findings array. Empty/whitespace-only fields produce a single "empty
 * field" info finding instead of running every rule (which would spew
 * noise).
 *
 * @param {{advancement_sought?:string, uncertainties?:string, work_performed?:string}} fields
 * @returns {{findings: Array<{field:string, severity:string, span:{start:number,end:number}|null, message:string, hint:string, ruleId:string}>}}
 */
export function checkNarrative(fields) {
  const findings = [];
  for (const field of FIELDS) {
    const raw = fields[field];
    const text = typeof raw === 'string' ? raw : '';
    findings.push(...checkField(field, text));
  }
  return { findings };
}

function checkField(field, text) {
  const out = [];
  const trimmed = text.trim();

  // Empty fields: one gentle info note, then skip the rest. No point
  // running the pattern bank against an empty string.
  if (!trimmed) {
    out.push({
      field,
      severity: 'info',
      span: null,
      message: 'Field is empty.',
      hint: `Fill in ${FIELD_LABELS[field]} — CRA needs all three narrative sections.`,
      ruleId: 'empty-field',
    });
    return out;
  }

  // Red-flag patterns. Reset regex lastIndex defensively (the patterns
  // are /g and shared across invocations).
  for (const rule of RED_FLAG_PATTERNS) {
    if (rule.fields && !rule.fields.includes(field)) continue;
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      out.push({
        field,
        severity: rule.severity,
        span: { start: m.index, end: m.index + m[0].length },
        message: rule.message,
        hint: rule.hint,
        ruleId: rule.id,
      });
      // Guard against zero-length matches creating infinite loops.
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
    }
  }

  // Missing-element checks. No span — the whole field is the locus.
  for (const check of REQUIRED_ELEMENTS) {
    if (!check.fields.includes(field)) continue;
    if (!check.test(text)) {
      out.push({
        field,
        severity: check.severity,
        span: null,
        message: check.message,
        hint: check.hint,
        ruleId: check.id,
      });
    }
  }

  // Word-count signals.
  const words = countWords(text);
  if (words < WORD_COUNT_THRESHOLDS.min_words) {
    out.push({
      field,
      severity: 'info',
      span: null,
      message: `Too thin — ${words} word${words === 1 ? '' : 's'}; CRA expects a substantive paragraph.`,
      hint: 'Aim for at least 30 words. Cover the why, the how, and the result.',
      ruleId: 'word-count-thin',
    });
  }
  if (field === 'work_performed' && text.length < WORD_COUNT_THRESHOLDS.work_performed_min_chars) {
    out.push({
      field,
      severity: 'error',
      span: null,
      message: `Work-performed is only ${text.length} characters — likely incomplete.`,
      hint: 'Describe the experiments run, the variants tried, and the measurements taken.',
      ruleId: 'work-performed-too-short',
    });
  }

  return out;
}
