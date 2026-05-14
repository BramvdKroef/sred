# TODO

Loose punch list. `[P1]` = blocks correctness or a planned demo path. `[P2]` = should fix soon. `[P3]` = polish / nice-to-have.

## Correctness / bugs

- [ ] [P1] Proxy-overhead rate `0.55` in `lib/t661.js` is a magic number. Pull into a named constant with a comment citing the CRA rule; the rate has historically been adjustable.
- [ ] [P1] Confirm the 2025 specified-employee wage cap in `lib/wage-caps.js` against the CRA source — the value is annotated `// verify`.
- [ ] [P2] `compensation_rows` has no `effective_until`. A terminated employee with no follow-up row keeps accruing at the last known rate. Confirm this is intentional, or add an end-date and update `findEffectiveComp`.
- [ ] [P2] `claimant.reporting_currency` is in the schema and surfaced in T661 output, but the FX path always assumes the converted total is in CAD. Either remove the column or use it when applying `fx_rate`.
- [ ] [P2] Under `sred_method='proxy'`, overhead-category expenses appear in `expense_lines` but are dropped from totals. Consumers reading `expense_lines` see numbers the totals don't reflect. Either filter them out of `expense_lines` or annotate them.
- [ ] [P3] `effectiveHourly` extracts the year via `workDate.slice(0, 4)` — a malformed `work_date` falls through to a `NaN` cap lookup that only logs a warning. Either validate date format at the schema level (`CHECK (work_date GLOB '____-__-__')`) or guard in the function.
- [ ] [P3] `compensation_rows.hours_per_year = 0` would divide-by-zero in the hourly calc. Schema has no CHECK preventing it.

## Tests to add

- [ ] [P2] `lib/format.js` — smoke tests for `toMarkdown`, `toCsv`, `toPdf` against a representative totals object. PDF: assert it streams non-empty bytes with the right magic header.
- [ ] [P2] `lib/route-helpers.js` — `getEntity` 404 path, `resolveUserClaimant` admin-vs-employee paths, `findOpenPeriod` 422 path, `assertEditable` (approved entry + closed period).
- [ ] [P2] `auth/tokens.js` — mint → consume → cannot-consume-twice, expiry, hash-not-raw stored.
- [ ] [P2] `auth/refresh.js` — mint, consume rotates, revoke, replay of consumed token is rejected.
- [ ] [P3] `auth/jwt.js` — sign/verify roundtrip, expired token rejected.
- [ ] [P3] `lib/wage-caps.js` — cap-for-year lookup, fallback path for years outside the table.
- [ ] [P3] Route-level integration tests for the high-value paths: close-period blocks edits, T661 export round-trip, audit-log writes on every mutating endpoint.

## Refactoring

- [ ] [P2] `scripts/seed-data.js` hardcodes user_claimant ids `{ALICE:1, CHARLIE:2, BRAM:3, DANA:4}`. Look them up by email so the script survives any prior UI activity.
- [ ] [P3] Route handlers all follow the same "load before → mutate → load after → audit" shape. Once one more handler is added, factor into a helper (`auditUpdate(table, id, mutator)`).
- [ ] [P3] `public/api.js` is ~526 lines mixing fetch, session, DOM helpers, form binding, and renderers. Split when it next needs an edit.
- [ ] [P3] CSS is inconsistent — some utility classes, some inline styles, some per-form one-offs. Pick a single approach for new code.
- [ ] [P3] Inline SQL is fine at this scale, but if the schema keeps growing, a thin `repositories/` layer would make handlers more testable.

## Reviews to run

- [ ] [P1] **UI use-case audit.** Walk through `docs/use-cases.md` and flag every use case that isn't reachable from the current SPA (admin + employee shells). Produce a list of missing implementations and their entry points. This is partly a backlog-recovery exercise after the "wire the UI" task was done one-pass and may have skipped paths.
- [ ] [P2] **UI usability review.** Imagine a brand-new admin opening the tool cold. Where does the flow confuse them? What is more than two clicks deep but should be one? What's not discoverable (e.g. that closing a period locks edits)? What labels are insider-jargon? Produce concrete suggestions, ranked.
- [ ] [P1] **Vulnerability review.** Audit the codebase for security issues — OWASP top 10 surface (authn/authz gaps, SQL injection, XSS in the SPA renderers, path traversal in evidence downloads / bundle paths, IDOR on tenant-scoped resources, JWT/refresh handling, WebAuthn ceremony correctness, file-upload validation, rate limiting, secret handling, CORS, error-message leakage). Produce a ranked report with severity + concrete fix suggestion per finding.

## Done
