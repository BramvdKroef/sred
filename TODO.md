# TODO

Loose punch list. `[P1]` = blocks correctness or a planned demo path. `[P2]` = should fix soon. `[P3]` = polish / nice-to-have.

## Correctness / bugs

- [x] ~~Proxy-overhead constant naming.~~ Fixed in `lib/t661.js`: `PROXY_OVERHEAD_RATE = 0.55` with a CRA-rule comment.
- [ ] [P1] Confirm the 2025 specified-employee wage cap in `lib/wage-caps.js` against the CRA source — the value is annotated `// verify`. **(Needs human, not agent — CRA source lookup.)**
- [x] ~~`findValidEmailToken` purpose enforcement.~~ Signature now `findValidEmailToken(rawToken, expectedPurpose)`. Mismatch returns same `unauthorized('invalid token')` shape as unknown-token. Register/start and register/finish in `src/routes/auth.js` pass `['invite', 'recovery', 'add_device']`.
- [x] ~~`compensation_rows.effective_until`.~~ Added in migration 007. `findEffectiveComp` now respects it.
- [x] ~~`claimant.reporting_currency` FX path.~~ Resolved: kept the column and documented its semantics in `t661.js` (`fx_rate` converts native currency to `reporting_currency`).
- [x] ~~Proxy `expense_lines` includes overhead rows.~~ Fixed: under proxy mode, `expense_lines` is filtered to exclude `category='overhead'`. Test added.
- [ ] [P2] `consumeEmailToken(tokenId)` is a blind UPDATE — silently succeeds for non-existent or already-consumed ids. Either make it return rows-affected, or validate first.
- [ ] [P2] **Employees tab race / stale state.** `public/admin/employees.js:52-87` returns a placeholder and resolves the user list via `.then()`; the module-level `let allUsers` survives tab switches. Await the fetch inside `render()` and drop the module-level state.
- [x] ~~`onHashChange` drops state silently.~~ Fixed in `public/admin.js`: reverts to last valid hash via `history.replaceState`. Unit-tested.
- [ ] [P2] **Field-of-science is free-text** but CRA T661 expects a categorical T4088 code. Misspellings won't match what the tax preparer pastes. **(Needs human — picking the right CRA categories.)**
- [x] ~~`work_date` format CHECK.~~ Migration 007: `CHECK (work_date GLOB '????-??-??')`.
- [x] ~~`compensation_rows.hours_per_year = 0` divide-by-zero.~~ Migration 007: `CHECK (hours_per_year > 0)`.
- [x] ~~Audit-log filter facets rebuild from filtered results.~~ Fixed: module-level `universeFacets` cache in `public/admin/audit.js` keeps the unfiltered facet set across renders.
- [x] ~~Evidence detail shows `user #{id}` as a raw ID.~~ Line dropped (the audit-log section of the detail panel already shows actor names).
- [x] ~~"Locked" label collapses three states.~~ Fixed: `lockReason(entry)` helper in `public/api.js` returns `'approved' | 'period closed' | null`. Server adds `period_status` to labour/expense list endpoints. Unit-tested.
- [ ] [P3] **CSV / MD / PDF export shapes differ.** `toCsv` emits one row per *category* per project (labour, materials, contract, third_party_payment, overhead, project_total); `toMarkdown` and `toPdf` iterate `labour_worksheet` and `expense_lines` row-by-row. Probably intentional (CSV is for accountant rollups) but someone diffing outputs across formats will be confused. Document the contract or normalize.
- [ ] [P3] **`refresh.js` follow-ups** (flagged by V-03 agent): `last_used_at` column is effectively dead (set in same UPDATE that revokes), `mintRefreshToken` never prunes expired siblings (unbounded growth over years), expired-vs-deactivated error messages differ slightly (minor enumeration vector).
- [ ] [P3] **`route-helpers.js` subtleties** (flagged by test agent): `resolveUserClaimant` rejects stringified ints (tight contract); `assertEditable` silently no-ops if the period row is missing; `isOwnerOrAdmin` swallows missing-uc into `false` (callers must not use it as a not-found signal).
- [ ] [P3] **Content-sniff MIME on evidence uploads.** Allowlist verifies the multipart-supplied MIME, but a `.html`-content file with `Content-Type: application/pdf` still slips through (and now lands on disk as `.pdf`, worse for an admin double-clicking the bundle locally). Add magic-byte detection (`file-type` library) as a follow-up.
- [ ] [P3] **Admin can invite themselves** via `/api/users/:id/invite`; no second-admin countersignature. `audit()` for invite also doesn't record `before/after` so the audit row hides the target identity.

## UI: missing / partial use cases

Distilled from [UI_USE_CASE_AUDIT.md](UI_USE_CASE_AUDIT.md). Use-case IDs reference `docs/use-cases.md`.

- [ ] [P1] **UC-R1 — Review queue scoping + bulk approve.**
  - [ ] Render employee name + project title in the queue (currently raw IDs). The labour/expense list endpoints already join through `user_claimants` for some routes — extend consistently.
  - [ ] Replace `prompt()` for rejection reason with an inline textarea + Cancel/Submit.
  - [ ] Add row checkboxes + a "select all visible" header + an "Approve / Reject selected" action bar.
  - [ ] Add per-claimant scope ← blocked by hoist step 2 (selection plumbing).
  - [ ] Add period / project / employee filters.
- [ ] [P1] **UC-E4 — Employee dashboard period + claimant scope.**
  - [ ] Add a claimant column on labour / expense / evidence tables (multi-claimant employees can't filter without it).
  - [ ] Add a period selector + per-period totals row on the activity tab.
- [ ] [P2] **UC-A4 — Project narrative revision viewer.**
  - [ ] List prior revisions on the project detail page (date, reviser, title at the time).
  - [ ] Click-to-view a revision (read-only side panel or modal).
  - [ ] *(optional)* Diff against current — only if list+view is shipped and proves valuable.
- [ ] [P2] **UC-A3 — Employee onboarding: look-up-by-email.**
  - [ ] On Add-employee submit, look up existing user by email; if found, switch the form to "attach to claimant" mode (asks for the per-claimant fields only).
  - [ ] Add title + employment start date fields to the initial form (currently only collected post-hoc).
  - [ ] Surface the cross-claimant attachment path from a top-level button on the Employees tab, not just via the edit-user drill-in.
- [ ] [P3] **UC-R2 — Comparative two-period export.** Side-by-side T661 export across two periods (alt flow R2.b).

## UI: usability

Distilled from [UI_USABILITY_REVIEW.md](UI_USABILITY_REVIEW.md). Top-impact items first.

- [ ] [P1] **Hoist active-claimant selector into page header.** Currently only on the Projects tab; Overview / Review / Audit silently aggregate across all claimants while other tabs are per-claimant scoped.
  - [ ] Step 1: move selector visually into the header. Behaviour identical — only the Projects tab consults it, like today. Shippable on its own.
  - [ ] Step 2: persist selection (localStorage + a tiny `state.activeClaimantId` source of truth) and add an "All claimants" sentinel. ← blocked by step 1.
  - [ ] Step 3: scope the Review tab to the selection (highest user-visible value). ← blocked by step 2.
  - [ ] Step 4: scope Audit and Overview tabs; handle deleted-claimant fallback. ← blocked by step 3.
- [ ] [P1] **Dollar inputs, not cent inputs.** People are typing `9500000` for $95k salaries.
  - [ ] Build a shared `<dollar-input>` helper (vanilla — a small wrapper around `<input type="number" step="0.01">`) that emits the cents value on form submit.
  - [ ] Apply to admin Employees forms (Add employee, Add comp row, Edit comp).
  - [ ] Apply to admin on-behalf expense form (`renderLogOnBehalfCards`).
  - [ ] Apply to employee Submit-expense form and the inline activity edit-expense form.
- [x] ~~**Confirmation dialog before "Close period".**~~ Native `confirm()` with the date range, the three row counts (labour / expenses / evidence), and the consequence wording. Reopen stays unconfirmed.
- [x] ~~**First-run empty state on Overview.**~~ When `state.claimants.length === 0` the body becomes a 5-step getting-started checklist with anchor links into the relevant tabs.
- [ ] [P2] **Errors as inline banners, not `alert()`.**
  - [ ] Build a shared banner helper (one CSS class + a `showError(cardEl, message)` function in `public/api.js`).
  - [ ] Replace `alert(e.message)` in `onSubmit` (the shared form helper) — fixes most sites at once.
  - [ ] Replace the remaining ad-hoc `alert()` call sites (search for `alert(` across `public/`).
- [ ] [P2] **Invite-link UX.** Replace `alert()` with a modal: copy-to-clipboard button, relative expiry, "Sent to <email>" indicator when SMTP is configured.
- [ ] [P2] **Tooltips for jargon.** Hover help on "Specified employee", "SR&ED method" (proxy vs traditional), "Comp type", "Reporting currency".
- [ ] [P2] **Mobile-friendly tables.**
  - [ ] Wrap every `<table>` in `overflow-x: auto` (one CSS class applied via a small DOM pass or just in `style.css`).
  - [ ] Add a `hide-on-narrow` class and apply it to non-essential columns; CSS hides them under 600px.
  - [ ] Polish the employee tabs specifically (Log labour, Submit expense, Add evidence) — they're the actual phone-relevant flows.
- [x] ~~**Auto-approve visual indicator.**~~ On-behalf labour and expense forms now show a `pill.approved` note: "As an admin, this entry will be saved as approved and skip the review queue."
- [x] ~~**Distinguish "locked" reasons.**~~ Replaced by `lockReason(entry)` returning `'approved' | 'period closed' | null`; `lockPill()` in `public/employee/activity.js` renders distinct pills.
- [ ] [P3] **Search-bar discoverability.** Rename placeholder to "Jump to project or employee…", add a "See all projects" overflow link.
- [x] ~~**Disabled+spinning state on "Build" evidence package.**~~ Click handler in `public/admin/exports.js` now disables the button and swaps the label to "Building…" while the POST is in flight; restores on error (success re-renders the row to a download link).
- [ ] [P3] **Loading vs empty-state distinction.** Currently both render `<p class="empty">…</p>`. Pick distinct copy or classes.
- [ ] [P3] **Hash-route key alignment.** `#claimants` is labeled "Projects" and `#users` is labeled "Employees". Either rename keys to match labels (with a redirect from the legacy hash) or rename labels to match keys.
- [ ] [P3] **Standardize form button labels.** "Save" / "Save changes" / "Create project" / "Generate" vary across forms. Pick a consistent verb-object pattern.
- [x] ~~**`fiscal_period_id` as a number** in the Exports list.~~ Exports table now shows `start_date → end_date` via a client-side lookup against `state.periods` (already loaded for the active claimant).

## Tests to add

- [x] ~~`lib/route-helpers.js`~~ (21 tests)
- [x] ~~`auth/refresh.js`~~ (9 tests, covering V-03 family-revoke behaviour)
- [x] ~~`auth/jwt.js`~~ (7 tests)
- [x] ~~`lib/wage-caps.js`~~ (6 tests)
- [ ] [P3] **Route-level integration tests** for the high-value paths.
  - [ ] Close-period blocks subsequent edits on labour/expense/evidence in that period.
  - [ ] T661 export round-trip: seed → POST `/api/exports/t661` → GET `/api/exports/:id/download?format=...` for all four formats.
  - [ ] Audit-log writes on every mutating endpoint (parameterized — table-driven test).

## Refactoring

- [x] ~~`scripts/seed-data.js` hardcoded IDs.~~ Replaced with email-keyed user/uc lookups and a derived admin/period lookup. Exits with a useful message if any prerequisite is missing.
- [ ] [P3] Route handlers all follow the same "load before → mutate → load after → audit" shape. Once one more handler is added, factor into a helper (`auditUpdate(table, id, mutator)`).
- [ ] [P3] **Split `public/api.js`** (~526 lines mixing concerns). Do when it next needs a non-trivial edit; otherwise defer.
  - [ ] Extract session storage + `setSession` / `clearSession` into `public/session.js`.
  - [ ] Extract `api`, `apiUpload`, refresh-on-401 into `public/fetch.js`.
  - [ ] Extract DOM helpers (`esc`, `cents`, `$`, `$$`, `safeHref`, `onSubmit`, `bindForm`) into `public/dom.js`.
  - [ ] Extract the per-feature renderers (`activityHtml`, `wireActivityDetails`, `renderPreferencesPage`, etc.) into per-feature files.
- [ ] [P3] CSS is inconsistent — some utility classes, some inline styles, some per-form one-offs. Pick a single approach for new code.
- [ ] [P3] Inline SQL is fine at this scale, but if the schema keeps growing, a thin `repositories/` layer would make handlers more testable.
- [ ] [P3] Three different "new X" form patterns coexist (toggle-card, inline-expansion, separate page). Pick one.

## Security

Tracked in [VULNERABILITY_REVIEW.md](VULNERABILITY_REVIEW.md). Latest audit: 0 critical, 2 high, 5 medium, 4 low/info (11 findings). High-priority items below; full evidence + fix suggestions in the report.

- [x] ~~**V-01 (High) Stored XSS via `javascript:` URLs in evidence link items.**~~ Fixed: scheme allowlist (`http:`/`https:`/`mailto:`) on both write (`src/routes/evidence.js`) and render (`safeHref` in `public/api.js`, applied at the three render sites).
- [x] ~~**CSP header.**~~ Middleware in `src/lib/csp.js` ships `Content-Security-Policy` on every response: bans inline scripts and `javascript:` URIs, allows jsdelivr (for `@simplewebauthn/browser`) and Google Fonts. Verified via `curl -I /`.
- [x] ~~**V-02 (High) Default `JWT_SECRET=change-me` boots without complaint.**~~ Fixed: `src/config.js` now rejects known weak values and enforces ≥32 chars at startup. `.env.example` replaced the placeholder with `__REPLACE_WITH_RANDOM_HEX_AT_LEAST_32_CHARS__`.
- [x] ~~**V-03 Refresh-token family revocation.**~~ Replay revokes all sibling tokens in a transaction and writes a `refresh_replay_detected` audit row.
- [x] ~~**V-04 Rate limiting.**~~ `express-rate-limit` on login/register/recovery/refresh/invite — see `src/lib/rate-limit.js`. 429s use the standard error shape.
- [x] ~~**V-05 Evidence MIME allowlist.**~~ PDF / common images / text-family / Office docs / zip only. Stored extension normalised from MIME, never from `originalname`.
- [x] ~~**V-06 Invite response no longer leaks magic-link.**~~ Body is `{ user_id, purpose, expires_at, delivered }`.
- [ ] [P3] **V-07 (Low) Single-origin WebAuthn `expectedOrigin`** — hardening only; accept a frozen array if multi-tunnel deployment is anticipated.
- [x] ~~**V-08 `audit_log` append-only triggers.**~~ Migration 008.
- [x] ~~**V-09 Stale WebAuthn challenges reaped.**~~ `storeChallenge` now deletes expired rows on each call.
- [x] ~~**V-10 `nodemailer` bumped to ^8.0.7.**~~ `npm audit --omit=dev` clean.
- [ ] [P3] **V-11 (Low) Refresh token in `localStorage`; JWT in `sessionStorage`.** XSS exfiltration risk; CSP now mitigates. Long-term: move refresh to `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/auth/refresh`.

## Docs to update

The UI use-case audit found these features in the SPA without a corresponding entry in `docs/use-cases.md`. Each is "decide: document it as a UC, or drop it from the UI."

- [ ] [P3] **Global search bar** (admin top nav) — useful, just unmodeled.
- [ ] [P3] **Overview dashboards** (admin + employee) — this-week chart, recent activity feed. Cross-cuts UC-E4 / UC-R1 but is its own surface; consider an explicit "at-a-glance dashboard" UC.
- [ ] [P3] **User deactivate / reactivate** — lifecycle action absent from UC-A3 (which only covers onboarding). Either extend A3 or add an offboarding UC.
- [ ] [P3] **Project `type` (sred/internal) and `phase` (concept/development/complete)** — present on the project form, not in UC-A4. Either document or drop.
- [ ] [P3] **Log labour on behalf** (admin → project detail). Alt flow E3.a covers the expense case; there's no equivalent in UC-E1 for labour. Add or remove.
- [ ] [P3] **Overtime flag** on labour entries. Surfaced on the form but absent from UC-E1; also unclear how it interacts with the T661 labour cost calc in UC-R2.
- [ ] [P3] **Project manager assignment** (`manager_user_id`) — not in UC-A4.
- [ ] [P3] **Audit-log tab** — §5 cross-cutting requirement only says actions are logged, not that there's a dedicated UI. The UI is fine; just confirm it's intentional and document.

## Done

- [x] **UI use-case audit** — see [UI_USE_CASE_AUDIT.md](UI_USE_CASE_AUDIT.md). 8 of 12 use cases fully reachable, 4 partial, 0 missing; action items distilled into "UI: missing / partial use cases" above.
- [x] **UI usability review** — see [UI_USABILITY_REVIEW.md](UI_USABILITY_REVIEW.md). Top 10 ranked recommendations + detailed findings by category; action items distilled into "UI: usability" above.
- [x] **Vulnerability review** — see [VULNERABILITY_REVIEW.md](VULNERABILITY_REVIEW.md). 11 findings tracked in "Security" section above.
- [x] **Unit tests for `lib/format.js`** — 9 tests added.
- [x] **Unit tests for `auth/tokens.js`** — 10 tests added, uncovered a real purpose-enforcement gap (tracked in "Correctness / bugs" above).
