# Narrative helper — use cases + Phase 1 agent brief

A new admin-facing feature: a guided narrative-writing helper for the
three SR&ED narrative fields (`advancement_sought`, `uncertainties`,
`work_performed`) on the project create/edit forms. The users writing
these are engineers who know the technical content but rarely know the
CRA-specific language a reviewer expects.

## Use cases

### UC-NH1 — Pre-submit narrative check

**Actor:** Admin (the engineer or project lead drafting the project
narrative on a new or existing SR&ED project).

**Trigger:** Admin clicks the `Check narrative` button below any of the
three narrative textareas on the project create/edit form
(`public/admin/projects/list.js` for new, `.../edit.js` for edit), OR
the helper auto-runs on text changes after a short debounce.

**Pre-conditions:** Project form is open. At least one narrative field
has text. No external network calls required (rule-based pass only in
Phase 1).

**Main flow:**

1. Helper reads the current text of all three narrative fields.
2. For each field, it runs three categories of checks:
   - **Red flags** — anti-pattern matches (marketing copy, business
     framing, routine-engineering language, future tense, vague
     references, missing measurables, prohibited words).
   - **Missing elements** — each field has a CRA-expected shape:
     - `advancement_sought` needs a specific technological capability
       AND a baseline ("what was knowable before").
     - `uncertainties` needs a stated hypothesis or unknown that
       couldn't be answered from existing technology.
     - `work_performed` needs an experimental method AND a measurable
       outcome.
   - **Word-count signals** — sub-30-word answers are flagged as too
     thin; sub-100-character answers for `work_performed` are flagged
     even harder.
3. Each finding is rendered in a right-rail panel next to the form,
   grouped by field, with:
   - Severity (warn / error / info).
   - The flagged span (highlighted with text quote + offset).
   - A one-line explanation of why it's a red flag.
   - A one-line suggestion of how to rephrase (Phase 1: a canned hint
     from the rule's table; Phase 2: an LLM-generated rewrite).
4. The admin reads the findings, edits the textareas, and re-runs the
   check (or the auto-debounced re-run fires).
5. When all findings clear (or the admin chooses to submit anyway),
   they submit the form as normal — the helper does not block submit.

**Alt flow NH1.a — admin dismisses a finding:**

Each finding has a small "dismiss" button. Dismissed findings stay
dismissed until the page reloads. Dismissals are not persisted server-
side in Phase 1 (the admin can re-run; we don't want to surface stale
dismissals across sessions).

**Alt flow NH1.b — narrative is good:**

If every check passes for a field, the panel shows a small green "✓
Looks clean" indicator instead of the empty-list "no findings" state.
Reassurance matters.

**Post-conditions:** Narrative text is unchanged unless the admin
chose to edit. The check is read-only — it never modifies the form
fields or the project itself.

**Notes:**

- Helper runs entirely client-side in Phase 1 (no LLM, no network).
- Findings are not persisted. The check is advisory.
- The submit button is never disabled by the helper.
- The audit log captures project create/edit as normal; the helper is
  not audited (it has no server interaction).

### UC-NH2 — (Phase 2, deferred) LLM-assisted rewrite

Out of scope for this work. Reserved here so the Phase 1 design leaves
room: each finding's `<button>Suggest rewrite</button>` slot exists in
Phase 1 but is hidden/disabled. Phase 2 wires it to a server call that
streams a rewrite suggestion back; Phase 3 swaps the backend for a
locally-hosted model.

## Phase 1 agent brief

Copy the section below into an agent prompt to implement UC-NH1.

---

You're adding a narrative-quality helper to the admin SPA of an SR&ED
tracking tool. **Phase 1 only — no LLM, no network, no server change.**

## Context

Read first:
- `docs/narrative-helper.md` (this file) → UC-NH1
- `docs/use-cases.md` → UC-A4 (Create or edit an SR&ED project) for the
  surrounding form context
- `public/admin/projects/list.js` (new-project form) and
  `public/admin/projects/edit.js` (edit form) — where the helper mounts
- `public/api.js` → existing helpers and the SPA style
- `public/style.css` → existing component patterns

## Scope

Build a pure-JS narrative-quality checker that runs in the browser and
renders findings in a right-rail panel. NO server changes. NO LLM. NO
new npm dependencies.

### Files to add

1. `public/lib/narrative-checks.js` — the rule engine. Exports:
   - `checkNarrative(fields)` where `fields = { advancement_sought,
     uncertainties, work_performed }`. Returns
     `{ findings: [{ field, severity, span, message, hint }] }`.
   - The rule list as exported constants (RED_FLAG_PATTERNS,
     REQUIRED_ELEMENTS, …) so they can be unit-tested without driving
     the DOM.

2. `tests/public/narrative-checks.test.js` — unit tests for the rule
   engine. Cover each red-flag pattern, each missing-element check,
   the word-count thresholds, and the "looks clean" case.

3. `public/admin/projects/narrative-helper.js` — the SPA panel. Exports
   a `mountNarrativeHelper(formEl, fields)` function that:
   - Inserts a `<aside class="narrative-helper">` next to the form (or
     below it on narrow viewports — use the existing breakpoints).
   - Attaches input listeners on the three textareas with a 400ms debounce.
   - Renders findings grouped by field, with severity, the quoted span,
     the message, the hint, and a `<button class="dismiss">` per finding.
   - Renders a green "✓ Looks clean" indicator for fields with no findings.
   - Does not modify the form. Does not block submit.

### Files to modify

- `public/admin/projects/list.js` — call `mountNarrativeHelper` from
  the new-project form's bind step.
- `public/admin/projects/edit.js` — same for the edit form.
- `public/style.css` — add a `.narrative-helper` section. Pull existing
  tokens (`--text-muted`, `--border`, status colours). One color per
  severity. Right-rail layout at >= 1024px, stacked below at < 1024px.

### Rule content (starting set — extend as you implement)

**Red-flag patterns** (substring or regex matches; flag with a hint):

- `/\b(revolutionary|world.class|cutting.edge|industry.leading|state.of.the.art)\b/i` → "marketing copy — describe the technical content"
- `/\b(save (?:our )?customers? time|user experience|business goal)\b/i` → "business framing — focus on the technical advancement, not the business outcome"
- `/\b(?:we will|we plan to|going to|in the future)\b/i` → "future tense — SR&ED claims describe work already performed"
- `/\b(best practices|industry standard|standard approach|we used (?:the )?normal)\b/i` → "routine engineering language — SR&ED requires *non-routine* investigation"
- `/\b(?:our|the) (?:product|platform|application|service|website)\b/i` (in advancement_sought only) → "describes the product, not the technological advancement"
- `/\b(?:easy|quick|simple|straightforward)\b/i` → "if it was simple, there was no uncertainty — reword"

**Missing-element checks** per field:

- `advancement_sought`:
  - Must mention a measurable capability ("X% better", "Y times faster", "to within Z", "<100ms", etc.) — flag if no number-bearing token.
  - Must include a baseline phrase ("previously", "existing", "prior art", "before", "current best", "state of") — flag if missing.
- `uncertainties`:
  - Must include a hypothesis-shaped phrase ("whether", "we did not know", "unknown", "untested", "open question", "couldn't be predicted") — flag if missing.
- `work_performed`:
  - Must include an experimental verb ("tested", "measured", "iterated", "compared", "benchmarked", "prototyped", "validated", "ran experiments") — flag if missing.
  - Must include a measurable outcome (any number + a unit, OR words like "result", "observed", "found that") — flag if missing.

**Word-count signals:**

- < 30 words in any field → "too thin — CRA expects a substantive paragraph".
- < 100 chars in `work_performed` → escalate to error (high signal of incomplete).

### Severity model

- `error` — would likely be rejected by a CRA reviewer (future tense, "easy" wording, < 100 chars in work_performed).
- `warn` — likely to attract pushback (marketing copy, missing baseline, missing hypothesis).
- `info` — soft hints (too thin, missing measurable but text is otherwise reasonable).

### Span highlighting

Each finding's `span` is `{ start, end }` byte offsets into the field's
text. The panel renders the quoted substring with a `<mark>` around it
for context. Optional in Phase 1: highlight inside the textarea via
overlay — skip if too invasive.

## Constraints

- No npm dependencies.
- No server change. No LLM. No network call.
- No persistence (dismissals are session-only).
- Don't touch `tests/helpers/db.js` or `package.json`.
- Don't change form submission behaviour. The submit button is never
  disabled by the helper.
- Don't commit. Leave unstaged.

## Tests

- Rule-engine unit tests in `tests/public/narrative-checks.test.js`:
  - Each red-flag pattern matches the text it should, doesn't match
    text it shouldn't.
  - Each missing-element check flags absence and passes presence.
  - Word-count thresholds fire at the right boundaries.
  - A clean narrative across all three fields returns `findings: []`.
- DOM tests skipped (too brittle for `node:test` without a DOM polyfill).

## Report back

< 250 words:

- Confirmation `npm test` is green + count.
- Total rules (red-flag + missing-element + word-count).
- File list with LOC for each new file.
- Anything subjective you decided (e.g. exact severity thresholds, which
  rules you added beyond the starter list).
- Worktree path + branch name.
