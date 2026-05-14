# Reliability / failure-mode review

_2026-05-14, against branch `master`, commit `d533fc3`_

## Summary

Headline risk: the server runs in a single Node process with no supervisor, no SQLite `busy_timeout`, no SMTP timeout, and no optimistic-concurrency check on any mutation. Most failure modes degrade gracefully because better-sqlite3 is synchronous (so the lock window per request is sub-millisecond), but several scenarios produce a hard 500 to the user where a retry or a friendly message would be far better, and one scenario (concurrent narrative edits) silently destroys an admin's work.

Tally:
- **Data-loss / silent-overwrite cases: 4** — concurrent project PATCH (last-write-wins); admin closes period while another admin's PATCH is in flight (no detection); evidence-package re-build race overwrites bundle row; SMTP transient failure drops the magic link to stderr only (the user never sees it).
- **User-experience / 500-or-hang cases: 9** — SQLITE_BUSY 500, disk-full DB write, bundles-dir unwriteable, uploads-dir deleted, SMTP timeout hangs the invite request, SMTP 5xx surfaces as `delivered:false` with no UI prompt, tunnel-domain mid-ceremony, deleted claimant deep link 404, stale user_claimant 403 mid-PATCH.

Most of the auth/security paths (refresh-family revoke, WebAuthn challenge reaping, MIME content-sniff, FK constraint, append-only audit log) are already robust — see *Already-robust paths* at the end.

## Findings by category

### Database

#### D-1 — SQLITE_BUSY under WAL contention
**Scenario:** Two writers contend (e.g. an admin closing a period at the same moment a bulk-approve transaction is in flight). better-sqlite3 in WAL mode permits one writer at a time; the loser gets `SQLITE_BUSY`.

**What the code does:** `src/db/index.js` opens the DB with only `journal_mode=WAL` and `foreign_keys=ON`. **No `busy_timeout` pragma is set**, so better-sqlite3 uses its default of 5000 ms — adequate for normal use but not configured explicitly anywhere. There is no application-level retry. A busy error escapes as an unhandled exception, hits `errorMiddleware`, and the user sees a generic 500 (`internal_error`).

**Failure mode:** Sporadic 500s under load; the user has no signal that a retry is safe. Audit row may or may not have been written depending on where the busy fired in the transaction.

**Severity:** Low (rare at demo scale; default 5s busy_timeout absorbs almost everything).

**Mitigation:** Set `db.pragma('busy_timeout = 5000')` explicitly so the value is documented and stable across better-sqlite3 versions. Wrap mutating routes in a 2-3 attempt retry helper that catches `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`.

#### D-2 — Disk full mid-migration
**Scenario:** Migration `tx()` in `src/db/migrate.js` is mid-flight (e.g. running a table-recreate from `011_drop_phase_rename_status.sql`) when the disk fills.

**What the code does:** The migration runs inside `db.transaction(...)`, so an `SQLITE_FULL` error rolls back the transaction. **However**, the migrate script does `pragma foreign_keys = OFF` *before* the transaction and `ON` *after*; if Node dies mid-statement (OOM rather than SQLITE_FULL) the next boot has FK enforcement off until migrations run again. Within a single migration that mixes structural changes + an `_migrations` row insert, the rollback is atomic — partial schema is not committed. SQLite WAL itself is robust: on next open, uncommitted frames are discarded.

**Failure mode:** Migration aborts cleanly; user sees a startup error and must free disk before retry. No corruption.

**Severity:** Low. The only real hazard is the `foreign_keys = OFF` window if Node is force-killed exactly between toggle and transaction; remote.

**Mitigation:** Move the `PRAGMA foreign_keys = ON` into the post-migration verification step (already present via `PRAGMA foreign_key_check`) so an interrupted run doesn't leave FK enforcement disabled on a normal startup path.

#### D-3 — Schema corruption / WAL truncation
**Scenario:** WAL file truncated by a poorly-configured backup tool, or DB file is moved while server is running.

**What the code does:** `db = new Database(config.databasePath)` is called at module import time. If the file is corrupt, better-sqlite3 throws synchronously and the Node process exits before `listen()` — no crash-loop because there's no supervisor restarting it. If the file is moved while the server runs, the open handle keeps working (Unix semantics) but anyone reading the path sees stale data.

**Failure mode:** Server exits at boot with `SqliteError: file is not a database` and stays down until an operator intervenes. No silent corruption.

**Severity:** Low. Failure is loud and at boot time, not mid-flight.

**Mitigation:** None needed at this scale. Document that the DB is single-writer and should be backed up via `VACUUM INTO` or `sqlite3 .backup`, not `cp` of the live file.

#### D-4 — Concurrent admin PATCH on the same project narrative (LAST-WRITE-WINS) — DATA LOSS
**Scenario:** Two admins open the project detail page, edit the narrative ("uncertainties" / "work_performed") simultaneously, and submit within a few seconds of each other.

**What the code does:** `src/routes/projects.js:65-123` PATCH handler is read-modify-write with **no version column, no `If-Match`, no ETag**:

```js
const before = getProject(req.params.id);
// ... assemble updates from req.body ...
const tx = db.transaction(() => {
  db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`).run(...);
  if (snapshotNeeded) db.prepare(`INSERT INTO project_revisions ...`).run(...);
});
tx();
```

Both PATCHes succeed. The second one overwrites the first's columns. **A `project_revisions` row is inserted for each PATCH**, so the lost edit is recoverable from the revisions history — but the live row reflects only the second writer. Neither admin is told their counterpart's edit was overwritten.

**Failure mode:** Silent data loss in the live `projects` row. Revision history preserves both, but only an admin who notices the conflict and digs into "Narrative revisions" will recover it.

**Severity:** **High.** The revision history is a real mitigation, but admins won't know to look.

**Mitigation:** Add an `updated_at` (or `version`) column and require `If-Match: <updated_at>` on PATCH; reject with 409 on mismatch. The column already exists on `projects`. Surface "this project was edited by X 30s ago — review their changes before saving" in the UI.

#### D-5 — Refresh-token consume race
**Scenario:** Two browser tabs both POST `/api/auth/refresh` with the same refresh token in the same millisecond.

**What the code does:** `src/auth/refresh.js:31-71` does `SELECT … WHERE token_hash = ?` then `UPDATE … WHERE id = ?`. Because better-sqlite3 is synchronous and SQLite serialises writers, the two requests are processed one at a time at the SQL layer. The first transaction commits the `UPDATE refresh_tokens SET revoked_at = …`. The second one's SELECT now sees `revoked_at IS NOT NULL` and triggers the **V-03 family-revoke transaction** — every active refresh token for that user is revoked and a `refresh_replay_detected` audit row is written.

**Failure mode:** Both tabs are logged out (correct behaviour by design — replay is treated as theft). The legitimate user has to re-authenticate. The window is **tight** because the two operations are inside the same synchronous JS event loop tick at the DB layer.

**Severity:** Low UX cost (occasional forced re-auth from a refresh race); intentional security stance.

**Mitigation:** Consider widening the rotation grace window to ~5s — accept the same refresh token from the same IP within that window without triggering family revoke. Not urgent.

### File system

#### F-1 — Upload disk-fill mid-write
**Scenario:** Multer is writing a 25 MB upload to `config.uploadsDir`, disk fills mid-write.

**What the code does:** `src/routes/evidence.js` uses `multer.diskStorage` — multer writes the file to disk **before** the route handler runs (and before `sniffUpload` reads its magic bytes). On `ENOSPC`, multer's write stream errors and the request fails. The route handler's `catch` block has `if (req.file?.path) fs.unlink(req.file.path, () => {});`, so the partial file *is* cleaned up — **but only if the route handler runs**. If multer errors before the handler is invoked (the disk-full case), control goes to the express-default error path; cleanup may or may not happen depending on multer's internal `req.file` population at the point of failure.

**Failure mode:** Partial files in `uploads/` consuming disk on a system that's already disk-full — making recovery harder. User sees 500.

**Severity:** Medium.

**Mitigation:** Add `try { fs.unlinkSync(...) } catch {}` in the error middleware when `req.file?.path` exists. Or use `multer.memoryStorage()` for the multipart parse, then write to disk after `sniffUpload` validation (also avoids the "write then sniff then maybe rename then maybe delete" sequence).

#### F-2 — `data/bundles/` is unwriteable
**Scenario:** Permissions on `data/bundles/` are wrong (e.g. server runs as non-root after a chown drift), or the parent volume is read-only.

**What the code does:** `src/routes/exports.js:21-22` does `fs.mkdirSync(BUNDLES_DIR, { recursive: true })` at module load — if that throws, the **entire server fails to boot** (the export router is imported by `src/routes/index.js`). At runtime, `fs.createWriteStream(bundlePath)` succeeds asynchronously; the error fires on the next tick. The `output.on('close', ...)` updates the DB unconditionally — there is **no `output.on('error', ...)` handler**. An EACCES on write will surface as an `archiver` error event, which routes through `archive.on('error', err => next(err))` — but the `t661_exports.bundle_path` is set in the close handler, and if `archive.on('error')` fires the close handler may still run with a partial file, **leading to a DB row pointing at a half-written zip**.

**Failure mode:** User-facing 500. DB possibly references a partial/empty zip; the next `GET /:id/evidence-package` returns the bad file via `res.download` (or "bundle file missing on disk" if cleanup happened).

**Severity:** Medium.

**Mitigation:** Add `output.on('error', err => next(err))`; only set `bundle_path` after successful close + zero-byte check. Also catch the boot-time mkdirSync and report a clear "data/bundles unwriteable" error instead of failing import.

#### F-3 — `uploads/` deleted while server is running
**Scenario:** An operator `rm -rf uploads/` while the server is up.

**What the code does:** New uploads — multer's `diskStorage.destination` is set once at module load to `config.uploadsDir`; multer does **not** re-create the dir per request. The next upload fails with `ENOENT` from multer, surfacing as a 500. Existing-file downloads in `evidence.js:280-289` use `res.download(path.join(uploadsDir, basename))`; `res.download` will 404 (Express converts ENOENT to a 404).

**Failure mode:** All new uploads fail with 500 until the server is restarted (so `fs.mkdirSync(config.uploadsDir, { recursive: true })` at the top of `evidence.js` runs again). All downloads of existing files 404 silently.

**Severity:** Medium — operationally fixable by a restart but easy to miss.

**Mitigation:** Re-`mkdirSync` per upload in the multer `destination` callback (cheap; idempotent). Add a startup self-check that verifies `uploadsDir`, `bundlesDir`, and the DB path are writeable.

### Network

#### N-1 — SMTP timeout
**Scenario:** Invite endpoint POSTs `/api/users/:id/invite`; the SMTP server (per `SMTP_HOST`) is unreachable / dropping packets.

**What the code does:** `src/lib/email.js:4-12` creates the nodemailer transport with no `connectionTimeout`, `socketTimeout`, or `greetingTimeout`. Defaults from nodemailer are **2 minutes**. `src/routes/users.js:292-293` calls `sendMagicLink({...}).catch(...)` — note: **not awaited**, fire-and-forget. The response is returned immediately with `delivered: Boolean(config.smtp.host)` — meaning `delivered: true` even if the mail never actually goes out, because the response is sent before the SMTP attempt completes/fails.

**Failure mode:** The **HTTP route does NOT hang** — the .catch() is unawaited. The admin sees a "success" response. But the user never gets their email. The link is also no longer returned in the response body (V-06 fix). The only place the link exists is the SMTP fallback log via `console.log('[email] fallback link: ${link}')` — invisible to anyone not watching stderr.

**Severity:** Medium — silent failure for the invited user.

**Mitigation:** Set explicit nodemailer timeouts (e.g. `connectionTimeout: 5000, socketTimeout: 10000`). Persist failed sends to a table so admins can re-trigger from the UI; surface `delivered` honestly (true only after the SMTP `then` resolves). Consider returning the magic link to the admin again, with a "show only on SMTP failure" guardrail — V-06 removed it specifically to avoid impersonation, but a "retry/copy" affordance after a known SMTP error is a different threat model.

#### N-2 — SMTP rejects (5xx)
**Scenario:** Mail server returns `550 No such user`.

**What the code does:** `sendMagicLink` catches the error in its `try/catch`, logs `[email] failed to send …`, falls back to `console.log('[email] fallback link: ${link}')`, and returns `{ delivered: false, reason: 'send_failed' }`. The caller in `users.js` ignored this return value (it `.catch()` chains only on raw throws); the audit row is already written; the response body has `delivered: Boolean(config.smtp.host)` (i.e. `true`).

**Failure mode:** Admin sees "delivered" in the UI but the user never gets the email. Same silent-failure pattern as N-1.

**Severity:** Medium.

**Mitigation:** Same as N-1. Await `sendMagicLink` and report its `delivered` flag honestly.

#### N-3 — Tunnel domain changes mid-WebAuthn-ceremony
**Scenario:** Operator running `ngrok`/`cloudflared`; the tunnel URL changes during a sign-in. User has hit `/login`, browser has called `/webauthn/login/start`, server stored a challenge tied to `config.rpId`, then the operator restarts the server with new `ORIGIN` / `RP_ID`.

**What the code does:** The challenge row in `webauthn_challenges` survives the restart (it's in SQLite). On `/finish`, `verifyAuthenticationResponse` is called with `expectedOrigin: config.origins` and `expectedRPID: config.rpId` — both from the **new** boot's config. The browser's signed assertion is bound to the **old** rpID. SimpleWebAuthn rejects with `verification.verified === false`, surfaced as `unauthorized('login verification failed')`.

**Failure mode:** User sees "login verification failed". Re-trying from the new URL works (fresh ceremony with the new rpID).

**Severity:** Low — UX rough but no security impact.

**Mitigation:** Document that RP_ID changes invalidate in-flight ceremonies. Consider supporting comma-separated `RP_ID`s analogous to multi-origin (already done for `ORIGIN`).

### State

#### S-1 — Closed period mid-mutation
**Scenario:** Admin A opens the edit form for a labour entry. Admin B closes the period. Admin A submits PATCH.

**What the code does:** `assertEditable(entry, { user })` in `src/lib/route-helpers.js:92-105` re-fetches the period row at PATCH time:

```js
const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(entry.fiscal_period_id);
if (!period) throw notFound('fiscal period not found');
if (period.status === 'closed') throw badRequest('fiscal period is closed');
```

This is checked **inside the handler** but **not inside a transaction** that holds the period row. Between `assertEditable` and the actual `UPDATE labour_entries`, admin B's close-period could land. Since better-sqlite3 is synchronous and the gap is microseconds, the chance is negligible in practice — but technically there's no advisory lock.

**Failure mode:** In the extreme race, an edit lands on a now-closed period. The data is correctly tagged with `fiscal_period_id`, so when `computeT661` runs later it reads the (now incorrectly-mutated) row. **Probability is effectively zero on a single-instance synchronous server.**

**Severity:** Low.

**Mitigation:** Wrap PATCH in `db.transaction(() => { assertEditable(...); db.prepare('UPDATE ...').run(...); })`. The transaction serialises with `period close` so they can't interleave.

#### S-2 — Deleted claimant + deep link — **but no DELETE route exists**
**Scenario:** Admin has a deep-linked URL to claimant 5; meanwhile claimant 5 is deleted.

**What the code does:** Searched the codebase: **there is no `DELETE /api/claimants/:id` route**. `src/routes/claimants.js` only exposes POST/GET/PATCH. The TODO references "deleted-claimant fallback" (hoist work, claimant-selector). The fallback in `public/admin.js:191-212` reacts to a stored `activeClaimantId` whose claimant is no longer present in the API's claimants list — but this can only happen if a row is removed by direct SQL (no HTTP path) or by a future delete route.

**Failure mode:** N/A today. **Future risk** if a delete route is added without checking the chain (project_assignments / labour_entries / expenses / evidence_items / user_claimants all have FKs to claimants; SQLite would refuse the delete unless they were cascaded).

**Severity:** Informational. The UI fallback is correct; the server-side risk doesn't materialise without a delete route.

**Mitigation:** If a delete is ever added, prefer soft-delete (status column) — every dependent table has FK enforcement on, so a hard delete would fail anyway unless cascades are wired explicitly.

#### S-3 — Stale user_claimant — PATCH succeeds because role-check doesn't re-check status
**Scenario:** Employee opens labour-entry edit form. Admin deactivates the employee's attachment to the claimant. Employee submits PATCH.

**What the code does:** `src/routes/labour.js:98-155` PATCH flow:
1. `getLabourEntry(id)` — loads the entry.
2. `isOwnerOrAdmin(req.user, before.user_claimant_id)` — `src/lib/route-helpers.js:75-79`: `SELECT user_id FROM user_claimants WHERE id = ?`. **Does NOT check `status`**. Returns true if the row exists and `user_id` matches.
3. `assertEditable(before, { user: req.user })` — checks entry.status + period.status only.

So a deactivated employee's PATCH succeeds. The same is true for `expenses` (`src/routes/expenses.js:121`). Evidence is slightly different: `canSee()` only checks `uploaded_by_user_id`, but the parent `findOpenPeriod` indirectly requires an open period, not an active attachment.

**Failure mode:** A deactivated employee with a still-valid session can mutate their existing rows. They cannot create new ones (`resolveUserClaimant` does check `status` on POST). They also cannot log in again once the session expires (deactivated user → `unauthorized('user not active')` in `requireAuth`). So the window is bounded by the JWT TTL (default 3600s).

**Severity:** Medium — bounded but unexpected behaviour.

**Mitigation:** Add `AND status = 'active'` to the `isOwnerOrAdmin` SELECT, and have it return false if either is missing. Or change `assertEditable` to verify the user_claimant attachment status as part of the editability check.

### External processes

#### E-1 — Node crashes mid-request, no supervisor
**Scenario:** Unhandled exception escapes the express error path, or `process.exit()` somewhere fires. There's no `pm2`, `systemd`, or `nodemon` (dev only).

**What the code does:** `src/server.js` is `node src/server.js` per `package.json`. No supervisor wrapper. Existing HTTP connections drop. Any in-flight DB transaction rolls back (better-sqlite3 / WAL is robust to process death; uncommitted frames are discarded on next open).

**Failure mode:** Server is down until manually restarted. No data corruption.

**Severity:** Medium (operational).

**Mitigation:** Run under `systemd` / `pm2` with `Restart=on-failure`. Document this in the README.

#### E-2 — OOM kill + WAL replay
**Scenario:** Kernel OOM-killer takes the Node process.

**What the code does:** WAL is designed for exactly this — on next open, SQLite checks the WAL header and replays committed frames into the main db, discards uncommitted. No special handling needed in the app. Migrations are idempotent (the `_migrations` table tracks applied filenames).

**Failure mode:** Server boots cleanly; no corruption.

**Severity:** Low.

**Mitigation:** None needed.

### Time

#### T-1 — JWT clock skew
**Scenario:** Server clock is 30s ahead of an operator's laptop; or vice versa.

**What the code does:** `src/auth/jwt.js:12-14` calls `jwt.verify(token, secret, { issuer: 'sred' })` with **no `clockTolerance`**. Default is 0. The token has `iat`, `exp`, no `nbf`. If a client's clock is far enough ahead, the issued token's `iat` may be in the server's future on the next verification (some JWT libraries reject; `jsonwebtoken` does not check `iat` by default — only `exp` and `nbf` if present).

**Failure mode:** Tokens become invalid exactly at `exp`; no grace window. Users see 401 right at boundary. With `nbf` absent, "not yet valid" is a non-issue.

**Severity:** Low.

**Mitigation:** `jwt.verify(token, secret, { issuer: 'sred', clockTolerance: 30 })`. 30s is the conventional value.

#### T-2 — DST boundary on `work_date`
**Scenario:** A labour entry has `work_date = '2026-03-08'` (DST spring-forward in Canada). Period `start_date='2026-01-01'`, `end_date='2026-12-31'`.

**What the code does:** `work_date` is a string column with `CHECK (work_date GLOB '????-??-??')` (migration 007). `findOpenPeriod` does `? BETWEEN start_date AND end_date` — a lexicographic string compare on ISO-8601 dates, which is correct regardless of TZ. SQLite's `date('now')` is UTC; **but nothing compares `work_date` against `date('now')` anywhere**. The comparisons that matter are all string-to-string between `YYYY-MM-DD` literals.

**Failure mode:** None. DST is irrelevant because all date comparisons are on TZ-naive ISO strings.

**Severity:** None.

**Mitigation:** None needed. (Watch out if a future feature compares `work_date` to `datetime('now')` — would silently mis-bucket entries near midnight UTC.)

### Cleanup / accumulation

#### C-1 — webauthn_challenges on idle server
**Scenario:** Server is idle; old challenge rows linger.

**What the code does:** `storeChallenge` (`src/auth/webauthn.js:14-24`) reaps expired rows on each insert. If the server is idle and no one ever calls `/start` again, expired rows persist.

**Failure mode:** Negligible. The table is bounded by the rate-limiter (10/min/IP for webauthnLimiter) and by the natural ceremony fan-in. An idle server isn't getting new rows, so growth is zero.

**Severity:** None.

**Mitigation:** None needed. If it ever matters, a once-an-hour `setInterval` reaper is a one-liner.

#### C-2 — refresh_tokens for never-returning users
**Scenario:** A user logs in once, then never comes back. Their rotated/expired refresh tokens accumulate.

**What the code does:** `mintRefreshToken` prunes that user's expired tokens on each new mint. A user who never mints a new token never triggers the prune. With `REFRESH_TTL_DAYS=30`, after the user's last token expires, the row sits forever.

**Failure mode:** Unbounded slow accumulation. With N inactive users × T tokens each (T is bounded by their session count before quitting), this is at most thousands of rows. Negligible at any realistic scale.

**Severity:** Low/info.

**Mitigation:** A nightly job: `DELETE FROM refresh_tokens WHERE expires_at < datetime('now', '-30 days')`. Optional.

#### C-3 — audit_log retention
**Scenario:** `audit_log` is append-only (migration 008 triggers RAISE(ABORT) on UPDATE/DELETE). It grows monotonically forever.

**What the code does:** Every create/update/delete/approve/reject across labour, expenses, evidence, project, claimant, user, fiscal_period, refresh-replay, login, invite writes a row with `before_json` and `after_json` (often kilobytes each). No retention, no archival.

**Failure mode:** DB size grows. At a few hundred KB per row × thousands of mutations per claim cycle, this is a slow accumulation. For SR&ED compliance the audit log **must** be retained (6 years per CRA), so trimming isn't appropriate — but archival to a separate DB after period close is.

**Severity:** Low (correct-but-unbounded).

**Mitigation:** Add a one-line migration tool to copy rows older than the most recent closed period into an `audit_log_archive.db`. Not urgent until DB hits multi-GB.

## Most concerning paths (ranked)

1. **D-4: Concurrent project narrative PATCH silently overwrites.** Two admins editing the same narrative will produce a last-write-wins outcome with no conflict signal. The `project_revisions` table preserves both writes (mitigation), but the live row reflects only one of them. **Real data-loss risk on a multi-admin team.**
2. **N-1 / N-2: SMTP fire-and-forget + `delivered: true` is a lie.** Admin invites a new user, sees green, the user never receives an email, the link only appears on stderr. No timeout is set on nodemailer, so a network black-hole holds up the connection for 2 minutes per attempt (won't block the request thanks to the unawaited promise, but multiplies under recovery flood + slow SMTP).
3. **S-3: Deactivated employee can still PATCH their own rows.** `isOwnerOrAdmin` only checks user_id, not user_claimant.status. Window is bounded by JWT TTL (1h) but is surprising. The POST path is correct; the PATCH path is the gap.
4. **F-2: Evidence-package archiver has no error handler on `output`.** A disk-full / EACCES during `archive.pipe(output)` may still trigger the `close` event with a half-written zip and stamp `bundle_path` in the DB.
5. **D-1: SQLITE_BUSY surfaces as 500 with no retry.** Rare at single-instance scale, but no `busy_timeout` is set explicitly and no application-level retry exists. First sign of future scaling friction will be sporadic 500s with no obvious cause.

## Already-robust paths

- **WAL crash recovery (D-3, E-2):** SQLite WAL handles process-kill and OOM gracefully; uncommitted frames discarded on next open. Migrations are idempotent (filename tracking) and run in transactions.
- **Refresh-token replay (D-5):** V-03 family revocation is in a transaction; the race window is bounded by SQLite's serialised writer.
- **WebAuthn challenge reaping (C-1):** Opportunistic delete-on-insert is sufficient; rate limiter bounds row growth from below.
- **Append-only audit log (C-3):** Triggers refuse UPDATE/DELETE; even direct SQLite access has to drop the trigger to tamper.
- **DST / date arithmetic (T-2):** All date comparisons are ISO-string-lexicographic; TZ is structurally irrelevant.
- **Upload MIME content-sniff (F-1):** `file-type` magic-byte sniffing + extension normalisation defends against the "HTML pretending to be PDF" attack; rejected uploads are unlinked.
- **Path traversal on uploads/downloads:** `path.basename` strips traversal; stored filenames are random + canonical-extension; the bundle path is built from integer IDs only.
- **FK enforcement:** `foreign_keys = ON` is set on every connection; migrations verify `PRAGMA foreign_key_check` after applying.
- **CSP header (V-01 follow-up):** Inline script and `javascript:` URIs banned; defence-in-depth against any future XSS.
- **Rate limiting:** All auth/recovery/refresh/invite paths are rate-limited via `express-rate-limit`.
- **Deleted-claimant UI fallback:** `public/admin.js` detects a stale stored `activeClaimantId`, resets it to "All", and shows a one-time banner. No server-side path can produce this state today (no delete route), but the client is ready.
