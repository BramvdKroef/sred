# Precision SR&ED

An in-house tracking tool for Canadian SR&ED (Scientific Research & Experimental Development) claims. Multiple claimants share one instance; admins configure claimants, projects, periods, and employees, while employees log labour, expenses, and supporting evidence. The system produces T661-ready exports (JSON / CSV / Markdown / PDF) plus an audit-defensible evidence package.

## Tech stack

- **Backend** — Node.js (20+), Express, SQLite via `better-sqlite3`. Plain JS modules (ESM), no transpile step.
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

## Environment

`.env.example` is the source of truth. Notable entries:

- `JWT_SECRET`, `JWT_TTL_SECONDS` — access-token signing + lifetime (default 1h).
- `REFRESH_TTL_DAYS` — refresh-token TTL (default 30).
- `RP_ID`, `ORIGIN`, `RP_NAME` — WebAuthn RP. Pin one tunnel domain for the day — changing `RP_ID` invalidates already-registered passkeys.
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
    email.js               nodemailer transport + sendMagicLink
    errors.js              HttpError + JSON error middleware
    t661.js                T661 calculation engine (labour cost w/ specified-emp cap, FX, overhead)
    format.js              JSON/CSV/Markdown/PDF renderers
    wage-caps.js           Hardcoded per-calendar-year specified-employee caps
  routes/
    auth.js                webauthn/{register,login}/{start,finish}, refresh, recovery, /me, /me/projects, /activity
    users.js               employee CRUD, invites, deactivate/reactivate
    user-claimants.js      per-claimant attachments + compensation
    claimants.js           claimants + nested periods + nested projects (create)
    projects.js            project CRUD, revisions, assignments
    periods.js             close / reopen
    labour.js              CRUD + approve/reject/bulk-approve
    expenses.js            CRUD + approve/reject
    evidence.js            CRUD (file/link/note), JWT-gated download
    exports.js             POST T661, GET in 4 formats, build + stream evidence zip
    audit-log.js           Admin-only filterable log view
public/
  index.html               Shell — one #app container, brand styles, Montserrat
  app.js                   Entry, login/enroll/recovery, role dispatch
  admin.js                 Admin SPA (overview, projects, employees, review, exports, audit log)
  employee.js              Employee SPA (overview, my activity, log labour, evidence, expense)
  api.js                   fetch wrapper with refresh-on-401, helpers (activity feed, chart, JWT downloads, inline-evidence attach, currentWeek)
  style.css                Brand palette, cards, tables, bar chart, pills
docs/                      Use cases, data model, API surface, auth flows
data/                      SQLite DB + WAL + bundle zips (gitignored)
uploads/                   Evidence files (gitignored)
```

## Notable patterns

- **Auth resilience.** The access token expires after an hour, but the SPA transparently calls `/api/auth/refresh` on a 401 and retries the original request. Closing and reopening the browser triggers a "warm start" via the long-lived refresh token in `localStorage` — no passkey ceremony unless the refresh has expired too.
- **Hash routing.** `#overview`, `#claimants/3`, `#users/7`, etc. Refreshing the page lands you back where you were. The search bar and back-buttons go through the same hash mutations.
- **Audit log everywhere.** Every create / update / approve / reject / period-close path writes a row to `audit_log` with `before_json` / `after_json` snapshots. The Audit log tab and per-row Open expansions surface this in the UI.
- **Append-only for closed periods.** Closing a fiscal period blocks edits and deletes to all labour, expense, and evidence rows in that period — reopening is the only way back, and is itself logged.
- **Revision-versioned narratives.** Editing a project's title / narrative / type / phase / manager appends a row to `project_revisions`, so a filed T661's `project_revisions_json` snapshot is bit-identical to what the tax preparer received.
- **Admin self-actions auto-approve.** Labour and expenses an admin submits skip the review queue and land in `status='approved'`, with the admin recorded as the reviewer.
- **One person → many claimants.** A single `users` row can attach to several claimants via `user_claimants`, each with its own compensation history and specified-employee flag.

## Docs

`docs/` contains the longer-form design background:

- `use-cases.md` — actors, entities, twelve concrete UC flows, decisions.
- `data-model.md` — full schema with rationale per table.
- `api.md` — every REST endpoint, authz scope, sample body.
- `auth.md` — passkey ceremonies, magic-link bootstrap, recovery flow.
