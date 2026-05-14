# UI use-case audit

_2026-05-14, against branch `worktree-agent-ab0cafd1abb953864` (base: `master`)_

## Summary

8 of 12 use cases fully reachable. 0 missing. 4 partial.

Scope notes:
- Use-case IDs follow `docs/use-cases.md` (UC-A1..A5, UC-E1..E4, UC-R1..R3).
- "Reachable" means a logged-in admin or employee can complete the documented main flow through the SPA, end-to-end, without resorting to deep-linked URLs or the REST API directly.
- Alt flows are called out under their parent UC.

## Per-use-case findings

### UC-A1 — Configure a claimant
**Status:** ✅ fully reachable
**Entry point:** Admin → `Projects` tab → "Claimant" card → `＋ New` (form id `claimant-form` in `public/admin/projects.js:32-43`). All required fields surface: legal name, business number, FYE (MM-DD), reporting currency, SR&ED method (proxy/traditional). The method shows a "(locked once set)" hint and is rendered disabled in the edit form (`public/admin/projects.js:189`).
**Notes:**
- UC-A1 step 2 ("set the first claim period") is performed in a separate step via the "Fiscal periods" card on the same tab. Not a gap — same screen — but the suggested-dates helper (`suggestPeriodDates`) does pre-fill the first period from the claimant's FYE so the flow is short.

---

### UC-A2 — Define a fiscal year / claim period
**Status:** ✅ fully reachable (including alt flow A2.a)
**Entry point:** Admin → `Projects` tab → "Fiscal periods" card → `＋ Add` (form id `period-form`). Close/reopen buttons render per-row in `renderPeriodsTable` (`public/admin/projects.js:130-146`); both POST `/api/periods/:id/close` and `.../reopen`.
**Notes:** Reopens trigger an audit-log entry (the close/reopen actions hit the standard period mutation path) but there is no UI affordance to view the per-period close/reopen history without going to the global Audit log tab.

---

### UC-A3 — Onboard an employee
**Status:** ⚠️ partially reachable
**Entry point:** Admin → `Employees` tab → "Add employee" card (`public/admin/employees.js:14-50`). On submit it creates a user record with an initial attachment (claimant, comp row, specified-employee flag). The invite link is sent via the per-row `Send invite` button (`public/admin/employees.js:131-144`), which surfaces the magic link in a confirm-style alert.
**Gap:**
- **No "look up by email" branch.** Step 1 of the use case says: "if no Employee record exists, Admin creates one; otherwise the existing person record is reused". The form unconditionally calls `POST /api/users` with `email + name + attachments[0]`; there is no UI affordance to detect an existing person and skip to attaching them to another claimant. The cross-claimant attachment path (alt flow A3.a) does exist — but only by drilling into an existing user via `Edit` → "Add attachment" form (`public/admin/employees.js:196-209`). A first-time admin would not discover this from the Add form.
- **Employment start date not collected.** Use-case step 1 lists "name, email, employment start date" as the basic fields. Only name and email are collected; `effective_from` on the comp row is the closest proxy. This may or may not be an intentional simplification.
- **Role/title** at the claimant level (use-case step 2) is collected via the inline "Add attachment" form but **not** on the initial Add employee form — title is missing there.

Compensation history (alt flow A3.b) is fully covered by the per-attachment "Add comp row" form (`public/admin/employees.js:239-247`).

---

### UC-A4 — Create or edit an SR&ED project
**Status:** ⚠️ partially reachable
**Entry point:** Admin → `Projects` tab → "Projects" card → `＋ New project` (form id `project-form`, `public/admin/projects.js:81-121`). Edit at `#claimants/<id>` → `✎ Edit` button (`public/admin/projects.js:404-470`). Narrative fields (advancement, uncertainties, work performed) are all surfaced.
**Gap (alt flow A4.a):**
- **No UI to view prior narrative revisions.** The edit form has a hint "Narrative edits create a new revision snapshot." but the SPA never lists or diffs revisions. The use case requires that "the version-as-filed can be retrieved during an audit" — currently retrievable only via the evidence-package zip (UC-R3) or by hitting `/api/audit-log` directly via the Audit tab and reading the JSON before/after blocks. There is no dedicated "revisions" panel on the project detail page.
- **Period assignment missing.** Step 3 of the use case says the admin sets "the period(s) the project belongs to". The form has no period field; projects appear to span all periods of their claimant.

---

### UC-A5 — Assign employees to a project
**Status:** ✅ fully reachable
**Entry point:** Admin → project detail (`#claimants/<id>`) → "Assigned employees" card → `＋ Assign` (`renderAssignForm` in `public/admin/projects.js:633-687`). Active assignees can be removed via the per-row `Remove` (DELETE `/api/projects/:id/assignments/:uc`), and removed-then-re-added via `Re-assign`. The use-case requirement that "existing entries remain attributable" is preserved server-side (UI shows historic rows as `inactive`).

---

### UC-E1 — Log labour
**Status:** ✅ fully reachable (including alt flow E1.a)
**Entry point:** Employee → `Log labour` tab (`public/employee/forms.js:15-58`). Edit own pending/rejected entries: `My activity` tab → per-row `Edit` button (`public/employee/activity.js:91-99`); approved entries show "locked".
**Notes:** Alt flow E1.b ("date outside open period") is handled server-side — the UI passes the work_date through and surfaces any backend rejection via the generic `alert(err.message)` path in `onSubmit`. No date-picker constraint or inline warning before submission.

---

### UC-E2 — Upload evidence
**Status:** ✅ fully reachable
**Entry point:** Employee → `Add evidence` tab (`public/employee/forms.js:62-133`). All three kinds (file / link / note) are supported, optional attachment to a labour entry or expense is offered. Inline attach-evidence also exists on the labour form (via `attachInlineEvidence`) and on the activity-detail expansion in `wireAttachForm` (`public/api.js:349-381`).

---

### UC-E3 — Submit an expense
**Status:** ✅ fully reachable (including alt flow E3.a)
**Entry point:** Employee → `Submit expense` tab (`public/employee/forms.js:137-184`). Receipt-as-evidence is auto-wired via `attachInlineReceipt`. Admin-entered expense (E3.a) is available on project detail → "Submit expense" card (`renderLogOnBehalfCards` in `public/admin/projects.js:505-588`), which lets the admin pick an active assignee and post on their behalf.

---

### UC-E4 — Review own contributions
**Status:** ⚠️ partially reachable
**Entry point:** Employee → `My activity` tab (`public/employee/activity.js`). Shows assigned projects, labour, expenses, evidence in one screen, **unified across all claimants the user is attached to** (each row shows the project's claimant; cf. `projectSelect` and the projects table at `public/employee/activity.js:11-15`). Overview tab also gives this-week totals.
**Gap:**
- **No period filter / period switcher.** The use case explicitly says "for the current period (and can switch to prior periods) with totals". The activity tab loads `/api/labour`, `/api/expenses`, `/api/evidence` with no `from`/`to` or period filter — it just shows the entire history. There is no period selector and no per-period totals row.
- **No claimant column on labour/expense/evidence tables.** The projects table does show claimant, but the labour/expense/evidence tables only show project title (`public/employee/activity.js:18-83`), so a multi-claimant employee cannot scan-and-filter their work by claimant. Use case says "the dashboard presents a unified view across all of them, with a claimant column/filter".

---

### UC-R1 — Review submissions
**Status:** ⚠️ partially reachable
**Entry point:** Admin → `Review queue` tab (`public/admin/review.js`). Lists pending labour and pending expenses with Approve / Reject (reason via `prompt()`) buttons.
**Gap:**
- **No filters.** The use case says the queue is "filterable by project and employee" and is scoped to "a claimant and period". The current queue loads `/api/labour?status=pending` + `/api/expenses?status=pending` globally, with no claimant, period, project, or employee filter. On a multi-claimant install the admin sees everything mixed together.
- **No bulk approve (alt flow R1.a).** Approval is per-row only.
- **No "edit" action.** Use case step 3 includes "approves, rejects (with a reason), or edits each item." The review queue offers approve / reject only. Inline editing of someone else's entry from the review queue is missing — the admin can edit via the activity-detail expansion (`public/api.js` activity detail panels surface entity values but the only mutation offered there is attaching evidence, not editing fields), so editing a pending entry requires going elsewhere (and there is no admin UI to edit a labour or expense record's fields once submitted).
- Rejection reason is collected via a native `prompt()`, which is functional but rough.

---

### UC-R2 — Generate T661 export
**Status:** ⚠️ partially reachable
**Entry point:** Admin → `T661 exports` tab (`public/admin/exports.js`). Generate by period with a draft checkbox (alt flow R2.a). Downloads available in pdf / md / csv / json.
**Gap:**
- **Comparative export (alt flow R2.b) is missing.** No way to select two periods and produce a side-by-side export. There is no second-period picker on the form and no "compare" entry on the exports list.

---

### UC-R3 — Export audit evidence package
**Status:** ✅ fully reachable
**Entry point:** Admin → `T661 exports` tab → per-export row → `Build` button (POST `/api/exports/:id/evidence-package`), then `download zip` link once built (`public/admin/exports.js:37-42, 57-64`). Tied to a specific export so the bundled narrative version is the as-filed one, satisfying the use-case requirement of versioned Part 2 inclusion.

---

## Features without a documented use case

These are present in the UI but not anchored to any UC. None look harmful; flagged in case the team wants to either document or tidy them.

- **Global search bar** (`public/admin.js:170-228`) — searches projects + employees from the admin top nav. Genuinely useful, just not in `use-cases.md`.
- **Overview dashboards** — `admin/overview.js` and `employee/overview.js` both render a this-week chart + recent-activity feed. Cross-cuts UC-E4 / UC-R1 but is its own surface; consider adding it as an explicit "at-a-glance dashboard" use case.
- **Recent-activity expansion panels** with audit-log mini-views and inline "attach evidence" forms (`public/api.js:293-466`) — these expose audit-log entries per-entity, which partially compensates for the missing narrative-revision viewer (UC-A4 gap) but in an indirect way.
- **Preferences / passkey management** (`renderPreferencesPage` in `public/api.js:166-245`) — auth/UX scaffolding, not modeled as a UC. Probably out of scope for `use-cases.md` by design.
- **User deactivate / reactivate** (`public/admin/employees.js:75-81, 145-166`) — lifecycle action absent from UC-A3 (which only covers onboarding). May want a UC for offboarding.
- **Project "Edit"** with type (sred/internal) and phase (concept/development/complete) fields — the `type` and `phase` columns aren't mentioned in UC-A4. Either document them or drop from the form.
- **Log labour / Submit expense on behalf of an employee** from the admin project-detail page (`renderLogOnBehalfCards`) — used by alt flow E3.a but also exists for labour, which is not in the use cases (UC-E1 is employee-only and has no admin-entered alt flow). Worth documenting if it's intentional.
- **Overtime flag** on labour entries — surfaced on the labour form and edit form. Not mentioned in UC-E1 or anywhere in `docs/use-cases.md`. May affect labour cost computation in UC-R2; either way, undocumented.
- **Project manager assignment** (`manager_user_id` selector on the project form) — not in UC-A4. Probably benign but undocumented.
- **Audit-log tab** is a fine top-level admin surface, but the cross-cutting "Audit log" requirement in §5 only says actions are logged, not that there is a dedicated UI. It is a natural complement; flagging only for completeness.
