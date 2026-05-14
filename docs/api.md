# REST API

All endpoints are JSON unless noted (`multipart/form-data` for file uploads). Bodies use `snake_case`. Auth is a `Bearer <jwt>` header on every endpoint except those marked **public**. Timestamps are ISO-8601. Monetary fields are `amount_cents` (integer).

Authorization rules (enforced server-side):
- **Admin** can read/write everything for any claimant.
- **Manager** is a target role for project-level assignment (`projects.manager_user_id`) but does not currently grant any additional API privileges beyond `employee` — managers go through the employee-scoped routes for their own labour/expense/evidence.
- **Employee** can read/write only entries linked to their own `user_claimants` rows; cannot see other employees' rows or any admin endpoints.

Error shape:
```json
{ "error": { "code": "validation_failed", "message": "...", "details": [...] } }
```

---

## Auth

The auth router is mounted at `/api/`, so most of these paths are flat under `/api/` (the only nested path is `/api/auth/refresh`).

| Method | Path                                | Auth     | Purpose                                       |
| ------ | ----------------------------------- | -------- | --------------------------------------------- |
| POST   | `/api/webauthn/register/start`      | token or session | Begin enrollment (consumes `email_token` if anonymous, else uses current user for add-device). Rate-limited. |
| POST   | `/api/webauthn/register/finish`     | same     | Finish enrollment, issue JWT + refresh token (if from token). Rate-limited. |
| POST   | `/api/webauthn/login/start`         | public   | Begin login ceremony. Rate-limited.           |
| POST   | `/api/webauthn/login/finish`        | public   | Finish login, issue JWT + refresh token. Rate-limited. |
| POST   | `/api/auth/refresh`                 | public   | Rotate a refresh token. Body `{ refresh_token }`; response `{ token, refresh_token, refresh_expires_at }`. Replay of an already-rotated token revokes the whole family for that user and emits an `audit_log` row. Rate-limited. |
| POST   | `/api/recovery`                     | public   | Request a recovery magic link. Body `{ email }`. Always returns `{ ok: true }` (no enumeration). Rate-limited (per-minute + per-hour windows). |
| POST   | `/api/logout`                       | required | Revoke the refresh token in the body (if any); JWT is client-discard. Body `{ refresh_token? }`. |
| GET    | `/api/me`                           | required | Current user + claimant attachments + role.   |
| GET    | `/api/me/projects`                  | required | Projects the caller is assigned to (joins through active `user_claimants` + active `project_assignments`). |
| GET    | `/api/me/periods`                   | required | Fiscal periods of every claimant the caller is attached to. Drives the employee period selector. |
| GET    | `/api/me/credentials`               | required | List the caller's passkeys (id, label, transports, counter, created_at, last_used_at). |
| DELETE | `/api/me/credentials/:id`           | required | Remove one of the caller's passkeys. Refuses to remove the last credential (400). |
| GET    | `/api/activity`                     | required | Recent activity feed (labour + expenses + evidence). Query: `?limit=&project_id=&claimant_id=&user_id=`. Employees auto-scoped to themselves; admins may pass `user_id` to scope to another user. Returns `{ items }` merge-sorted by `created_at` desc. |

Success-response shape for `register/finish` and `login/finish`:

```json
{
  "user": { "id": 1, "email": "...", "name": "...", "role": "admin|manager|employee", "status": "active" },
  "token": "<jwt>",
  "refresh_token": "<base64url-32>",
  "refresh_expires_at": "ISO-8601"
}
```

Detailed flow in `auth.md`.

---

## Users (admin)

| Method | Path                                | Body / Notes                                                     |
| ------ | ----------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/users`                        | List. Query: `?role=admin,manager,employee&claimant_id=&status=&q=` (q is substring against name + email). When `claimant_id` is supplied each row also carries the `user_claimant_id` + attachment fields. |
| POST   | `/api/users`                        | `{ email, name, role, attachments: [{claimant_id, title, is_specified_employee, employment_start_date?, compensation: {comp_type, amount_cents, hours_per_year, effective_from}}] }` — creates a `pending` user. Sending the magic-link invite is a separate step (`POST /api/users/:id/invite`). |
| GET    | `/api/users/:id`                    | Includes attachments (with `employment_start_date` + comp history) and assigned projects. |
| PATCH  | `/api/users/:id`                    | `{ name?, role?, status? }`                                      |
| POST   | `/api/users/:id/deactivate`         | Sets `users.status='disabled'` and bulk-flips every currently-active `user_claimants` row for that user to `inactive`, tagging it with `deactivated_with_user_id = userId`. Self-deactivation is rejected. |
| POST   | `/api/users/:id/reactivate`         | Inverse: sets `users.status='active'` and flips back only those `user_claimants` rows whose `deactivated_with_user_id = userId`, then clears the marker. Independently-deactivated attachments are left alone. |
| POST   | `/api/users/:id/invite`             | Mint a magic link (`purpose=invite` for `pending` users, `add_device` for active). Rate-limited. Returns `{ user_id, purpose, expires_at, delivered }`. The raw link is deliberately **not** in the response — it is emailed via SMTP and (when SMTP is off) logged to stderr. Self-invite is rejected — use the recovery flow. |
| POST   | `/api/users/:id/attachments`        | `{ claimant_id, title?, is_specified_employee?, employment_start_date?, compensation }` — attach an existing user to an additional claimant. Returns the created `user_claimants` row. |
| PATCH  | `/api/user-claimants/:id`           | `{ title?, is_specified_employee?, status?, employment_start_date? }` |
| POST   | `/api/user-claimants/:id/compensation` | `{ comp_type, amount_cents, hours_per_year, effective_from }` — adds a new dated row |

---

## Claimants (admin)

| Method | Path                                | Body / Notes                                                     |
| ------ | ----------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/claimants`                    |                                                                  |
| POST   | `/api/claimants`                    | `{ legal_name, business_number, fiscal_year_end_month, fiscal_year_end_day, reporting_currency, sred_method }` |
| GET    | `/api/claimants/:id`                |                                                                  |
| PATCH  | `/api/claimants/:id`                | `{ legal_name?, business_number?, reporting_currency?, fiscal_year_end_month?, fiscal_year_end_day? }` — `sred_method` not editable (rejected with 400 if changed). |

---

## Fiscal periods (admin)

| Method | Path                                            | Body / Notes                                       |
| ------ | ----------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/claimants/:id/periods`                    |                                                    |
| POST   | `/api/claimants/:id/periods`                    | `{ start_date, end_date }`                         |
| POST   | `/api/periods/:id/close`                        | Marks closed; writes to labour/evidence/expense are blocked until reopen. |
| POST   | `/api/periods/:id/reopen`                       | Logged in `audit_log`.                             |

---

## Projects (admin)

| Method | Path                                            | Body / Notes                                       |
| ------ | ----------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/projects`                                 | Global list. Query: `?q=&limit=` (q substring match against title + claimant name; default limit 20, max 100). Used by the admin top-nav search. |
| GET    | `/api/claimants/:id/projects`                   | Per-claimant list.                                 |
| POST   | `/api/claimants/:id/projects`                   | `{ title, field_of_science, start_date, end_date?, status, type?, manager_user_id?, advancement_sought, uncertainties, work_performed }` — `status` must be one of `concept|development|complete`; `type` defaults to `sred` (must be `sred|internal`); `manager_user_id` must reference a user with role `admin` or `manager` and `status='active'`. A `project_revisions` row is written in the same transaction. |
| GET    | `/api/projects/:id`                             | Includes current narrative + manager + assignment list. |
| PATCH  | `/api/projects/:id`                             | `{ __updated_at, title?, field_of_science?, advancement_sought?, uncertainties?, work_performed?, type?, manager_user_id?, start_date?, end_date?, status? }`. **`__updated_at` is required** (optimistic-concurrency precondition); a missing value is a 400, a mismatched value is a 409 carrying `{ current_updated_at }`. When any of `title`, `field_of_science`, `advancement_sought`, `uncertainties`, `work_performed`, `type`, `manager_user_id` change, a `project_revisions` row is snapshotted. |
| GET    | `/api/projects/:id/revisions`                   | Narrative history (joins `revised_by_user_id` and `manager_user_id` to user names). |
| POST   | `/api/projects/:id/assignments`                 | `{ user_claimant_id }` — re-activates an existing inactive assignment idempotently. |
| DELETE | `/api/projects/:id/assignments/:user_claimant_id` | Soft-delete: flips status to `inactive`. Existing labour/expense entries remain attributable. |

---

## Labour

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/labour`                       | both     | Query: `?project_id=&period_id=&user_claimant_id=&claimant_id=&status=&from=&to=`. Employees scoped to self. Rows include joined `period_status`, `project_title`, `user_name`, `user_email`, `claimant_name`. |
| POST   | `/api/labour`                       | both     | `{ project_id, work_date, hours, description, is_overtime?, user_claimant_id? }` — `user_claimant_id` is inferred from auth + project's claimant for employees and required for admins (admin "log on behalf"). When the caller is an admin the entry is auto-approved (`status='approved'`, `reviewed_by_user_id=actor`); employees land at `pending`. |
| GET    | `/api/labour/:id`                   | both     |                                                                                       |
| PATCH  | `/api/labour/:id`                   | both     | Owner or admin. Body: `{ work_date?, hours?, description?, is_overtime? }`. Blocked once `status=approved` (except when the admin self-edits their own auto-approved entry — that path reverts the row to `pending` and clears review fields, so it must be re-approved). Blocked when the containing fiscal period is closed. |
| DELETE | `/api/labour/:id`                   | both     | Same constraints as PATCH.                                                            |
| POST   | `/api/labour/:id/approve`           | admin    |                                                                                       |
| POST   | `/api/labour/:id/reject`            | admin    | `{ reason }`                                                                          |
| POST   | `/api/labour/bulk-approve`          | admin    | `{ ids: [int, ...] }` — approves each id in one transaction. Returns `{ approved: count }`. (No `filter` mode.) |

---

## Evidence

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/evidence`                     | both     | Query: `?project_id=&period_id=&labour_entry_id=&expense_id=`. Employees auto-scoped to their own uploads. |
| POST   | `/api/evidence`                     | both     | `multipart/form-data` for `kind=file`; JSON for `kind=link` / `kind=note`. Fields: `project_id, kind, caption, evidence_date, labour_entry_id?, expense_id?, file?/url?/note_text?`. Uploads are content-sniffed against an allowlist (PDF, common images, plain-text family, MS Office, ZIP) — HTML-pretending-to-be-PDF is rejected. The on-disk extension is normalised to the detected MIME, and link `url` must use http/https/mailto. Max 25 MB. |
| GET    | `/api/evidence/:id`                 | both     | Metadata.                                                                             |
| GET    | `/api/evidence/:id/download`        | both     | Streams the file (if `kind=file`).                                                    |
| PATCH  | `/api/evidence/:id`                 | both     | `{ caption?, evidence_date?, url? (kind=link), note_text? (kind=note) }`. Blocked when the fiscal period is closed. If `evidence_date` moves, the row is re-bucketed into the open period that covers the new date. |
| DELETE | `/api/evidence/:id`                 | both     | Blocked when the containing fiscal period is `closed`. (Open periods are mutable; there is no separate 6-year clock.) |

---

## Expenses

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/expenses`                     | both     | Query: `?project_id=&period_id=&user_claimant_id=&claimant_id=&status=&category=&from=&to=`. Employees scoped to self. Rows include joined `period_status`, `project_title`, `user_name`, `user_email`, `claimant_name`. |
| POST   | `/api/expenses`                     | both     | `{ project_id, expense_date, category, amount_cents, currency, fx_rate?, description, user_claimant_id? }`. `user_claimant_id` is required for admins ("log on behalf"). When the caller is an admin the expense is auto-approved (mirrors labour). Receipts are uploaded separately as evidence with `expense_id` set. |
| GET    | `/api/expenses/:id`                 | both     |                                                                                       |
| PATCH  | `/api/expenses/:id`                 | both     | Owner or admin. Body: `{ expense_date?, category?, amount_cents?, currency?, fx_rate?, description? }`. Admin self-edits of their own auto-approved row revert it to pending (same pattern as labour). Blocked when approved (by another reviewer) or when the period is closed. |
| DELETE | `/api/expenses/:id`                 | both     | Owner or admin. Same gates as PATCH.                                                  |
| POST   | `/api/expenses/:id/approve`         | admin    |                                                                                       |
| POST   | `/api/expenses/:id/reject`          | admin    | `{ reason }`                                                                          |

---

## T661 export (admin)

| Method | Path                                | Body / Notes                                                                          |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/api/exports/t661`                 | `{ claimant_id, fiscal_period_id, draft?: bool }` — inserts a `t661_exports` row capturing `totals_json`, `project_revisions_json`, and `evidence_manifest_json`. Response is the row plus the live `totals` JSON: `{ ...exportRow, totals }`. |
| POST   | `/api/exports/t661/compare`         | `{ claimant_id, period_a_id, period_b_id }` — ephemeral side-by-side export (UC-R2 alt R2.b). Computes T661 totals for each period and a per-field diff. Returns `{ a, b, diff }`. **Not persisted** (the `t661_exports` table is reserved for filing snapshots). |
| GET    | `/api/exports/compare/download`     | Query `?claimant_id=&period_a=&period_b=&format=json|csv|md|pdf`. Re-runs the comparative calculation and streams it back as the requested format. |
| GET    | `/api/exports/:id`                  | Returns the row plus parsed `totals`, `project_revisions`, `evidence_manifest`.       |
| GET    | `/api/exports/:id/download`         | Query `?format=json|csv|md|pdf` — the file the tax preparer wants.                    |
| POST   | `/api/exports/:id/evidence-package` | Builds the audit zip (`export.json`, `summary.md`, `manifest.csv`, plus the file-kind evidence). Sets `bundle_path` on the export. 409 if a bundle already exists. |
| GET    | `/api/exports/:id/evidence-package` | Streams the zip.                                                                      |
| GET    | `/api/exports`                      | List historical exports for a claimant (`?claimant_id=`).                             |

### T661 totals computation (server, per project)

```
labour_cost = Σ over approved labour entries:
                hours × hourly_rate_on(work_date, user_claimant_id)
              where hourly_rate_on:
                if comp_row.comp_type = 'hourly': comp_row.amount_cents
                if comp_row.comp_type = 'salary': comp_row.amount_cents / comp_row.hours_per_year
              and where, if user_claimant.is_specified_employee:
                clamp the effective annual base salary to the year's hardcoded cap
                before computing the hourly rate.

materials              = Σ approved expenses where category = 'material'
contract_expenditures  = Σ approved expenses where category = 'contract'
third_party_payments   = Σ approved expenses where category = 'third_party_payment'

overhead = if claimant.sred_method = 'proxy': 0.55 × labour_cost
           else:                              Σ approved expenses where category = 'overhead'

total = labour_cost + materials + contract_expenditures + third_party_payments + overhead
```

Only projects with `type='sred'` are included in the T661 rollup (internal projects are excluded). The export response also returns each project's narrative fields, the source revision id, and a per-employee labour worksheet (hours × rate, with cap applied if relevant) so the tax preparer can sanity-check the numbers.

---

## Audit log (admin)

| Method | Path                | Body / Notes                                                                          |
| ------ | ------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/audit-log`    | Query: `?entity_type=&entity_id=&action=&actor_user_id=&from=&to=&claimant_id=&limit=` (default 100, max 500). When `claimant_id` is set, results are filtered to entities owned by that claimant (claimant-agnostic types like `user` and `refresh_token` are excluded). Returns `{ items, facets: { entity_types, actions } }`. |

---

## Conventions

- **Pagination**: list endpoints return `{ items }`. Some accept `limit=` (capped server-side). No endpoint emits a cursor today.
- **Idempotency**: not required at this scale; clients may retry safely on 5xx.
- **Validation**: 400 with field-level details on bad input. 403 for authorization failures (never 404 for things the caller can't see). 409 for optimistic-concurrency conflicts (only on `PATCH /api/projects/:id` today). 422 for write requests whose date falls outside any open fiscal period.
- **Date handling**: dates without time are ISO `YYYY-MM-DD`; timestamps are ISO with `Z`. The server's clock is the source of truth.
- **Period inference**: when a write specifies `project_id` + a date, the server picks the matching open `fiscal_period_id`. If none matches, return 422 — the admin must open the period first.
- **Rate limiting**: webauthn, recovery, refresh, and invite endpoints are individually rate-limited (see `src/lib/rate-limit.js`). Over-limit responses are `429` with the standard error shape.
