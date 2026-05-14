# Documentation accuracy review

_2026-05-14, against branch `master`, commit `d533fc3`_

## Summary

Rough drift score by document (counting *claims that contradict the code*, not stylistic gaps):

| Doc | Severity | Approx. contradicting claims |
| --- | --- | --- |
| `README.md` | small | 2 (Project layout omits files, one prose claim about narrative versioning fields) |
| `docs/use-cases.md` | medium | ~5 (status values, missing employee role and entities, retention semantics) |
| `docs/data-model.md` | large | ~10 (missing two tables, missing five columns, wrong status enum, false retention claim) |
| `docs/api.md` | large | ~25 (wrong path prefixes, missing endpoints, stale enums, missing payload fields, missing query params) |
| `docs/auth.md` | medium | ~4 (no JWT-refresh, no rate-limit, no V-07 multi-origin, no V-02 secret enforcement, no V-08 audit triggers) |

Overall: the docs were written before migrations 003-012 and most security/UX hardening landed. `docs/api.md` and `docs/data-model.md` are the worst-drifted; `README.md` is the best.

## Findings by document

### README.md

- **"Project layout" omits files that exist.** The block lists `src/lib/audit.js`, `email.js`, `errors.js`, `t661.js`, `format.js`, `wage-caps.js`. Missing: `src/lib/csp.js` (CSP middleware), `src/lib/rate-limit.js` (per-route limiters), `src/lib/random.js` (`randomToken` / `sha256`), `src/lib/route-helpers.js` (`getProject`, `findOpenPeriod`, `resolveUserClaimant`, `assertEditable`, …). It also doesn't mention `src/auth/refresh.js` (which is listed in `auth/` but the README's auth section doesn't describe it). The `scripts/` directory exists (`seed-admin.js`, `seed-etc.js`, `seed-data.js`) but is missing from the layout block — though the seed scripts table on line 34 covers them, so this is borderline.
- **Notable patterns / "Revision-versioned narratives."** Lists "title / narrative / type / phase / manager" as the snapshot trigger. `phase` was dropped in migration 011 (`projects.phase` no longer exists). `projects.js:11` `SNAPSHOT_FIELDS` is `['title', 'field_of_science', 'advancement_sought', 'uncertainties', 'work_performed', 'type', 'manager_user_id']` — no `phase`.
- **Public layout — `admin.js` description.** Says "admin SPA (overview, projects, employees, review, exports, audit log)". Accurate, but the SPA actually splits into `public/admin/{overview,projects,employees,review,exports,audit}.js` modules; the comment-style description is fine but the layout block doesn't show the `admin/` and `employee/` subdirectories.
- **Quick start.** End-to-end correct as of the latest seed-etc bootstrap (matches recent commit `3f62f19`).
- **Scripts table.** Accurate. `npm test` is in `package.json` but not in the README's table — minor omission.
- **Environment table.** Matches `.env.example`. ORIGIN can now be comma-separated; the README mentions "pin one tunnel domain" but doesn't mention multi-tunnel support (V-07 change). Minor.

### docs/use-cases.md

- **Actors section omits the `manager` role.** §2 lists Admin and Employee only. The users table accepts `role IN ('admin', 'manager', 'employee')` (migration 004). Manager only acts as a project-assignment target today (UC-A8 draft); the `manager` role row in `users.role` is otherwise inert, but the actors list should at least acknowledge it exists.
- **Project status enum is stale.** §4 UC-A4 step 3: "planned / active / completed". Migration 011 renamed these to `concept / development / complete`. Same wording shows up in `data-model.md` (see below).
- **`SR&ED Project` entity description omits `type`.** §3 says "Carries the technical narrative … plus a start/end date and status." Doesn't mention `type` (`sred`|`internal`), which materially affects whether the project appears in T661 totals (migration 003; verified by `src/lib/t661.js` filtering `WHERE type = 'sred'`). This is the same point the draft UC-A7 makes.
- **Cross-cutting "Evidence retention" claim is overstated.** §5: "All labour, evidence, and expense records … are retained for at least 6 years … Deletion before that horizon is blocked." The code only blocks deletion *within a closed period* (`routes/evidence.js:343-346`, `routes/labour.js:assertEditable`, `routes/expenses.js:assertEditable`). There is no 6-year clock anywhere. Open-period rows are deletable immediately. The closed-period rule + the admin's discipline about closing periods is the only safeguard.
- **§7 Decisions: "Evidence retention — 6 years following the end of the fiscal year in which records were filed. Deletion is blocked within that window."** Same overstatement as above.
- **Cross-cutting "Specified employee wage cap" — accurate.** Hardcoded per calendar year in `src/lib/wage-caps.js`. Matches what the doc claims.
- **Cross-cutting "Audit log everywhere" — accurate**, and now better than before: migration 008 added triggers that make `audit_log` append-only at the DB level (no UPDATE/DELETE possible). Worth mentioning in the doc.
- **The eight drafts in `docs/use-cases-drafts.md` correctly cover the missing flows** (deactivate/reactivate, type+phase — now type-only, project manager, audit-log viewer, overview dashboards, overtime flag, log-on-behalf, search). Three notable corrections needed in those drafts:
  - UC-A7 should be re-read as "type only" — `phase` is gone (migration 011). The drafts file's own §"Notable corrections" acknowledges this.
  - UC-A6 reactivate is still incomplete — `user_claimants` rows that match `deactivated_with_user_id = userId` are restored, others are not (migration 012 added the marker column; reactivate uses it).
  - UC-E6 overtime is purely a marker; no calc consumes it. Confirmed.

### docs/data-model.md

This doc has the largest drift. The schema block is the snapshot at migration 001 only.

- **Missing table `webauthn_challenges`** (migration 001). It is a real schema table; not in §Auth.
- **Missing table `refresh_tokens`** (migration 005, columns updated in 010). Not described anywhere. Should be in §Auth, with the note that `last_used_at` was dropped in 010.
- **`users.role` enum stale.** Doc says `role ∈ { admin, employee }`. Migration 004 widened it to `{ admin, manager, employee }`.
- **`fiscal_periods` — accurate.**
- **`user_claimants` missing two columns.**
  - `employment_start_date` (migration 009).
  - `deactivated_with_user_id` (migration 012).
- **`compensation_rows` missing column.** `effective_until TEXT` (migration 007). Also missing the `CHECK (hours_per_year > 0)` (007).
- **`projects` schema is stale in three ways.**
  - Missing `type TEXT NOT NULL DEFAULT 'sred' CHECK (type IN ('sred','internal'))` (migration 003).
  - Missing `manager_user_id INTEGER REFERENCES users(id)` (migration 004).
  - `status` enum shown as `('planned', 'active', 'completed')`; actual is `('concept', 'development', 'complete')` (migration 011).
- **`project_revisions` missing columns.** Should have `type` and `manager_user_id` (migrations 003 and 004; 003 added `phase` too but 011 dropped it).
- **`labour_entries` missing column.** `is_overtime INTEGER NOT NULL DEFAULT 0 CHECK (is_overtime IN (0,1))` (migration 006). Also missing the `CHECK (work_date GLOB '????-??-??')` (007).
- **`audit_log` description omits append-only triggers.** Migration 008 adds `audit_log_no_update` and `audit_log_no_delete` triggers. Worth a one-line note next to the CREATE TABLE.
- **Indexes block — out of date.** Doc lists `idx_pa_project`, `idx_uc_user`, etc. (matches 001). Migration 005 added `idx_refresh_tokens_user` and `idx_refresh_tokens_hash`; migration 007 recreates `idx_labour_*` (same names) after the table rebuild. Not contradictions per se, but the refresh-token indexes are unmentioned.
- **Design notes — false retention claim.** Last bullet: "Retention is enforced in the delete paths (block hard delete of labour/evidence/expense within 6 years of the containing fiscal year's end)." The code only blocks deletion in closed periods; there is no 6-year check. Match this to whatever you change in `use-cases.md` §5.
- **Entity overview diagram** at top — claimant ←< t661_exports is correct; doesn't include refresh_tokens or webauthn_challenges (consistent with the missing-tables omission above).
- **`expenses.fx_rate` comment "→ reporting currency; null when currency matches" is accurate** and matches the TODO line about the FX semantics being documented in `t661.js`.

### docs/api.md

This is the most-drifted doc; numerous endpoints and shapes are off. Group by section:

**Auth table (§Auth):**
- **Wrong path prefix on three rows.** `/api/auth/recovery`, `/api/auth/me`, `/api/auth/logout` are documented; actual paths are `/api/recovery`, `/api/me`, `/api/logout` (the auth router is mounted at `/`, with only `/auth/refresh` nested under `/auth`). Easy fix.
- **Missing endpoint: `POST /api/auth/refresh`** — the rotating-refresh endpoint. Body `{ refresh_token }`; returns `{ token, refresh_token, refresh_expires_at }`. Critical for client behaviour (the "fetch wrapper with refresh-on-401" pattern in `public/api.js`).
- **Missing endpoint: `GET /api/activity`** — recent activity feed (used by overview dashboards). Query: `?limit=&project_id=&claimant_id=&user_id=`.
- **Missing endpoints: `GET /api/me/credentials`, `DELETE /api/me/credentials/:id`** — passkey self-management.
- **Missing endpoint: `GET /api/me/projects`** — drives the employee project picker.
- **Missing endpoint: `GET /api/me/periods`** — fiscal periods for the caller's attached claimants; backs the employee My-activity period selector.
- **`register/finish` response shape isn't shown.** It returns `{ user, token, refresh_token, refresh_expires_at }`. Same for `login/finish`.

**Users (§Users):**
- **`POST /api/users` body missing fields.** Actual: `attachments[*]` accepts `employment_start_date` (migration 009). Doc omits it.
- **Missing endpoint: `POST /api/users/:id/deactivate`** — flips `users.status='disabled'` and bulk-marks `user_claimants.status='inactive'` with `deactivated_with_user_id` set.
- **Missing endpoint: `POST /api/users/:id/reactivate`** — symmetric, restores only the attachments marked by `deactivated_with_user_id`.
- **Missing endpoint: `POST /api/users/:id/invite`** — mints a magic-link invite or add-device token. Rate-limited. Response: `{ user_id, purpose, expires_at, delivered }`. Notably: the doc would need to call out that the raw link is **not** in the response (V-06 hardening).
- **`GET /api/users` query params.** Doc shows `?role=&claimant_id=&status=`; actual code also accepts `q=` (substring search across name + email). Missing.
- **`PATCH /api/user-claimants/:id` body missing field.** Actual: also accepts `employment_start_date`.

**Claimants (§Claimants):**
- **`PATCH /api/claimants/:id` body missing fields.** Actual: also accepts `fiscal_year_end_month` and `fiscal_year_end_day` (with the same 1-12 / 1-31 checks as POST).

**Projects (§Projects):**
- **`POST /api/claimants/:id/projects` body missing fields.** Actual: also accepts `type` (`sred`|`internal`, default `sred`) and `manager_user_id` (validated as admin|manager + active).
- **Project `status` enum stale.** Doc body says `status`; actual must be one of `concept|development|complete` (was `planned|active|completed`). Worth listing the enum inline.
- **`PATCH /api/projects/:id` body shape.** Doc just says "Editing narrative fields creates a `project_revisions` row." Actual `EDITABLE_FIELDS` = `[title, field_of_science, advancement_sought, uncertainties, work_performed, type, manager_user_id, start_date, end_date, status]`; the snapshot trigger fires when any of the first seven changes.
- **`GET /api/projects` (no `:id`) missing from table.** Code has it: lists projects globally with `?q=&limit=` (drives the search bar). Doc shows only the nested `GET /api/claimants/:id/projects`.

**Fiscal periods (§Fiscal periods):**
- **Accurate** for close/reopen, nested list/create. Doc doesn't mention that there's no `DELETE`, which is fine (close/reopen are the only mutations).

**Labour (§Labour):**
- **`POST /api/labour` body missing field.** Accepts `is_overtime` (boolean, default false) — migration 006.
- **`POST /api/labour` admin-self-approve behaviour undocumented.** When the actor is an admin, the entry lands as `status='approved'` with `reviewed_by_user_id=actor`. Important for callers building admin tooling.
- **`POST /api/labour/bulk-approve` body shape claim is partly wrong.** Doc says "`{ ids: [...] }` or `{ filter: { project_id, period_id, ... } }`". Actual code only supports `{ ids: [...] }` (filter mode was never implemented or has been removed). See `routes/labour.js:206`.
- **`GET /api/labour` query params missing.** Actual also accepts `claimant_id` (review-queue scope filter). The doc shows `project_id|period_id|user_claimant_id|status|from|to`; add `claimant_id`. Response rows now also include `period_status`, `project_title`, `user_name`, `user_email`, `claimant_name` — none of these are mentioned.

**Expenses (§Expenses):**
- **`GET /api/expenses` query params missing.** Actual also accepts `claimant_id` and `category` (the doc says "same filters as labour" which covers `claimant_id` once labour is fixed, but `category` is genuinely separate).
- **Missing endpoint: `DELETE /api/expenses/:id`** — exists in `routes/expenses.js:183`, with the same closed-period / owner-or-admin gates as labour. Not in the doc.
- **`POST /api/expenses` body should list `user_claimant_id`** as an admin-only override (admin "log on behalf" path). Mirrors labour.
- **Admin-self-approve behaviour undocumented**, same as labour.

**Evidence (§Evidence):**
- **Doc claim "Blocked inside the 6-year retention window" is wrong.** Code blocks `DELETE /api/evidence/:id` only when the parent `fiscal_period.status='closed'`; no 6-year check.
- **Missing endpoint: `PATCH /api/evidence/:id`** — caption / evidence_date / url (for link kind) / note_text (for note kind). Re-buckets fiscal_period when date moves.
- **MIME validation behaviour undocumented.** The route does content-sniffing (V-05). Worth a note: "uploads are content-sniffed against an allowlist; HTML-pretending-to-be-PDF rejects." Bonus: the on-disk extension is normalised to the detected MIME.

**Employee dashboard (§Employee dashboard):**
- **`GET /api/me/summary` does not exist.** This is the most flagrant entry — the doc invents an endpoint that has no implementation. The closest real endpoints are `/api/me`, `/api/me/projects`, `/api/me/periods`, and `/api/activity` (under §Auth in the actual code). Either drop the row or describe what the SPA actually does (combine those four).

**T661 export (§T661 export):**
- **Missing endpoints (UC-R2 alt R2.b comparative export):**
  - `POST /api/exports/t661/compare` — body `{ claimant_id, period_a_id, period_b_id }`, returns `{ a, b, diff }`. Ephemeral, not persisted.
  - `GET /api/exports/compare/download?claimant_id=&period_a=&period_b=&format=json|csv|md|pdf`.
- **`POST /api/exports/t661` response shape.** Code returns `{ ...exportRow, totals }`. Doc just says "creates a `t661_exports` row, returns id" — totals_json, project_revisions_json, evidence_manifest_json, generated_by_user_id all present.
- **Wage cap mention accurate** — the §"T661 totals computation" pseudocode matches `src/lib/t661.js`.

**Conventions (§Conventions):**
- **"Pagination: list endpoints return `{ items, next_cursor? }`. Default page size 50."** Misleading. No endpoint implements cursor pagination in current code. List endpoints return `{ items }` only; some accept `limit=` but none emit `next_cursor`. Either implement or drop the claim.

### docs/auth.md

- **No mention of rotating refresh tokens.** The whole `refresh_tokens` table and the `POST /api/auth/refresh` ceremony is absent. This is the bulk of the warm-start UX and the V-03 family-revocation hardening; needs a §"4.5 Refresh-token rotation" or similar.
- **No mention of rate limiting (V-04).** `src/lib/rate-limit.js` wraps webauthn / recovery / refresh / invite endpoints. Worth a sentence in §"Implementation gotchas" or its own decision row.
- **No mention of `JWT_SECRET` enforcement (V-02).** Doc says "JWT in memory (or sessionStorage), short-lived (~1h). Payload is minimal: `{ userId, role }`." Should add: secret rejected at startup if < 32 chars or one of a banned-weak set (`change-me`, `secret`, `password`, …). The payload claim is also slightly inaccurate: actual keys are `uid` and `role` (with `iss: 'sred'`, `sub: <user-id>`), not `userId`.
- **No mention of multi-origin support (V-07).** Doc says "RP_ID is baked into every credential. Pin one tunnel domain for the day." The actual `config.origins` is a comma-split list and `verifyRegistrationResponse`/`verifyAuthenticationResponse` are called with the array (`expectedOrigin: config.origins`). RP_ID is still single; the doc's claim is still partly true (RP_ID single) but the implication that ORIGIN is single is wrong.
- **No mention of `audit_log` append-only triggers (V-08)** — relevant because the refresh-replay handler relies on a single transaction across `refresh_tokens` UPDATE + `audit_log` INSERT.
- **WebAuthn challenge storage table omitted.** The doc's §Tables block lists `users`, `credentials`, `email_tokens` only; `webauthn_challenges` (migration 001) exists and is mutated by `storeChallenge`/`consumeChallenge` in `src/auth/webauthn.js`. Same omission as in `data-model.md`.
- **"`credentials.counter` is bumped on each authentication"** — accurate.
- **"counter regression → reject the assertion and flag the credential"** — partly accurate. `finishLogin` throws `unauthorized('counter regression — possible cloned authenticator')`. There is no "flag the credential" persistence today.
- **§"Implementation gotchas" / "JWT storage"** — says JWT goes to sessionStorage (matches code). Doesn't mention refresh tokens live in `localStorage` (matches V-11, tracked as a low-priority known issue).
- **§"1. First admin" CLI snippet says "no SMTP wired at this stage"** — accurate, but the seed-admin script does now route through `sendMagicLink` which logs to stderr when SMTP is disabled. Worth a small clarification.

## Recommended actions

Concrete edits ranked by impact (high → low; agent did not make any of these):

1. **`docs/api.md` — fix the auth path prefix.** Three rows refer to `/api/auth/...` for endpoints that are actually at `/api/...`. Fix `/api/auth/me`, `/api/auth/logout`, `/api/auth/recovery`. *(2-minute edit; reader-blocking.)*
2. **`docs/api.md` — add `POST /api/auth/refresh`** with body and response shape. *(Critical for any third-party integrator.)*
3. **`docs/api.md` — drop or rewrite `GET /api/me/summary`.** It does not exist. Replace with the four real `/api/me*` and `/api/activity` endpoints.
4. **`docs/data-model.md` — add `refresh_tokens` and `webauthn_challenges` tables.** Note migration 010's drop of `refresh_tokens.last_used_at` next to the CREATE.
5. **`docs/data-model.md` — update `projects` table.** Add `type`, `manager_user_id`; replace `status` enum (`planned|active|completed` → `concept|development|complete`). Same enum fix in `docs/api.md` and `docs/use-cases.md` UC-A4 step 3.
6. **`docs/data-model.md` — update `users.role` enum** to include `manager` (migration 004). Add a one-liner about the role.
7. **`docs/data-model.md` — add `is_overtime` to `labour_entries`**, plus the `work_date GLOB` CHECK (007). Add `employment_start_date` and `deactivated_with_user_id` to `user_claimants`. Add `effective_until` and the `hours_per_year > 0` CHECK to `compensation_rows`.
8. **`docs/data-model.md` and `docs/use-cases.md` — correct the "6-year retention" claim.** Replace with the actual rule (closed-period blocks deletion). Either implement a real 6-year clock or drop the cross-cutting requirement to match.
9. **`docs/api.md` — add the missing endpoints** in order of importance:
   - `POST /api/users/:id/deactivate`, `.../reactivate`, `.../invite`.
   - `POST /api/users/:id/attachments`.
   - `DELETE /api/expenses/:id`, `PATCH /api/evidence/:id`.
   - `POST /api/exports/t661/compare`, `GET /api/exports/compare/download`.
   - `GET /api/activity`, `GET /api/me/credentials`, `DELETE /api/me/credentials/:id`, `GET /api/me/projects`, `GET /api/me/periods`.
   - `GET /api/projects` (global with `?q=&limit=`).
10. **`docs/api.md` — refresh existing endpoint bodies** for fields the doc misses: `is_overtime` on labour POST, `type`/`manager_user_id` on project POST, `employment_start_date` on user attachments, `fiscal_year_end_*` on claimant PATCH, `claimant_id` and `category` query params on the list endpoints, the bulk-approve `filter` mode (drop the claim — it does not exist), and the admin auto-approve behaviour on labour/expense POST.
11. **`docs/api.md` — correct retention claim on `DELETE /api/evidence/:id`** (closed-period only, no 6-year window).
12. **`docs/api.md` — drop or implement the pagination claim.** `{ items, next_cursor? }` is documented but no endpoint emits a cursor.
13. **`docs/auth.md` — add §"Refresh-token rotation"** (consume = rotate, replay = revoke family + audit). Add notes for V-02 (secret enforcement), V-04 (rate limiting), V-07 (multi-origin), V-08 (append-only triggers). Add the `webauthn_challenges` table. Correct the JWT payload claim (`uid` not `userId`).
14. **`docs/use-cases.md` — add the `manager` role to §2 Actors** (one sentence). Add `type` to the SR&ED Project entity description in §3.
15. **`README.md` — add `src/lib/csp.js`, `rate-limit.js`, `random.js`, `route-helpers.js` to the Project layout**; remove `phase` from the "Notable patterns / Revision-versioned narratives" bullet; mention `public/admin/*` and `public/employee/*` subdirectories.
16. **`docs/use-cases-drafts.md` — re-read UC-A7 as type-only** (the file already notes this in its §"Notable corrections"; the body of UC-A7 still describes phase as a working field).
