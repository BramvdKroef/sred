# Precision SR&ED

An in-house tracking tool for Canadian SR&ED (Scientific Research & Experimental Development) claims. Multiple claimants share one instance; admins configure claimants, projects, periods, and employees, while employees log labour, expenses, and supporting evidence. The system produces T661-ready exports (JSON / CSV / Markdown / PDF) plus an audit-defensible evidence package.

## Tech stack

- **Backend** — Node.js (22+), Express, SQLite via `better-sqlite3`. Plain JS modules (ESM), no transpile step.
- **Auth** — WebAuthn passkeys (`@simplewebauthn/server`) with magic-link invites & recovery; JWT access tokens + rotating refresh tokens.
- **Frontend** — Vanilla JS SPA, no bundler. Montserrat from Google Fonts, brand-themed CSS variables. Hash routing.
- **Files & PDF** — `multer` for uploads, `pdfkit` for T661 PDF output, `archiver` for audit-bundle zips.
- **Mail** — `nodemailer`; defaults target a local [Mailpit](https://mailpit.axllent.org/) (SMTP `localhost:1025`).

## Quick start

```sh
npm install
cp .env.example .env                     # generate a fresh JWT_SECRET if you care
npm run migrate                          # apply all schema migrations
npm run seed:admin -- --email=you@example.com --name="You"
npm run dev                              # node --watch
```

The seed script prints a magic-link URL to stdout (and sends it via SMTP if `SMTP_HOST` is set). Open `http://localhost:3000`, follow the link, enroll a passkey, and you're in.

To bootstrap a richer demo (run after `seed:admin` on a fresh DB so the IDs line up):

```sh
npm run seed:etc          # Extreme Technology Corp claimant + FY2026 period + 4 employees + 4 fixture projects
npm run seed:data         # ~150 labour entries, 12 expenses, 11 evidence items spread over 7 weeks
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Boot the server (production-style, no watcher). |
| `npm run dev` | `node --watch-path=src --watch src/server.js` — auto-restarts on `src/` changes. |
| `npm run migrate` | Apply pending migrations in `src/db/migrations/`. Toggles FK enforcement around each one so table recreates (e.g. for CHECK widening) stay safe. |
| `npm run seed:admin -- --email=... --name="..."` | Create or re-invite the first admin; prints a fresh magic link. |
| `npm run seed:etc` | Idempotent: create/rename claimant 1 to ETC, FY2026 period, four employees with comp rows, and four SR&ED projects with realistic narratives. |
| `npm run seed:data` | Idempotent demo data on top of `seed:etc`: project assignments, labour, expenses, evidence files. |
| `npm run backup` | Online snapshot of `data/sred.db` (WAL-safe) plus a tarball of `uploads/` into `data/backups/<timestamp>.db`. Prunes snapshots older than `BACKUP_RETENTION_DAYS` (default 30). |
| `npm run cleanup:bundles` | Delete `data/bundles/*.zip` older than `BUNDLE_RETENTION_DAYS` (default 90) and null the matching `t661_exports.bundle_path` so the API rebuilds on demand. |
| `npm test` | `node --test 'tests/**/*.test.js'` — the Node-builtin test runner over the suite under `tests/`. |

## Environment

`.env.example` is the source of truth. Notable entries:

- `JWT_SECRET`, `JWT_TTL_SECONDS` — access-token signing + lifetime (default 1h).
- `REFRESH_TTL_DAYS` — refresh-token TTL (default 30).
- `RP_ID`, `ORIGIN`, `RP_NAME` — WebAuthn RP. `RP_ID` is single and pinned — changing it invalidates already-registered passkeys. `ORIGIN` may be a comma-separated list (multi-tunnel previews); in `NODE_ENV=production` every entry must use `https://`, and the first entry is the canonical origin used for outbound magic links.
- `INVITE_TTL_MINUTES` / `RECOVERY_TTL_MINUTES` / `ADD_DEVICE_TTL_MINUTES` — single-use email-token windows.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — empty `SMTP_HOST` disables sending (magic links still log to stdout).

## Project layout

```
src/
  server.js                Express bootstrap, error middleware, static + SPA fallback
  config.js                Single source of truth for env-driven config
  db/
    index.js               better-sqlite3 wrapper, WAL + FK
    migrate.js             Migration runner (FK-off + integrity check around each)
    migrations/*.sql       Numbered, applied once
  auth/
    jwt.js                 Sign/verify access tokens
    refresh.js             Mint, consume (rotate), revoke refresh tokens
    tokens.js              Single-use email tokens (sha256-hashed)
    webauthn.js            Registration + login ceremonies
    middleware.js          requireAuth / requireRole / requireAdmin
  lib/
    audit.js               One-liner helper that writes audit_log rows
    csp.js                 Content-Security-Policy middleware
    email.js               nodemailer transport + sendMagicLink
    errors.js              HttpError + JSON error middleware
    format.js              JSON/CSV/Markdown/PDF renderers
    random.js              randomToken / sha256 — shared by tokens + refresh + evidence filename
    rate-limit.js          Per-route limiters (webauthn, recovery, refresh, invite)
    route-helpers.js       Shared entity loaders + period inference + scope/edit gates
    t661.js                T661 calculation engine (labour cost w/ specified-emp cap, FX, overhead)
    wage-caps.js           Hardcoded per-calendar-year specified-employee caps
  routes/
    auth.js                webauthn/{register,login}/{start,finish}, /auth/refresh, /recovery, /logout, /me, /me/{credentials,projects,periods}, /activity
    users.js               user CRUD, invites, deactivate/reactivate, attachments
    user-claimants.js      per-claimant attachments + compensation
    claimants.js           claimants + nested periods + nested projects (create)
    projects.js            project CRUD (with optimistic-concurrency on PATCH), revisions, assignments
    periods.js             close / reopen
    labour.js              CRUD + approve/reject/bulk-approve
    expenses.js            CRUD + approve/reject
    evidence.js            CRUD (file/link/note), MIME-sniffed uploads, JWT-gated download
    exports.js             POST T661, GET in 4 formats, comparative export, build + stream evidence zip
    audit-log.js           Admin-only filterable log view
  scripts/
    seed-admin.js          Create / re-invite the first admin
    seed-etc.js            Bootstrap Extreme Technology Corp demo claimant + period + employees + projects
    seed-data.js           Idempotent demo labour/expense/evidence on top of seed:etc
public/
  index.html               Shell — one #app container, brand styles, Montserrat
  app.js                   Entry, login/enroll/recovery, role dispatch
  admin.js                 Admin SPA shell
  admin/                   Admin SPA modules (overview, projects, employees, review, exports, audit)
  employee.js              Employee SPA shell
  employee/                Employee SPA modules (overview, activity, forms)
  api.js                   fetch wrapper with refresh-on-401, helpers (activity feed, chart, JWT downloads, inline-evidence attach, currentWeek)
  style.css                Brand palette, cards, tables, bar chart, pills
tools/                     Operator / dev scripts that aren't part of the seed path
  backup.js                Online DB snapshot + uploads tarball (used by `npm run backup`)
  cleanup-bundles.js       Prune old evidence-bundle zips (used by `npm run cleanup:bundles`)
  mint-dev-jwt.js          Mint a short-lived dev JWT for one-off API testing
  visual-audit.mjs         Headless screenshot pass over the SPA for visual review
  analyze-audit.mjs        Audit-log analysis CLI
docs/                      Use cases, data model, API surface, auth flows
data/                      SQLite DB + WAL + bundle zips (gitignored)
uploads/                   Evidence files (gitignored)
tests/                     Node-builtin `node --test` suite
```

## Notable patterns

- **Auth resilience.** The access token expires after an hour, but the SPA transparently calls `/api/auth/refresh` on a 401 and retries the original request. Closing and reopening the browser triggers a "warm start" via the long-lived refresh token in `localStorage` — no passkey ceremony unless the refresh has expired too.
- **Hash routing.** `#overview`, `#claimants/3`, `#users/7`, etc. Refreshing the page lands you back where you were. The search bar and back-buttons go through the same hash mutations.
- **Audit log everywhere.** Every create / update / approve / reject / period-close path writes a row to `audit_log` with `before_json` / `after_json` snapshots. The Audit log tab and per-row Open expansions surface this in the UI.
- **Append-only for closed periods.** Closing a fiscal period blocks edits and deletes to all labour, expense, and evidence rows in that period — reopening is the only way back, and is itself logged.
- **Revision-versioned narratives.** Editing a project's title, narrative fields (advancement, uncertainties, work performed), `field_of_science`, `type`, or `manager_user_id` appends a row to `project_revisions`, so a filed T661's `project_revisions_json` snapshot is bit-identical to what the tax preparer received. `PATCH /api/projects/:id` is guarded by an optimistic-concurrency precondition (`__updated_at`) so two admins editing the same project don't silently clobber each other.
- **Admin self-actions auto-approve.** Labour and expenses an admin submits skip the review queue and land in `status='approved'`, with the admin recorded as the reviewer.
- **One person → many claimants.** A single `users` row can attach to several claimants via `user_claimants`, each with its own compensation history and specified-employee flag.

## Backup and restore

`data/sred.db` is the entire system of record — claimants, projects, labour, expenses, evidence metadata, audit log, refresh tokens, passkey credentials. Hot-copying the file while WAL is in use produces a torn snapshot; always use `npm run backup`, which calls SQLite's online-backup API (`db.backup(...)`) and cooperates with concurrent writers.

```sh
npm run backup                      # one-off snapshot
BACKUP_RETENTION_DAYS=14 npm run backup   # tighter retention
```

Outputs land under `data/backups/`:

- `<YYYY-MM-DDTHH-MM-SS>.db` — the database snapshot
- `uploads-<YYYY-MM-DDTHH-MM-SS>.tar.gz` — tarball of `uploads/` (skipped if empty / `tar` not on `$PATH`)

Snapshots and their matching upload tarballs older than `BACKUP_RETENTION_DAYS` (default **30**) are pruned on each run.

**Recommended cadence.** A nightly cron is enough for most deployments — the DB is small and `db.backup()` is cheap. Example:

```cron
# /etc/cron.d/sred-backup
0 3 * * *  sred-user  cd /opt/sred && /usr/bin/npm run backup >> /var/log/sred-backup.log 2>&1
```

Or via a systemd timer: a `OnCalendar=daily` unit invoking `ExecStart=/usr/bin/npm run backup` from `WorkingDirectory=/opt/sred`. For off-host durability, point cron at a script that runs `npm run backup` and then `rsync`s `data/backups/` to S3 / an offsite host.

### Restoring

1. Stop the server (`systemctl stop sred` or whatever your supervisor uses).
2. Move the live DB and its WAL/SHM sidecars out of the way: `mv data/sred.db{,.broken} && rm -f data/sred.db-wal data/sred.db-shm`.
3. Copy the chosen snapshot into place: `cp data/backups/2026-05-14T03-00-00.db data/sred.db`.
4. (Optional) Restore the matching uploads tarball: `tar -xzf data/backups/uploads-2026-05-14T03-00-00.tar.gz` from the repo root (the tarball preserves the `uploads/` prefix).
5. Start the server.

### What's NOT backed up

- `data/bundles/*.zip` — these are evidence-package zips built on demand from `t661_exports` rows. The DB carries the totals, project revisions, and the evidence manifest, so any bundle can be rebuilt by POSTing `/api/exports/:id/evidence-package` again. Skipping them keeps the backup tarball small and avoids re-snapshotting the same content nightly.
- `data/sred.db-wal` / `data/sred.db-shm` — these are SQLite's WAL companions. The online-backup API captures their state atomically into the snapshot, so the restored file is internally consistent without them.

### Disk pressure

`uploads/` (25 MB × N) and `data/bundles/` (the export zips) are the two unbounded directories. Run `npm run cleanup:bundles` periodically to prune old bundles; closed fiscal periods retain their evidence by design, so `uploads/` only shrinks via the regular delete path (open periods) or operator action.

## Docs

`docs/` contains the longer-form design background:

- `use-cases.md` — actors, entities, twelve concrete UC flows, decisions.
- `data-model.md` — full schema with rationale per table.
- `api.md` — every REST endpoint, authz scope, sample body.
- `auth.md` — passkey ceremonies, magic-link bootstrap, recovery flow.
