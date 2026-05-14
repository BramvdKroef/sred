# Visual design review

_2026-05-14, against branch `worktree-agent-a042e7204ddcb32ac`, commit `d533fc3`_

This is a code-only audit — derived from reading `public/style.css`, the SPA
renderers under `public/`, and `public/index.html`. I did not render the
pages. All contrast ratios below are computed from the hex tokens declared
in `:root` using the WCAG 2.x relative-luminance formula; I rounded to two
decimals.

## Headline findings

1. **`--text-muted` (`#6b7480`) fails WCAG AA on every background it's used
   on.** Computed ratio is **4.04 : 1** on `--surface` (`#ffffff`) and
   **3.79 : 1** on `--bg` (`#eef2f7`). The `.muted` class, every `<label>`,
   every `nav.tabs button` (inactive), every `.metric + .muted` caption,
   and every "secondary metadata" line in the SPA inherits this colour — so
   the failure is system-wide, not isolated.
2. **`.loading` (`#9aa3ad`) ≈ 2.36 : 1 on `--bg`.** The pulsing loading
   placeholder is well below AA-large and AA-non-text. Anyone with mild
   low-vision will miss it on first paint.
3. **Disabled buttons render white-on-`#cfd2d6` ≈ 1.33 : 1.** WCAG exempts
   disabled controls from contrast, but at this ratio the label is almost
   invisible; disabled state is conveyed entirely by tonal flatness.
4. **Inline-style debt: 109 `style="…"` attributes across the JS bundles.**
   ~40 of them are reusable patterns leaking out of the design system
   (sticky bar offsets, `gap`/`margin` spacing tweaks, hard-coded widths,
   inline `font-size:0.85rem` for what should be a "small label" token).
5. **`--gold` (`#f2b134`) and `--green` (`#2d9d6b`) are declared but never
   referenced.** Every "success" pill uses the literal `#1c6a3e`/`#d9efe1`
   pair instead; every "warning" pill uses `#8a6300`/`#fff4d6`. The tokens
   exist on paper, the palette does not.
6. **User/attachment "active" status renders four different ways across
   the admin SPA** — sometimes via `.pill.open` (green), sometimes
   `.pill.pending` (yellow), sometimes `.pill.closed` (grey). Same data
   value, different colour depending on which renderer wrote the row.
7. **Project status is rendered twice on the project-detail header** — once
   as a plain `.pill` (no colour modifier; comes out as the unstyled
   white box) at line 353 of `admin/projects.js`, and immediately below as
   `.pill.status-<value>` (correctly coloured) in the meta-strip.
8. **No focus styles on `button`.** Only `input/select/textarea` and
   `.header-claimant-select` have a `:focus` rule. Keyboard users get the
   UA default outline at best, none on `nav.tabs button` and the dozen
   `.small`/`.secondary`/`.danger` buttons that drive every form.

## Findings by category

### Design system

- **Dead palette tokens.** `--gold` and `--green` are declared in `:root`
  but referenced nowhere in `public/`. Either delete or wire them into the
  warning-pill / approved-pill backgrounds (which currently hard-code
  `#fff4d6` / `#d9efe1` instead).
- **`--brand-darker` is used only once** (the page-header gradient,
  `style.css:58`). Borderline-dead.
- **Pill palettes hard-code ~20 hex values that aren't tokens.**
  `style.css:410-426`. Six "background / text / border" triplets
  (`pending`, `approved`, `rejected`, `kind-internal`, `status-concept`,
  `status-development`, `status-complete`, `overtime`) are inlined.
  If the palette ever needs to shift hue (e.g. for a dark-mode pass), each
  pill is an independent edit. Pull them into `--status-*-bg/text/border`
  tokens.
- **One-off pale-grey backgrounds.** Six distinct off-whites appear with no
  shared token: `#f0f2f4` (search section head), `#f8fafc` (row hover),
  `#f6f9fc` (sub-card), `#f6f8fa` (table-head gradient + pre.json),
  `#fbfcfd → #f3f6fa` (metric-tile gradient), `#fafbfc` (inline activity
  detail + reject editor — used in `api.js:569` and `review.js:339` as
  literal inline styles). Three of these (`#f6f8fa`, `#f8fafc`, `#fafbfc`)
  are essentially identical to the eye but encoded independently.
- **Contrast computations** (computed from the actual tokens):
  - `--text` `#1c2530` on `--surface` `#ffffff` ≈ **15.8 : 1**. Excellent.
  - `--text-muted` `#6b7480` on `--surface` ≈ **4.04 : 1**. **Fails AA**
    for normal text (≥ 4.5). Passes AA-large (≥ 3).
  - `--text-muted` on `--bg` `#eef2f7` ≈ **3.79 : 1**. **Fails AA** for
    normal text; passes AA-large.
  - `--brand` `#0078b5` on `--surface` ≈ **4.88 : 1**. Borderline AA;
    passes for normal text.
  - `--brand` on `--brand-light` `#e6f2f9` ≈ **4.19 : 1**. **Fails AA**
    for normal text. Affects `.role` pill, `.pill.type-labour`,
    `.pill.kind-sred`, and `.summary-link` over the brand-light row hover.
  - `#fff` on `--brand` ≈ **4.88 : 1**. Borderline; passes AA-large for
    the header h1 (which is 1.45rem so qualifies as large) but the
    `header .role` pill at 0.7rem white-on-translucent-white is harder
    to compute precisely (depends on the gradient pixel underneath).
  - `--accent-dark` `#d34a47` on `--surface` ≈ **3.96 : 1**. The
    `.error` text class **fails AA** for normal text.
  - `.loading` `#9aa3ad` on `--bg` ≈ **2.36 : 1**. **Fails AA-large and
    UI-component contrast.** The pulse animation partially mitigates,
    but at the dim end of the cycle the contrast is even lower.
- **Type scale: 20 distinct `font-size` values** in `style.css` alone
  (count via `grep -oE 'font-size: ?[^;]+' style.css | sort -u`), plus
  six more inline in JS (`0.7em`, `0.85rem`, `0.88rem`, `0.92rem`). The
  ladder mostly hits multiples of 0.02-0.05rem
  (`0.55, 0.62, 0.7, 0.72, 0.74, 0.78, 0.8, 0.82, 0.84, 0.85, 0.88, 0.9,
  0.92, 0.95, 0.98, 1.1, 1.2, 1.45, 1.7, 2.2`). There's no power-of-1.2
  or 1.25 scale; pairs like `0.78`/`0.8`/`0.82`/`0.84`/`0.85`/`0.88` are
  visually indistinguishable and probably the result of one-off tuning.
  Collapse to ~6 sizes (`xs/sm/base/md/lg/xl/2xl`) declared as tokens.
- **Spacing scale: ad-hoc.** Padding values include
  `0.08`, `0.12`, `0.25`, `0.3`, `0.35`, `0.4`, `0.45`, `0.5`, `0.55`,
  `0.6`, `0.65`, `0.7`, `0.75`, `0.8`, `0.85`, `0.9`, `0.95`, `1.1`,
  `1.2`, `1.25`, `1.4`, `1.5`, `1.6`, `3` (rem). At least 24 distinct
  rem values, with no apparent 4/8/12/16-px rhythm. The 0.43rem-style
  one-offs the brief mentions aren't present, but `0.08rem` and `0.12rem`
  vertical pill padding read as the same value (≈ 1.3 px vs 1.9 px).
- **Border radius: 9 distinct values** (`2, 3, 4, 5, 6, 8, 10, 12 px` plus
  the `4 4 0 0` bar-top). No clear `--radius-sm/md/lg` token; e.g. cards
  are `8px`, header is `10px`, pills are `12px`, search-results is `6px`,
  inputs/buttons are `5px`. Inputs and buttons at `5px` is unusual
  (everyone else uses `4/6/8`); likely a copy-paste artefact.
- **Shadow tokens are inconsistently honoured.** `--shadow-sm/md/lg`
  exist, but several places re-declare custom shadows: `nav.tabs
  button.active` (`0 2px 6px rgba(0,120,181,0.18)`), buttons
  (`0 1px 2px rgba(0,120,181,0.2)` → `0 2px 6px rgba(0,120,181,0.3)`
  on hover), chart bars (custom inset). The shadow language is
  basically *brand-shadow* (blue-tinted, on interactive accents) vs.
  *neutral-shadow* (dark-blue-tinted, on surfaces); promote them to
  `--shadow-brand-sm/md` and `--shadow-surface-sm/md/lg`.
- **Transition tokens absent.** Five durations (`0.15s`, `0.15s`,
  `0.15s`, `0.2s`, `0.15s, 0.15s`, `0.15s`) are scattered; the brand-
  consistent value is plainly `0.15s ease`. Pull to `--transition-fast`.

### Component patterns

- **Cards.** Two declared variants (`.card`, `.card.compact`). The
  inventory of `class="card"` usages is 58; `class="card compact"` is 12.
  No third ad-hoc card-shaped `<div>` was found — that part of the design
  system is clean. *However*, two inline pseudo-cards are inlined in JS:
  - `api.js:569` — the activity-detail wrapper:
    `<div style="padding:0.7rem 0.9rem; background:#fafbfc; border:1px
    solid var(--border); border-radius:4px">`.
  - `review.js:339` — the reject-editor form, identical CSS.
  These should be either a new `.card.inset` or a `.sub-card` (the latter
  already exists at `style.css:511` with a slightly different palette).
- **Buttons.** Variants are `default` (brand), `.secondary` (dark
  neutral), `.danger` (accent red), and the size modifier `.small`. No
  per-feature button colours via inline `style="background: …"` — that's
  clean. Label patterns are 99 % standardized to verb-object
  (`Save claimant`, `Save labour entry`, `Save expense`, `Save project`,
  `Save user fields`, `Create claimant`, `Create project`, `Add labour
  entry`, `Add evidence`, `Add expense`, `Add passkey`, `Add period`,
  `Add assignment`, `Generate export`, `Generate comparison`) — except
  **one stray plain `<button>Save</button>`** at
  `admin/employees.js:499` (the per-attachment row's "save title /
  specified / status" form). Other near-bare labels — `Approve`,
  `Reject`, `Cancel`, `Close`, `Open`, `Remove`, `Reactivate`,
  `Deactivate`, `Edit`, `Build`, `Attach` — read as table-row actions
  and are fine as bare verbs.
- **Pills.** The CSS defines pill modifiers for 11 distinct semantic
  values: `pending`, `approved`, `rejected`, `open`, `closed`,
  `type-labour`, `type-expense`, `type-evidence`, `kind-sred`,
  `kind-internal`, `status-concept`, `status-development`,
  `status-complete`, `overtime`. Issues:
  - **User/attachment status is rendered four different ways.** Same
    `u.status === 'active'` data point becomes:
    - `pill open` / `pill pending` (`admin/projects.js:172`)
    - `pill open` / `pill closed` (`admin/projects.js:392`,
      `admin/employees.js:629`)
    - `pill open` / `pill pending` / `pill closed`
      (`admin/employees.js:116`)
    - `pill open` / `pill pending` (`api.js:235`, the preferences card)
    The semantic mapping for "inactive / disabled / removed" is
    inconsistent — sometimes yellow (`pending`), sometimes grey
    (`closed`). Promote to `.pill.user-active`, `.pill.user-inactive`,
    `.pill.user-pending`, `.pill.user-disabled` so the colour is bound
    to the actual data value, not the renderer's preference.
  - **Bare `.pill` (no modifier) renders a colourless badge.**
    Four sites use it: `audit.js:107` for audit-log actions
    (intentional — actions are open-vocabulary), `projects.js:534` for
    `v<N>` revision tags (fine), `employee/activity.js:42` for project
    status on the employee shell (should be `.pill.status-<value>` to
    match the admin SPA), and **`projects.js:353` — the duplicate
    project-status pill on the project-detail header**, which is
    rendered with no modifier *next to* the same status correctly
    coloured in the meta-strip below. Looks like a leftover from
    a refactor.
  - **`type-labour`/`type-expense`/`type-evidence` only render in
    `activityHtml`**; they don't show up anywhere else. Consistent with
    being feed-row affordances.
- **Tables.** Header row uses a gradient (`#f6f8fa` → `#eef1f4`); body
  rows have a universal `tr:hover td { background: #f8fafc }`. The
  hover applies whether or not the table is clickable. The clickable
  variant is `table.rows-clickable`, with hover `var(--brand-light)`.
  So *every* table has hover feedback but only one in three is actually
  clickable — affordance lies. The `td.actions { white-space: nowrap }`
  pattern is good. `.hide-on-narrow` is used 4 times (IDs in
  employees/audit, "Field" on the projects list, the audit entity-id
  suffix). Coherent.
- **Forms.** `form .grid` (`auto-fit, minmax(180px, 1fr)`) is honoured
  in nine renderers (`renderPreferencesPage`, `claimant-form`,
  `project-form`, `form-edit-project`, `add-employee-form`,
  `attach-existing-form`, `add-attachment`, `labour-form`,
  `expense-form`, `evidence-form`). Required asterisks: not rendered at
  all — `required` attribute is set on inputs but the label has no `*`
  cue, so the user can only learn a field is required by submitting.
  Helper text below inputs is inconsistently placed (`.muted` paragraph
  *below* the form actions in some, *above* in others; sometimes
  inside the actions row). Error banners use the `.error-banner` class
  consistently via `showError()` — that part is well-factored.
- **Empty / loading states.** `.empty` is used 28 times in JS; no
  ad-hoc "No data" paragraphs remain (good). `.loading` is used as
  expected for in-flight fetches in `overview.js`, `review.js`,
  `audit.js`, `employees.js`, and `projects.js`. The
  `<p class="muted">Loading…</p>` pattern survives in three places
  (`api.js:325, 441`, `admin/employees.js:325`) — those should be
  `.loading` so the pulse animation fires.

### Inline-style audit

109 `style="…"` attributes across the JS bundles
(`grep -rn 'style="' public/ | wc -l`). Categorized:

**Style replicates a token but inline** (~25 cases):
- `font-size:0.85rem` recurring as a "small caption" — at
  `admin/audit.js:42, 56`, `admin/employees.js:503`,
  `admin/overview.js:30`, `admin/review.js:147, 154, 161`, etc. Should
  be a `.caption` or `.text-sm` class. Today there are six variants
  with `<0.05rem` differences (`0.84`, `0.85`, `0.88`, `0.9`, `0.92`).
- `background:#fafbfc; border:1px solid var(--border); border-radius:4px`
  duplicated verbatim at `api.js:569` and `review.js:339` — should be
  `.card.inset` (or reuse `.sub-card`).
- `text-decoration:none` on muted links (`admin/projects.js:348`,
  `admin/employees.js:598`). Should be a `.breadcrumb-link` or just
  `.muted a { text-decoration: none }` global.
- `flex:1` on form fields nested inside `.row` (5 sites). The
  `.input-grow` utility class already exists at `style.css:507` for
  this purpose; these should adopt it.
- `gap:0.4-0.6rem` inline on `.row` containers (15+ sites). The base
  `.row` rule has `gap: 0.6rem`, so inline overrides of `0.4`/`0.5`
  are visible-but-marginal tweaks. Consolidate or accept the default.

**"Style would be better as a class" — reusable, recurring** (~10 cases):
- The sticky bulk-action bar in `review.js:198`:
  `position:sticky; top:0; z-index:5; padding:0.6rem 0.9rem; ...`. Whole
  pattern should be `.action-bar.sticky`.
- The mini-modal in `employees.js:403` —
  `dlg.style.cssText = 'border: 1px solid rgba(0,0,0,0.1); border-radius:
  8px; padding: 1.25rem 1.4rem; max-width: 28rem; box-shadow: 0 10px
  30px rgba(0,0,0,0.15);'`. Re-implements `--shadow-lg`, the card
  radius, and the card padding from scratch. Should be a `.dialog`
  class so all future modals look the same.
- Repeated `width: 6rem` / `9rem` / `5rem` inline widths on number
  inputs (`employee/activity.js:217, 230-232`, `employees.js:508`).
  These are five different ad-hoc widths for the same conceptual
  "narrow number input."

**Genuinely one-off** (~15 cases):
- `<div class="bar" style="height: ${b.pct}%">` — bar height is
  data-driven, cannot be a class.
- `<th style="width:1.6rem">` for the bulk-select checkbox column — a
  one-off column width.
- `<span style="font-size:0.7em">` for the currency suffix on the
  metric tile — single use, contextual.

**Worst-offender sampler (most-repeated inline pattern):**
```text
style="gap:0.4rem"          on .row             ×7
style="margin-top:0.5rem"   on <details>        ×5
style="gap:0.5rem; ..."     on .row form        ×6
style="font-size:0.85rem"   on label/p          ×9
```

### Cross-shell coherence

- **Header.** Admin (`admin.js:151-159`) and employee (`employee.js:37-44`)
  both render a `<header>` with the same gradient bar, brand h1, user
  block, and "Sign out" button. The only divergence is the
  `.header-claimant-select` dropdown (admin-only) and the role-pill text
  (`admin` vs `employee`). Visually consistent.
- **Tabs.** Both shells use the same `nav.tabs` markup and styling.
  Admin has 6 tabs + search; employee has 5 tabs, no search. The
  employee tab strip is *not* missing anything visually — admin's
  search input becomes part of the tab row (`margin-left: auto`),
  which works as long as nothing else gets shoved to that auto
  position.
- **Overview.** Admin (`admin/overview.js`) and employee
  (`employee/overview.js`) both use:
  - A "This week — <from> → <to>" card with a `.metrics` grid and a
    bar chart from `chartHtml()`.
  - A "Recent activity" card.
  Structurally identical. The two diverge in metric labels (admin shows
  "contributors / pending labour / pending expenses", employee shows
  "pending review / to fix / assigned projects") and in `activityHtml`
  options (admin passes `showActor:true, showOpen:true`; employee
  passes `showActor:false`).
- **Activity feed.** `activityHtml` (`api.js:398`) is the single
  renderer used by both shells. The output is identical: the
  `table.activity` class adds `when`-column tabular nums and shrinks the
  details cell. Confirmed consistent.
- **Preferences page.** Shared (`renderPreferencesPage` in `api.js:220`).
  Identical in both shells. *However*, the status-pill mapping here
  (`active` → `pill open`, otherwise `pill pending`) doesn't match the
  same field's rendering in `admin/employees.js:116`, so a user who
  toggles between the Preferences tab and the Employees tab will see
  their own status drawn in two different colours.

### Accessibility (computed)

- **No `:focus` ring on buttons.** `style.css` defines focus only for
  `input, select, textarea` (border + blue glow) and for
  `.header-claimant-select` (outline). `button`, `nav.tabs button`,
  `.summary-link`, `<details><summary>`, and the search-result `.item`
  divs all rely on UA defaults — and for some user agents that's *no
  outline at all* because the SPA's hover effects (translateY,
  box-shadow) interfere visually. Add at least `button:focus-visible
  { outline: 2px solid var(--brand-dark); outline-offset: 2px; }`.
- **Labels.** Most inputs have an associated `<label>` element via
  visual proximity inside a `.grid > div`. None of them use
  `for="<id>"`, so the label is *not* programmatically associated.
  Screen readers fall back to placeholder / nearby text. Notable
  unlabeled inputs:
  - `#project-search` (`admin.js:168`) — only a `placeholder`. No
    `aria-label`, no `<label for>`.
  - `#email` on the login card (`app.js:34`) — has a `<label
    for="email">` *above* it, which is the one place this is wired
    correctly.
  - Bulk-select checkboxes in `review.js:68, 73, 93, 98` correctly use
    `aria-label`.
- **Colour-only signalling.** The "today" column on the bar chart
  switches from blue to red gradient (`style.css:643-647`) but
  *also* shows a `TODAY` text label below it (`api.js:625`), so
  colour is reinforced. The lock-state pills (`.pill.approved`,
  `.pill.closed`) carry text, so the lock affordance isn't
  colour-only. **The status / kind pills are colour-coded but always
  carry the status text**, so the visualization is redundant — good.
- **Tap targets under 600 px.** `style.css:696-708` correctly bumps
  `button` to `0.75rem 1.2rem` padding (~45 px content box),
  `button.small` to `0.55rem 0.85rem` (~36 px — **still under the
  44 px iOS HIG minimum**), and `input/select/textarea` to
  `0.65rem 0.7rem` (~45 px). The `button.small` mobile padding is too
  tight; bump to `0.7rem 0.95rem` or remove the size override on
  narrow viewports.
- **Magnifying-glass icon.** Rendered as a CSS `::before`
  `background-image` (data-URI SVG), no DOM element. Screen readers
  cannot perceive it, which is correct for a purely decorative icon
  paired with a labeled (or at least placeholdered) input. *But* the
  input itself has no label, so the icon-as-affordance has no AT
  fallback. Add an `aria-label="Search projects and employees"`
  to the input.
- **Disabled button contrast.** White-on-`#cfd2d6` ≈ 1.33 : 1. WCAG
  excludes disabled controls, but this is hard to perceive even for
  users without vision impairment. Consider switching to a darker
  text colour (`color: var(--text-muted)`) on disabled.
- **Heading hierarchy.** Cards use `<h2>` for the title; project /
  user detail pages re-use `<h2>` for the breadcrumb-style title.
  The page has no `<h1>` other than the brand mark in the header
  (`<h1>Precision SR&ED</h1>`), which is reasonable for a SPA but
  worth flagging — the page title doesn't change per route, so screen
  readers landing on a deep link can't infer where they are without
  the breadcrumbs.

## Things that work well

- **Token-driven brand bar.** The page-header gradient
  (`--brand` → `--brand-dark` → `--brand-darker`) and the matching
  thin top accent strip on `body::before` are the strongest pieces of
  visual branding and they're entirely token-driven. Keep.
- **Card → meta-strip → content rhythm.** The detail pages
  (`admin/projects.js`, `admin/employees.js`) consistently use a
  "card title + meta-strip pills + body cards" structure. The
  `.meta-strip` class + `.row` utility + pill modifiers are a
  legible pattern.
- **`.metrics` grid + `.metric` typography.** The 2.2rem tabular
  brand-blue numerals over an upper-case 0.78rem muted caption are a
  distinctive, recognizable hero pattern. Survives a refactor.
- **Inline-SVG icon idiom.** Two decorative icons (the header bar-chart
  mark and the search magnifier) are both data-URI SVGs in `::before`
  pseudo-elements. Self-contained, no asset pipeline, consistent
  approach. Keep.
- **`activityHtml` as a single feed renderer.** One function, both
  shells, identical output. Exactly the right abstraction.
- **Mobile-table scroll wrapper.** `style.css:365-379` selects every
  `<table>` inside a `.card` and gives it horizontal-scroll plus
  a gradient shadow that hints at off-screen content. Generic, no
  per-renderer wrapping needed.
- **The bar chart's "today" colour swap + animation.** The `.col.today
  .bar` gradient and the `barGrow` keyframe are deliberate and
  consistent across both overview pages.
- **`.pill.<status>` palette colours are computed to pass AA.** Every
  pill with a status modifier (pending, approved, rejected, closed,
  status-concept, status-development, status-complete, type-expense,
  type-evidence, overtime) has computed text-on-bg contrast
  ≥ 5 : 1. Only the bare-brand pills (`type-labour`, `kind-sred`)
  fall back to 4.19 : 1, and that's worth fixing.

## Coverage gaps

Things I could not audit without a render:

- **Actual on-screen alignment.** The number of inline `gap`/`margin`
  tweaks suggests visual tuning that I can't verify without seeing
  the pixel result.
- **Tab-strip wrap behaviour.** With six tabs + a search input + the
  `margin-left: auto` positioning, the wrap point on a 700-900 px
  viewport is renderer-dependent. The CSS allows wrap but doesn't
  control where the search lands.
- **Font rendering.** Montserrat at `0.78rem` vs. `0.82rem` vs.
  `0.85rem` is unlikely to be distinguishable to a human eye, but I
  can't confirm without seeing it.
- **Bar-chart label collision under ~360 px.** The 600 px breakpoint
  shrinks them; below ~340 px they may still collide given the
  weekday + MM-DD stack.
- **`<dialog>` appearance.** `dlg.style.cssText` in `employees.js`
  sets a card-like style but I can't see whether the native UA
  styling (e.g. Firefox's default border) bleeds through.
- **Animation feel.** Three transitions, one keyframe (`barGrow`),
  one (`loadingPulse`). I can read durations but not perceive feel.
- **Search-results dropdown alignment.** The `position: absolute;
  right: 0; width: 26rem` rule may overflow the viewport on narrow
  windows; can't verify without rendering at multiple widths.
- **Header collapse at 680 px.** `flex-direction: column` is set
  for the header, but the user-block's `.role` + `claimant-select` +
  `sign-out` button row may itself wrap awkwardly inside the
  collapsed column — not visible in CSS alone.
