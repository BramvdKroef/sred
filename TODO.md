# TODO

Loose punch list. `[P1]` = blocks correctness or a planned demo path. `[P2]` = should fix soon. `[P3]` = polish / nice-to-have.

> **2026-05-14 multi-review batch.** Ten reviews landed: [PRODUCTION_READINESS_REVIEW.md](PRODUCTION_READINESS_REVIEW.md), [VISUAL_DESIGN_REVIEW.md](VISUAL_DESIGN_REVIEW.md), [RENDER_REVIEW.md](RENDER_REVIEW.md), [DATABASE_REVIEW.md](DATABASE_REVIEW.md), [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md), [TEST_STRATEGY_REVIEW.md](TEST_STRATEGY_REVIEW.md), [RELIABILITY_REVIEW.md](RELIABILITY_REVIEW.md), [DOCS_ACCURACY_REVIEW.md](DOCS_ACCURACY_REVIEW.md), [SRED_DOMAIN_REVIEW.md](SRED_DOMAIN_REVIEW.md), [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md). Findings distilled into the sections below.

## Production-readiness blockers

From [PRODUCTION_READINESS_REVIEW.md](PRODUCTION_READINESS_REVIEW.md). Verdict: not ready for production; pilot-acceptable after these.

- [x] ~~**`app.set('trust proxy', …)`.**~~ Honours `TRUST_PROXY` env var (default 1, single proxy hop). `req.ip` now resolves to the real client; V-04 rate limiters work as intended.
- [x] ~~**SIGTERM/SIGINT shutdown hook.**~~ `shutdown()` closes the listener, drains in-flight, calls `db.close()` to flush WAL. 10s force-exit safety. Also: `unhandledRejection` exits 1 so a supervisor restarts.
- [x] ~~**Backup + retention strategy.**~~ `npm run backup` (WAL-safe via `db.backup()`, tars `uploads/`, default 30-day retention). `npm run cleanup:bundles` (default 90-day). `email_tokens` is reaped on each mint (V-09 pattern). README has a Backup-and-restore section.
- [ ] [P2] **Structured logging.** Currently `console.log` / `console.error`. Operators need request-id, user-id, route correlation.
- [ ] [P2] **Health / readiness endpoints** (`/healthz`, `/ready`) for load-balancer probes.
- [ ] [P3] Error-monitoring hook (Sentry/Honeybadger integration point).
- [ ] [P3] Request correlation IDs flowing into logs + `audit_log`.

## Accessibility

From [VISUAL_DESIGN_REVIEW.md](VISUAL_DESIGN_REVIEW.md) and [RENDER_REVIEW.md](RENDER_REVIEW.md) (24 axe-critical + 301 axe-serious violations across 64 page captures).

- [x] ~~**`--text-muted` contrast.**~~ Token bumped to `#5a6470` (4.93:1 on surface, 4.62:1 on bg).
- [x] ~~**`<select>` and form inputs without accessible names.**~~ 9 `aria-label` adds on filter selects/textarea; ~120 controls converted from sibling-label to wrapping-label across 8 files.
- [x] ~~**`:focus` styles.**~~ Unified `:focus-visible` outline (brand-blue on light backgrounds, white on the header gradient) for buttons, tabs, `.summary-link`, `<summary>`, `.card a`.
- [x] ~~**`.pill.kind-sred` contrast.**~~ Foreground now `--brand-dark` (~5.4:1).
- [x] ~~**Mobile tables overflow.**~~ Selector broadened from `.card > table` to `.card table` so the `#all-users-table` wrapper div doesn't escape the rule.
- [ ] [P2] **Two `<h1>`s per page.** The brand strip "Precision SR&ED" is an `<h1>`, plus each page emits its own. Demote one.
- [ ] [P2] **No `<main>` wrapper** on overview + login.
- [x] ~~**`.loading` and `.error-banner` contrast.**~~ `.loading` uses `--text-muted` now; `.error-banner` text bumped to `#8a2521` (~7:1).
- [x] ~~**CSP fonts**.~~ `connect-src` now allows `fonts.googleapis.com` + `fonts.gstatic.com`.
- [ ] [P3] **Employee Overview speculatively hits `/api/claimants` (admin-only)** → 403 + console error on every page load.

## Correctness / bugs

- [x] ~~Proxy-overhead constant naming.~~ Fixed in `lib/t661.js`: `PROXY_OVERHEAD_RATE = 0.55` with a CRA-rule comment.
- [ ] [P1] Confirm the 2025 specified-employee wage cap in `lib/wage-caps.js` against the CRA source — the value is annotated `// verify`. **(Needs human, not agent — CRA source lookup.)**
- [x] ~~`findValidEmailToken` purpose enforcement.~~ Signature now `findValidEmailToken(rawToken, expectedPurpose)`. Mismatch returns same `unauthorized('invalid token')` shape as unknown-token. Register/start and register/finish in `src/routes/auth.js` pass `['invite', 'recovery', 'add_device']`.
- [x] ~~`compensation_rows.effective_until`.~~ Added in migration 007. `findEffectiveComp` now respects it.
- [x] ~~`claimant.reporting_currency` FX path.~~ Resolved: kept the column and documented its semantics in `t661.js` (`fx_rate` converts native currency to `reporting_currency`).
- [x] ~~Proxy `expense_lines` includes overhead rows.~~ Fixed: under proxy mode, `expense_lines` is filtered to exclude `category='overhead'`. Test added.
- [x] ~~`consumeEmailToken(tokenId)` silent UPDATE.~~ Now returns rows-affected; register/finish throws `unauthorized` when consume returns 0.
- [x] ~~**Employees tab race / stale state.**~~ `render()` is now async and awaits the user fetch; `allUsers`/`redrawAllUsers`/`currentCtx` indirection dropped. Matches `review.js`'s pattern.
- [x] ~~`onHashChange` drops state silently.~~ Fixed in `public/admin.js`: reverts to last valid hash via `history.replaceState`. Unit-tested.
- [ ] [P2] **Field-of-science is free-text** but CRA T661 expects a categorical T4088 code. Misspellings won't match what the tax preparer pastes. **(Needs human — picking the right CRA categories.)**
- [x] ~~`work_date` format CHECK.~~ Migration 007: `CHECK (work_date GLOB '????-??-??')`.
- [x] ~~`compensation_rows.hours_per_year = 0` divide-by-zero.~~ Migration 007: `CHECK (hours_per_year > 0)`.
- [x] ~~Audit-log filter facets rebuild from filtered results.~~ Fixed: module-level `universeFacets` cache in `public/admin/audit.js` keeps the unfiltered facet set across renders.
- [x] ~~Evidence detail shows `user #{id}` as a raw ID.~~ Line dropped (the audit-log section of the detail panel already shows actor names).
- [x] ~~"Locked" label collapses three states.~~ Fixed: `lockReason(entry)` helper in `public/api.js` returns `'approved' | 'period closed' | null`. Server adds `period_status` to labour/expense list endpoints. Unit-tested.
- [ ] [P3] **CSV / MD / PDF export shapes differ.** `toCsv` emits one row per *category* per project (labour, materials, contract, third_party_payment, overhead, project_total); `toMarkdown` and `toPdf` iterate `labour_worksheet` and `expense_lines` row-by-row. Probably intentional (CSV is for accountant rollups) but someone diffing outputs across formats will be confused. Document the contract or normalize.
- [x] ~~`refresh.js` follow-ups.~~ `last_used_at` column dropped (migration 010); `mintRefreshToken` prunes expired siblings; expired and deactivated paths now share `unauthorized('refresh token invalid')`.
- [x] ~~`route-helpers.js` subtleties.~~ `resolveUserClaimant` casts stringified ints; `assertEditable` throws `notFound` if the period row is missing; `isOwnerOrAdmin` documents the missing-uc-returns-false contract (grep confirmed no caller relies on it as a not-found signal).
- [x] ~~**Content-sniff MIME on evidence uploads.**~~ `file-type@22` integrated. HTML-pretending-to-be-PDF rejects via the text-family fallback (HTML has no magic bytes). When supplied≠detected and both are allowlisted, detected MIME wins and the on-disk extension is renamed accordingly.
- [ ] [P3] **Flaky cleanup race in content-sniff test.** The disk-unlink on rejection is async-ish; the test occasionally sees the file still on disk and fails. Make the cleanup synchronous, or `await` the unlink before the assertion. (Test count fluctuates 228 ↔ 229 on rerun.)
- [x] ~~**Admin self-invite blocked.**~~ Returns `badRequest('cannot invite yourself; use the recovery flow')`. Audit row's `after_json` now carries `{ email, role }` for the target. (Second-admin countersignature still TODO if you want it.)
- [x] ~~**Admin can't edit their own auto-approved entries.**~~ Flagged by route-integration-tests agent. Fixed: `assertEditable(entry, { user })` lets the approving admin PATCH their own approved labour/expense; the row reverts to `pending` (same precedent as rejected-entry edits).

## UI: missing / partial use cases

Distilled from [UI_USE_CASE_AUDIT.md](UI_USE_CASE_AUDIT.md). Use-case IDs reference `docs/use-cases.md`.

- [x] ~~**UC-R1 — Review queue scoping + bulk approve.**~~ All 5 sub-tasks done.
  - [x] ~~Render employee name + project title.~~
  - [x] ~~Replace `prompt()` for rejection reason with an inline textarea.~~
  - [x] ~~Add per-claimant scope.~~
  - [x] ~~Bulk approve/reject action bar.~~ Sticky bar, per-kind select-all, shared rejection-reason textarea, `Promise.allSettled` with failure-count reporting.
  - [x] ~~Period / project / employee filters.~~ Three dropdowns over the queue, filter selection persists across re-renders within the tab.
- [x] ~~**UC-E4 — Employee dashboard period + claimant scope.**~~
  - [x] ~~Add a claimant column on labour / expense / evidence tables.~~
  - [x] ~~Add a period selector + per-period totals row on the activity tab.~~ Selector groups periods by claimant via `<optgroup>`; defaults to the unique open period (or "All periods" otherwise). Totals card sums approved/pending hours, expense amounts bucketed per-currency (no FX summation), and evidence count. New `/api/me/periods` endpoint (employees can't hit admin-only `/api/claimants/:id/periods`). `periodTotals()` unit-tested.
- [ ] [P2] **UC-A4 — Project narrative revision viewer.**
  - [x] ~~List prior revisions on the project detail page.~~ New "Narrative revisions (N)" card; `/revisions` endpoint joins users for `revised_by_name` + `manager_name`.
  - [x] ~~Click-to-view a revision (read-only inline expansion).~~
  - [ ] *(optional)* Diff against current — only if list+view proves valuable.
- [x] ~~**UC-A3 — Employee onboarding: look-up-by-email.**~~ All 3 sub-tasks done.
  - [x] ~~Look up existing user by email on Add-employee submit; switch form to attach mode if found.~~
  - [x] ~~Add title + employment start date fields.~~
  - [x] ~~Surface the cross-claimant attachment path from a top-level button.~~ New "＋ Attach existing employee to claimant" button in the Add-employee card head, expands an inline attach-only form.
- [x] ~~**UC-R2 — Comparative two-period export.**~~ `POST /api/exports/t661/compare` returns `{ a, b, diff }` (ephemeral, no DB row). `GET /api/exports/compare/download?...` for json/csv/md/pdf. Per-project union with `missing_from: 'a' | 'b' | null`. New "Compare two periods" card on Exports tab.

## UI: usability

Distilled from [UI_USABILITY_REVIEW.md](UI_USABILITY_REVIEW.md). Top-impact items first.

- [x] ~~**Hoist active-claimant selector into page header.**~~ All 4 steps done.
  - [x] ~~Step 1: move selector visually into the header.~~
  - [x] ~~Step 2: persist selection + add "All claimants" sentinel.~~
  - [x] ~~Step 3: scope the Review tab to the selection.~~ `claimant_id` filter added to labour/expense list endpoints.
  - [x] ~~Step 4: scope Audit and Overview tabs; handle deleted-claimant fallback.~~ Audit log endpoint accepts `claimant_id` with per-entity-type subqueries; Overview scoped via labour/expense/activity filters; deleted-claimant fallback shows an inline banner.
- [x] ~~**Dollar inputs, not cent inputs.**~~ `dollarsToCents` helper in `public/api.js`; applied to Add-employee, Add-attachment, Add-comp-row, on-behalf expense, Submit-expense, and inline edit-expense forms. Unit-suffix flips `$/yr ↔ $/hr` with comp-type dropdown. API field `amount_cents` unchanged.
- [x] ~~**Confirmation dialog before "Close period".**~~ Native `confirm()` with the date range, the three row counts (labour / expenses / evidence), and the consequence wording. Reopen stays unconfirmed.
- [x] ~~**First-run empty state on Overview.**~~ When `state.claimants.length === 0` the body becomes a 5-step getting-started checklist with anchor links into the relevant tabs.
- [x] ~~**Errors as inline banners, not `alert()`.**~~ `showError`/`clearError`/`showTopBanner` helpers in `public/api.js`; `onSubmit` now uses inline banner. Six ad-hoc `alert()` sites replaced (passkey-remove, send-invite, deactivate, close-period, unassign, re-assign). Magic-link delivery confirmation alert left deliberately (notification, not error).
- [x] ~~**Invite-link UX.**~~ `<dialog>` modal showing name/email/purpose/relative-expiry and SMTP-delivery line. Copy-link button dropped because V-06 removed the raw link from the API response (post-V-06 there's nothing to copy).
- [x] ~~**Tooltips for jargon.**~~ `title=` attribute hover help on Specified-employee, Comp-type, SR&ED method, Reporting currency. No CSS, no library.
- [x] ~~**Mobile-friendly tables.**~~ CSS-selector approach (`.card > table { overflow-x: auto }` + scroll-shadow gradient) — zero per-render wrapping needed. `.hide-on-narrow` applied to All-employees `ID`, Project list `Field of science`, Audit log `#<entity_id>` suffix. Employee tabs: single-column grid + ≥44px tap targets under 600px; bar-chart labels tightened.
- [x] ~~**Auto-approve visual indicator.**~~ On-behalf labour and expense forms now show a `pill.approved` note: "As an admin, this entry will be saved as approved and skip the review queue."
- [x] ~~**Distinguish "locked" reasons.**~~ Replaced by `lockReason(entry)` returning `'approved' | 'period closed' | null`; `lockPill()` in `public/employee/activity.js` renders distinct pills.
- [x] ~~**Search-bar discoverability.**~~ Placeholder "Jump to project or employee…", SVG magnifying-glass `::before`, dropdown cap raised to 30 with a "See all N matches" footer.
- [x] ~~**Disabled+spinning state on "Build" evidence package.**~~ Click handler in `public/admin/exports.js` now disables the button and swaps the label to "Building…" while the POST is in flight; restores on error (success re-renders the row to a download link).
- [x] ~~**Loading vs empty-state distinction.**~~ New `.loading` class (italic + gentle pulse) swapped in across 5 files.
- [x] ~~**Hash-route key alignment.**~~ `#claimants` → `#projects`, `#users` → `#employees`. `migrateLegacyHash` extracted + unit-tested.
- [x] ~~**Standardize form button labels.**~~ Verb-object pattern (Save/Create/Add/Generate) across 15 buttons in 5 files. Two documented exceptions (`Add assignment`, `Submit rejection`).
- [x] ~~**`fiscal_period_id` as a number** in the Exports list.~~ Exports table now shows `start_date → end_date` via a client-side lookup against `state.periods` (already loaded for the active claimant).

## Reliability

From [RELIABILITY_REVIEW.md](RELIABILITY_REVIEW.md).

- [x] ~~**Concurrent narrative PATCH silently overwrites.**~~ Fixed: strict `__updated_at` precondition (missing = 400, mismatch = 409). Server uses millisecond-precision `strftime('%Y-%m-%d %H:%M:%f', 'now')` to handle same-second PATCHes. Client snapshots `updated_at` at form-bind and shows a "reload-and-retry" banner on 409. Other PATCH routes audited — only `projects` has the narrative co-edit risk; others target narrow scalars where loss is small/visible.
- [ ] [P2] **SMTP invite returns lying `delivered:true`.** `src/routes/users.js:292` fires `sendMagicLink(...).catch(...)` unawaited; response goes before the send completes; nodemailer has no timeout. On 5xx/timeout the link only appears on stderr. Either await with a timeout, or return `delivery_status: 'queued'`.
- [ ] [P2] **`isOwnerOrAdmin` doesn't check `user_claimants.status`.** Deactivated employees can still PATCH/DELETE their own rows for the JWT TTL. Add the status check.
- [ ] [P3] **SQLITE_BUSY** under concurrent writers — no retry; user gets a 500. Wrap mutations with a small retry-on-busy.
- [ ] [P3] **Disk-full mid-write** on uploads / bundles leaves partial files. Wrap in transactions with cleanup.

## Database performance

From [DATABASE_REVIEW.md](DATABASE_REVIEW.md). The DB has 12 existing indexes plus PKs/UNIQUEs; these are the gaps.

- [ ] [P2] **`CREATE INDEX idx_comp_uc ON compensation_rows(user_claimant_id)`.** Biggest perf win — `findEffectiveComp` runs once per labour entry, so T661 export is O(N·M) without it.
- [ ] [P2] **`CREATE INDEX idx_expense_project ON expenses(project_id)`** and **`idx_expense_uc ON expenses(user_claimant_id)`** — review queue + T661 both filter by these.
- [ ] [P3] **Audit-log indexes** on `audit_log(actor_user_id)` and `audit_log(created_at DESC)` to support the admin date-range filter UI.
- [ ] [P3] **Evidence_items indexes** on the 3 join columns flagged in the report.
- [ ] [P3] **CHECK constraints**: `amount_cents > 0` on `expenses` + `compensation_rows`; `hours > 0` on `labour_entries`; `expense_date` + `evidence_date` GLOB pattern (match the `work_date` treatment from migration 007).

## SR&ED domain accuracy

From [SRED_DOMAIN_REVIEW.md](SRED_DOMAIN_REVIEW.md). **The agent did this without web access; cite recall with caution.** A tax preparer should final-check.

- [ ] [P1] **Specified-employee cap not pro-rated by days-as-specified.** Over-claims for mid-year hires, part-time, most hourly specified employees. Steady-state full-time year-round cases are correct. Needs a `days_as_specified_in_year` factor.
- [ ] [P2] **T661 line numbers absent from every export format.** Tax preparer maps everything by hand. Annotate `toMarkdown` / `toCsv` / `toPdf` with line references.
- [ ] [P2] **Traditional-method overhead is one bucket.** No sub-categorisation (rent/utilities/maintenance/supporting-salaries) and no allocation-basis field. CRA expects per-overhead-type documentation.
- [ ] [P3] **Materials** are one category — no consumed-vs-transformed split.
- [ ] [P3] **Contract** doesn't distinguish arm's-length vs non-arm's-length (different allowable percentages).
- [ ] [P3] **Audit-defensibility gaps**: no `hypothesis` field, no FX-rate-source attribution, evidence isn't linked to a specific uncertainty, no "date uncertainty was identified" field.
- [ ] [P3] Re-run the domain review with web access enabled to verify 2025-2027 wage-cap values, current T661 v22 line numbers, and the OT straight-time-vs-premium question.

## Tests to add

- [x] ~~`lib/route-helpers.js`~~ (21 tests)
- [x] ~~`auth/refresh.js`~~ (9 tests, covering V-03 family-revoke behaviour)
- [x] ~~`auth/jwt.js`~~ (7 tests)
- [x] ~~`lib/wage-caps.js`~~ (6 tests)
- [x] ~~**Route-level integration tests.**~~ 18 new tests across three files: `close-period.test.js` (10), `t661-export-roundtrip.test.js` (7), `audit-log-writes.test.js` (1 parameterised covering 11 endpoints). Caught: admin-logged labour auto-approves into `status='approved'` which immediately locks it from PATCH via `assertEditable` — admin can't fix a typo on their own on-behalf entry without reject-then-edit-then-re-approve. Flagged for follow-up.
- [x] ~~**`src/auth/middleware.js` is untested.**~~ 19 new negative-path tests added. `requireAuth` does validate user status (`!== 'active'` → 401). Worth flagging: every JWT-library error surfaces as generic `"unauthorized"` but the deactivated path leaks `"user not active"` — a 401 with that exact message confirms the token was crypto-valid + the user exists (minor enumeration vector).
- [ ] [P2] **Cross-tenant isolation tests.** Seed 2 claimants + walk every endpoint as a wrong-claimant employee to prove `isOwnerOrAdmin`/`assertAttached` are wired everywhere.
- [ ] [P2] **`src/auth/webauthn.js` is untested** — counter regression, expired/replayed challenges, unknown credential.
- [ ] [P3] **`src/lib/email.js` is untested** — silent invite regressions would slip through.

## Refactoring

From [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md). Largest files: `admin/projects.js` 771 LOC · `admin/employees.js` 663 · `api.js` 630 · `lib/format.js` 590 · `admin.js` 428. **Zero import cycles** — the DAG is clean.

- [x] ~~`scripts/seed-data.js` hardcoded IDs.~~ Replaced with email-keyed user/uc lookups and a derived admin/period lookup.
- [ ] [P2] **Extract `mutateAndAudit(table, id, mutator, …)`** — the "load before → mutate → load after → audit" pattern recurs ~25 times across routes. The new `audit-log-writes.test.js` now pins the contract.
- [ ] [P2] **Split `public/admin/projects.js` (771 LOC)** along list/detail/on-behalf/inline-edit seams.
- [ ] [P2] **Split `public/admin/employees.js` (663 LOC)** similarly.
- [ ] [P2] **Split `src/routes/auth.js`** into `auth.js` (ceremonies) + `me.js` (`/api/me*` endpoints).
- [ ] [P2] **109 inline `style="…"` attributes** in the SPA, ~25 replicating tokens (muted captions, breadcrumb decoration). The `<dialog>` invite modal is hand-rolled via `dlg.style.cssText`. Extract to classes.
- [ ] [P2] **Status pill mapping inconsistency** across `admin/projects.js`, `admin/employees.js`, `api.js` — user/attachment "active" status is rendered four different ways. Pull into a single helper.
- [ ] [P3] **Split `public/api.js`** (630 LOC). Do when it next needs a non-trivial edit.
  - [ ] Extract session storage + `setSession`/`clearSession` into `public/session.js`.
  - [ ] Extract `api`, `apiUpload`, refresh-on-401 into `public/fetch.js`.
  - [ ] Extract DOM helpers (`esc`, `cents`, `$`, `$$`, `safeHref`, `onSubmit`, `bindForm`) into `public/dom.js`.
  - [ ] Extract per-feature renderers (`activityHtml`, `wireActivityDetails`, `renderPreferencesPage`, etc.) into per-feature files.
- [ ] [P3] **Remove unused exports** in `public/api.js`: `dollarInput`, `$$`. Move `setJwt`/`clearJwt`/`setRefresh`/`clearRefresh` to non-exported (used only internally).
- [ ] [P3] **Unused tokens** `--gold` and `--green` are declared in `:root` but referenced nowhere. Either remove or use.
- [ ] [P3] CSS is inconsistent — some utility classes, some inline styles, some per-form one-offs. Pick a single approach for new code.
- [ ] [P3] Inline SQL is fine at this scale, but if the schema keeps growing, a thin `repositories/` layer would make handlers more testable.
- [ ] [P3] Three different "new X" form patterns coexist (toggle-card, inline-expansion, separate page). Pick one.

## Dependencies

From [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md). License posture clean (292 packages, all permissive); `npm audit` reports 0 vulnerabilities.

- [ ] [P2] **Upgrade `multer` 1.4.5-lts → 2.x.** Author deprecated 1.x citing unpatched vulnerabilities. Only one call site (`src/routes/evidence.js`).
- [ ] [P2] **Upgrade `@simplewebauthn/server` 11 → 13.** Two majors stale; v13 also drops the deprecated `@simplewebauthn/types@11` transitive.
- [ ] [P3] **Resolve `file-type@22` engine mismatch** — declares `engines.node >=22`; project says `>=20`. Either bump `engines.node` or downgrade to `^21`.
- [ ] [P3] **`express` 4.x is in maintenance.** 5.x migration when convenient.

## Security

Tracked in [VULNERABILITY_REVIEW.md](VULNERABILITY_REVIEW.md). Latest audit: 0 critical, 2 high, 5 medium, 4 low/info (11 findings). High-priority items below; full evidence + fix suggestions in the report.

- [x] ~~**V-01 (High) Stored XSS via `javascript:` URLs in evidence link items.**~~ Fixed: scheme allowlist (`http:`/`https:`/`mailto:`) on both write (`src/routes/evidence.js`) and render (`safeHref` in `public/api.js`, applied at the three render sites).
- [x] ~~**CSP header.**~~ Middleware in `src/lib/csp.js` ships `Content-Security-Policy` on every response: bans inline scripts and `javascript:` URIs, allows jsdelivr (for `@simplewebauthn/browser`) and Google Fonts. Verified via `curl -I /`.
- [x] ~~**V-02 (High) Default `JWT_SECRET=change-me` boots without complaint.**~~ Fixed: `src/config.js` now rejects known weak values and enforces ≥32 chars at startup. `.env.example` replaced the placeholder with `__REPLACE_WITH_RANDOM_HEX_AT_LEAST_32_CHARS__`.
- [x] ~~**V-03 Refresh-token family revocation.**~~ Replay revokes all sibling tokens in a transaction and writes a `refresh_replay_detected` audit row.
- [x] ~~**V-04 Rate limiting.**~~ `express-rate-limit` on login/register/recovery/refresh/invite — see `src/lib/rate-limit.js`. 429s use the standard error shape.
- [x] ~~**V-05 Evidence MIME allowlist.**~~ PDF / common images / text-family / Office docs / zip only. Stored extension normalised from MIME, never from `originalname`.
- [x] ~~**V-06 Invite response no longer leaks magic-link.**~~ Body is `{ user_id, purpose, expires_at, delivered }`.
- [x] ~~**V-07 Multi-origin WebAuthn.**~~ `config.origin` → `origins` (frozen array, comma-split). Production https assertion. `buildMagicLink` uses `origins[0]`.
- [x] ~~**V-08 `audit_log` append-only triggers.**~~ Migration 008.
- [x] ~~**V-09 Stale WebAuthn challenges reaped.**~~ `storeChallenge` now deletes expired rows on each call.
- [x] ~~**V-10 `nodemailer` bumped to ^8.0.7.**~~ `npm audit --omit=dev` clean.
- [ ] [P3] **V-11 (Low) Refresh token in `localStorage`; JWT in `sessionStorage`.** XSS exfiltration risk; CSP now mitigates. Long-term: move refresh to `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/auth/refresh`.

## Docs to update

Drift from [DOCS_ACCURACY_REVIEW.md](DOCS_ACCURACY_REVIEW.md). Per-doc severity: api **largest**, data-model **large**, use-cases medium, auth medium, README small.

- [ ] [P2] **`docs/api.md`** — many wrong paths (`/api/auth/me` → actual `/api/me`); phantom `/api/me/summary`; missing entire endpoint families (refresh, lifecycle, comparative export, `DELETE /api/expenses/:id`, `PATCH /api/evidence/:id`).
- [ ] [P2] **`docs/data-model.md`** — missing `refresh_tokens` (mig 005), `webauthn_challenges` (mig 001), ~6 columns from migrations 003-012. Still references the dropped `planned|active|completed` enum. **Remove the false "6-year retention enforced in delete paths" claim** — code only blocks deletes in closed periods, no 6-year clock anywhere.
- [ ] [P2] **`docs/auth.md`** — predates the refresh-token system entirely (no rotation, no V-03 family revocation, no rate limiting, no multi-origin, no JWT_SECRET strength check, no append-only triggers). JWT payload claim wrong (`{userId, role}` → actual `{uid, role}`).
- [ ] [P3] **`docs/use-cases.md`** — medium drift; some new entities and actors not reflected.
- [ ] [P3] **README** — small drift; `src/lib/csp.js` and `src/lib/rate-limit.js` missing from layout.

### UC drafts

The UI use-case audit earlier found 8 features in the SPA without a corresponding entry in `docs/use-cases.md`. Proposed drafts live in [`docs/use-cases-drafts.md`](docs/use-cases-drafts.md). Each has a `[DRAFT]` header + a "Keep or drop" subsection. Decision is the owner's.

Drafted IDs: UC-A6 (deactivate/reactivate), UC-A7 (project type+phase), UC-A8 (project manager), UC-A9 (audit-log tab), UC-E5 (overview dashboards), UC-E6 (overtime flag), UC-E7 (log-on-behalf), UC-R4 (global search).

Notable corrections from the draft agent:
- ~~**Project `type` is load-bearing**~~ (still true). ~~`phase` is decorative.~~ Resolved: `phase` column dropped (migration 011); `status` values renamed to `concept`/`development`/`complete` (the old `phase` wording). The UC-A7 draft about type+phase should be re-read as type-only.
- ~~**`reactivate` is incomplete**~~ Fixed: migration 012 + symmetric flip.
- ~~**Overtime flag is a marker only**~~ Resolved: `is_overtime` is now a reportorial breakdown on the T661 worksheet.

- [ ] [P3] Decide keep-or-drop for each of the 8 drafts; promote accepted ones into `docs/use-cases.md` and delete the drafts file.

## Done

- [x] **UI use-case audit** — see [UI_USE_CASE_AUDIT.md](UI_USE_CASE_AUDIT.md). 8 of 12 use cases fully reachable, 4 partial, 0 missing; action items distilled into "UI: missing / partial use cases" above.
- [x] **UI usability review** — see [UI_USABILITY_REVIEW.md](UI_USABILITY_REVIEW.md). Top 10 ranked recommendations + detailed findings by category; action items distilled into "UI: usability" above.
- [x] **Vulnerability review** — see [VULNERABILITY_REVIEW.md](VULNERABILITY_REVIEW.md). 11 findings tracked in "Security" section above.
- [x] **Unit tests for `lib/format.js`** — 9 tests added.
- [x] **Unit tests for `auth/tokens.js`** — 10 tests added, uncovered a real purpose-enforcement gap (tracked in "Correctness / bugs" above).
- [x] **2026-05-14 multi-review batch (10 reports)** — production-readiness, visual design, render-and-look (Playwright + 64 screenshots), database, architecture, test strategy, reliability, docs accuracy, SR&ED domain, dependencies. All distilled into the sections above; full reports retained at the repo root.
