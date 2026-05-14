# SR&ED Tracker — Use Case Drafts

## What this is

These are **draft** use-case entries for features that exist in the SPA today but are not yet described in `docs/use-cases.md`. The list (and the audit notes that motivated it) come from `UI_USE_CASE_AUDIT.md` → "Features without a documented use case", with a follow-up in `TODO.md` → "Docs to update". The drafts here mirror what the code in `public/` actually does as of this branch — not what the SPA might do in some future redesign.

## How to read it

- Every draft is marked **[DRAFT]** in its header. Nothing in this file is canonical until it's promoted into `use-cases.md` by the owner.
- Each draft uses the same shape as the existing UCs: Actor / Trigger / Pre-conditions / Main flow / Alt flows / Post-conditions, plus two extra sections:
  - **Why this exists** — one or two lines on what the feature actually does today, so a reader who has forgotten the feature can orient quickly.
  - **Keep or drop** — pros for adopting the UC vs. pros for dropping the feature (or folding it into an existing UC). The decision is the owner's; this file just stages both sides.
- IDs slot into the existing scheme — `UC-A*` for admin-driven, `UC-E*` for employee-facing, `UC-R*` for reporting/cross-cutting. Existing IDs go up to `A5`, `E4`, and `R3`; these drafts continue from there.
- Where two drafts would naturally collapse into one UC (e.g., the two overview dashboards, or project `type` + `phase`), I have kept them as separate drafts but flagged the merge option under "Keep or drop".

---

## UC-A6 — Manage employee lifecycle (deactivate / reactivate) [DRAFT]

**Actor:** Admin
**Trigger:** An employee leaves the company, a contractor's engagement ends, or a previously deactivated person needs access restored.
**Preconditions:**
- The user record exists.
- For deactivation: the target user is not the admin themselves (the API rejects self-deactivation).

**Main flow:**
1. Admin opens the `Employees` tab and locates the user in the All Employees table.
2. Admin clicks `Deactivate`. The SPA shows a `confirm()` dialog naming the user and warning that historical labour/expense/evidence rows are preserved.
3. On confirmation the SPA posts `/api/users/:id/deactivate`. Server transactionally sets `users.status='disabled'` and flips every `user_claimants` row for that user to `status='inactive'`.
4. The user is blocked from signing in, falls out of project-assignment pickers (active-only filtering), and shows a `disabled` pill in the All Employees table. The `Deactivate` button is replaced by `Reactivate`.

**Alt flows:**
- *A6.a Reactivate* — Admin clicks `Reactivate` on a disabled user. The SPA posts `/api/users/:id/reactivate`, which sets `users.status='active'`. *Note: it does not auto-restore `user_claimants.status` — each claimant attachment must be re-activated individually via the per-attachment edit form. This is intentional but easy to overlook.*
- *A6.b Self-deactivation guard* — The admin's own row hides the `Deactivate` button entirely; the API also rejects self-deactivation with `400 you can't deactivate your own account`.

**Postconditions:**
- Deactivated user cannot authenticate, is removed from active rosters, and produces no new entries.
- Historical labour, expense, and evidence rows remain attributable.
- Both deactivate and reactivate write `audit_log` rows with full before/after.

**Why this exists:** Offboarding is a separate flow from onboarding (UC-A3 covers only onboarding). It also exists because CRA evidence retention requires that historical entries stay attributable to the person who made them — the SPA achieves this by disabling, not deleting.

**Keep or drop:**
- *Pros for keeping:* Lifecycle is real and frequent; offboarding is currently invisible in the use-case document, which makes it look unsupported. Captures the non-obvious behaviour that reactivate does not auto-restore attachments. CRA retention semantics ("entries stay attributable") are worth pinning down somewhere.
- *Pros for dropping (folding into UC-A3):* This could equivalently be an alt flow `A3.c Offboard an employee` on the existing onboarding UC, keeping the employee-lifecycle story in one place. The behaviour is small (two endpoints) and arguably doesn't warrant its own top-level UC.

---

## UC-A7 — Maintain a project's classification (type & phase) [DRAFT]

**Actor:** Admin
**Trigger:** Admin is creating or editing a project and needs to indicate whether it counts toward SR&ED at all, and where it sits in its lifecycle.
**Preconditions:** A claimant exists; admin is on the new-project form or the project's `Edit` form.

**Main flow:**
1. On the project form, admin sets **type** to one of `sred` (the default) or `internal`. Both options are accepted by the schema; only `sred` projects appear in the T661 export rollup (verified in `src/lib/t661.js:55-58` — the project list query filters `WHERE type = 'sred'`).
2. Admin sets **phase** to one of `concept`, `development`, or `complete`. This is currently a free-floating reporting marker — it surfaces as a pill on the project list and detail headers and on the per-employee project list, but it does not gate any other workflow.
3. Admin saves. Both `type` and `phase` are included in the project's narrative-revision snapshot (`SNAPSHOT_FIELDS` in `src/routes/projects.js:11`), so changes are auditable alongside other narrative edits.

**Alt flows:**
- *A7.a Reclassify mid-project* — Admin edits the project, flips `type` from `sred` to `internal` (or vice versa) or moves `phase`. Snapshot row is written; the next T661 export reflects the new classification.

**Postconditions:**
- Project carries a `(type, phase)` pair, visible on every project surface.
- T661 export totals include only `type='sred'` projects; `internal` projects accept labour/evidence/expense entries but are excluded from the claim.

**Why this exists:** `type` is a real eligibility gate — flipping a project to `internal` is the documented way to exclude work from the T661 without deleting it. `phase` is currently descriptive only (used in display, no calculation depends on it); it gives admins a coarse "where is this in its lifecycle" marker independent of the open/closed status of its periods.

**Keep or drop:**
- *Pros for keeping:* `type` materially affects what lands on the T661 — that's exactly the kind of behaviour a use-case document should pin down so nobody silently filters out a project they meant to include. `phase` is cheap to document and the UI already exposes it.
- *Pros for dropping (or merging):*
  - Could be folded into **UC-A4** as a small addition to step 2 ("Admin sets type, phase, and status") plus a note in the post-condition that `type='internal'` excludes the project from T661. That's arguably the more natural home — these fields live on the same form as the narrative.
  - `phase` has no functional effect today. If the team is uncertain whether it will ever drive logic, it's a candidate for removal rather than documentation — at which point this UC shrinks to just the `type` field.
  - These two fields could also be split into two UCs (one for `type`, one for `phase`) since `type` carries weight and `phase` is decoration. Combining them here was a judgement call.

---

## UC-A8 — Assign a project manager [DRAFT]

**Actor:** Admin
**Trigger:** Admin wants to record who is accountable for a project, separate from rank-and-file assigned employees.
**Preconditions:**
- A claimant and project exist.
- At least one user with role `admin` or `manager` exists and is active (the API rejects employees, inactive users, and unknown IDs — see `src/routes/projects.js:17-25`).

**Main flow:**
1. Admin opens the new-project form or the existing project's `Edit` form.
2. The `Manager` dropdown is populated from `state.managers` (the same list of admin/manager users used elsewhere) with an explicit `— none —` option.
3. Admin picks a manager (or leaves it empty) and saves. `manager_user_id` is stored on the project row.
4. The project's detail header shows `Manager: <name>` (or `—`). The manager has no extra permissions in v1 — this is a recording field, not an authorisation grant.

**Alt flows:**
- *A8.a Reassign manager* — Admin edits the project and picks a different manager (or clears the field). The change is captured in the project's narrative-revision snapshot (`manager_user_id` is included in `SNAPSHOT_FIELDS`).
- *A8.b Invalid manager candidate* — If the admin tries to set a manager who is an employee or deactivated, the API rejects with a `400` and the SPA's generic `alert(err.message)` surfaces the reason. The UI prevents this in practice by filtering the dropdown to admin/manager candidates.

**Postconditions:**
- Project carries a `manager_user_id` (or null), surfaced on the project header.
- Manager assignments are versioned via the same project-revision mechanism as narrative changes.

**Why this exists:** Records project accountability for audit and for the "who do I ask?" question, without conflating it with the per-claimant role hierarchy. The manager role itself exists primarily to gate who can be selected here.

**Keep or drop:**
- *Pros for keeping:* The dropdown is on the form; users will set it, so the data exists and ought to be documented. Captures the non-obvious constraint that managers must be admin/manager-role and active — that constraint is hard to discover from the SPA alone.
- *Pros for dropping (or merging):*
  - Could collapse into **UC-A4** as a single sentence in the main flow ("Admin optionally assigns a project manager"). It's a one-field decision and doesn't drive much workflow.
  - The field has no functional effect today (no notifications, no extra permissions). If the team isn't planning to wire anything to it, it's plausibly a candidate to drop from the SPA, not document.
  - Closely related to UC-A5 (assignment of regular employees); could be reframed as "two ways to associate a person with a project: as manager (1, optional) or as assignee (n, active)".

---

## UC-A9 — Browse the audit log [DRAFT]

**Actor:** Admin
**Trigger:** Admin needs to investigate a mutation: who changed what, when, and what the before/after looked like.
**Preconditions:** Admin is authenticated.

**Main flow:**
1. Admin opens the `Audit log` tab. SPA fetches `/api/audit-log?limit=100` and renders a table of the most recent 100 events (when, actor, action, entity, summary of changed fields).
2. Admin can filter by **entity type** and/or **action** via two select dropdowns. The filters are server-side query parameters; the dropdowns are populated from a cached "universe" of facet values so narrowing the filter never strips options (`universeFacets` module cache in `public/admin/audit.js:6`).
3. Admin clicks the `details` button on a row to expand a JSON pane showing the full `before` / `after` snapshot for that event.

**Alt flows:**
- *A9.a Drill from elsewhere* — Audit-log entries also surface in per-entity expansion panels on the Overview tab and on the Employee detail page (`wireActivityDetails` in `public/api.js`). The Audit tab is the only place that lists all events globally, but the same rows are reachable scoped to a single entity from those panels.
- *A9.b Filter persists with selection* — If the admin selects a filter value that the server doesn't currently return in its facet list (e.g., the only matching row scrolled off the limit window), the cache logic merges the selected value back into the dropdown so it doesn't vanish.

**Postconditions:**
- Admin has seen the requested events. No data is mutated.

**Why this exists:** The §5 cross-cutting requirement ("every create / edit / approve / reject action is logged with user, timestamp, and before/after values") states that the audit log exists on the back end. The Audit tab is the first-party UI for reading it without going to the database. It is also currently the only way to inspect prior project-narrative revisions (UC-A4 alt flow A4.a) until a dedicated revisions viewer ships.

**Keep or drop:**
- *Pros for keeping:* Real surface used during incident investigation and partial cover for the missing narrative-revision viewer. Documents the not-obvious "facets are cached" behaviour. The cross-cutting §5 requirement is general; without a UC, the existence of a dedicated tab is implicit.
- *Pros for dropping:* Could remain a §5 cross-cutting note ("admins have a global audit-log viewer") rather than a full UC, since it's a read-only support tool, not a step in any business flow. If the team wants `use-cases.md` to stay focused on T661-claim work, this is the most droppable of the eight.

---

## UC-E5 — Glance at this-week activity (overview dashboard) [DRAFT]

**Actor:** Admin or Employee (separate variants of the same surface)
**Trigger:** User signs in or clicks the top-level `Overview` tab and wants a quick sense of "what's happening this week".
**Preconditions:** User is authenticated.

**Main flow (admin variant — `public/admin/overview.js`):**
1. Admin lands on `#overview` (the default tab). SPA fetches in parallel: this-week labour, all pending labour, all pending expenses, and the most-recent 15 activity events.
2. Page renders four metric tiles (hours this week across all employees, contributor count, pending-labour count, pending-expense count), a per-day bar chart for the current ISO week, and a recent-activity feed with expandable detail panels. The recent-activity panels reuse `wireActivityDetails` (per-entity audit-log mini-views).
3. If the claimant list is empty (first-run state), the body is replaced with a 5-step getting-started checklist linking to the relevant tabs.

**Main flow (employee variant — `public/employee/overview.js`):**
1. Employee lands on their `Overview` tab. SPA uses the already-loaded `state.labour`, `state.projects`, and `state.activity` (no extra fetches).
2. Page renders metric tiles (own hours this week, own pending count, own to-fix-after-rejection count if non-zero, assigned-project count), a per-day bar chart of the employee's own hours, and a recent-activity feed.

**Alt flows:**
- *E5.a First-run state (admin only)* — When the claimant list is empty, the overview is replaced with a "Welcome — get set up in 5 steps" checklist. This is the only first-run guidance in the app.
- *E5.b Drill into a row* — Clicking the recent-activity entries expands an audit-log mini-view per entity with inline attach-evidence support (same component as elsewhere).

**Postconditions:**
- User has seen current-week totals. No data is mutated.

**Why this exists:** A "home" surface that gives both roles a quick orientation without making them dig into the activity tab or review queue. The admin variant doubles as the pending-work nudge ("X labour entries waiting for review"); the employee variant doubles as a "did I forget to log?" cue.

**Keep or drop:**
- *Pros for keeping:* Both variants are real surfaces (admin overview is the default landing tab). The first-run checklist lives here and has no other home. Cross-cuts but doesn't replicate UC-E4 or UC-R1.
- *Pros for dropping (or merging):*
  - Could be folded into the existing UCs: the admin overview's pending counts arguably belong as a "queue summary" alt flow on UC-R1; the employee overview's "this-week totals" belongs as an alt flow on UC-E4 ("Review own contributions"). Splitting reduces the surface area of `use-cases.md`.
  - The two variants could also be merged into a single UC ("at-a-glance dashboard") with two main-flow branches by actor — which is what this draft does. Alternatively, split into UC-A* (admin overview) and UC-E* (employee overview) if the owner prefers strict role separation.
  - The first-run checklist is arguably its own micro-UC ("Set up the first claimant") and would be more discoverable extracted.

---

## UC-E6 — Log labour with an overtime marker [DRAFT]

**Actor:** Employee (or Admin on behalf — see UC-E7)
**Trigger:** Employee is logging time that was worked outside regular hours and wants to flag it as such.
**Preconditions:** Same as UC-E1 (employee is assigned to a project in an open period).

**Main flow:**
1. Employee opens the labour entry form (`public/employee/forms.js:15-58`).
2. Employee fills in project, date, hours, description as in UC-E1, and additionally ticks the `Overtime` checkbox.
3. Employee saves. The flag is persisted on `labour_entries.is_overtime` (migration 006).
4. The hourly cost used in the T661 calculation is **unchanged** — overtime in v1 is a reporting marker only, not a multiplier. Per the migration header: "1.5x cost is a downstream conversation between admin and payroll; adding a multiplier here would change historical totals."

**Alt flows:**
- *E6.a Edit overtime flag* — Employee edits a pending or rejected entry from `My activity`; the checkbox toggles like any other field. Approved entries are locked.
- *E6.b Admin overtime on behalf* — The same checkbox appears on the admin's `Log labour on behalf` form (`renderLogOnBehalfCards` in `public/admin/projects.js`), so the flag can be set when entering labour on an employee's behalf.

**Postconditions:**
- Entry carries an `is_overtime` flag (default 0).
- T661 labour cost is **not** affected. The flag is currently surfaced in the audit-log before/after diff but does not appear in any export format.

**Why this exists:** Allows employees and admins to mark out-of-hours work so payroll and downstream review can spot it. Deliberately decoupled from the labour-cost calculation so historical exports stay reproducible.

**Keep or drop:**
- *Pros for keeping:* The field exists on disk, on three forms (employee log, employee edit, admin on-behalf), and in the API. Documenting it pins down the deliberate "marker, not multiplier" decision before someone tries to change the T661 to multiply by 1.5.
- *Pros for dropping:*
  - Could be folded into **UC-E1** as a one-line note ("entries may be flagged as overtime; the flag is a reporting marker only and does not affect labour cost").
  - If the team isn't using the flag — and the audit hasn't surfaced any reports filtered by it — the feature itself is a candidate to drop from the SPA. It currently has no downstream consumer.

---

## UC-E7 — Log labour or expense on behalf of an employee [DRAFT]

**Actor:** Admin
**Trigger:** Admin needs to record work or a cost for someone who can't (or won't) log it themselves — typical for past hires being backfilled, contractors logged centrally, or a paper-trail catch-up.
**Preconditions:**
- A claimant, project, and an open fiscal period covering the work_date / expense_date exist.
- At least one **active** assigned employee exists on the project (`renderLogOnBehalfCards` in `public/admin/projects.js:524-528` hides the cards otherwise with a "Assign an active employee first" hint).

**Main flow (labour on behalf):**
1. Admin opens the project detail page and clicks `＋ New` under the `Log labour` card.
2. Admin selects the target employee from the active-assignees dropdown (`user_claimant_id`), then enters work_date, hours, description, and optionally the overtime flag.
3. Admin optionally attaches evidence (file or link) inline via the same evidence-attach helper as the employee form.
4. Admin saves. POST `/api/labour` with `user_claimant_id` set to the chosen employee. **The entry is saved as `approved` (skipping the review queue) because the actor is an admin.** This is signalled in the UI by a visible pill: "As an admin, this entry will be saved as approved and skip the review queue."

**Main flow (expense on behalf):**
1. Admin opens the project detail page and clicks `＋ New` under the `Submit expense` card.
2. Admin selects the target employee, enters expense_date, category, amount, currency, optional FX rate, and description.
3. Admin optionally attaches a receipt file.
4. Admin saves. POST `/api/expenses`. Same auto-approve behaviour as labour.

**Alt flows:**
- *E7.a No eligible assignee* — If no employee on the project is currently `active`, both cards collapse to a placeholder telling the admin to add an assignee first.
- *E7.b Reuses E3.a* — The expense-on-behalf path duplicates what alt flow E3.a already references (admin-entered expense). Documenting it here makes the symmetric labour-on-behalf path discoverable, but the expense half could remain in E3.a and only the labour half become new text.

**Postconditions:**
- A labour entry or expense exists under the target employee's `user_claimant_id`, in the period containing the entry date, status `approved`.
- Audit-log row records the admin as actor and the employee as the data subject.

**Why this exists:** Operations reality — not every claim cycle has the employee available to enter their own time, and contractor invoices often arrive after the engagement ends. The auto-approve behaviour is intentional: an admin acting on someone's behalf is implicitly already reviewing.

**Keep or drop:**
- *Pros for keeping:* The labour-on-behalf path is genuinely undocumented (UC-E1 is employee-only). The auto-approve behaviour is non-obvious and is worth pinning down — currently a reader could think the entry sits in the review queue. Brings labour and expense on-behalf into a single symmetric UC.
- *Pros for dropping (or merging):*
  - **Option: fold into UC-E1 / UC-E3 as alt flows.** UC-E3 already has `E3.a Admin-entered expense`; UC-E1 could grow a parallel `E1.c Admin-entered labour`. That keeps each entity's UCs self-contained, at the cost of duplicating the auto-approve note in two places.
  - **Option: fold into UC-R1.** Both are reviewer actions in some sense — the admin is reviewing and entering in one step. But "log on behalf" is data-entry, not queue-processing, so this fit is weaker.

---

## UC-R4 — Jump to a project or employee via the global search [DRAFT]

**Actor:** Admin
**Trigger:** Admin knows the name (or partial name) of a project or employee and wants to navigate there without scrolling through lists.
**Preconditions:** Admin is authenticated; at least one project or employee exists.

**Main flow:**
1. Admin types into the search input in the top nav (`#project-search` in `public/admin.js`). After a 180ms debounce, the SPA fires `/api/projects?q=...&limit=6` and `/api/users?q=...&limit=6` in parallel.
2. A dropdown shows up to 6 projects (with type pill and claimant name) and up to 6 employees (with role and email), grouped by section.
3. Admin clicks a result. The SPA navigates: clicking a project calls `selectProject(...)`, clicking an employee calls `selectUser(...)` — both update `location.hash` and re-render. The search bar resets.

**Alt flows:**
- *R4.a Escape to close* — Pressing `Esc` clears the input and hides the dropdown.
- *R4.b Click outside* — Clicking outside the dropdown hides it; clicking back into the input re-shows the last results.
- *R4.c No matches* — Dropdown shows `"No matches."`.
- *R4.d Stale-response guard* — If the user keeps typing while a request is in flight, results from earlier queries are discarded (the `lastQuery` check in the renderer).

**Postconditions:**
- User has navigated to the chosen project or employee detail page. No data is mutated.

**Why this exists:** Linear scanning of the project and employee lists becomes painful past a handful of rows; the search bar is the only fast-jump affordance in the app. Lives in the top nav so it's available from every admin tab.

**Keep or drop:**
- *Pros for keeping:* The search is in the top nav of every admin page — i.e., it's the most-visible piece of UI not yet documented. Pinning down the "what does the search cover" (projects + employees, not expenses, evidence, or audit-log) prevents future readers from assuming it's global.
- *Pros for dropping:* Pure navigation, no business semantics. `use-cases.md` already doesn't document menu structure or keyboard shortcuts; this is plausibly the same class of thing. If the owner wants the UC document focused on T661-claim flows, this is one of the more droppable entries (alongside UC-A9 audit-log).
