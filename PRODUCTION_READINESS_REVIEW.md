# Production-readiness review

_2026-05-14, against branch `master`, commit `d533fc3`_

## Summary

**Verdict: not ready for production. Ready with substantial caveats for a single-VM, one-or-two-claimant pilot _only_ after the four blockers below are addressed.**

The codebase is correct, audited (V-01..V-11 closed except low/info V-11), and the schema is reasonable. What it is not is _operable_: `src/server.js` is a 25-line dev bootstrap. There is no signal handling, no structured logging, no readiness endpoint distinct from liveness, no reverse-proxy trust setting (so the rate limiter keys all traffic to the proxy IP), no backup/retention strategy for the SQLite file or the unbounded `uploads/` and `data/bundles/` directories, and no Node version pin. The single most important blocker is that **`app.set('trust proxy', …)` is not configured**, which means every IP-keyed rate limiter (the V-04 mitigations: webauthn, recovery, refresh, invite) collapses into a single per-process bucket the moment the server is put behind nginx/Caddy/Cloudflare — i.e. the exact deployment topology this review is scoped to.

## Blockers (must fix before production)

### B-1: Reverse-proxy trust not configured — `req.ip` is the proxy IP for every request

`src/server.js` does not call `app.set('trust proxy', …)`. Behind a reverse proxy (nginx, Caddy, Cloudflare, anything), Express sees the proxy's loopback IP on every request. Consequence: every IP-keyed limiter in `src/lib/rate-limit.js` (webauthn, recoveryShort, recoveryHour, refresh, invite) shares a single bucket across all real clients. One legitimate user retrying a flaky webauthn ceremony can lock out everyone else; a single attacker can be invisible because their traffic is mixed with everyone's. The V-04 hardening is effectively voided in any real deployment. `express-rate-limit` will also emit a warning on boot for this exact reason.

**Fix:** set `app.set('trust proxy', 'loopback')` (or `1` for a single nginx hop, or the explicit IP range if Cloudflare is in front). Document this in `.env.example` (e.g. `TRUST_PROXY=loopback`). Re-confirm `req.ip` after the change.

### B-2: No SIGTERM / SIGINT handling — process kill leaves DB and in-flight requests in unknown state

`src/server.js`:
```js
app.listen(config.port, () => { console.log(...); });
```
There is no `process.on('SIGTERM'|'SIGINT', …)` handler, no `server.close()` to drain in-flight requests, and no `db.close()` to flush WAL and release the lock. On a `systemctl restart sred` (which sends SIGTERM, waits 90s, then SIGKILL):
- Connections in the middle of a `POST /api/exports/:id/evidence-package` (which streams a `pdfkit` PDF or builds a multi-megabyte ZIP via `archiver`) are cut mid-flight; partial bundle files are left in `data/bundles/`, and the row in `t661_exports.bundle_path` is _not_ updated (the UPDATE runs in `output.on('close')` after `archive.finalize()`).
- The SQLite file itself is safe under WAL — `better-sqlite3`'s default WAL mode survives kill -9 — but a long-running write that's still in the WAL won't checkpoint until next open.
- Pending `mailer.sendMail()` promises (fired-and-forgot from `/api/recovery` and `/api/users/:id/invite`) silently disappear.

**Fix:** add a shutdown hook:
```js
const server = app.listen(...);
function shutdown(signal) {
  console.log(`got ${signal}, draining`);
  server.close(err => {
    if (err) console.error(err);
    try { db.close(); } catch {}
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => { console.error('forcing exit'); process.exit(1); }, 25_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```
Also add `process.on('unhandledRejection', …)` so the fire-and-forget `sendMagicLink().catch(...)` blocks don't get re-classified as crashes by Node 22+ defaults.

### B-3: No backup / retention story; `uploads/` and `data/bundles/` are unbounded

There is no documented or implemented backup procedure for `data/sred.db` (the entire system of record — claimants, projects, labour, expenses, evidence metadata, audit log, refresh tokens, passkey credentials). Hot-copying the file while the server is running under WAL is **unsafe**: you'll get a torn snapshot of the main file vs. its WAL companion. The supported approaches with `better-sqlite3` are (a) `db.backup('/path/to/snapshot.db')` (online backup API) or (b) `VACUUM INTO`. Neither is wired up.

Adjacent disk-fill risks, also unmitigated:
- `uploads/` (25 MB × N evidence files, no retention, no quota, no cleanup on closed-period purge — closed periods are append-only by design).
- `data/bundles/` (T661 ZIPs, one per `t661_exports` row that was built, never garbage-collected — `POST .../evidence-package` errors with `conflict('already built')` rather than re-using).
- `webauthn_challenges`: reaped on each `storeChallenge` call (good).
- `refresh_tokens`: per-user prune on `mintRefreshToken` (good).
- `email_tokens`: no reaper visible; rows accumulate forever once `consumed_at` is set.

Behaviour on full disk is the silent-failure kind: SQLite write attempts throw `SQLITE_FULL`, but `archive.pipe(output)` will half-write a corrupt zip, `multer` will half-write an upload then 500 (without cleaning up the partial file), and any `console.log` that backs a write to `journalctl` will block.

**Fix:** ship a `scripts/backup.sh` that calls `sqlite3 data/sred.db ".backup '/var/backups/sred-$(date +%F).db'"` or use the JS online-backup API; document the cron schedule in README. Add a nightly cleanup script (or in-process timer) that prunes `email_tokens WHERE expires_at < now()-7d` and `data/bundles/` zips older than N days where the corresponding `t661_exports` row still exists (don't delete the row, just the cached bundle — POST will rebuild on demand). Document `df` thresholds and an alerting hook.

### B-4: Default `JWT_SECRET=change-me` is rejected but **the boot has no error handler** — `console.error` + exit doesn't reach the operator

This is a half-fix of V-02. `jwtSecret()` throws synchronously during module initialisation in `src/config.js`. That's fine. But:
- The throw is unhandled at the import site (`server.js` does `import { config } from './config.js'`), so Node prints a stack trace to stderr and exits with 1. Under `systemd`, that's logged to the journal. Under `pm2` it's logged to the pm2 log. Under `docker run` it's gone unless someone is `docker logs -f`. There is **no startup health log** that says "I started cleanly with these origins" once `config` is initialised — only an `app.listen` callback `console.log` that ships _after_ binding the port.
- More importantly: `errorMiddleware` is the only `console.error` call site for runtime errors. It dumps to stdout with no request context. An operator triaging a 500 in production has no way to correlate the stack trace to the request that caused it. (See L-1 below.)

**Fix:** wrap the boot in a try/catch and `console.error(JSON.stringify({event:'boot_failed', err: err.message}))` before `process.exit(1)`. Print the resolved config (sans `jwtSecret`, `smtp.pass`) at startup so the operator can confirm what's wired. Combine with L-1 (structured logging) for the runtime side.

## Strongly recommended (fix before exposing real customer data)

### S-1: No structured logging; no request ID

Every log call in the codebase is `console.log` / `console.warn` / `console.error` with a free-form string. There is no JSON output, no level configuration, and no request correlation ID. The few logs that exist:

- `src/server.js:24` — boot banner
- `src/lib/email.js:28/45/48/49` — magic link delivery
- `src/lib/errors.js:23` — `console.error('unhandled error:', err)` (no request method, path, ip, user.id, or any request-scoped context)
- `src/routes/users.js:293` and `src/routes/auth.js:125` — fire-and-forget email failures
- `src/db/migrate.js` — migration progress

A 500 in production looks like: `unhandled error: Error: foo at /var/app/src/routes/...js:217:9 (stack...)`. That is unrecoverable for triage without a screen-share with the affected user.

**Fix:** add a tiny request-id middleware (no dep needed — `crypto.randomUUID()` per request, set `req.id` and the response header `x-request-id`; honour an inbound `x-request-id` from the proxy). Replace `errorMiddleware`'s `console.error` with a single JSON line including `req.id`, `req.method`, `req.originalUrl`, `req.user?.id`, status, and the error code/message. Either adopt `pino` (small, JSON-native, level config, no transitive baggage) or build a 20-line `lib/log.js` wrapper. Wire the same `req.id` into the `audit()` call so the audit row carries it.

### S-2: No Sentry / error-tracking integration point

`errorMiddleware` is the only place unhandled errors land, and it does nothing beyond `console.error`. There is no `Sentry.captureException` hook, no `process.on('uncaughtException')`, no `process.on('unhandledRejection')` handler. A null-pointer in a route handler today is logged once to stdout and never surfaces unless an operator is watching the journal.

**Fix:** add hooks (even no-op) for an error sink. The simplest path: `process.on('uncaughtException', err => { logger.error(...); process.exit(1); })` plus `process.on('unhandledRejection', …)`. When the team picks Sentry/Honeybadger/Bugsnag, the plug-in point is `errorMiddleware` + those two process handlers.

### S-3: No `/readyz` distinct from `/health`; `/api/health` doesn't probe the DB

`src/routes/index.js:16`:
```js
api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
```
This is a liveness probe — it returns 200 as long as the event loop is alive. It does not open the DB, run a query, or check disk space. A load balancer using this for readiness will route traffic to a half-broken instance whose `data/sred.db` was unmounted under it. Also: there is no `/readyz` distinct path that the LB can hit pre-traffic-routing.

**Fix:** keep `/api/health` as a liveness probe (cheap, no DB), and add `/api/readyz` that runs `db.prepare('SELECT 1').get()` and `fs.accessSync(config.uploadsDir, fs.constants.W_OK)`. Return 503 + JSON details if either fails.

### S-4: Schema migrations are atomic per-file, but FK enforcement is off during them — and there's no integrity check on the post-state for table-recreates

`src/db/migrate.js` toggles `foreign_keys = OFF` for the duration of each migration, wraps the SQL in a transaction, then runs `PRAGMA foreign_key_check` after re-enabling FKs. That's the SQLite-recommended pattern and is solid.

What's not protected:
- **No `PRAGMA integrity_check` after the table-recreate migrations** (007 and 011). On a 50k-row `labour_entries` (the only large table here), 007's `INSERT INTO labour_entries_new ... SELECT FROM labour_entries` followed by `DROP TABLE` is roughly 50k row-copies inside one transaction — that's tractable (single-digit seconds, hundreds of MB of WAL), but if the disk is near-full it can fail half-way and the rollback leaves the WAL bloated. Worth running `integrity_check` after each table-recreate.
- **No dry-run / verification mode.** The migration runner does not let you preview which migrations would be applied.
- **No backup-before-migrate.** A `db.backup()` call before each table-recreate would make the migration safely retryable.

**Fix:** add `db.pragma('integrity_check')` after re-enabling FK and asserting `foreign_key_check` is empty. Add a `--dry-run` flag that lists pending migrations without applying. Document in README that operators should run `scripts/backup.sh` immediately before `npm run migrate`.

### S-5: SMTP failure is fire-and-forget; the invite/recovery flow doesn't degrade visibly

`src/routes/auth.js:124-126`:
```js
sendMagicLink({ to: user.email, name: user.name, purpose: 'recovery', link })
  .catch(err => console.warn('[recovery] email send error:', err));
```
And `src/routes/users.js` does the same with `delivered` returned in the JSON body. The HTTP response is the same whether the email was delivered or not (since V-06 removed the raw link from the body). The console warning is the _only_ signal an operator gets that recovery emails are failing.

**Fix:** persist an `email_delivery_log` row (recipient, purpose, success, error, request_id) so admins can see in the audit-log tab when SMTP is misbehaving. Surface SMTP health in the readiness probe (S-3): if `mailer.verify()` has failed in the last N minutes, downgrade `/readyz` to 503 with `{ degraded: 'smtp' }`.

### S-6: Static asset serving has no `Cache-Control` / `ETag` tuning

`src/server.js:14` mounts `express.static(public/)` with default options. Express's defaults set `ETag` (good) and `Last-Modified` (good), but no `Cache-Control` directive — clients use heuristic caching. For an admin tool that pushes a UI change once a week, this means stale `admin.js` after a deploy, and the user has to hard-reload. Worse, there is no cache-busting on `index.html` referencing `app.js` (no hashed filenames).

**Fix:** explicit `express.static(public/, { etag: true, lastModified: true, maxAge: '1h', setHeaders(res, path) { if (path.endsWith('index.html')) res.setHeader('Cache-Control','no-cache'); } })`. For a future hardening pass, hash the filenames on a build step.

Note: `uploads/` is NOT served via `express.static` — evidence downloads route through `/api/evidence/:id/download` with JWT-gated `res.download(...)`. That's correct and was a deliberate choice.

### S-7: No Node version pin (`.nvmrc` / `.node-version`); no `Dockerfile`

`package.json` says `"engines": { "node": ">=20" }`. The repo has no `.nvmrc`, no `.node-version`, no `Dockerfile`, no `systemd` unit. A deployment on Node 24 (current at time of writing) may behave differently than on Node 20 around `node --watch`, fetch defaults, and `unhandledRejection` handling. `package-lock.json` is committed (good).

**Fix:** add `.nvmrc` pinning a single Node line (e.g. `20.18.0` LTS). Optionally add a tiny `Dockerfile` (multi-stage: `npm ci --omit=dev`, copy, run) so deployment is reproducible. Document the production command in README (i.e. _not_ `npm run dev`, which uses `--watch`).

### S-8: Security response headers beyond CSP are missing

`src/lib/csp.js` ships a strict CSP — good. But there is no `Strict-Transport-Security` (HSTS), no `X-Content-Type-Options: nosniff`, no `Referrer-Policy`, no `Permissions-Policy`. The reverse proxy can supply these, but the application shouldn't rely on that.

**Fix:** extend `cspMiddleware` to also set:
```
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```
HSTS only in production (don't ship it in dev or you'll lock localhost to HTTPS for the developer's browser for two years).

## Nice-to-haves

- **N-1 — CORS.** Currently same-origin (no `Access-Control-Allow-Origin` is set; the SPA is served from the API). If a CDN ever fronts `public/` while leaving the API on a different subdomain, CORS will need to be configured. Document this assumption in `docs/`.
- **N-2 — Timezone consistency.** SQLite `datetime('now')` returns UTC; `t661.js:228` and `format.js:330,488` use `new Date().toISOString()` (also UTC). All storage is consistent. The SPA renders timestamps in the browser's local time. No `Intl`-based rendering helper yet; a CRA auditor in PST opening a bundle generated by an admin in EST will see two different times for the same event (one in the PDF "Generated: …" line, one in their browser). Not a correctness issue, but document the contract: "all stored timestamps are UTC; renderers should call `.toLocaleString('en-CA', { timeZone: 'America/Toronto' })` or similar at display time."
- **N-3 — DB encryption at rest.** `better-sqlite3` doesn't support SQLCipher out of the box. If the VM is shared, evidence files in `uploads/` and the audit log in `data/sred.db` are readable by any process running as the same user. Either run on a LUKS-encrypted volume or migrate to `better-sqlite3-multiple-ciphers`. Not blocking for a 1-2 claimant pilot on a single-tenant VM.
- **N-4 — SMTP creds in `.env`.** `SMTP_PASS` is plaintext in `.env`. For a small VM this is fine; for a managed-secrets posture, hook into `systemd`'s `LoadCredential=` or a vault. Document the file mode (`chmod 600 .env`).
- **N-5 — Refresh-token storage on the client** (V-11). Already flagged; CSP largely mitigates. Long-term, move to `HttpOnly` cookie scoped to `/api/auth/refresh`.
- **N-6 — `email_tokens` cleanup.** Per S-5 above, no reaper. Cheap to add (`DELETE FROM email_tokens WHERE expires_at < datetime('now','-7 days')`).
- **N-7 — Body-parse limit asymmetry.** `express.json({ limit: '2mb' })` applies to all `/api/*` routes including small ones; `multer` caps file uploads at 25 MB. If an admin pastes a giant narrative into a project, 2 MB JSON is the cap (~250k characters), which is fine; just document.
- **N-8 — Compression.** No `compression` middleware. For T661 PDF / JSON downloads (frequently 100 KB - 1 MB), gzip would help, but a reverse proxy will typically handle this — defer to it.

## Already in good shape

- **Vulnerability hygiene.** V-01..V-10 all closed; V-11 is the only known residual and CSP mitigates the realisable exploit path. `npm audit --omit=dev` is clean per TODO.md.
- **Auth surface.** WebAuthn + JWT + rotating refresh + IP-keyed rate limits (modulo B-1 above), magic-link tokens hashed with sha256, single-use enforcement, family-revoke on replay (V-03), counter regression check on assertion, append-only audit log enforced by SQLite triggers (V-08 migration 008).
- **SQL injection posture.** Universally parameterised; the vuln review confirmed this audit-wide. No user-controlled `ORDER BY`.
- **SQLite WAL + FK.** `journal_mode=WAL` and `foreign_keys=ON` set at every connection open in `src/db/index.js`.
- **Migration runner.** FK-off + transaction + post-migration `foreign_key_check` is the correct pattern (S-4 only proposes adding `integrity_check`).
- **Filename / path-traversal safety.** Random base name + canonical-extension-from-MIME for uploads. `path.basename` on every disk read.
- **File-type content sniffing** (V-05 fix). `file-type@22` validates magic bytes after multer writes the file; text-family fallback is explicit and bounded.
- **CSP.** Strict and shipping on every response (`src/lib/csp.js`). Bans inline scripts and `javascript:` URIs.
- **Append-only audit log.** Trigger-enforced at the SQLite layer (migration 008).
- **Lockfile committed.** `package-lock.json` is in the tree; deterministic installs are possible.
- **Test suite exists.** `npm test` runs node's built-in test runner over `tests/**/*.test.js` — covers route helpers, refresh-token family revoke, JWT, wage caps, format, tokens, route-integration. ~230 tests per TODO.md.

## Coverage gaps

- **Real load not measured.** No benchmark exists for the 50k-row labour table migration (S-4), the bundle-build throughput, or the rate-limit ceilings under contention. The "is this fast enough?" answer is by inspection only.
- **WAL behaviour under concurrent writes** not stress-tested. Two admins racing on `bulk-approve` against the same `period_id` is plausible at small scale and was not exercised under load.
- **Browser compatibility of WebAuthn** not tested across Safari iOS, Firefox, and Edge enterprise builds — `@simplewebauthn` covers the protocol, but per-browser passkey UX differs.
- **`mailer.verify()` on boot** is not called, so an SMTP misconfiguration is only detected on the first send. Adding it would feed S-3 and S-5.
- **No penetration testing** beyond the static audit in `VULNERABILITY_REVIEW.md`. V-01's `javascript:` URL exploit was verified by code reading, not by exercising a browser.
- **`better-sqlite3` native-binary compatibility** with the deployment OS (glibc version, ARM vs x86) was not verified — `npm ci` on a fresh VM might trigger a recompile and need build-essential.
- **Real RP_ID rotation** (changing the WebAuthn relying-party ID) invalidates all existing passkeys with no recovery path other than the magic-link recovery flow. Documented in `.env.example` but not exercised; worth a runbook entry before pilot.
