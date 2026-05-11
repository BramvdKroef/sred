# SR&ED Tracker — Use Cases

## 1. Purpose

An in-house tool for capturing the data a Canadian SR&ED claim requires: eligible labour, supporting evidence, and eligible expenses, organized per claimant, fiscal year, and SR&ED project. The tool supports the admin in producing T661-ready reports and an audit-ready evidence package.

## 2. Actors

- **Admin** — Operates the tool on behalf of the company. Configures claimants, projects, fiscal periods, and employee records. Reviews submitted data, runs the T661 export, and assembles the evidence package for CRA review.
- **Employee** — A person whose work may qualify for SR&ED. Logs hours against projects, uploads contemporaneous evidence, and submits eligible expenses.

A *Technical Reviewer / Project Lead* role (to attest that work is SR&ED-eligible) is out of scope for v1; the Admin performs review.

## 3. Domain Entities

- **Claimant** — A legal entity that files its own T661. Has a Business Number, fiscal year end, and its own pool of employees and projects. The tool supports multiple claimants concurrently.
- **Fiscal Year / Claim Period** — A claim window for one claimant, bounded by the claimant's fiscal year. Determines which labour, evidence, and expense records roll up into a given T661.
- **SR&ED Project** — A project belonging to one claimant. Carries the technical narrative required by T661 Part 2 (advancement sought, uncertainty, work performed) plus a start/end date and status.
- **Employee** — A person belonging to a claimant, with compensation data (annual salary or hourly rate, effective dated) and a *specified employee* flag (per ITA s.248(1) — affects the wage cap on Part 3 line 307).
- **Labour Entry** — Hours worked by one employee on one project on one date, with a short description of the work done. The basis for the labour cost line of T661.
- **Evidence** — A contemporaneous artifact attached to a project, labour entry, or expense. Types include uploaded files (design docs, test results, screenshots), external links (commits, tickets), and free-form notes.
- **Expense** — A non-labour cost categorized per T661 expenditure type: materials consumed/transformed, SR&ED contract, third-party payment, or overhead (if traditional method is used).

## 4. Use Cases

### UC-A1 — Configure a claimant

**Actor:** Admin
**Preconditions:** Admin is authenticated.
**Main flow:**
1. Admin creates a Claimant record: legal name, Business Number, fiscal year end (month/day), reporting currency, SR&ED method (proxy or traditional). The SR&ED method is locked once set — it cannot be changed for this claimant.
2. Admin sets the first claim period (start/end dates aligned with the fiscal year).
3. Admin saves; the claimant becomes available for further configuration.

**Postcondition:** A claimant exists and is ready to receive employees, projects, and entries.

---

### UC-A2 — Define a fiscal year / claim period

**Actor:** Admin
**Preconditions:** A claimant exists.
**Main flow:**
1. Admin selects a claimant and opens its fiscal-period list.
2. Admin creates a new period (start date, end date, status = open).
3. Admin can close a period once the T661 has been filed; closed periods reject new labour/evidence/expense entries.

**Alt flows:**
- *A2.a Reopen a period* — Admin reopens a closed period (e.g., to add late-discovered evidence before reassessment). Reopening is logged.

**Postcondition:** Submissions are now bucketed against the active period.

---

### UC-A3 — Onboard an employee

**Actor:** Admin
**Preconditions:** A claimant exists.
**Main flow:**
1. Admin looks up the person by email. If no Employee record exists, Admin creates one (name, email, employment start date); otherwise the existing person record is reused.
2. Admin attaches the person to the claimant with a role/title and a compensation row: annual salary OR hourly rate, with effective-from date. (Compensation can be updated later with a new effective date; history is preserved.)
3. Admin flags whether the employee is a *specified employee* under this claimant for the current period.
4. Admin sends the invite (or, if the person already has access via another claimant, no new invite is needed); the employee can now log work under this claimant.

**Alt flows:**
- *A3.a Cross-claimant employee* — One person identity may be attached to multiple claimants. Each attachment has its own compensation history, specified-employee flag, and project assignments. The person sees a single unified login (see UC-E4) but data is partitioned per claimant on the back end.
- *A3.b Compensation change mid-year* — Admin adds a new comp row with a new effective date. Labour cost calculations use the comp row in effect on each labour-entry date.

**Postcondition:** The employee can authenticate and is scoped to the claimant(s) they're attached to.

---

### UC-A4 — Create or edit an SR&ED project

**Actor:** Admin
**Preconditions:** A claimant exists.
**Main flow:**
1. Admin opens the claimant's project list and creates a project.
2. Admin enters the T661 Part 2 narrative fields: title, field of science/technology, project start date, technological advancement sought, technological uncertainties addressed, work performed.
3. Admin sets the project status (planned / active / completed) and the period(s) the project belongs to.
4. Admin saves; the project becomes available for labour, evidence, and expense entries.

**Alt flows:**
- *A4.a Edit existing project* — Admin updates the narrative; revisions are versioned so the version-as-filed can be retrieved during an audit.

**Postcondition:** Employees assigned to the project can log work against it.

---

### UC-A5 — Assign employees to a project

**Actor:** Admin
**Preconditions:** Project and employee both exist under the same claimant.
**Main flow:**
1. Admin selects a project and adds one or more employees as participants.
2. Admin can remove a participant; existing entries remain attributable to that employee but no new entries can be added.

**Postcondition:** The project appears in each assigned employee's project picker.

---

### UC-E1 — Log labour

**Actor:** Employee
**Preconditions:** Employee is assigned to at least one project in an open period.
**Main flow:**
1. Employee opens the labour entry form.
2. Employee selects a project, a date, and enters hours and a short description of the work done.
3. Employee saves the entry. The system records it against the open period containing that date.

**Alt flows:**
- *E1.a Edit prior entry* — Employee edits or deletes an entry within the open period. Edits to entries in a closed period are blocked.
- *E1.b Date outside open period* — System rejects the entry and prompts the admin to open the appropriate period.

**Postcondition:** Hours are available for review and roll up into the T661 labour cost calculation.

---

### UC-E2 — Upload evidence

**Actor:** Employee
**Preconditions:** Employee can log against the relevant project.
**Main flow:**
1. Employee opens the evidence form for a project (or attaches evidence directly to a labour entry).
2. Employee adds one or more items: file upload, external URL (e.g., commit, ticket, doc), or a dated note.
3. Each item carries a date (defaulting to today), a short caption, and an optional link back to a labour entry.
4. Employee saves; the system stores the artifact and records the upload timestamp (contemporaneity matters).

**Postcondition:** Evidence is attached to the project and the period, available for the audit package.

---

### UC-E3 — Submit an expense

**Actor:** Employee
**Preconditions:** Employee can log against the relevant project.
**Main flow:**
1. Employee opens the expense form.
2. Employee selects project, date, expense category (material / contractor / third-party payment / other), amount, currency, and description.
3. Employee attaches the receipt or invoice as evidence.
4. Employee submits; the expense enters the *pending review* state.

**Alt flows:**
- *E3.a Admin-entered expense* — For contractor invoices or material POs handled centrally, Admin enters the expense directly and skips employee submission.

**Postcondition:** Expense is queued for admin review and, once approved, rolls into the T661 expenditure totals.

---

### UC-E4 — Review own contributions

**Actor:** Employee
**Preconditions:** Employee has logged at least one entry.
**Main flow:**
1. Employee opens their dashboard.
2. Employee sees their labour, evidence, and expenses for the current period (and can switch to prior periods) with totals. If the employee is attached to multiple claimants, the dashboard presents a unified view across all of them, with a claimant column/filter; individual entries remain partitioned by claimant on the back end.

**Postcondition:** Employee can self-check and amend pending entries.

---

### UC-R1 — Review submissions

**Actor:** Admin
**Preconditions:** A period has employee submissions.
**Main flow:**
1. Admin opens the review queue for a claimant and period.
2. Admin sees pending labour, evidence, and expenses, filterable by project and employee.
3. Admin approves, rejects (with a reason), or edits each item.
4. Rejected items return to the employee for correction.

**Alt flows:**
- *R1.a Bulk approve* — Admin approves a filter-defined batch in one action.

**Postcondition:** Only approved items contribute to T661 totals.

---

### UC-R2 — Generate T661 export

**Actor:** Admin
**Preconditions:** Period is closed (or admin is producing a draft).
**Main flow:**
1. Admin selects a claimant and period.
2. System computes per-project totals:
   - **Labour cost** — sum over approved labour entries of `hours × applicable hourly cost`, where hourly cost derives from each employee's effective compensation, with the *specified employee* wage cap applied where flagged.
   - **Materials** — sum of approved material expenses.
   - **Contracts** — sum of approved SR&ED contract expenses.
   - **Third-party payments** — sum of approved third-party payments.
   - **Overhead** — proxy = 55% × labour (per claimant's chosen method); traditional = sum of overhead expenses.
3. System produces an export that maps each total to its T661 line, plus a per-project Part 2 narrative section.
4. Export format is a structured file (CSV/JSON) plus a human-readable summary (PDF or Markdown) for the tax preparer.

**Alt flows:**
- *R2.a Draft export* — Admin runs the export on an open period to preview totals before closing.
- *R2.b Comparative export* — Admin exports two periods side by side to support continuity narratives.

**Postcondition:** Tax preparer has the data needed to fill T661.

---

### UC-R3 — Export audit evidence package

**Actor:** Admin
**Preconditions:** T661 has been generated (or is being prepared) for a period.
**Main flow:**
1. Admin requests the evidence package for a claimant and period.
2. System produces a bundle containing, per project:
   - The Part 2 narrative as filed (versioned).
   - All approved labour entries with date, employee, hours, description.
   - All evidence items with upload timestamps and links/files.
   - All approved expenses with attached receipts.
   - The labour cost calculation worksheet showing hours × rate per employee.
3. The bundle is downloadable as a zip with a manifest.

**Postcondition:** Admin can hand the package to CRA on request, demonstrating contemporaneous documentation.

---

## 5. Cross-Cutting Requirements

- **Period immutability** — Once a period is closed and an export has been generated, the system preserves the as-exported snapshot even if records are subsequently edited.
- **Audit log** — Every create / edit / approve / reject action is logged with user, timestamp, and before/after values. Critical for CRA defensibility.
- **Authorization scope** — Employees see only their own data and projects they're assigned to, across all claimants they're attached to (unified view). Admins see all data for the claimant(s) they administer.
- **Contemporaneity** — Upload timestamps for evidence are recorded server-side and shown in the audit package, since CRA weighs contemporaneous documentation heavily.
- **Currency** — Each claimant has a reporting currency; expenses entered in other currencies are converted at a documented rate on the expense date.
- **Specified employee wage cap** — Hardcoded per calendar year in the codebase, indexed by the calendar year of the labour entry. New cap values are added by code change as CRA publishes them.
- **Evidence retention** — All labour, evidence, and expense records (and their attached files) are retained for at least 6 years following the end of the fiscal year in which they were filed. Deletion before that horizon is blocked; after it, retention is governed by the audit log rather than user action.

## 6. Out of Scope (v1)

- Direct e-filing to CRA — the tool exports for a tax preparer, it does not submit T661.
- Capital expenditure tracking — no longer eligible for SR&ED ITC (post-2014); not modeled.
- Provincial credit calculations beyond what falls out of the T661 inputs.
- A Technical Reviewer role distinct from Admin.
- Time imports from external systems (Jira, GitHub, payroll); manual entry only in v1.

## 7. Decisions

These were open during drafting; decisions captured here:

- *Specified employee wage cap* — Hardcoded in the codebase, indexed by calendar year. Updates ship as code changes when CRA publishes new caps.
- *Overhead method* — Locked at the claimant level when the claimant is created; not switchable afterwards.
- *Multi-claimant employees* — One person identity, attached to each claimant separately, presented as a unified view to the employee.
- *Evidence retention* — 6 years following the end of the fiscal year in which records were filed. Deletion is blocked within that window.
