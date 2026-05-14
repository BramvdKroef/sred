# TODO

Loose punch list. `[P1]` = blocks correctness or a planned demo path. `[P2]` = should fix soon. `[P3]` = polish / nice-to-have.

## Correctness / bugs

- [ ] [P1] Proxy-overhead rate `0.55` in `lib/t661.js` is a magic number. Pull into a named constant with a comment citing the CRA rule; the rate has historically been adjustable.
- [ ] [P1] Confirm the 2025 specified-employee wage cap in `lib/wage-caps.js` against the CRA source — the value is annotated `// verify`.
- [ ] [P1] **`findValidEmailToken` doesn't enforce `purpose`.** A token minted as `invite` would validate in a `recovery` or `add_device` flow if passed there. Route handlers don't pass a purpose either. Add purpose to the WHERE clause and to every caller. (Flagged by the auth/tokens test agent — likely overlaps with vuln review.)
- [ ] [P2] `compensation_rows` has no `effective_until`. A terminated employee with no follow-up row keeps accruing at the last known rate. Confirm this is intentional, or add an end-date and update `findEffectiveComp`.
- [ ] [P2] `claimant.reporting_currency` is in the schema and surfaced in T661 output, but the FX path always assumes the converted total is in CAD. Either remove the column or use it when applying `fx_rate`.
- [ ] [P2] Under `sred_method='proxy'`, overhead-category expenses appear in `expense_lines` but are dropped from totals. Consumers reading `expense_lines` see numbers the totals don't reflect. Either filter them out of `expense_lines` or annotate them.
- [ ] [P2] `consumeEmailToken(tokenId)` is a blind UPDATE — silently succeeds for non-existent or already-consumed ids. Either make it return rows-affected, or validate first.
- [ ] [P2] **Employees tab race / stale state.** `public/admin/employees.js:52-87` returns a placeholder and resolves the user list via `.then()`; the module-level `let allUsers` survives tab switches. Await the fetch inside `render()` and drop the module-level state.
- [ ] [P2] **`onHashChange` drops state silently.** `public/admin.js:55` — if the hash isn't in `ALLOWED_TABS` it returns without reverting the URL. Either revert or fall through to overview.
- [ ] [P2] **Field-of-science is free-text** but CRA T661 expects a categorical T4088 code. Misspellings won't match what the tax preparer pastes.
- [ ] [P3] `effectiveHourly` extracts the year via `workDate.slice(0, 4)` — a malformed `work_date` falls through to a `NaN` cap lookup that only logs a warning. Either validate date format at the schema level (`CHECK (work_date GLOB '____-__-__')`) or guard in the function.
- [ ] [P3] `compensation_rows.hours_per_year = 0` would divide-by-zero in the hourly calc. Schema has no CHECK preventing it.
- [ ] [P3] **Audit-log filter facets rebuild from filtered results**, so once you filter by `action=approve` the entity-type dropdown only contains approve-relevant types — hard to switch back without clearing manually. Compute facets from the unfiltered universe.
- [ ] [P3] **Evidence detail shows `user #{id}` as a raw ID** (`public/api.js:420`). Show the name or hide the line.

## UI: missing / partial use cases

Distilled from [UI_USE_CASE_AUDIT.md](UI_USE_CASE_AUDIT.md). Use-case IDs reference `docs/use-cases.md`.

- [ ] [P1] **UC-R1 — Review queue scoping + bulk approve.** Add claimant / period / project / employee filters. Add row checkboxes + an "Approve / Reject selected" action bar. Replace `prompt()` for rejection reason with an inline input. Render employee name + project title instead of raw IDs.
- [ ] [P1] **UC-E4 — Employee dashboard period + claimant scope.** My-activity needs a period selector with per-period totals. Labour / expense / evidence tables need a claimant column for multi-claimant employees.
- [ ] [P2] **UC-A4 — Project narrative revision viewer.** Project detail should list prior revisions and let the admin view/diff them. The "Narrative edits create a new revision snapshot" hint currently raises a question the SPA doesn't answer.
- [ ] [P2] **UC-A3 — Employee onboarding: look-up-by-email.** Detect existing user before creating a new one; surface the "attach to another claimant" path from the Add-employee form. Add title + employment start date to the initial form.
- [ ] [P3] **UC-R2 — Comparative two-period export.** Side-by-side T661 export across two periods (alt flow R2.b).

## UI: usability

Distilled from [UI_USABILITY_REVIEW.md](UI_USABILITY_REVIEW.md). Top-impact items first.

- [ ] [P1] **Hoist active-claimant selector into page header.** Currently only on the Projects tab; Overview / Review / Audit silently aggregate across all claimants while other tabs are per-claimant scoped.
- [ ] [P1] **Dollar inputs, not cent inputs.** Replace every `Amount (cents)` / `(¢/yr or ¢/hr)` input with a dollars input that multiplies by 100 on submit. People are typing `9500000` for $95k salaries.
- [ ] [P1] **First-run empty state.** When `state.claimants.length === 0`, replace the Overview body with a getting-started checklist (Create claimant → Add period → Onboard employees → Create project → Generate T661) with links to each form.
- [ ] [P1] **Confirmation dialog before "Close period".** Name what gets locked (labour, expenses, evidence) and show row counts. Currently a one-click irreversible-ish action.
- [ ] [P2] **Errors as inline banners, not `alert()`.** Replace every `alert(e.message)` with a per-card error banner.
- [ ] [P2] **Invite-link UX.** Replace `alert()` with a modal: copy-to-clipboard button, relative expiry, "Sent to <email>" indicator when SMTP is configured.
- [ ] [P2] **Tooltips for jargon.** Hover help on "Specified employee", "SR&ED method" (proxy vs traditional), "Comp type", "Reporting currency".
- [ ] [P2] **Mobile-friendly tables.** Wrap `<table>` in `overflow-x: auto`. Collapse non-essential columns under 600px. Especially: the employee tabs (Log labour, Submit expense, Add evidence) are the actual mobile-relevant flows — they should be the most polished.
- [ ] [P2] **Distinguish "locked" reasons.** Show `approved` / `rejected` / `period closed` rather than collapsing all three into "locked".
- [ ] [P2] **Auto-approve visual indicator.** Admin-submitted labour/expenses skip the review queue — surface a "Will be saved as approved" badge on the on-behalf forms.
- [ ] [P3] **Search-bar discoverability.** Rename placeholder to "Jump to project or employee…", add a "See all projects" overflow link.
- [ ] [P3] **Disabled+spinning state on "Build" evidence package.** Currently no progress indicator; users re-click.
- [ ] [P3] **Loading vs empty-state distinction.** Currently both render `<p class="empty">…</p>`. Pick distinct copy or classes.
- [ ] [P3] **Hash-route key alignment.** `#claimants` is labeled "Projects" and `#users` is labeled "Employees". Either rename keys to match labels (with a redirect from the legacy hash) or rename labels to match keys.
- [ ] [P3] **Standardize form button labels.** "Save" / "Save changes" / "Create project" / "Generate" vary across forms. Pick a consistent verb-object pattern.
- [ ] [P3] **`fiscal_period_id` as a number** in the Exports list — replace with the period's date range.

## Tests to add

- [ ] [P2] `lib/route-helpers.js` — `getEntity` 404 path, `resolveUserClaimant` admin-vs-employee paths, `findOpenPeriod` 422 path, `assertEditable` (approved entry + closed period).
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
- [ ] [P3] Three different "new X" form patterns coexist (toggle-card, inline-expansion, separate page). Pick one.

## Security

Tracked in [VULNERABILITY_REVIEW.md](VULNERABILITY_REVIEW.md). Latest audit: 0 critical, 2 high, 5 medium, 4 low/info (11 findings). High-priority items below; full evidence + fix suggestions in the report.

- [x] ~~**V-01 (High) Stored XSS via `javascript:` URLs in evidence link items.**~~ Fixed: scheme allowlist (`http:`/`https:`/`mailto:`) on both write (`src/routes/evidence.js`) and render (`safeHref` in `public/api.js`, applied at the three render sites). CSP header is still TODO as defence-in-depth.
- [x] ~~**V-02 (High) Default `JWT_SECRET=change-me` boots without complaint.**~~ Fixed: `src/config.js` now rejects known weak values and enforces ≥32 chars at startup. `.env.example` replaced the placeholder with `__REPLACE_WITH_RANDOM_HEX_AT_LEAST_32_CHARS__`.
- [ ] [P2] **V-03 (Med) Refresh-token replay doesn't invalidate the family.** `src/auth/refresh.js:18-36` revokes the replayed token but leaves siblings live. Treat replay as theft: revoke all `WHERE user_id = ? AND revoked_at IS NULL`.
- [ ] [P2] **V-04 (Med) No rate limiting anywhere.** Recovery flood, magic-link spam, `webauthn_challenges` table-fill DoS. Add `express-rate-limit` on the auth endpoints and a reaper for stale challenges.
- [ ] [P2] **V-05 (Med) Evidence upload accepts any MIME / any extension.** Compounds V-01 for offline bundle consumers. Add `fileFilter` allowlist + normalize stored extension against detected MIME.
- [ ] [P2] **V-06 (Med) `POST /api/users/:id/invite` returns the raw magic-link in the response body.** Lets any admin silently mint a sign-in link for any other admin and impersonate them. Stop returning the link; rely on SMTP. Consider a second-admin countersignature on admin-targeted invites.
- [ ] [P3] **V-07 (Low) Single-origin WebAuthn `expectedOrigin`** — hardening only; accept a frozen array if multi-tunnel deployment is anticipated.
- [ ] [P3] **V-08 (Low) `audit_log` has no append-only enforcement at the DB layer.** Add `RAISE(ABORT)` triggers on `UPDATE`/`DELETE`. Optionally hash-chain rows.
- [ ] [P3] **V-09 (Low) Stale WebAuthn challenges accumulate.** Delete expired rows on each new `storeChallenge`.
- [ ] [P3] **V-10 (Low) `nodemailer` 6.x DoS advisory `GHSA-rcmh-qjqh-p98v`.** Bump to ^7.0.11 or ^8.0.4. Realistic exposure is low (we only feed it server-constructed addresses).
- [ ] [P3] **V-11 (Low) Refresh token in `localStorage`; JWT in `sessionStorage`.** Exfiltrated by any XSS (V-01 makes this realisable today). Long-term: move refresh to `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/auth/refresh`. Short-term: ship a CSP banning inline scripts.

## Done

- [x] **UI use-case audit** — see [UI_USE_CASE_AUDIT.md](UI_USE_CASE_AUDIT.md). 8 of 12 use cases fully reachable, 4 partial, 0 missing; action items distilled into "UI: missing / partial use cases" above.
- [x] **UI usability review** — see [UI_USABILITY_REVIEW.md](UI_USABILITY_REVIEW.md). Top 10 ranked recommendations + detailed findings by category; action items distilled into "UI: usability" above.
- [x] **Vulnerability review** — see [VULNERABILITY_REVIEW.md](VULNERABILITY_REVIEW.md). 11 findings tracked in "Security" section above.
- [x] **Unit tests for `lib/format.js`** — 9 tests added.
- [x] **Unit tests for `auth/tokens.js`** — 10 tests added, uncovered a real purpose-enforcement gap (tracked in "Correctness / bugs" above).
