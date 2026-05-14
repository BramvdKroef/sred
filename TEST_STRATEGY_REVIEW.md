# Test strategy review

_2026-05-14, against branch `master`, commit `d533fc3`_

## Summary

**Total tests: 235** across 32 test files (counted as top-level `test(` / `it(` callsites). Distribution:

| Category | Files | Tests |
|---|---:|---:|
| `tests/lib/` (pure logic) | 5 | 73 |
| `tests/auth/` (auth modules) | 4 | 37 |
| `tests/public/` (SPA helpers) | 7 | 60 |
| `tests/routes/` (HTTP integration) | 14 | 62 |
| `tests/server/` (CSP, rate limit) | 2 | 4 |
| `tests/db/` (schema-level triggers) | 1 | 1 |

**Headline gap.** Authentication ceremony plumbing (the WebAuthn finish handlers, the magic-link enrollment flow end-to-end), the multipart evidence upload route's failure paths (size limit, disk failure, malformed body), and `src/auth/middleware.js` itself are exercised only as side effects of higher-level integration tests. The middleware is the single chokepoint protecting every mutating endpoint — there is no negative-path test for it (missing/expired/bad token, deactivated user, role mismatch on a non-admin route). That is the single highest-impact untested surface in the codebase.

A secondary gap: there are essentially zero negative-authz tests at the route layer. The `route-helpers` unit suite proves the building blocks (resolveUserClaimant, isOwnerOrAdmin) behave correctly in isolation, but no integration test attempts a cross-tenant `PATCH /api/labour/:id` as an employee attached to claimant A against a labour row owned by claimant B — the assertion that the building blocks are actually wired in correctly at every route. Same for `GET /api/projects/:id`, `GET /api/users/:id`, `GET /api/evidence/:id/download`, etc.

## Coverage map

`L` = direct unit test that imports the module; `R` = exercised by HTTP integration; `T` = touched (transitive — runs as a dependency of another covered module but has no test asserting its behaviour); `—` = untested.

| `src/` module | Class | Coverage |
|---|---|---|
| `src/server.js` | — | Not booted by any test; the API router is mounted into ad-hoc express apps. CSP middleware tested separately. |
| `src/config.js` | R | Origin parsing covered (`webauthn-origins`); SMTP config, TTL parsing, banned-JWT-secret guard not directly asserted. |
| `src/db/index.js` | T | Indirectly exercised by every test via the helper. No test asserts WAL mode / FK pragma. |
| `src/db/migrate.js` | T | Runs on every test as a side effect. No assertion on migration idempotency, no roundtrip-over-populated-data test, no test that migrations are applied in order. |
| `src/db/migrations/*.sql` | T | Same as above; migration 008 has a dedicated test (audit-log append-only), the other 11 do not. |
| `src/auth/jwt.js` | L | **Well covered.** Sign/verify, expiry, wrong-secret, wrong-issuer, malformed, empty, payload-leak. |
| `src/auth/middleware.js` | — | **Critical untested.** Used by every protected route. No test for: missing Bearer, malformed Bearer, expired token, bad signature, valid token but deactivated user, `requireAdmin` rejecting non-admin. |
| `src/auth/refresh.js` | L | **Well covered.** mint/consume/revoke, replay-detection family revoke, audit row, unified error message, expired pruning, cross-user isolation. |
| `src/auth/tokens.js` | L | **Well covered.** mint/consume/find, purpose enforcement, hashed-at-rest, expiry, unknown-purpose, replay races. |
| `src/auth/webauthn.js` | — | **Critical untested.** No test for `startRegistration`, `finishRegistration`, `startLogin`, `finishLogin`. Counter regression branch (the "cloned authenticator" 401) is uncovered. Challenge consume / 5-min TTL / opportunistic reaper untested. |
| `src/lib/audit.js` | R | Touched by every route test; no direct unit. The null-actor branch (`actorUserId ?? null`) is implicitly exercised when the recovery flow audits. The trigger that makes audit_log append-only is covered in `tests/db/`. |
| `src/lib/csp.js` | L | Covered. |
| `src/lib/email.js` | — | **Untested.** `sendMagicLink` SMTP path, transport-failure fallback, the subject/action lookup table. The dev "smtp-disabled" path is touched via invite test but never asserted on. |
| `src/lib/errors.js` | T | Constructors used everywhere; `errorMiddleware` exercised through routes but no direct test of its 500-fallback behaviour (`err instanceof HttpError === false`) or its handling of an `_next` already-sent response. |
| `src/lib/format.js` (590 lines) | L+R | Single-period MD/CSV overtime columns + compare formatters covered. PDF output covered only as `%PDF` magic-byte check. The PDF rendering engine, the special-character escaping in CSV, the long-narrative truncation are untested. |
| `src/lib/random.js` | T | `randomToken` and `sha256` are used pervasively; no direct test. Both are trivial wrappers but `sha256` collisions/encoding (hex output, UTF-8 handling) are unverified. |
| `src/lib/rate-limit.js` | R | Two limiters tested (refresh, webauthn-login). The invite limiter, recovery-short, recovery-hour are not exercised. No window-reset test. |
| `src/lib/route-helpers.js` | L | **Well covered.** 24 tests across entity loaders, period inference, resolveUserClaimant, isOwnerOrAdmin, assertEditable. |
| `src/lib/t661.js` | L+R | **Well covered.** 31 dedicated tests covering proxy vs traditional, wage cap, FX, status filter, snapshot/manifest. |
| `src/lib/wage-caps.js` | L | **Well covered.** |
| `src/routes/auth.js` | R | Refresh path covered via rate-limit test (negative); `/logout`, `/me`, `/activity`, `/me/credentials`, `/me/projects`, `/me/periods` are untested. The webauthn register/login start/finish endpoints have no test. `/recovery` (account-enumeration neutrality, the "always 200" contract) is untested. |
| `src/routes/audit-log.js` | R | Covered (entity-type filter map, claimant scoping). The 500-row LIMIT clamp is asserted; the facets payload is not. |
| `src/routes/claimants.js` | R | POST/PATCH lightly covered via `audit-log-writes` (only that they write an audit row). The fiscal_period_end_month/day validation, the `sred_method` lock, the nested period UNIQUE-violation 400 mapping are untested. |
| `src/routes/evidence.js` | R | **Partly covered.** Upload allowlist + content-sniff covered, period-closed PATCH/DELETE covered, list filter covered. Uncovered: `validateLinkUrl` scheme rejection at PATCH time, the `download` endpoint, evidence attached to labour_entry / expense parent (FK linking), oversized payload (>25MB), the `canSee` non-admin path. |
| `src/routes/expenses.js` | R | List, period-closed lock, admin-self-edit covered. FX validation (`validateFxAgainstClaimant`) at POST has no direct test; only the happy path. Cross-tenant PATCH/DELETE by employee not tested. |
| `src/routes/exports.js` | R | T661 round-trip + compare covered. The evidence-package bundle is covered. Uncovered: the conflict response when a bundle already exists; archiver error path; orphaned `bundle_path` (file missing on disk) GET behaviour. |
| `src/routes/index.js` | T | The `/health` endpoint is untested. |
| `src/routes/labour.js` | R | List, admin-self-edit, period-closed lock covered. `bulk-approve` has zero direct test (its transactional behaviour and per-row audit rows are unverified). |
| `src/routes/periods.js` | R | close/reopen covered (10 tests in `close-period.test.js`). |
| `src/routes/projects.js` | R | Revisions GET covered; PATCH snapshotting behaviour covered indirectly via `audit-log-writes`. POST assignment / DELETE assignment have no behaviour test beyond audit-log presence. The `manager_user_id` validation branches (not-found, wrong role, inactive) have no test. |
| `src/routes/user-claimants.js` | R | PATCH employment_start_date and compensation POST covered. The `is_specified_employee` boolean coercion is uncovered. |
| `src/routes/users.js` | R | invite (V-06), deactivate/reactivate symmetry, employment-start covered. Uncovered: POST validation matrix (bad email, missing name, attachment without compensation), search `q` LIKE-injection surface, the role-comma split when `?role=admin,manager` is passed. |
| `src/scripts/seed-*.js` | — | No test. These run only manually; risk of regression on schema changes (seed-data.js inserts via raw SQL and would be the first to break). |

## Critical untested code

Files where a bug would corrupt data, leak data, or break login, and there is no direct test:

1. **`src/auth/middleware.js`.** Every protected route runs through it. A regression here (e.g. accidentally accepting a token for a `status='disabled'` user, or stripping the Bearer prefix incorrectly) would silently undermine the entire authz model. No test covers any of: missing header, wrong scheme, expired token, deactivated user, role mismatch. The only thing that catches this today is downstream tests failing to authenticate — a poor signal.

2. **`src/auth/webauthn.js`.** 132 lines including the counter-regression check (`if (newCounter < credRow.counter) throw cloned-authenticator`), the challenge TTL + reaper, the consume-or-fail semantics, the unknown-credential path, and the per-user existing-credential exclusion list. None of these branches are exercised. The `@simplewebauthn/server` library is mocked nowhere; that's fine — but a fake authenticator harness (use `@simplewebauthn/browser`'s test helpers, or pre-canned response fixtures) could cover the registration finish + login finish without a real key.

3. **`src/routes/evidence.js`** failure paths. Specifically: the `multer` size limit (25MB), what happens when the upload partially writes and the validation rejects (the catch-block file unlink is asynchronous and the TODO already flags this as a flaky race), the `download` endpoint authorization (`canSee` returning false for a non-admin non-uploader — there is no test for this), and the link-URL javascript:/data: schema rejection on PATCH (only POST is covered).

4. **`src/lib/email.js`.** No coverage at all. The `sendMagicLink` SMTP path is the only thing standing between a misconfigured SMTP server and silent invite-email failures. The fallback `[email] failed to send` path could be swallowing errors; nothing asserts that the error is logged or that the caller's `.catch` doesn't crash the request.

5. **`src/lib/audit.js`** + the `audit()` helper's null/undefined-coalescing logic. The `before === undefined ? null : JSON.stringify(before)` branch decides what ends up in `before_json`. There is no test that audit rows are written with proper JSON shape across mutating routes (only that a row exists with the right `action`/`entity_type`). A change to JSON.stringify's behaviour on a class instance, BigInt, or circular ref could quietly write garbage.

6. **Migration 002, 006, 007, 009, 010, 011, 012.** Five of these are table-recreate migrations. Each one drops + recreates a table and copies data; a typo in the copy SELECT would silently lose rows. The current test suite only proves _the final schema works_ — not that running each migration against a populated table preserves data.

## Gap categories

### Authz cross-tenant isolation

The closest thing to a cross-tenant test is `audit-log.test.js`, which seeds two claimants and verifies `?claimant_id=A` doesn't leak B's rows — but that's a query-filter test, not an authz test (the caller is an admin who's allowed to see both anyway).

**No test asserts that an employee attached to claimant A cannot:**
- `GET /api/evidence/:id` for an evidence row owned by claimant B (the `canSee` check)
- `PATCH /api/labour/:id` for a row owned by claimant B (the `isOwnerOrAdmin` check)
- `GET /api/projects/:id` (the projects router has no employee-scoped filter — it's admin-only via `requireAdmin`, so this is fine, but no test proves the 403)
- `POST /api/evidence` with `project_id` pointing at claimant B's project (the `assertAttached` check)
- `GET /api/labour?project_id=<claimant-B-project>` — the where-clause does have `uc.user_id = req.user.id` for non-admins, but no test asserts it actually filters out a row scoped to another user_claimant.

The `route-helpers` unit tests prove the building blocks are correct, but nothing proves they are wired in at every route.

### Concurrency

Only the refresh-token replay test exercises a concurrency scenario, and it does so sequentially (the "attacker replays after the legit consume" pattern). There is no test that simulates:

- Two simultaneous `POST /api/auth/refresh` for the same token. (better-sqlite3 is synchronous, so this is hard to express, but a `db.transaction` failure mode could still be probed.)
- Two simultaneous `PATCH /api/projects/:id` writing different snapshot fields. The current code wraps both update + snapshot insertion in `db.transaction`, but no test forces an interleaved write.
- Concurrent evidence uploads racing on the same project — the file rename branch (`fs.renameSync`) could collide if two requests happen to hit the same random token.
- Concurrent `consumeEmailToken` calls on the same token id — the rows-affected race is tested explicitly via simulation (good), but not in the actual web layer.

### Failure paths

- **Malformed JSON body.** `express.json({ limit: '2mb' })` will 400 on malformed JSON, but no test asserts the response shape (does it match the `{error: {code, message}}` contract or does it use express's default HTML?). I suspect it doesn't go through `errorMiddleware` at all.
- **Oversized payload.** `2mb` JSON limit and `25mb` upload limit have no test.
- **SMTP timeout.** `sendMagicLink` swallows errors and returns `{ delivered: false, reason: 'send_failed' }`. Nothing asserts that the user-facing 200 response is still returned (the invite endpoint fires the email with `.catch(...)` after the response, but a test that the catch handler doesn't crash the process is absent).
- **Disk full on upload.** Multer's writeStream error would surface as a generic 500. No test.
- **DB busy.** SQLite WAL mode + `busy_timeout` defaults aren't probed. A long-running transaction blocking a write would currently throw `SQLITE_BUSY`; there's no graceful handling and no test.
- **Bad path param.** `Number(req.params.id)` for non-numeric ids ends up looking up `WHERE id = NaN`, which returns no row, which raises a 404 via the entity loader. Untested but probably correct; worth pinning.

### Property-based

None today. Highest-value candidates:

- **Currency conversion math (`reportingAmount` in `src/lib/t661.js`).** `Math.round(amount_cents * (fx_rate ?? 1))`. Property: for any positive integer `amount_cents` and any positive `fx_rate`, the result is a non-negative integer and is monotonic in `amount_cents`. Floating-point edge cases (FX rates like 1.349999...) could expose a 1-cent drift.
- **`dollarsToCents` (`public/api.js`).** Property: for any reasonable dollar string (`"\d+(\.\d{1,2})?"` with optional commas), round-trip via `centsToDollars` returns the same string. Currently 9 hand-picked tests; fast-check would cover the comma+decimal interplay.
- **Fiscal period date arithmetic in `findOpenPeriod`.** Property: a date inside `[start_date, end_date]` always returns the period; one second outside returns none. Already covered for the boundary cases but no random-input fuzz.
- **`buildCompareDiff` (`src/lib/format.js`).** Property: `diff.grand_total.X.delta_cents == b.grand_total.X - a.grand_total.X` for every numeric field, and the project union is symmetric (swap A/B, deltas negate). Hand-tested but trivial to extend with random totals.
- **`computeT661` labour aggregation.** Property: sum of `worksheet[i].labour_cost_cents` equals `project.totals.labour_cost_cents`. Currently asserted for specific scenarios; fuzz over random labour entries would catch precision bugs at the cents boundary.

### Migration data preservation

There is implicit confidence here: every test starts with `setupTempDb()` which runs all 12 migrations from scratch, and the suite passes. But:

- **No test populates table N-1 then applies migration N.** Migrations like 002 (`credential_id` text fix), 006 (labour overtime column), 011 (drop phase / rename status) involve recreating a table; a typo in the `INSERT INTO new_table SELECT ... FROM old_table` would silently drop data, and the suite would still pass because tests seed _after_ migrate.
- **No test for migration ordering / idempotency.** The `_migrations` table is honoured (`if (applied.has(file)) continue`), but not asserted.
- **No test that running migrations twice is a no-op.** Re-running `setupTempDb` from a populated state is exactly what production restart does; nothing tests this.

### E2E

No browser E2E today, as noted in the brief. The render-and-look agent is exploring that space; no duplication. One adjacent gap worth flagging: the SPA imports `@simplewebauthn/browser` from a CDN (`https://cdn.jsdelivr.net/npm/.../+esm`) — there is no test that the import URL actually resolves, and no SRI hash. A jsdelivr outage breaks login with zero coverage.

## Test quality findings

### Flaky tests

- **`tests/routes/evidence-upload.test.js` content-sniff cleanup race.** Already in TODO.md (P3). The `next(e)` path triggers `fs.unlink(req.file.path, () => {})` — an async cleanup — but the next assertion is synchronous `fs.readdirSync(uploadsDir)`. Test count fluctuates 228 ↔ 229 on rerun. Fix is documented: `await` the unlink, or make cleanup synchronous, then re-check on the assertion path.
- **`tests/auth/jwt.test.js`** has a `setTimeout(resolve, 1100)` to wait for a JWT to expire. 1.1s is comfortable above jsonwebtoken's second-resolution clock but is the only wall-clock-coupled test in the suite. Could be flaky under heavy CI load.
- **Per-file inter-test ordering in `close-period.test.js`** is explicit by design — the period state machine is driven across 10 tests. Node's test runner does run tests within a file in declaration order, but if anyone ever flips on test-level parallelism (`--test-concurrency`), this entire file collapses. Worth a comment + a guard, or restructure as one test with sub-checks.

### Slow tests

The whole suite runs in a few seconds locally (no test takes >500ms in normal conditions). Specifically:

- `tests/auth/jwt.test.js` — the 1.1s wait is the longest single test.
- `tests/routes/t661-export-roundtrip.test.js` — PDF generation via pdfkit and zip generation via archiver each take a few hundred ms. Probably under 500ms each but worth profiling.
- `tests/server/rate-limit.test.js` — 30 sequential HTTP requests to trip the limiter is observably slow (~200-400ms).

Nothing is expensive enough to need extraction, but the rate-limit test could use the smaller `webauthnLimiter` (10/min) instead of `refreshLimiter` (30/min) to halve its cost.

### Brittle assertions

`grep -c 'assert.match.*error' tests/**/*.js` → **9 occurrences.** Every one of these is asserting against an error _message string_ (rather than `error.code`). Examples:

- `tests/routes/users-invite.test.js`: `assert.match(body.error?.message || '', /yourself/i)` — would break if the message is reworded to "cannot self-invite".
- `tests/routes/close-period.test.js`: `assertClosedError` regex matches three possible phrasings — that's good defensive coding but signals the brittleness up front.
- `tests/routes/admin-edit-approved.test.js`: `assert.match(patched.body.error?.message || '', /approved/i)` — brittle.

Recommended pattern: `assert.equal(body.error.code, 'bad_request')` plus a `details` field on `HttpError` for the structured reason, then assert on `details.reason === 'period_closed'` instead of message regex.

The auth tests are mostly good — they assert `err.status` and `err.code`, with `assert.match` on the message only where the message is part of the contract (the "unified error wording so attackers can't enumerate" test).

### Test isolation

Mostly clean:

- Each test file gets a fresh temp DB (`setupTempDb`) and tears it down (`teardownTempDb`).
- The `beforeEach` `DELETE FROM` pattern in the lib unit tests (`t661.test.js`, `route-helpers.test.js`, `refresh.test.js`) wipes data between tests cleanly.

Cross-test state shared by design:

- `tests/routes/close-period.test.js` — declared in the file header; 10 tests share the period state machine.
- `tests/routes/audit-log-writes.test.js` — captures ids across cases via a `state` object. Single `test()`, so isolation isn't the concern, but the loop iterates over an ordered table — if one case 4xxs, every later assertion is invalidated. Better: continue past failures and aggregate.
- `tests/routes/t661-export-roundtrip.test.js` — mutates `exportId` and `postedGrandTotalCents` at module scope across tests. Same comment as above.

No accidental shared state between separate files (each gets its own temp DB).

### Test helper coverage

`tests/helpers/db.js` is in good shape: 8 insert helpers cover the main entities, plus 2 getters. Duplicated fixture code that could move into the helper:

- **`insertEvidence(db, projectId, periodId, userId, overrides)`** — appears as inline `db.prepare('INSERT INTO evidence_items...')` in 5+ test files. A helper would also let tests not have to know the kind/caption/note_text column triple.
- **`signAdminToken(db)` / `signEmployeeToken(db)`** — the four-line dance of `insertUser` + `insertUserClaimant` + `signSession` is repeated in nearly every route test. A helper that returns `{ id, token, ucId, claimantId }` would cut ~20 lines per file.
- **`startApiServer(ctx)`** — the express boot block at the top of every route test (mount apiRouter, mount errorMiddleware, listen on 0, return baseUrl) is ~20 lines of pure boilerplate, repeated 14 times.
- **A `cross-tenant` fixture** that builds two claimants + one user attached to one of them, ready for negative authz testing.

## Production-readiness gaps

- **Smoke test.** No test boots `src/server.js`. The rate-limit and CSP tests mount the api router into an ad-hoc app, but the real `src/server.js` — which also serves `public/`, handles the `/enroll` and `/login` SPA-fallback routes, and crucially wires `cspMiddleware` + `errorMiddleware` together — is not exercised. Risk: a regression in the server.js boot sequence (e.g. ordering of `app.use` calls, accidental change to static-files middleware) lands without a single test failing.
- **Migration roundtrip.** Implicitly covered (every test runs migrate.js to completion against a fresh DB), but not asserted. Documented here for the record.
- **`npm install` from clean checkout.** No test. The TODO doesn't flag this; no `npm ci` check in any CI artefact present in the repo. A regression where a transitive native module (better-sqlite3) fails to build on a fresh node version goes silent.
- **`npm test` from clean checkout.** Same. No reproducibility guarantee.

## Suggested additions (ranked)

1. **`tests/auth/middleware.test.js`** — `requireAuth` and `requireAdmin` integration tests. Six negative cases (no header, wrong scheme, expired, bad signature, deactivated user, missing user row), one positive admin-required case. Highest single-test ROI in the codebase.

2. **`tests/routes/cross-tenant-isolation.test.js`** — one file that seeds two claimants + two users, one attached to each, and walks every read/write endpoint asserting employee-A cannot see/touch claimant-B's labour, expenses, evidence, projects, audit log. Would catch any future refactor that breaks the `uc.user_id = req.user.id` filter. ~15 tests.

3. **`tests/auth/webauthn.test.js`** — fixture-based tests for the four ceremony halves. Use pre-canned attestation/assertion responses (the @simplewebauthn package ships fixtures, or capture once from a YubiKey emulator). Cover at minimum: counter regression, unknown credential, expired challenge, replay of a consumed challenge.

4. **Migration data-preservation test.** Add a `tests/db/migrations.test.js` that, for each migration that recreates a table (002, 006, 007, 010, 011, 012), seeds rows under the pre-migration schema and asserts post-migration row count + key column values. Most of these can't run from a partially-applied state today (migrate.js applies all-or-nothing), but a per-migration replay harness is straightforward.

5. **`tests/lib/email.test.js`** — direct tests on `sendMagicLink`. Mock the nodemailer transport (or use the `ethereal.email` test SMTP server). Assert: SMTP-disabled returns `{delivered: false, reason: 'smtp_disabled'}` and logs to stderr; SMTP-failed returns `{delivered: false, reason: 'send_failed'}`; SMTP success returns `{delivered: true}` with a messageId. ~4 tests.

6. **Bulk-approve test.** `tests/routes/labour-bulk-approve.test.js` — POST `/api/labour/bulk-approve` with mixed ids (some already approved, some on another claimant), assert transactional behaviour and one audit row per row updated. The transaction wrapper around the bulk update is currently completely untested.

7. **Error-shape conformance test.** One parameterised test that hits every 4xx-producing path with a malformed body and asserts the response matches `{error: {code, message}}`. Currently each test asserts shape ad-hoc, so a regression in `errorMiddleware` would be hard to attribute.

8. **`tests/server/smoke.test.js`** — boot `src/server.js` as a subprocess with `PORT=0` (or import it dynamically with a port-0 patch), hit `/health`, assert `{ok: true}`. Cheapest possible end-to-end test.

9. **Property-based tests via fast-check.** Add `fast-check` as a devDependency and start with `reportingAmount`, `dollarsToCents`, and `buildCompareDiff.grand_total`. Three small property files; each takes minutes to write and runs in milliseconds.

10. **Fix the known content-sniff cleanup race.** Already in TODO P3. `await` the unlink in the catch path of `src/routes/evidence.js`, and add a deterministic test that fails before the fix and passes after.

11. **Express body-parser failure shape.** One test: POST `/api/labour` with `Content-Type: application/json` and body `{` — assert the response is the `{error: {code, message}}` shape, not Express's default HTML 400. (This likely needs a custom error handler hooked into `express.json`.)

12. **Hardening tests for `mintEmailToken` race.** Two concurrent calls to `consumeEmailToken(id)` — assert only one returns 1. (The route-level test simulates this through DB manipulation; an in-process Promise.all over two consumeEmailToken calls would exercise the actual concurrency primitive.)

## Already in good shape

Worth preserving through any cleanup:

- **`tests/lib/route-helpers.test.js`** (24 tests) — the model for how to unit-test a DB-touching module. Fresh DB per file, wipe-between-tests via `beforeEach`, scenario builder for the shared fixture, every helper covered with positive + negative cases. If anything, copy this pattern to `tests/auth/middleware.test.js`.

- **`tests/auth/tokens.test.js`** (16 tests) — exemplary coverage of a security-sensitive module: round-trip, single-use, hashed-at-rest, purpose enforcement, cross-purpose rejection, unified error wording, expiry. The "register/finish-style flow refuses (unauthorized) when consume returns 0" test is particularly good — it bridges unit and integration concerns without booting the server.

- **`tests/auth/refresh.test.js`** (11 tests) — the family-revoke / replay-theft test is the kind of attack-scenario integration test that should live in more places. Audit-row assertion + cross-user isolation check are both included.

- **`tests/lib/t661.test.js`** (31 tests) — the calculation engine has dense coverage including wage caps, FX, status filtering. Worth keeping intact through any refactor of t661.js.

- **`tests/helpers/db.js`** — small, well-documented helper. The "IMPORTANT: do not statically import db/migrate" comment is a load-bearing piece of guidance. Preserve.

- **`tests/routes/close-period.test.js`** — the only test file that explicitly drives a state machine across multiple tests. The pattern is sound (period transitions are inherently sequential) and the in-file comment explains it. Don't try to refactor this into per-test isolation; that fights the model.

- **`tests/routes/audit-log-writes.test.js`** — parameterised verification that every mutating endpoint writes exactly one audit row. This is the cheapest way to catch a missing `audit()` call after adding a new route, and is one of the highest-leverage tests in the suite.

- **`tests/auth/webauthn-origins.test.js`** — clever use of `spawnSync` to get a fresh module graph per test, since `config.js` memoises. Pattern worth reusing for the JWT_SECRET banned-value tests if those get added.
