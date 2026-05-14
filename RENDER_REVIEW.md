# Render-and-look review

_2026-05-14, against branch `worktree-agent-ab55e0cd3ab4b39ea`, commit `d533fc3`_

This is a rendered audit driven by Playwright with a minted admin/employee
JWT. I drove the SPA through every reachable screen at four viewport
widths. The agent itself cannot see images — screenshots are saved under
`screenshots/<viewport>/<role>-<page>.png` for a human to review.

Driver lives at `tools/visual-audit.mjs`; helper at `tools/mint-dev-jwt.js`;
raw artifact at `RENDER_REVIEW_ARTIFACTS/audit.json` (and a flat analysis
dump at `RENDER_REVIEW_ARTIFACTS/analysis.txt`).

## Stats

- Pages visited: 16 distinct routes × 4 viewports = **64 page captures** (all `ok`)
- Viewports: 4 (1440×900 / 1024×768 / 768×1024 / 375×667)
- Screenshots saved: **64** under `screenshots/`
- axe violations (counted by failing **node**, axe run at 1440 + 375):
  **24 critical · 301 serious · 24 moderate · 14 minor**
  (8 distinct critical rule hits, 25 serious, 8 moderate, 6 minor)
- Console: **37 errors, 32 warnings, 4 pageerrors**
- Network 4xx/5xx: **4** (all the same `403 GET /api/claimants` on
  employee overview — see "Cross-shell" below)
- Layout overflows flagged (horizontal `scrollWidth > clientWidth` outside
  known scroll containers): **92 total**, distributed
  1440=18 · 1024=16 · 768=24 · 375=34

## Headline findings

1. **The brand bar uses `<h1>` for "Precision SR&ED" on every page**, so
   every screen ships with two h1s (brand + real page title). On the
   login screen and the admin overview, axe reports `region` and
   `landmark-one-main` because the body content sits outside any `<main>`
   — those two surfaces don't wrap content in a landmark at all.
2. **`select` elements without an accessible name are pervasive**
   (axe-critical `select-name`, 14 nodes). Most are the
   period/fiscal-period filter that ships on `#review`, `#employees`,
   `#audit`. Adding `aria-label` or an explicit `<label for=…>` would
   close all of them.
3. **The "add employee" form on `#employees` ships unlabelled inputs**
   (axe-critical `label`, 10 nodes — `email`, `name`, role select, comp
   inputs). Also `label-title-only` on the comp-type select. This is
   the only page with critical-severity unlabeled inputs; every other
   form (log-labour, submit-expense, add-evidence) labels its inputs.
4. **Pill chrome has poor contrast.** `color-contrast` is far and away
   the loudest serious violation (292 nodes). The clearest culprit is
   `.pill.kind-sred` (`#0078b5` on `#e6f2f9` = 4.23 contrast, below the
   4.5 WCAG-AA threshold), which appears on every project meta-strip
   and dominates `#review`, `#projects/N`, and `#employees/N`.
5. **Tables overflow horizontally at narrow viewports.** At 375 px the
   review table overflows by 577 px, the employee activity table by 612
   px, and the admin `#employees` table pushes `#all-users-table` 495 px
   past `clientWidth`. None of those overflowing scopes carries the
   `.table-scroll` wrapper the rest of the app uses, so on mobile they
   blow out the page-level horizontal scroll instead of scrolling within
   the card.
6. **The page header overflows at every viewport.** `header` was flagged
   60 times in the overflow scan (every viewport, every page). The brand
   strip + global search + nav are slightly wider than the available
   container; not a layout disaster at 1440 but it's the canary that
   says the brand bar is rendered at fixed widths.
7. **Visible focus rings missing on a handful of inputs/textarea.** At
   1440, `input` on `#preferences`, `#activity` and `textarea` on
   `#projects/1`, `#activity` returned `outline: 0px / box-shadow: none`
   under simulated focus. (Buttons and links do get rings.)
8. **CSP blocks the Google Fonts stylesheet on every page.** Console
   error on every navigation:
   `Refused to connect to 'https://fonts.googleapis.com/css2?family=Montserrat…' because it violates the following Content Security Policy directive: "connect-src 'self'"`.
   Plus a `Couldn't load preload assets: ProgressEvent` warning that
   pairs with it. The app falls back to system fonts (computed
   `font-family: Montserrat, -apple-system, …, system-ui, sans-serif`),
   but the noise is constant across all 64 pages.
9. **Employee shell makes an admin-only request on overview.** Navigating
   to `#overview` as Alice produces four `403 GET /api/claimants`
   responses and four `requires role: admin` pageerrors. Functionally
   harmless (the page renders) but the noise hides real errors.
10. **Empty table-header cells.** `empty-table-header` fires 14 times
    across project-detail and activity tables; the trailing
    "actions"/"icon" column ships without a screen-reader label.

## Findings by category

### Accessibility (from axe)

Critical (8 distinct rule hits, 24 failing nodes):

| Rule | Nodes | Where | Suggested fix |
|---|---|---|---|
| `select-name` | 14 | `#review`, `#employees`, `#audit` period/fiscal selects | Add `aria-label="Fiscal period"` (or a visible `<label>`) to the select. |
| `label` | 10 | `#employees` add-employee form (`email`, `name`, role select, comp inputs) | Wrap each input in `<label>` or use `for=…`. Other forms already do this. |

Serious (25 rule hits, 301 nodes):

| Rule | Nodes | Where | Suggested fix |
|---|---|---|---|
| `color-contrast` | 292 | Every page that renders pills (`.pill.kind-sred`, etc.), `#review` rows, project meta-strips, table totals | Darken pill foreground or bump background. `.pill.kind-sred` at `#0078b5 on #e6f2f9` is the loudest. Also several light-grey muted-text values (`rgb(107,116,128)` on white at <14 px) come up. |
| `scrollable-region-focusable` | 7 | Tables inside cards at 375 px that have no `tabindex` and no native focusable child | Add `tabindex="0"` to the `.table-scroll` wrapper. |
| `label-title-only` | 2 | `select[data-comp-type-for="add-employee"]` | Add a visible `<label>` instead of relying on `title=`. |

Moderate (24 nodes):

| Rule | Nodes | Where | Suggested fix |
|---|---|---|---|
| `region` | 20 | `preauth-00-login`, `admin-01-overview` body content | Wrap the content card in `<main>` (or `<section role="region">` with a heading). |
| `landmark-one-main` | 4 | Same two pages, both viewports | Add a single `<main>` per page. |

Minor (14 nodes):

| Rule | Nodes | Where | Suggested fix |
|---|---|---|---|
| `empty-table-header` | 14 | "Actions" / icon trailing column on activity and detail tables | Use `<th><span class="sr-only">Actions</span></th>` or `aria-label`. |

### Computed-style drift

These are the places where representative selectors yield more than one
signature across pages at 1440×900 — i.e. the design system is _almost_
consistent but has a few outliers worth examining:

- **`h1`** (2 signatures):
  - `rgb(28, 37, 48)`, 32 px, 700 — the **page** h1 (only on overview/login)
  - `rgb(255, 255, 255)`, 23.2 px, 400 — the **brand strip** h1 (every other page)
  - These shouldn't both be h1. The brand strip should be `<a class="brand">` or `<div>` so screen-reader users get one true h1 per route.
- **`h2`** (3 signatures): 15.68 px / 17.6 px (×2 with different margins) — one outlier is ~10 % smaller than the rest. Worth standardising.
- **`.pill`** (3 signatures): unstyled (no `kind-*` class), green `kind-sred` (`#1c6a3e` on `#d9efe1`), blue `kind-sred` (`#0078b5` on `#e6f2f9`). Same border-radius and font sizing, just colour variants. The blue variant is the one that fails contrast.
- **`button.danger`** (2 signatures): `#ee5f5b` (red) and `#cfd2d6` (grey). The grey is `button.danger:disabled`; that's fine, but the disabled appearance loses the "this is destructive" cue — easy to mistake for a regular disabled control.
- **`input`** (2 signatures): default 16 px / 8 px 11.2 px padding, vs. 14.4 px / 7.2 px 11.2 px 7.2 px 32 px (the search input with a leading icon). Two patterns, both deliberate.
- **`table th`/`table td`** drift in font-size (11.84/12.48 and 13.6/14.08/16) — the "compact" cards use a smaller cell, the wide cards use the default. Looks intentional, but check the small-cell labour table at 1440 to confirm it doesn't look anaemic next to the project meta.

### Layout / overflow

Sorted by impact:

- **`<header>` overflow on every viewport.** 56 hits across 4 viewports — the brand strip + nav + global search pushes ~7 px past the page container on desktop and 60 px past on mobile. Cosmetic on desktop, visible on mobile.
- **`table` (no `.table-scroll` wrapper) on `#review` and `#activity`.** Up to 612 px of overflow at 375 px. These specific tables look like they were missed when the rest of the app switched to wrapped scroll containers — confirm by checking the markup of `#review` and `#activity` against `#projects` (which does wrap).
- **`#all-users-table` inside `.card` on `#employees`.** Pushes the entire `<main>` 471 px past `<html>` at 375 px — page-level horizontal scroll appears on mobile. Most invasive overflow in the audit.
- **`table.activity`** on every page that embeds it (`#projects/1`, `#employees/2`, `#log-labour`, `#submit-expense`, `#add-evidence`) overflows 180–286 px at 375.
- **`form#add-employee-form > .grid`** on `#employees` overflows by 7 px in every viewport — the `.grid` columns force a content width slightly larger than the card. Cosmetic.

### Console output

Across all 64 navigations (deduped):

- **CSP block — Google Fonts CSS** (every page, ~64 occurrences):
  `Refused to connect to 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap' because it violates the following Content Security Policy directive: "connect-src 'self'".`
  Either `connect-src` should allow `fonts.googleapis.com` and
  `font-src` allow `fonts.gstatic.com`, or stop loading Montserrat from
  Google and self-host it. The current state means Montserrat never
  actually loads in production — the design relies on the fallback
  stack.
- **`Couldn't load preload assets: ProgressEvent`** — pairs with the
  CSP block, same root cause (the preload tag points to the same
  Google Fonts URL).
- **`Failed to load resource: 404`** on the pre-auth `/` page. Likely a
  favicon or preload chain — worth a `Network` tab look. (Not seen on
  authenticated pages.)
- **`403 GET /api/claimants`** + **`requires role: admin`** pageerror —
  fires four times on employee `#overview`. The employee shell appears
  to call an admin-only endpoint speculatively, then surface the rejection
  as a thrown error caught only by the global handler. Should be gated
  by role before the fetch.

### Cross-viewport / cross-shell

- **Same surface, different shell:** `#overview` renders cleanly as
  employee (no axe violations at 1440), but the admin variant is missing
  `<main>` and produces `region` + `landmark-one-main` failures. The
  admin overview seems to be a different template that hasn't been
  brought in line with the employee one's landmarks.
- **Mobile (375) is meaningfully worse than 1440.** axe overflow counts
  almost double on the mobile pass (34 vs. 18). The biggest losses are
  the admin `#employees` table and the employee `#activity` table.
- **Login screen behaves like a mini-app:** no `<main>`, the brand h1
  remains in the document, and at 375 the centered card sits beneath
  the brand strip rather than alongside it. Worth checking that the
  rendered screenshot at 375 doesn't crop the email field on iPhone-SE.

## Screenshot manifest

All 64 PNGs saved under `screenshots/<viewport>/<role>-<label>.png`.
The interesting screenshots for a human reviewer to open first:

| Path | Why |
|---|---|
| `screenshots/375x667/admin-04-review.png` | review table overflows 577 px — confirm horizontal scroll is page-level (bad) and not inside the card. |
| `screenshots/375x667/admin-06-employees.png` | `#all-users-table` blows out `<main>`; expect to see the whole page horizontally scrolling. |
| `screenshots/375x667/employee-21-activity.png` | activity table overflows 612 px — worst single overflow in the audit. |
| `screenshots/1440x900/admin-04-review.png` | every pill renders here — eyeball the contrast on `.pill.kind-sred`. |
| `screenshots/1440x900/admin-03-project-detail.png` | meta-strip pills + the small-cell labour table together. |
| `screenshots/1440x900/admin-06-employees.png` | the unlabelled add-employee form — visually does it look broken, or does the form rely on placeholders? |
| `screenshots/1440x900/preauth-00-login.png` | confirm the brand h1 + missing `<main>` on the login screen don't look weird visually. |
| `screenshots/1440x900/admin-09-preferences.png` and `…/employee-25-preferences.png` | same route, two shells — see if they look meaningfully different. |
| `screenshots/375x667/admin-09-preferences.png` | preferences at narrow viewport — sanity check. |
| `screenshots/1024x768/admin-08-audit.png` | tablet view of the audit-log table — does the table compress gracefully? |

Full file list (sorted by viewport then label) is in
`RENDER_REVIEW_ARTIFACTS/manifest.json`, with the axe/overflow flags
attached to each entry.

## Things that work well

- **Design tokens are largely consistent.** The Montserrat → system
  fallback works across every page; the body text colour
  `rgb(28, 37, 48)` is uniform; the card border-radius is the same on
  every surface.
- **Pills are a real design system,** not ad-hoc classes — every pill
  has the same 11.84 px / 700 / 1.92 px 9.6 px shape and only colour
  varies. The contrast fix can be a one-line change in `style.css`.
- **Forms outside `#employees` are correctly labelled.** Log-labour,
  submit-expense, add-evidence and preferences all carry proper
  `<label>` elements — only the add-employee admin form is the
  outlier.
- **Hash routing is solid.** All 16 routes resolved to their requested
  hash on first navigation (no surprise redirects) and legacy hash
  migration didn't fire for any of the new names.
- **Disabled state is rendered consistently** on `button.danger` — same
  padding, same font weight, just colour. Not a bug.
- **No JavaScript exceptions outside the known employee-overview 403
  cascade.** 60/64 navigations had zero `pageerror`.

## Coverage gaps

Things the agent could not audit and a human will need to cover:

- **Modal dialogs.** No "click this button → modal opens" flow was
  triggered. Confirmation modals, the project edit modal on
  `#projects/N`, the evidence preview modal, the labour-entry edit
  modal, and the export download dialog all remained closed during
  the sweep.
- **WebAuthn enrollment / passkey flow.** `/enroll`, the passkey
  registration overlay, and the recovery magic-link landing page
  require a real WebAuthn authenticator and weren't visited. Admin
  was forced to `status='active'` to bypass enrollment so we could
  even drive the SPA.
- **Magic-link landing pages.** The `/auth/magic?token=…` and
  `/enroll?token=…` URLs were not visited.
- **Empty/loading states.** The audit ran against a fully-seeded DB.
  "No projects yet" / "no labour entries" / "empty review queue" empty
  states aren't covered.
- **Error states.** The page renders a generic error toast on
  network failure; no failure path was forced.
- **Dark mode / OS-level prefers-color-scheme.** Playwright defaulted
  to no preference; the audit did not flip `prefers-color-scheme: dark`.
- **`prefers-reduced-motion`** and other media-query-driven CSS were
  not toggled.
- **Long-text wrap & truncation.** Project titles in the seed data
  are 40–70 chars. A real claim with a 200-char project title might
  reveal additional overflow.
- **Tab order / keyboard nav** — only spot-checks of focus rings on
  representative elements, not a full Tab walk.
- **Real screen-reader pass.** axe-core catches structural problems,
  but a manual VoiceOver/NVDA pass on `#review` and `#projects/N`
  would be worth doing once the `select-name` and `label` criticals
  are fixed.
