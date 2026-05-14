# UI usability review

_2026-05-14, against branch `worktree-agent-aeb9ed76c161e8782`_

This is a cold walkthrough of the admin and employee SPAs as if a brand-new
admin had just enrolled their passkey and is staring at the home page with a
T661 they need to file. Findings prioritized by impact × confidence.

## Top recommendations (ranked)

1. **The active-claimant selector lives only under "Projects."** `public/admin.js` → "Projects" tab (`#claimants`). A new admin who opens Overview, Review queue, T661 exports, or Audit log first has no way to scope to a claimant from those tabs — and worse, Overview / Review / Audit silently aggregate across *all* claimants while Projects / Exports / Employees use the per-claimant scope. Fix: hoist the claimant picker into the page header (next to the user/sign-out controls) so it's visible from every tab, and have Overview, Review queue, and Audit log honor it.

2. **"Amount (cents)" / "Amount (¢/yr or ¢/hr)" inputs everywhere.** `public/admin/employees.js:37,204,242`, `public/admin/projects.js:570`, `public/employee/forms.js:152`, `public/employee/activity.js:107`. A user invoicing a $12.50 lunch must type `1250`, and a salary of $95,000/yr is `9500000`. This is implementation jargon leaking into UI and is a near-certain source of misentered figures. Fix: accept dollars (decimal) in the input, label it "Amount" with the claimant's currency suffix, and multiply by 100 on submit. The internal storage in cents can stay.

3. **Closing a fiscal period has no confirmation and no warning.** `public/admin/projects.js:141` renders a plain `Close` button; the click handler calls the API immediately with no `confirm()` and no tooltip. The README itself flags this as a high-stakes irreversible-ish action ("blocks edits and deletes to all labour, expense, and evidence rows in that period"). Fix: add a confirmation dialog that names what gets locked (labour, expenses, evidence) and shows the count of rows that will become read-only, mirroring the wording on the Deactivate employee flow.

4. **Review queue shows raw IDs instead of names.** `public/admin/review.js:18-21` renders `<td>${e.project_id}</td><td>${e.user_claimant_id}</td>` — the columns literally say "Project" and "UC" with numeric values. The reviewer can't tell whose hours they're approving without cross-referencing another tab. Fix: include `project_title` and `user_name` in the labour/expense list responses (most other list endpoints already join these) and render them; drop the "UC" column header (jargon) entirely.

5. **No "first-run" empty state for a brand-new admin.** A fresh database has zero claimants. The admin lands on Overview, which renders "0 hours / 0 contributors / 0 pending" with no guidance. Switching to Projects shows a `<select>` whose only option is `— select —` with a small `+ New` button buried in the card head. Fix: when `state.claimants.length === 0`, replace the Overview body with a getting-started checklist (Create your first claimant → Add a fiscal period → Onboard employees → Create a project → Generate a T661) and link each step directly to the relevant form. This is the single biggest discoverability gap for a cold user.

6. **The global search box is the only way to reach a project's detail page from the header — but its placeholder hides that.** `public/admin.js:94` ships placeholder `"Search projects & employees…"` and `public/style.css:141-148` makes it look like a generic filter. New admins do not realize it's the primary navigation into a project's narrative / assignment / log-on-behalf surface. Plus the dropdown only shows up to 6 results, which is fine, but there is no "see all" overflow. Fix: rename placeholder to "Jump to project or employee…", show an arrow/icon, and add a "See all projects" link to the bottom of the dropdown.

7. **Invite-link UX exposes the magic link via `alert()`.** `public/admin/employees.js:137` opens a native `alert()` containing the magic-link URL, purpose, and expiry. There is no copy-to-clipboard button, the URL wraps unselectably on narrow viewports, and the email-also-sent path is hidden in parentheses. Fix: replace with a modal/card that has a "Copy link" button, the expiry as a relative time, and a "Sent to <email>" confirmation when SMTP is configured.

8. **Tables are not mobile-usable; the README's "phone access via magic link" pitch oversells the SPA.** `public/style.css` has only two `@media` breakpoints (820px stacks `two-up`; 680px wraps the header and shrinks the chart). The activity, review, audit, employees, and project tables have many columns and no horizontal-scroll wrapper or column-collapse rules, and the search box keeps its `width: 18rem` even when the header has already wrapped. Realistically the employee tabs ("Log labour", "Submit expense") are the only mobile-relevant flows — they should be the most polished but the form `.grid` still expects ≥180-pixel columns and the bar chart's day labels lose readability under ~350 px. Fix: wrap `<table>` in an `overflow-x: auto` container, hide non-essential columns under 600 px, and use `width: 100%` on the nav search input below 820 px.

9. **Approve / reject buttons in the review queue have no batch action.** The use-cases doc (UC-R1 alt flow R1.a) calls out "bulk approve a filter-defined batch in one action" but `public/admin/review.js` only has per-row buttons and no project/employee filter at all. With realistic volume (the seed creates ~150 labour entries) the per-row approval is several hundred clicks. Fix: add row-level checkboxes, a "select all visible" header checkbox, a project/employee filter dropdown, and an "Approve selected" / "Reject selected" action bar.

10. **Hash-route gotcha: the "claimants" tab is labeled "Projects."** `public/admin.js:30` whitelists `claimants` and `users` as tab keys but the tab button labels are "Projects" and "Employees" (lines 88, 89). A power user who bookmarks `#claimants/3` later sees the URL contradicts the visible tab; a cold user who types `#projects` is silently dropped onto Overview because the hash isn't allowed. Fix: rename the hash keys to `projects` / `employees` (with a one-time migration that rewrites the legacy `claimants` / `users` hash on first load) so the URL matches the label.

## Detailed findings by category

### Discoverability

- **The Preferences page is reachable only by clicking your own name in the header** (`public/admin.js:81`). There's no tab, no kebab menu, and the link is the same color as surrounding text inside a dark gradient bar. Add a small gear / "Settings" entry in the user menu, or expose Preferences in the tab bar for first-time passkey-management.
- **"Add device" vs "Send invite"** (`public/admin/employees.js:77`) — the same column toggles between two completely different actions based on `u.status`. A new admin probably can't predict which one they will see. Split into two explicit buttons or add an icon/tooltip.
- **Project drill-down requires clicking a table row, but the row offers no chevron / link styling beyond `cursor: pointer`.** (`public/style.css:319-320` plus `data-open-project` rows in `public/admin/projects.js`.) Add a trailing `›` glyph or make the title a real `<a href="#claimants/N">`.
- **Audit-package "Build" → wait → reload** (`public/admin/exports.js:38-41`) doesn't indicate progress. There's no spinner; the user re-clicks and gets a no-op. Disable the button + show "Building…" while in flight.
- **The "Send invite" magic-link can be re-issued for *active* users too.** The button label changes to "Add device" but the underlying purpose is different. Without docs, an admin who clicks "Add device" for themselves might not know they're enrolling a *second* passkey on a different machine, not resetting the existing one. Inline-help one-liner next to the button.

### Click depth

- **Logging labour for an absent employee is a multi-tab dance.** UC-E1 / UC-A3 imply admins can do it. They can, but only from a project detail page (`renderLogOnBehalfCards`). Discovering it requires: Overview → Projects tab → pick claimant → click project row → scroll past narrative → "Log labour" card → "+ New". Five clicks. Surface "Log labour on behalf" from the employee detail page too (already loaded with the user_claimant_id), so it's two clicks from Employees → row → form.
- **Adding compensation history is buried in a collapsed `<details>` inside a sub-card inside an inline-expansion of the All-employees row.** (`public/admin/employees.js:236-247`.) Discovery cost is high for a routine A3.b "mid-year raise" task.
- **Generating a T661 takes the user to a tab where the period selector is unlabeled and the "draft" checkbox is presented inline with a one-line muted hint.** (`public/admin/exports.js:13-19`.) A new admin won't know whether to leave `draft` on or off. Reword: "Draft (allows export against an open period)" and default to `draft` based on whether the selected period is open or closed.

### Jargon / labels

- **"UC" column header in the Review queue** (`public/admin/review.js:14`). "UC" = "user_claimant" — implementation jargon. Replace with "Employee."
- **"Specified employee" checkbox** (`public/admin/employees.js:39, 206, 226`). The term is in ITA s.248(1) and is required vocabulary, but the UI offers zero hover-help. Add a `title` / `aria-describedby` tooltip explaining what flagging it does (caps their hourly rate at the per-year specified-employee cap on T661 line 307).
- **"SR&ED method (locked once set)" / "proxy" / "traditional"** (`public/admin/projects.js:37-38`). New admins won't know which to pick. Add a one-sentence comparison link or contextual help text: "Proxy = 55% of labour cost is auto-claimed as overhead; Traditional = you itemize overhead expenses."
- **"Comp type" / "¢/yr or ¢/hr"** (`public/admin/employees.js:34, 37`). Rename "Comp type" → "Pay type", and offer the input as dollars with a unit suffix ("/yr" or "/hr") that flips with the type select.
- **"Reporting currency" defaults to "CAD" without explanation** (`public/admin/projects.js:36`). Clarify: "All T661 figures will be reported in this currency. Foreign-currency expenses will be converted at the entered FX rate."
- **`fiscal_period_id`** is shown as a plain numeric column in the Exports table (`public/admin/exports.js:28`) where each row has `<td>${x.fiscal_period_id}</td>`. Replace with the period's date range — admins won't memorize numeric period IDs.

### Surprise / hidden behavior

- **Closing a period: see top-recommendation #3.** No confirmation and no in-UI hint that submissions get blocked.
- **Admin-submitted labour/expenses auto-approve** (per README) but the on-behalf forms in `public/admin/projects.js:505-588` give zero visual hint. A reviewing admin who logs labour for someone else may not realize the entry skipped pending. Show a "Will be saved as approved" badge above the submit button when an admin is the actor.
- **Pending entries can be edited by the employee but approved entries become read-only** (`public/employee/activity.js:23,45`). The lock state is shown as a tiny grey `<span class="muted">locked</span>`. Tell the user *why* it's locked (rejected, approved, or closed period — currently the UI lumps "approved" and "closed-period" into the same "locked" state).
- **Removing an employee from a project ≠ deactivating them.** `Remove` (project detail) and `Deactivate` (employees tab) have different scopes but similar-looking secondary buttons; the confirmation dialog in `public/admin/projects.js:670` is descriptive while the equivalent in employees.js:151 is much heavier. Aligning the two would reduce risk of an admin nuking a person when they meant to take them off one project.
- **Editing a project narrative auto-creates a revision snapshot** (footer hint in `public/admin/projects.js:465`), but only the muted "Narrative edits create a new revision snapshot" line surfaces it, and there is no UI to *view* prior revisions. Either show a "History" tab on project detail or remove the muted hint (which raises a question it doesn't answer).

### Empty / loading / error states

- **Most "loading" placeholders are `<p class="empty">Loading…</p>`** (`overview.js:4`, `review.js:4`, `audit.js:4`, `employees.js:54`, project detail). The same `.empty` class is used for "no data" — so a user can't tell mid-load from a known-empty result without watching the network tab.
- **Errors throughout are `alert(e.message)`.** Native dialogs interrupt and offer no remediation. Add an inline error banner per card.
- **The Employees tab races: `renderAllUsersTable` returns a `<div>Loading…</div>` and kicks off a separate `api()` call that swaps the contents in a callback** (`public/admin/employees.js:52-55`). On a slow refresh you can re-click Edit before the row even exists. Awaiting before render would be simpler and bug-free; see "Possible bugs" below.
- **Exports tab with no claimant selected says "Select a claimant first"** (`public/admin/exports.js:5`) but no link to *go* select one. Combined with the top-rec #1 (selector buried under Projects), this is dead-end UX.

### Mobile / narrow viewport

- See top-recommendation #8. Specifically: the `nav.tabs` flex-wraps but the search input doesn't shrink, so on narrow viewports the search input pushes the last tab to a new line with awkward whitespace. The `header h1` ::before SVG icon and the role pill compete for space in the header.
- The chart's day labels lose the `MM-DD` text under 400 px because `b.date.slice(5)` is rendered alongside the day initial — fine but the chart `height: 200px` rule (at 680px breakpoint) still doesn't help the bar-value badges from overlapping the label row when the column is narrow.

### Consistency

- **Three different "new X" patterns coexist:** (a) toggle-card-into-view (claimants, periods, projects, log-on-behalf), (b) modal-ish inline expansion (Employees edit row), and (c) fully separate page (Employee shell: Log labour, Submit expense, Add evidence are top-level tabs). Pick one. The employee shell's "every entry-form is its own tab" approach is the most cold-user-friendly; the admin's "click + New to reveal a hidden form" requires the user to think the button is a tray-flap.
- **Project detail and Employee detail headers differ visually:** project uses `<a href="#" id="back-to-projects">` with a JS handler that intercepts and writes `location.hash = 'claimants'` (`public/admin/projects.js:395`), employee detail uses a plain `<a href="#users">` (`public/admin/employees.js:315`). The plain anchor is better — drop the JS interceptor.
- **Form button labels are mixed** ("Save", "Save changes", "Create project", "Add", "Generate", "Save labour", "Save expense"). The employee forms say plain "Save" (forms.js); admin forms vary. Standardize on the verb-object pattern ("Save labour entry", "Save expense", "Create project").
- **The two "log labour" surfaces on the admin side (project-detail "Log labour" and a hypothetical employee-detail one)** look different even though they should be the same. Extract `renderLogOnBehalfCards` into a shared component once a second site appears (deferred but worth flagging).

### Affordances

- **Table rows in `.rows-clickable` are clickable, but rows in other tables look identical** because both get a `tr:hover td { background: #f8fafc }` hover (`public/style.css:318`). A user can't tell which tables drill in. Reserve hover-fade for clickable tables only, or add a chevron column.
- **`a` elements with `id="back-to-projects"` have `text-decoration: none; class="muted"`** (`public/admin/projects.js:334`) so they look like plain text. A user might not realize the breadcrumb is interactive.
- **Disclosure `<details>` summaries are styled `class="summary-link"`** (blue, semibold, no caret). Good — they look like buttons — but the bare `<details>` for the "Audit log" / "Compensation history" reverts to a default grey caret, an inconsistent affordance.
- **The `tabBtn` for the active tab has a blue underline-y bar but inactive tabs are visually flat** — fine on the admin shell but on a narrow viewport the wrapping tabs leave the search input alone on its own row with no visual relation to the tab bar.

## Things that work well

A short list of UI choices that are deliberately good — keep them through any refactor.

- **Hash routing makes every detail page bookmarkable.** Refreshing on `#claimants/3` lands you back where you were. The "back to list" breadcrumbs are anchor links to `#claimants` / `#users` so the browser back button works naturally.
- **The Overview hero is a great first-glance summary**: this-week hours, contributors, pending labour, pending expenses, plus a daily bar chart with the today-column visually distinct. The accompanying "Recent activity" feed with Open-row expansion is a very effective drill-in.
- **Inline activity-detail expansion** (`public/api.js` `wireActivityDetails` + `fetchActivityDetail`) keeps context: clicking Open on a labour-feed row pops in the entity, its linked evidence, an attach-more-evidence form, and the audit-log trail — all without a page nav. This is the strongest single piece of UX in the app.
- **Smart defaults for "Add period."** `suggestPeriodDates` (`public/admin/projects.js:203`) prefills the next sequential year. New admins don't have to math fiscal-year-end + 1 day.
- **Authentication resilience is invisible to the user.** The transparent refresh-on-401 retry in `public/api.js:60-76` plus the warm-start refresh in `public/app.js:17-24` means closing the browser doesn't re-prompt for the passkey — a real win for a tool that admins live in for a week each quarter.
- **The unified search bar covers projects and employees in one input** with two sections in the dropdown — once a user finds it (see top-rec #6), it's the fastest navigation pattern in the app.
- **Project narrative fields use sensible placeholders** ("What technological advancement is this project trying to achieve?") that prompt the right SR&ED-framed answer rather than letting users guess what CRA wants.
- **Per-claimant currency surfacing in the log-on-behalf expense form** (`public/admin/projects.js:571`): the currency input is pre-filled with the claimant's `reporting_currency` and the FX-rate label says "(if not <ccy>)". Nice contextual default.

## Possible bugs noticed

These look like real defects, not usability issues; calling out separately:

- **Employees tab race condition.** `public/admin/employees.js:52-87`: `renderAllUsersTable()` returns a placeholder and asynchronously fetches users, then `redrawAllUsers(ctx)` is called from the `.then()` callback with `ctx = currentCtx`. If the admin clicks Edit on a row before the fetch completes (rare in practice), the click target doesn't exist yet. More worryingly, switching tabs and back can leave `allUsers` stale because the module-level `let allUsers = []` survives — the second render still shows the old list while the new fetch is in flight. Fix: `await` the fetch inside `render()`, drop the module-level mutable state.
- **`onHashChange` early-return drops state.** `public/admin.js:55`: if the new hash isn't in `ALLOWED_TABS` the function returns silently — but the URL has already changed. The user is left looking at the old tab while the URL claims something else. Either revert the hash or fall through to the overview default.
- **`bindForm('#export-form', ...)` reads `fd.get('draft') === 'on'`** (`public/admin/exports.js:53`) but the checkbox is `checked` by default and has no explicit `value` attribute — modern browsers do submit `"on"` so this works, but the `checked` attribute combined with the muted "Draft means the period need not be closed" copy is misleading: passing `draft: false` against an open period currently returns a 422, not the intuitive "promote this draft", which is confusing UX even if it isn't strictly a bug.
- **Field-of-science is presented as a free-text input** (`public/admin/projects.js:104, 437`) even though CRA Form T661 expects a categorical code (field-of-science/technology classification from the T4088 guide). Exports will accept anything the admin types, including misspellings, which would not match what the tax preparer expects to paste into the actual form.
- **`renderActivityDetail`** for evidence shows `Uploaded by: user #{e.uploaded_by_user_id}` as a raw numeric ID (`public/api.js:420`). Should be the name (or hide the line).
- **`audit.js` filter facets reset on every render.** `data.facets.entity_types` is rebuilt from each filtered response — if you filter to `action=approve`, the entity-type dropdown then only contains entity types that have approve actions, which can make it impossible to switch back without clearing manually. The facets should come from the unfiltered universe.
- **`bindList` in `employees.js:91` calls `currentCtx = ctx;`** but `renderUsersTab` also runs `renderAllUsersTable()` synchronously which depends on `currentCtx`. On first render the placeholder fetches and then calls `redrawAllUsers()` which reads `currentCtx`. Works in practice because the fetch finishes after `bindList` runs, but the ordering invariant is implicit. Worth de-globalizing.
