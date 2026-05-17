# Architecture review

_2026-05-14, against branch `master`, commit `d533fc3`_

## Status

**Mostly addressed** as of 2026-05-16. The top-3 recommendations are all done; the long-tail P3 splits are still open.

- **Closed:** `mutateAndAudit` extracted to `src/lib/route-helpers.js` and swept across ~25 callsites (commit `0dcfdf0`). `public/api.js` split into `session.js` / `fetch.js` / `dom.js` / `features.js` — `api.js` is now a 16-line re-export shim. `public/admin/projects.js` (771 → entry + 6 sub-modules under `public/admin/projects/`) and `public/admin/employees.js` (663 → entry + 7 sub-modules under `public/admin/employees/`) split. Inline `style="…"` attributes reduced from 109 → 1 (the data-driven bar-chart height). Status-pill mapping consolidated via `pillClassFor()` / `statusPill()`. Unused `dollarInput` / `$$` exports removed.
- **Still open (P2/P3):** Split `src/routes/auth.js` (295 LOC) into `auth.js` (ceremonies) + `me.js` (`/api/me*` endpoints) — `src/routes/me.js` does not exist on disk. Split `src/lib/format.js` (723 LOC) along the single-period / compare seam. Extract `buildUpdate(table, id, updates)` helper for the labour/expenses/users PATCH partial-update builders. Extract `sendFormat(res, baseName, { json, csv, md, pdf })` for the exports/compare download dispatcher. Promote `MAX_UPLOAD_BYTES` and `BUNDLES_DIR` to `config.*`. Add startup `wage-caps` future-year check (warn if `LATEST_YEAR < currentYear + 1`). Optional `repositories/` layer if the schema keeps growing. Toggle-card consolidation in `public/admin/*`.

## Summary

The codebase is in healthy structural shape for a 12-month-old vanilla-JS Express
app: ~8,500 LOC of source, a clean acyclic import graph (no cycles found across
~40 modules), a one-screen routes layout, and a real shared-helpers file
(`src/lib/route-helpers.js`) that earns its keep — every helper has 2+ callers.
The test tree mirrors `src/` accurately. There are no glaring "wrong drawer"
files. The hot spots are all on the frontend — the SPA tabs have grown into the
500–800 LOC range and `public/api.js` is, as the TODO already notes, a grab bag.

Top 3 recommendations (full rationale below):

1. **Split `public/api.js`** along the four seams the TODO already names
   (session, fetch, DOM helpers, activity-detail panel). It is the single
   highest-fan-in file in the SPA and the only place every tab touches.
2. **Extract a `mutateAndAudit(table, id, mutator, { actor, action, entityType })`
   helper** in `src/lib/`. The `load before → mutate → reload after → audit`
   shape recurs ~25 times across routes and is identical down to the variable
   names; the saving is real once you factor in the patch-style SQL builder
   that two routes already hand-roll. The TODO has this as P3; it's actually
   higher leverage now that 18 integration tests pin the contract.
3. **Lift inline edit-row rendering out of `public/admin/projects.js` and
   `public/admin/employees.js` into per-form modules.** Both files are
   pushing 700+ LOC and 80 % of that is repeated `renderXForm` /
   `bindXForm` / `wireXToggle` boilerplate that has the same shape across
   three or four entities.

## Module structure

The five top-level drawers (`auth/`, `db/`, `lib/`, `routes/`, `scripts/`) hold
up cleanly. Nothing belongs to a wrong drawer. A few observations:

- **`src/routes/auth.js` is doing two jobs.** Half the file is webauthn /
  refresh / recovery routes (auth-bootstrap); the other half is `/me`,
  `/me/projects`, `/me/periods`, `/me/credentials`, `/activity`
  ("identity / activity feed" endpoints that just happen to be auth-gated).
  These are conceptually different concerns — auth ceremonies vs.
  current-user reads. Worth splitting into `routes/auth.js` (ceremonies +
  refresh + recovery) and `routes/me.js` (everything `/me*` + `/activity`).
  See `src/routes/auth.js:139-268`.
- **`src/lib/csp.js`** is one of three modules in `lib/` that's strictly a
  middleware (`csp.js`, `rate-limit.js`, and the middleware functions in
  `errors.js`). They sit in `lib/` because there's no `src/middleware/`
  drawer. At 3 modules it's not yet worth a split, but if a fourth lands
  (e.g. request-logging) consider it. No action today.
- **`public/` is half SPA, half shared helpers** as you flagged. The
  `public/api.js` split — session.js / fetch.js / dom.js / activity.js — is
  the right shape. Today `api.js` mixes:
  - session storage (lines 1–25, 27–49): `getJwt`/`setJwt`/`getRefresh`/
    `setRefresh`/`setSession`/`clearSession`/`tryRefresh`.
  - fetch wrappers (60–91): `api()`, `apiUpload()`.
  - inline-evidence helpers (93–146): `attachInlineEvidence`,
    `attachInlineReceipt`, `bindEvidenceKindToggle`.
  - error-banner UX (148–217): `showError`, `clearError`, `showTopBanner`,
    `onSubmit`, `bindForm`.
  - the preferences page (219–299): `renderPreferencesPage`. This is
    notable — it's a full SPA tab masquerading as a helper.
  - DOM helpers (301–359): `esc`, `safeHref`, `cents`, `dollarsToCents`,
    `dollarInput`, `lockReason`, `$`, `$$`.
  - week / chart helpers (361–396, 613–630): `currentWeek`, `weekBars`,
    `chartHtml`.
  - the activity-detail expansion panel (398–611): `activityHtml`,
    `wireActivityDetails`, `renderActivityDetail`, plus three inner helpers.
  The TODO's proposed split is correct; I'd additionally peel
  `renderPreferencesPage` out into `public/preferences.js` (it's a tab, not
  a helper) and move `activityHtml` + friends into
  `public/activity-detail.js`. Net result is six small files instead of one
  630-line one, each importable on its own.
- **No new drawer is needed.** The DB layer's coupling to routes is via raw
  `db.prepare` calls; introducing a `repositories/` layer is on the TODO
  (P3) but I wouldn't act on it yet — the SQL is short, well-localised,
  and routinely audited end-to-end. The schema is the main pressure
  source; if the next round of features doubles `JOIN`s in handlers, a
  query-builder or repo layer becomes more attractive.

### Dependency graph

Manually walked every `import` in `src/` and `public/`. The graph is a strict
DAG; **no cycles**.

The shape:

```
src/server.js → routes/index.js → routes/*.js
                                  ↓
                              lib/route-helpers.js, lib/audit.js,
                              lib/errors.js, lib/email.js,
                              lib/t661.js, lib/format.js,
                              lib/wage-caps.js, lib/rate-limit.js,
                              lib/csp.js
                                  ↓
                              auth/*.js (jwt, tokens, webauthn,
                                          refresh, middleware)
                                  ↓
                              db/index.js → config.js
```

```
public/app.js → public/admin.js → public/admin/*.js → public/api.js
              → public/employee.js → public/employee/*.js → public/api.js
```

No back-edges (e.g. `lib/` does not import from `routes/`, `auth/` does not
import from `lib/audit.js` except `refresh.js` which only depends on `audit`,
not vice-versa). `db/index.js` is a single shared leaf and never imports up.

## Abstractions

### Missing abstractions

The TODO already flags one: **load-before / mutate / load-after / audit**.
Concrete repetitions of that exact shape (counted from `src/routes/`):

- `routes/users.js` PATCH (lines 174–206), POST `/deactivate` (208–237),
  POST `/reactivate` (239–266).
- `routes/labour.js` PATCH (98–155), POST `/approve` (168–184), POST
  `/reject` (186–204).
- `routes/expenses.js` PATCH (121–181), POST `/approve` (194–210), POST
  `/reject` (212–230).
- `routes/projects.js` PATCH (65–123).
- `routes/claimants.js` POST (16–53), PATCH (61–105).
- `routes/periods.js` POST `/close`, POST `/reopen`.
- `routes/evidence.js` PATCH (292–334), DELETE (336–355).

A helper of the shape:

```js
function mutateAndAudit(table, id, mutator, { actor, action, entityType }) {
  const before = getEntity(table, id);
  mutator(before);                       // throws on validation failure
  const after  = getEntity(table, id);   // mutator already wrote
  audit(actor, action, entityType, id, before, after);
  return after;
}
```

…would compress every PATCH handler by ~10 lines, eliminate the easy bug
of forgetting to re-read after the UPDATE, and let the test suite cover the
boundary once instead of per-route. The TODO has this as P3; the integration-
test agent has already pinned the contract via `audit-log-writes.test.js`, so
the risk of refactoring is low.

A **second missing abstraction**: the **partial-update SQL builder**. Both
`labour.js` (lines 141–149) and `expenses.js` (167–175) hand-roll the same
`setParts.push(...).join(', ')` machinery, plus `values = [...keys.map, id]`.
Variant 1 (with the `clearReview` branch) is identical between the two files
down to whitespace. Extract:

```js
function buildUpdate(table, id, updates, extraSet = {}) {
  // returns { sql, params } for `UPDATE table SET ... WHERE id = ?`
}
```

…and the two PATCH handlers shrink by ~15 LOC each. Also a `routes/users.js`
candidate (lines 199–200, simpler form).

A **third missing abstraction**: the **download-format dispatcher**. The 4-way
format switch (json/csv/md/pdf) is duplicated 1:1 between `exports.js`
download (168–195) and `compare/download` (123–154). Factor out
`sendFormat(res, baseName, { json, csv, md, pdf })`. Tiny win individually,
but it documents the contract you mention in the TODO (P3 "CSV/MD/PDF export
shapes differ").

A **fourth missing abstraction (frontend)**: the **toggle-card pattern**.
Every "＋ New X" button in `public/admin/projects.js` and
`public/admin/employees.js` has the same `getElementById(btnId).addEventListener
('click', () => form.hidden = !form.hidden)` shape. `projects.js` has four of
these in lines 235–243; `employees.js` repeats the pattern at least three
times. A `bindToggle(btnId, formId)` helper (in the future `public/dom.js`)
turns 4-line stanzas into 1-line calls.

### Premature abstractions

I looked for helpers used by exactly one caller; there aren't many. Two
observations though:

- **`bindForm(selector, handler)`** in `public/api.js:215` is a 3-line
  convenience over `onSubmit(document.querySelector(selector), handler)`. It
  has 5 callers — not premature, but worth knowing it's a tight wrapper.
- **`isOwnerOrAdmin`** (`lib/route-helpers.js:75`) takes a `userClaimantId`
  but does an extra `SELECT` to recover the `user_id`. Every caller
  (`labour.js`, `expenses.js`) has already loaded the parent entity which
  carries `user_claimant_id`. If the contract were "you've already loaded
  the entity, here's the row, am I allowed to touch it?" the function
  could read `entry.user_claimant_id` directly off the entity and avoid the
  extra query. The current shape is more general but pays a query per call.
  Not a refactor blocker; flagged so it doesn't become folklore.

### Leaky abstractions

- **Raw SQL in routes is everywhere**, which is fine for SQLite at this
  scale and matches the project's stated philosophy. The "leak" worth
  noting is **`route-helpers.js` calling `db.prepare` rather than going
  through a repository**. If the repo layer ever happens (TODO P3), the
  helpers should move with it; today the leak is contained because
  `lib/route-helpers.js` is the only `lib/` module that uses SQL.
- **Column-name literals in the frontend.** Surveyed; the SPA reads JSON
  field names but never writes raw column literals back. `period_status`
  is the one that crosses the wire as a column name (added in `lib/route-
  helpers.js` and read in `public/api.js`'s `lockReason` and in three
  list endpoints). Not a leak; it's the route's projection of the column.

## Coupling

### `route-helpers.js`

Everything in it is genuinely shared. Concrete counts of cross-file usage
(`grep -rn` against `src/routes/`):

| Symbol               | Callers (route files)                                                    |
|----------------------|--------------------------------------------------------------------------|
| `getClaimant`        | claimants, expenses                                                      |
| `getProject`         | projects, expenses, labour                                               |
| `getPeriod`          | periods                                                                  |
| `getLabourEntry`     | labour                                                                   |
| `getExpense`         | expenses                                                                 |
| `getEvidence`        | evidence                                                                 |
| `getUserClaimant`    | user-claimants                                                           |
| `getT661Export`      | exports                                                                  |
| `findOpenPeriod`     | labour, expenses, evidence                                               |
| `resolveUserClaimant`| labour, expenses                                                         |
| `isOwnerOrAdmin`     | labour, expenses                                                         |
| `assertEditable`     | labour, expenses                                                         |

`getPeriod`, `getLabourEntry`, `getExpense`, `getEvidence`, `getUserClaimant`,
and `getT661Export` each have **only one caller**. They are still worth
keeping because they're trivial cousins of multi-caller siblings and
homogenise the "wrap-with-notFound" pattern — moving them inline would re-
introduce 8 lines of boilerplate per file. Net: route-helpers is the right
size. Don't shrink it.

`getEntity` itself (line 9) is only used by the eight thin wrappers in this
file — but those exist to give better 404 messages, which is its whole point.
Keep.

### `state.*` in the SPA

Both `public/admin.js` (state object at lines 13–32) and `public/employee.js`
(similar pattern) hand a `ctx = { state, render, reloadAll, … }` to per-tab
modules. Mutations to `state.*`:

- **Through `reloadAll()`** (admin.js:187–223): the canonical path. All
  ancillary state lists (claimants/periods/projects/users/managers) are
  set here. Sound.
- **Through helpers**: `setPeriodFilter` (employee), `selectProject` /
  `selectUser` (admin) — all callable via the `ctx` and they mutate
  `state.tab`, `state.viewingProjectId`, `state.viewingUserId`, then drive
  a hash change.
- **Direct mutation from tab modules**: `state.activeClaimantId` is
  written in `admin.js` (bindHeaderClaimantSelect) and by `selectProject`.
  No tab module writes it directly.
- **Read-mostly**: every tab reads `state.users`, `state.projects`, etc.,
  never writes.

The pattern is consistent enough that I'd call it enforced-by-convention. It
would be useful to document in a one-paragraph comment at the top of
`admin.js` ("Tab modules read `ctx.state`; mutations go through
`reloadAll()` or the navigation helpers — never write directly."). No
restructuring needed.

### `audit()` contract

The contract is `audit(actorUserId, action, entityType, entityId, before, after)`
where `before`/`after` are objects to be JSON-stringified, or `undefined` to
omit. **Searched every mutating route**; coverage is uniform with two patterns
worth flagging:

- **`actorUserId === null`** is allowed (column is nullable). Used by
  refresh-token consume in `auth/refresh.js` (system-detected replay
  revocation, no actor). No problem; it's the documented system path.
- **`after_json` mode for "metadata-only"**: `routes/users.js:298–300`
  audits an invite with `{ email, role }` rather than the user row. Same
  for exports.js evidence-package (`{ bundle_path, size_bytes }`). These
  break the "after = row from DB" assumption but the contract is just
  "captures relevant after-state JSON" so it's fine. Worth one sentence
  in `lib/audit.js`.

No mutating route I read skips `audit()`. The single grey zone is the
`POST /api/labour/bulk-approve` (`labour.js:206–236`) — it audits each row
individually after the bulk UPDATE, which is correct but if the audit
helper threw mid-loop, we'd have a partially-audited approval. The audit
helper itself doesn't throw under any reachable input; not a real risk.

## Complexity hotspots

Five longest source files (LOC):

| File                              | LOC | Notes |
|-----------------------------------|-----|-------|
| `public/admin/projects.js`        | 771 | List view + project detail subview + assignment + revisions + log-on-behalf. Split candidate. |
| `public/admin/employees.js`       | 663 | All-employees table + add-employee form + attach-existing + inline edit + user-detail subview + invite-link modal. Split candidate. |
| `public/api.js`                   | 630 | TODO-listed; see split plan above. |
| `src/lib/format.js`               | 590 | T661 formatters (md/csv/pdf) + compare formatters (md/csv/pdf). Split candidate. |
| `public/admin.js`                 | 428 | Shell + routing + search. Reasonable for the role. |

Recommendations per file:

- **`public/admin/projects.js` (771 LOC).** The file does five distinct
  things: (1) claimants/periods/projects list view, (2) project detail
  subview, (3) assignments management, (4) log-on-behalf forms, (5)
  narrative-revisions card. Natural split:
  - `public/admin/projects.js` — list view + dispatch (≈200 LOC).
  - `public/admin/project-detail.js` — detail view, edit form, revisions
    (≈300 LOC).
  - `public/admin/project-log-on-behalf.js` — the two on-behalf forms
    (≈200 LOC).
  The "log on behalf" sub-flow is the strongest candidate to peel off — it
  has zero overlap with the list view and reuses inline-evidence helpers
  that the form module already imports.
- **`public/admin/employees.js` (663 LOC).** Three logically separate
  things: (1) the All-employees table + add-employee + attach-existing
  forms, (2) the inline edit-user expansion (renderUserEditForm /
  renderAttachmentEditor + their bindings), (3) the User-detail subview
  (renderUserDetail). The invite-link modal (lines 388–432) is fine
  inline. Suggested split:
  - `public/admin/employees.js` — list + add/attach forms + row actions
    (≈300 LOC).
  - `public/admin/employee-edit.js` — inline edit form + attachment
    editors + comp-history bindings (≈250 LOC).
  - `public/admin/employee-detail.js` — the detail view (≈120 LOC).
- **`public/api.js` (630 LOC).** Split per TODO plan; expanded above to six
  files (TODO's four plus preferences-page extraction plus activity-detail
  extraction).
- **`src/lib/format.js` (590 LOC).** Halves naturally along the
  comparative-export seam. Lines 1–219 are single-period formatters; lines
  226–590 are compare formatters + the diff builder. Split into
  `src/lib/format.js` (single-period) and `src/lib/format-compare.js`
  (compare). The shared helpers (`csvCell`, `dollars`, `metaLine`,
  `sectionHeader`, `totalsRow`, `narrativeBlock`) would either move to a
  `format-shared.js` or be duplicated — at ~80 LOC the duplication is
  reasonable, but extraction is cleaner. The tests already split
  (`format.test.js` + `format-compare.test.js`) so the seam is already
  drawn.
- **`public/admin.js` (428 LOC).** Largest portion (lines 320–428) is the
  global search. If a fifth concern (e.g. notifications) lands in the
  shell, extract `public/admin-search.js`. Not yet urgent.

`src/routes/evidence.js` (357 LOC), `src/routes/users.js` (332 LOC),
`src/routes/exports.js` (271 LOC) are within healthy single-file size for
their domain breadth.

## Dead code

Found by grepping each `export …` symbol against the rest of the tree.

**Truly unused (zero importers outside the defining file):**

- `public/api.js:337` — `export function dollarInput()`. No callers in
  `src/`, `public/`, or `tests/`. Was added for "render a dollars-
  denominated `<input>`" but every caller hand-rolls the markup instead.
  **Delete.**
- `public/api.js:359` — `export const $$`. No callers outside the file.
  **Delete.**

**Exported but only used internally (the `export` keyword is misleading):**

- `public/api.js:9-15` — `setJwt`, `clearJwt`, `setRefresh`, `clearRefresh`.
  All four are only called via `setSession` / `clearSession` (lines 18–25).
  Drop the `export` keyword. (They become free in the future
  `public/session.js` extraction, but for today the surface is wider than
  it needs to be.)
- `public/api.js:152`, `:165` — `showError`, `clearError`. Used by
  `onSubmit` (line 207–212) internally; no external callers. Keep
  exports if you anticipate per-page callers will materialise; otherwise
  drop. (Borderline.)

**Internal-only exports that earn their `export`:**

- `src/auth/middleware.js:20` `requireRole` — only `requireAdmin` uses
  it inside the file, but it documents the factory pattern and tests
  could grow to need it. Keep.
- `src/lib/route-helpers.js:9` `getEntity` — same story. Keep.
- `src/lib/csp.js:31` `CSP_HEADER_VALUE` — only `tests/server/csp.test.js`
  imports it; that's a real test consumer. Keep.

**Helper functions defined but never called:** None found. Every internal
function in the 5 longest files has at least one call site within its
module.

**Unused imports:** None found by spot-checking the routes and SPA tabs.
(Imports are clean; tabs reach for `TYPE_LABEL`/`STATUS_LABEL` only when
they actually render type/status pills.)

## Configuration sprawl

`src/config.js` (89 LOC) is in good shape. Everything that should be
configurable is configurable. Two minor observations:

- `MAX_UPLOAD_BYTES = 25 * 1024 * 1024` (`src/routes/evidence.js:19`) is
  hardcoded. Reasonable but should probably read from
  `config.maxUploadBytes` so a deployment with stricter / looser limits
  doesn't fork code. Trivial change.
- `BUNDLES_DIR = path.join(config.uploadsDir, '..', 'data', 'bundles')`
  (`src/routes/exports.js:21`) is computed by going up from `uploadsDir`,
  which feels brittle if someone moves `uploadsDir`. Promote to
  `config.bundlesDir` with the current value as the default.
- `EXPANDED_CAP = 30` / `SEARCH_CAP = 6` (`public/admin.js:324–325`) —
  internal-only, leave as constants.
- `PROXY_OVERHEAD_RATE = 0.55` (`src/lib/t661.js:8`) is a regulatory
  constant, not config. Correctly hardcoded with a CRA-rule comment.

### `wage-caps.js` long-term plan

The current shape — a `CAPS_BY_YEAR` object hardcoded for 2023–2027 with a
fallback-to-latest-with-warning — is fine and well-commented (`src/lib/
wage-caps.js`). Long-term options when the table runs out:

1. **Status quo**: code change per year (one number, one comment edit). Risk
   is forgetting in November of year N. Detection: the runtime warning is
   silently logged. Add a `npm run check-caps` script that errors if today
   is past the last known year? Cheap.
2. **External JSON / DB seed**: introduces an update path that doesn't need
   a code release. Probably overkill.
3. **CRA-source fetch**: out of scope (TODO already notes "needs human" for
   the 2025 value).

Recommend: keep the current shape, add a single-line startup check that
console.warns if `LATEST_YEAR < current year + 1`, and add a TODO for
year +1 each January.

## Test architecture

The tree mirrors `src/` accurately:

| Test dir       | Mirrors                  | Count |
|----------------|--------------------------|-------|
| `tests/auth/`  | `src/auth/`              | 4 files |
| `tests/db/`    | `src/db/`                | 1 file |
| `tests/lib/`   | `src/lib/`               | 4 files |
| `tests/routes/`| `src/routes/`            | 11 files |
| `tests/server/`| `src/server.js` + middleware | 2 files |
| `tests/public/`| `public/` SPA helpers    | 7 files |
| `tests/helpers/db.js` | shared fixture    | 1 file |

No orphan tests — every file maps to a real consumer. Coverage is uneven
(audit-log has 1 file, public/ has 7) but reflects what's worth testing
(SPA helpers are pure JS; tabs themselves are DOM-heavy and harder to test
in isolation without jsdom).

`tests/helpers/db.js` is the right thing to keep shared. The other
candidates I noticed:

- **A request-fixture helper** (build a `req` with `req.user`, body, query
  for unit-testing route handlers outside Express). Several
  `tests/routes/*.test.js` files build minimal Express apps just to drive
  one handler; a shared `mountTestApp(routerName)` would compress them.
- **A user-fixture builder** (`makeUser({ role, email })`). Currently
  inlined in most route tests.

Neither is urgent — total test LOC is reasonable and refactoring tests
without breaking the green bar isn't free.

## Refactoring opportunities (ranked)

Ordered by impact × ease. Higher in the list = bigger payoff per hour.

1. **Split `public/api.js`** into session / fetch / dom / activity-detail
   / preferences-page / inline-evidence (6 files). Lowest-risk: every
   importer can keep working through re-exports during the transition.
   Impact: every SPA tab gets clearer dependencies. Already in TODO.
2. **Extract `mutateAndAudit()` helper** in `src/lib/`. Apply to
   labour/expenses/projects/claimants/users/periods/evidence PATCH +
   /approve + /reject handlers. ~25 callsites, ~10 LOC saved each.
   TODO has this as P3; bump to P2.
3. **Split `public/admin/projects.js`** into list + detail + log-on-behalf
   sub-modules (3 files instead of 1 × 771 LOC).
4. **Split `public/admin/employees.js`** into list + inline-edit +
   user-detail (3 files instead of 1 × 663 LOC).
5. **Split `src/lib/format.js`** along the single-period / compare seam
   (~365 + ~225 LOC). Tests already split.
6. **Extract `routes/me.js`** from `routes/auth.js`. ~130 LOC moves; the
   auth file becomes ceremony-only at ~140 LOC.
7. **Extract `buildUpdate(table, id, updates)`** helper and apply to the
   three PATCH handlers (`labour.js`, `expenses.js`, `users.js`).
8. **Extract `sendFormat(res, baseName, { json, csv, md, pdf })`**
   dispatcher; apply to the two exports.js download handlers.
9. **Promote two values to `config`**: `MAX_UPLOAD_BYTES` and `BUNDLES_DIR`.
10. **Delete `dollarInput`** and `$$` from `public/api.js`.
11. **Add the `wage-caps` future-year check** at startup.

## Already in good shape

Preserve these characteristics through any cleanup:

- **Acyclic import graph**, with the layering routes → lib → auth → db →
  config. The `routes/` ↔ `lib/` separation is the most important; the
  `route-helpers` extraction is the only thing routes share, and it
  doesn't reach back into routes. Don't undo this.
- **Audit-everywhere discipline.** Every mutating route already calls
  `audit()`. The `mutateAndAudit` extraction should preserve this exactly —
  test coverage (`audit-log-writes.test.js`) already pins all 11
  endpoints.
- **The `ctx = { state, render, reloadAll, selectProject, selectUser }`
  shape** in the SPA. Every tab uses the same signature; new tabs
  Just Work. Don't introduce a global state container.
- **Migration numbering & integrity-check pattern** in `db/migrate.js`.
  FK-off around each migration with an integrity check is unusual and
  defensible.
- **`route-helpers.js` size discipline** — every helper has ≥1 caller,
  most have 2+. Don't let it become a junk drawer.
- **The append-only audit-log trigger** (migration 008). Architectural
  guarantee at the database layer; protect it.
- **Tests mirror src/.** Keep test-file paths in lockstep with source-file
  paths through the splits above.
- **Vanilla JS, no bundler.** It's working at 8,500 LOC and ~230 tests.
  Resist the gravity of "we need React / vite / TS" — the cost-benefit
  hasn't flipped.
