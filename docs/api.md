# REST API

All endpoints are JSON unless noted (`multipart/form-data` for file uploads). Bodies use `snake_case`. Auth is a `Bearer <jwt>` header on every endpoint except those marked **public**. Timestamps are ISO-8601. Monetary fields are `amount_cents` (integer).

Authorization rules (enforced server-side):
- **Admin** can read/write everything for any claimant.
- **Employee** can read/write only entries linked to their own `user_claimants` rows; cannot see other employees' rows or any admin endpoints.

Error shape:
```json
{ "error": { "code": "validation_failed", "message": "...", "details": [...] } }
```

---

## Auth

| Method | Path                                | Auth     | Purpose                                       |
| ------ | ----------------------------------- | -------- | --------------------------------------------- |
| POST   | `/api/webauthn/register/start`      | token or session | Begin enrollment (consumes `email_token` if anonymous, else uses current user for add-device) |
| POST   | `/api/webauthn/register/finish`     | same     | Finish enrollment, issue JWT (if from token)  |
| POST   | `/api/webauthn/login/start`         | public   | Begin login ceremony                          |
| POST   | `/api/webauthn/login/finish`        | public   | Finish login, issue JWT                       |
| POST   | `/api/auth/recovery`                | public   | Request a recovery magic link                 |
| GET    | `/api/auth/me`                      | required | Current user + claimant attachments + role    |
| POST   | `/api/auth/logout`                  | required | Client-side discard; server logs the event    |

Detailed flow in `auth.md`.

---

## Users (admin)

| Method | Path                                | Body / Notes                                                     |
| ------ | ----------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/users`                        | List. Query: `?role=employee&claimant_id=...&status=active`     |
| POST   | `/api/users`                        | `{ email, name, role, attachments: [{claimant_id, title, is_specified_employee, compensation: {comp_type, amount_cents, hours_per_year, effective_from}}] }` — invites and sends magic link |
| GET    | `/api/users/:id`                    | Includes attachments + comp history                              |
| PATCH  | `/api/users/:id`                    | `{ name?, role?, status? }`                                      |
| POST   | `/api/users/:id/attachments`        | `{ claimant_id, title, is_specified_employee, compensation }` — attach existing user to additional claimant |
| PATCH  | `/api/user-claimants/:id`           | `{ title?, is_specified_employee?, status? }`                    |
| POST   | `/api/user-claimants/:id/compensation` | `{ comp_type, amount_cents, hours_per_year, effective_from }` — adds a new dated row |

---

## Claimants (admin)

| Method | Path                                | Body / Notes                                                     |
| ------ | ----------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/claimants`                    |                                                                  |
| POST   | `/api/claimants`                    | `{ legal_name, business_number, fiscal_year_end_month, fiscal_year_end_day, reporting_currency, sred_method }` |
| GET    | `/api/claimants/:id`                |                                                                  |
| PATCH  | `/api/claimants/:id`                | `{ legal_name?, business_number?, reporting_currency? }` — `sred_method` not editable |

---

## Fiscal periods (admin)

| Method | Path                                            | Body / Notes                                       |
| ------ | ----------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/claimants/:id/periods`                    |                                                    |
| POST   | `/api/claimants/:id/periods`                    | `{ start_date, end_date }`                         |
| POST   | `/api/periods/:id/close`                        | Marks closed; writes to labour/evidence/expense blocked |
| POST   | `/api/periods/:id/reopen`                       | Logged in audit_log                                |

---

## Projects (admin)

| Method | Path                                            | Body / Notes                                       |
| ------ | ----------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/claimants/:id/projects`                   |                                                    |
| POST   | `/api/claimants/:id/projects`                   | `{ title, field_of_science, start_date, end_date?, status, advancement_sought, uncertainties, work_performed }` |
| GET    | `/api/projects/:id`                             | Includes current narrative + assignment list       |
| PATCH  | `/api/projects/:id`                             | Editing narrative fields creates a `project_revisions` row |
| GET    | `/api/projects/:id/revisions`                   | Narrative history                                  |
| POST   | `/api/projects/:id/assignments`                 | `{ user_claimant_id }`                             |
| DELETE | `/api/projects/:id/assignments/:user_claimant_id` |                                                  |

---

## Labour

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/labour`                       | both     | Query: `?project_id=&period_id=&user_claimant_id=&status=&from=&to=`. Employees scoped to self. |
| POST   | `/api/labour`                       | both     | `{ project_id, work_date, hours, description }` — `user_claimant_id` inferred from auth + project's claimant. Admin may pass it explicitly. |
| GET    | `/api/labour/:id`                   | both     |                                                                                       |
| PATCH  | `/api/labour/:id`                   | both     | Owner or admin. Blocked once `status=approved` or period is closed.                   |
| DELETE | `/api/labour/:id`                   | both     | Same constraints as PATCH.                                                            |
| POST   | `/api/labour/:id/approve`           | admin    |                                                                                       |
| POST   | `/api/labour/:id/reject`            | admin    | `{ reason }`                                                                          |
| POST   | `/api/labour/bulk-approve`          | admin    | `{ ids: [...] }` or `{ filter: { project_id, period_id, ... } }`                      |

---

## Evidence

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/evidence`                     | both     | Query: `?project_id=&period_id=&labour_entry_id=&expense_id=`                         |
| POST   | `/api/evidence`                     | both     | `multipart/form-data` for `kind=file`; JSON for `kind=link` / `kind=note`. Fields: `project_id, kind, caption, evidence_date, labour_entry_id?, expense_id?, file?/url?/note_text?` |
| GET    | `/api/evidence/:id`                 | both     | Metadata                                                                              |
| GET    | `/api/evidence/:id/download`        | both     | Streams the file (if `kind=file`)                                                     |
| DELETE | `/api/evidence/:id`                 | both     | Blocked inside the 6-year retention window                                            |

---

## Expenses

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/expenses`                     | both     | Query: same filters as labour                                                         |
| POST   | `/api/expenses`                     | both     | `{ project_id, expense_date, category, amount_cents, currency, fx_rate?, description }` — receipts uploaded separately as evidence with `expense_id` set |
| PATCH  | `/api/expenses/:id`                 | both     | Owner or admin; blocked when approved/closed                                          |
| POST   | `/api/expenses/:id/approve`         | admin    |                                                                                       |
| POST   | `/api/expenses/:id/reject`          | admin    | `{ reason }`                                                                          |

---

## Employee dashboard

| Method | Path                                | Auth     | Body / Notes                                                                          |
| ------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/me/summary`                   | employee | Cross-claimant rollup: hours by project, evidence count, expense totals, current open periods |

---

## T661 export (admin)

| Method | Path                                | Body / Notes                                                                          |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/api/exports/t661`                 | `{ claimant_id, fiscal_period_id, draft?: bool }` — creates a `t661_exports` row, returns id |
| GET    | `/api/exports/:id`                  | Returns totals JSON + narratives                                                      |
| GET    | `/api/exports/:id/download`         | Query `?format=csv|json|md` — the file the tax preparer wants                          |
| POST   | `/api/exports/:id/evidence-package` | Builds the audit zip; sets `bundle_path` on the export                                |
| GET    | `/api/exports/:id/evidence-package` | Streams the zip                                                                       |
| GET    | `/api/exports`                      | List historical exports for a claimant                                                |

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

The export response also returns each project's narrative fields, the source revision id, and a per-employee labour worksheet (hours × rate, with cap applied if relevant) so the tax preparer can sanity-check the numbers.

---

## Conventions

- **Pagination**: list endpoints return `{ items, next_cursor? }`. Default page size 50. Cursor is opaque, sorts by `id desc`.
- **Idempotency**: not required at this scale; clients may retry safely on 5xx.
- **Validation**: 400 with field-level details on bad input. 403 for authorization failures (never 404 for things the caller can't see).
- **Date handling**: dates without time are ISO `YYYY-MM-DD`; timestamps are ISO with `Z`. The server's clock is the source of truth.
- **Period inference**: when a write specifies `project_id` + a date, the server picks the matching open `fiscal_period_id`. If none matches, return 422 — the admin must open the period first.
