# SR&ED domain accuracy review

_2026-05-14, against branch `worktree-agent-afe428beb8e93ea24`, commit `d533fc3`._

**Caveat:** I am an LLM, not a tax professional. This review cross-references publicly-available CRA documentation against my training knowledge of T661, T4088, and ITA s.37 / s.248. Live web access was unavailable for this run (`WebSearch`/`WebFetch` permissions denied), so I could not pull the current CRA pages verbatim — every CRA citation below is from training-data recollection and is flagged accordingly. **Final accuracy must be verified by a qualified tax preparer before filing.**

When I write "[CRA, T4088 §2.x]" or "[ITA s.37(...)]" below, treat it as "this is what I recall the rule to be — please confirm against the live publication". I have not invented rules; where I cannot recall a specific value I have written "couldn't verify".

## Summary

**Verdict: the code is broadly correct on the structural shape of a T661 claim (categories, proxy-vs-traditional bifurcation, narrative fields, contemporaneous evidence) but has notable gaps on (a) the specified-employee cap mechanics — it's applied per-labour-entry against an unprorated full-year salary equivalent, which is the right idea but doesn't handle partial-year employment or apportionment to SR&ED time the way CRA's formula does — (b) T661 line numbers are not present in any output, leaving the tax preparer to map every total, and (c) the schema is missing some T661-eligible expenditure categories (most prominently equipment lease and a separate "salary base" vs "SR&ED salary" distinction).**

Rough count, of the audit points enumerated below:
- **5 confirmed broadly correct** (proxy 55%, narrative fields, contemporaneous timestamps, salary effective-dating, traditional method as sum of overhead expenses being directionally right)
- **6 flagged discrepancies** (cap proration, line-number mapping, FX rate semantics, traditional-method overhead breadth, missing categories, overtime treatment in worksheet)
- **4 couldn't verify with high confidence** (2025-2027 cap values, exact line-numbering changes after T661 v22, whether "internal" type is a CRA-recognised distinction, whether 1.5× overtime is allowed)

## Findings (ranked)

### Confirmed correct

1. **Proxy overhead = 55% of SR&ED salary/wages.** `t661.js:8` sets `PROXY_OVERHEAD_RATE = 0.55`. This matches the prescribed proxy amount (PPA) rate at ITA Reg. 2900(4) and CRA's *Total Qualified SR&ED Expenditures Policy* / T4088 line 502. The rate changed historically (was 65% pre-2013, then phased 60% → 55% by 2014) and has been 55% since. **Note (confidence: high):** the rate is applied here to **all eligible SR&ED salary** including specified-employee salary (post-cap). CRA's rule is that PPA is computed on the *salary base* — which excludes bonuses/remuneration based on profits and is also subject to the specified-employee cap. The code computes PPA on `projectLabourCents`, which is post-cap. That is **correct** for the cap, but `projectLabourCents` includes all approved labour cost and the schema has no concept of bonuses/profit-based remuneration to exclude — see flagged discrepancy #5.

2. **Salary effective-dating + comp history.** `compensation_rows` keyed on `effective_from`/`effective_until` (migration 007), with `findEffectiveComp` picking the row in force on `work_date`. This is the right pattern — CRA expects compensation actually paid in the period, and a mid-year raise should change the rate forward, not retroactively. [CRA, *Salary or Wages Policy* §2.0]

3. **Narrative captured at the right granularity.** `projects.advancement_sought`, `uncertainties`, `work_performed` map 1:1 to T661 Part 2 lines 242, 244, 246 (the "three questions"). The `project_revisions` table snapshots historical narratives — this directly addresses CRA's audit expectation of contemporaneous documentation of the version-as-filed.

4. **Contemporaneous evidence timestamps.** `evidence_items.created_at` (server-side) plus `evidence_date` (claimed date) gives both server-recorded ingestion and the user-claimed contemporaneous date. CRA's *Information Circular IC86-4R3* and audit guidance emphasise contemporaneity. The two-field design correctly distinguishes "when the artifact was created" from "when we recorded it".

5. **Type='sred' filter for export.** `t661.js:58` excludes `type != 'sred'` projects from the export. This matches CRA's stance that only work meeting the SR&ED definition at ITA s.248(1) gets reported on T661. (Whether the *internal vs sred* distinction is sufficient to identify SR&ED work is a separate concern — see flagged #3.)

### Flagged discrepancies

#### F1. Specified-employee cap is not pro-rated for partial-year employment, and is applied to a full-year-equivalent salary rather than to SR&ED-attributed salary.

**What the code does** (`t661.js:26-40`):
```
annualBase = comp.amount_cents (if salary) or amount_cents * hours_per_year (if hourly)
cap = specifiedEmployeeCapCents(year)
effectiveAnnual = min(annualBase, cap)
hourly_cents = effectiveAnnual / yearlyHours
labour_cost = hours * hourly_cents
```

The cap is applied to the **per-employee annual salary**, then a fraction is taken via `hours / hours_per_year`. So an employee who only worked half the year sees the *same* annual cap test as a full-year employee, and an employee whose SR&ED time is only 200 hours of a 2080-hour year gets `cap * (200/2080)` charged to SR&ED — i.e., the cap is implicitly apportioned by hours-on-SR&ED, which is roughly defensible.

**What CRA actually requires** [training recollection, please verify]:
- ITA s.37(9.1) and s.248(1) "specified employee" definition: the cap is **5× the YMPE** for the calendar year — and the *cap itself* is pro-rated for the number of days in the year the person was a specified employee. So a person hired July 1 has a cap of ~½ × (5 × YMPE), not the full cap.
- The cap is on **salary or wages incurred in the year on SR&ED** (form T661 line 307 in the salary base), not on total salary. The mechanism is: take SR&ED salary actually incurred for this person, and cap it at the prorated cap amount.
- For hourly employees on partial-year contracts, "actual salary or wages incurred in the period" is the input to the cap test, not an annualised projection.

**Why it usually doesn't matter for a full-time year-round salaried employee:**
- If hours-per-year = 2080, salary = annual_base, and the person worked all 12 months, then `min(annual_base, cap) × (hours_on_sred / 2080)` = `min(annual_base × (hours_on_sred / 2080), cap × (hours_on_sred / 2080))`, which is also what CRA's prorated-cap formula yields. **The two formulas agree in the steady-state case.**

**When it diverges:**
- **Partial-year employment.** An employee hired Oct 1 with annual_base = $400k. Code: caps the $400k annual at (say) $357.5k, then charges (hours_on_sred / 2080) × $357.5k. CRA: prorates cap to ~$89k (3/12 of $357.5k) and caps SR&ED salary at that.
- **Hourly with sporadic work.** `amount_cents * hours_per_year` invents a full-year salary equivalent even if the person only logged 80 hours, then caps that fictional number. Result: the cap almost never bites for an hourly employee, which is the opposite of the policy intent.
- **`hours_per_year` defaults to 2080.** Migration 001 line 92 default; effectively asserts everyone is full-time-equivalent. There's no UI/API path to claim "this person was at 60% FTE" — so part-time specified employees will appear under-capped.

**Impact:** for a steady-state full-time specified employee, totals are correct. For mid-year hires, mid-year departures, part-time staff, or contractors flagged as specified employees, the cap-applied amount can be materially wrong — typically *over-claiming* SR&ED labour cost because the cap doesn't tighten.

**Suggested fix (no code change here, just direction):** track employment start/end dates per `user_claimants` row (column already exists, migration 009 added `employment_start_date`; would also need `employment_end_date`). Compute prorated cap as `(days_specified_in_year / days_in_year) × annual_cap`. Cap the *SR&ED salary* (= sum of `hours × effective_hourly` for SR&ED entries) at the prorated cap, not the full-year-equivalent salary.

#### F2. T661 line numbers are absent from every output.

**What the code does:** `format.js` emits Markdown / CSV / PDF using human labels like "Labour", "Materials", "Contract expenditures", "Third-party payments", "Overhead". There is **no T661 line number** anywhere in any output. The CSV's `line` column is the *category name* (`labour`, `materials`, etc.), not the T661 form line.

**What CRA forms expect** [training recollection, please verify against current T661]:
On T661 v22 (latest I'm aware of, valid for tax years 2022+), Part 3 has discrete lines. From memory, approximately:
- Line **300** Total salary/wages (current year)
- Line **305** SR&ED portion of salary/wages
- Line **306** [I don't recall this being an OT-specific line; the OT split is part of *internal* worksheets, not T661 itself — see F6]
- Line **307** Specified-employee SR&ED salary
- Line **320** Cost of materials consumed
- Line **325** Cost of materials transformed
- Line **340** Contracts for SR&ED performed on behalf
- Line **345** Lease costs of equipment used (traditional only)
- Line **350** Overhead and other expenditures (traditional only)
- Line **360** Third-party payments
- Line **370** Total allowable SR&ED expenditures
- Line **502** Prescribed proxy amount (proxy only)

**Could not verify** with web access; numbers shift between T661 versions, and I'd want to confirm against the live form.

**Impact:** the tax preparer has to mentally map each export line to the right T661 line. For Materials there's no split between "consumed" (320) and "transformed" (325) — the schema has a single `material` category. For Contracts there's no distinction between "arm's-length SR&ED contracts" (340) and "non-arm's-length" — which CRA treats differently (qualifying expenditures are limited for NAL contracts). Third-party payments (360) are restricted to **approved entities** (universities, approved research institutes, qualifying corporations) — the schema doesn't enforce any of that.

**Suggested fix:** attach a `t661_line` field on each expense category, and surface it in `format.js` output as "Line 320 — Materials consumed". Add `arm_length` boolean on contract expenses. Add an `approved_entity` lookup table for third-party payments and validate against it.

#### F3. SR&ED-eligibility test is implicit, only encoded as a `type='sred'|'internal'` boolean.

**What the code does:** `projects.type` enum, with `'sred'` projects rolling up into T661. Eligibility decision is whoever ticks the dropdown.

**What CRA requires** [training recollection — ITA s.248(1) definition of SR&ED, T4088 §3]:
The three-prong test (per IC86-4R3 and *Eligibility of Work for SR&ED Investment Tax Credits Policy*):
1. **Scientific or technological uncertainty** — must be a real uncertainty not resolvable by routine engineering.
2. **Hypothesis formulated to reduce the uncertainty** — work must be guided by hypothesis.
3. **Systematic investigation/search** by means of experiment or analysis by qualified personnel.

The code's `projects.uncertainties` and `projects.advancement_sought` capture (1) and (3) implicitly, but there's no explicit field for **hypothesis** (item 2). Neither is there a field for **how the work was systematic** (test plans, control conditions, iteration log). The five questions CRA asks in IC86-4R3 are usually rendered as a checklist; here we get three free-text fields and a checkbox.

**Impact:** a project is flagged `sred` based on admin's judgment. On audit, CRA expects evidence of *all five questions* (the three above plus "what advancements were achieved or attempted" and "what records were kept of the hypotheses tested and the results"). The narrative may answer them implicitly but the schema doesn't prompt the admin for each.

**Suggested fix:** add a `hypothesis` field on `projects`, and an "evidence-of-systematic-investigation" association (currently labour_entry descriptions cover this loosely, but they're not explicitly tied to a hypothesis cycle).

#### F4. FX rate semantics: schema accepts a single per-expense rate, no documentation of *which* rate.

**What the code does** (`t661.js:42-48` and `expenses.fx_rate REAL`): one rate per expense row. `reportingAmount = amount_cents × fx_rate`. No constraint on which date's rate or which source's rate.

**What CRA requires** [training recollection — *Income Tax Folio S5-F4-C1*, *Income Tax Conversion of Foreign Currency*]:
- Foreign-currency amounts must be converted at the **spot rate on the day the amount arose** (i.e., transaction date), OR consistently at an annual average from a source CRA accepts (typically Bank of Canada).
- CRA has, for several years now, specified that the **Bank of Canada single daily rate** (changed in 2017) or annual average is acceptable.
- The choice must be consistent and disclosed.

The code stores `fx_rate` as an opaque number with no source attribution and no constraint on *when* the rate was sampled. A user could enter the rate from any date or any source. The `expenses.fx_rate REAL` column is not even constrained to be > 0.

**Impact:** auditable but not defensible without out-of-band notes. If a foreign contract was invoiced in USD on three different dates with three different rates, the user enters whatever rate they want. If the company switches between "transaction-date" and "annual-average" mid-year, the system can't tell.

**Suggested fix:** add `fx_rate_source` (enum: `bank_of_canada_daily`, `bank_of_canada_annual`, `other`) and `fx_rate_date` (DATE) columns. Validate the rate against Bank of Canada API where possible. Lock the choice per-claimant (similar to how `sred_method` is locked).

#### F5. Traditional-method overhead is "everything with category='overhead'" — too coarse.

**What the code does:** `t661.js:131-134` accumulates any expense with `category='overhead'` into `overheadExpenses`, then under `sred_method='traditional'` reports that sum as the overhead line.

**What CRA requires** [training recollection — *Traditional and Proxy Methods Policy* §3, T4088 line 360 area]:
Under the traditional method, overhead and other expenditures are eligible only if they are **directly attributable to the prosecution of SR&ED**. That includes:
- Salaries of employees who *directly support* SR&ED but whose work isn't itself SR&ED (e.g., admin assistant exclusively for the SR&ED lab).
- The portion of rent, utilities, property taxes attributable to SR&ED space (allocated by floor area or other reasonable basis).
- Maintenance and repair of equipment used for SR&ED.
- Travel costs directly tied to SR&ED.
- Office supplies consumed during SR&ED.

Each of these has its own **allocation basis** and CRA expects the allocation methodology to be documented. The schema's single bucket loses all that structure — and worse, an admin could classify, say, a non-SR&ED supporting expense as `overhead` and have it slip through.

**Impact:** the traditional-method total is whatever the admin types in. There's no separate field for "allocation basis" or "% allocated to SR&ED". This is the kind of thing that gets disallowed in audit and the admin has nothing to point to.

**Suggested fix:** under traditional method, expand `category='overhead'` into sub-categories (`overhead_salary_support`, `overhead_rent_utilities`, `overhead_maintenance`, etc.) with a per-row `sred_allocation_pct` and `allocation_basis_text`. Or, more conservatively, add a free-form `allocation_methodology` field on the expense.

#### F6. Overtime hours surfaced as a separate line in the worksheet — but T661 itself doesn't ask for an OT split.

**What the code does:** `t661.js:107-117` tracks `regular_hours` / `overtime_hours` per worksheet row; `format.js:62-75` and `:188-202` show the split in Markdown and PDF; CSV emits separate `labour_regular_hours` / `labour_overtime_hours` rows. The comment at `t661.js:103-106` correctly notes that "T4088 treats overtime hours at the same hourly rate as regular hours for SR&ED labour cost" — so the cost is the same regardless. And the OT split is shown only when there's OT (`anyOt` flag).

**What CRA requires** [training recollection]:
- For SR&ED purposes, overtime *paid as straight time at a higher hourly rate* is included in salary. Overtime *paid in lieu* (banked) is included when paid out.
- I do **not** recall a T661 line that asks for OT hours separately — the form asks for total SR&ED salary (line 300/305 split), and the calculation uses actual amounts paid.
- The internal `is_overtime` flag is a reporting marker, fine for the worksheet, but the comment in `t661.js:106` that references "T661 line 305 vs 306 reporting" looks **incorrect** — line 306 isn't (to my knowledge) an OT-specific line on T661. **Couldn't verify** what line 306 actually is on the current T661 v22.

**Impact:** low — the actual labour cost calculation is correct. The risk is documentation confusion: if the tax preparer sees the OT split and tries to enter it on T661 line 306, they may be entering the wrong thing or filling a line that no longer exists.

**Suggested fix:** drop the "T661 line 305 vs 306" comment unless someone can cite a current CRA reference for line 306. Keep the OT split as an internal reporting nicety; clarify in the export that it's a worksheet annotation, not a T661 form field.

### Couldn't verify

- **V1. Specified-employee cap values for 2025/2026/2027.** `wage-caps.js:9-11` says $357,500 / $367,500 / $377,500, all annotated `// verify`. The cap is **5 × YMPE** at ITA Reg. 8501-ish (actually it's referenced in s.37(9.1) and the YMPE is set under the CPP). YMPE for 2024 was $68,500 → 5× = $342,500 (matches code). For 2025+ I'd want to cross-reference the published YMPE plus the *additional maximum pensionable earnings* (the YAMPE / CPP2 layer started in 2024 — I'm unsure whether CRA's specified-employee cap uses YMPE or YMPE+YAMPE going forward). **The 2025+ figures need confirmation against the latest CRA *Salary or Wages Policy* publication.**

- **V2. Current T661 line numbers.** Form versions change. I'm citing line numbers from memory of T661 v21/v22. Whoever consumes this report should pull the current PDF from canada.ca and confirm.

- **V3. Whether `type='sred' | 'internal'` is sufficient.** The CRA-recognised binary is "SR&ED" vs "not SR&ED"; internally, claimants often distinguish between, say, "experimental development", "applied research", "basic research", which map to ITA s.248(1)(a)/(b)/(c). T661 has a "category of work" question (line ~205 area, IIRC). The code's flat `'sred'` doesn't capture the (a)/(b)/(c) sub-type. **Confidence: low — the schema may be sufficient if "field_of_science" is taken to encode this, but I can't verify against the current form.**

- **V4. Whether 1.5× overtime cost can be claimed.** Migration 006's comment says "1.5x cost is a downstream conversation between admin and payroll; adding a multiplier here would change historical totals." The CRA position [training recollection — *Salary or Wages Policy* §2.2 area] is that **actual amounts paid** are eligible — so if payroll actually paid 1.5× for OT, that 1.5× is eligible salary. The code currently treats OT hours at the **regular** hourly rate, which understates SR&ED salary when overtime was actually paid at premium rates. But the comment suggests this is intentional. **Couldn't verify** whether the policy choice (treat at straight time) is consistent with how the underlying payroll is being reflected in `amount_cents`.

## Form-line mapping audit

| Code surface | T661 line (from memory; verify) | Comment |
|---|---|---|
| `labour_cost_cents` (grand total) | Line 300 → 305 | Code doesn't distinguish total salary from SR&ED salary; only SR&ED hours are recorded, so this is effectively line 305. Line 300 would require knowing total salary (out of scope for this app). |
| `is_specified_employee` worksheet rows | Line 307 (subset of 305) | Per-employee aggregation is right; the cap math (F1) is the concern. |
| `regular_hours` / `overtime_hours` | **No matching line** I can confirm | The "line 305 vs 306" comment at t661.js:106 is suspect — V2/F6. |
| `materials_cents` | Line 320 + 325 | Schema doesn't split consumed vs transformed. |
| `contract_expenditures_cents` | Line 340 | No arm's-length / non-arm's-length distinction; CRA limits NAL contract eligibility to "qualifying expenditure" basis. |
| `third_party_payments_cents` | Line 360 | No approved-entity validation. |
| `overhead_cents` (proxy) | Line 502 (PPA) | Correct: 55% of SR&ED salary base. |
| `overhead_cents` (traditional) | Line 350 (?) | Single bucket — F5. |
| `total_cents` | Line 370 | Sum is right; line 370 is "total allowable SR&ED expenditures before adjustments". |
| **Missing entirely** | Line 345 (equipment lease, traditional) | No `lease` expense category in the schema. |
| **Missing entirely** | Line 390 / 400 area (adjustments, contract payments received) | No mechanism for assistance / government contributions reducing the claim. |
| **Missing entirely** | Capital expenditures | Use-cases.md §6 explicitly excludes these post-2014 (correct decision per ITA changes). |

Outputs (`toMarkdown`, `toCsv`, `toPdf`) **none reference T661 line numbers**. Add them as parenthetical labels at minimum.

## Eligible expense categories audit

Schema (migration 001 `expenses.category`):
- `material` — covers lines 320 + 325 without splitting.
- `contract` — covers line 340 without arm's-length attribute.
- `third_party_payment` — covers line 360 without approved-entity validation.
- `overhead` — covers line 350 (traditional) without sub-categorisation; replaced by PPA under proxy (handled correctly).

**Categories missing** that may apply:
- **Equipment lease costs** (line 345, traditional only). Schema treats this as either `material` or `overhead` — both are wrong. Lease of equipment used >50% for SR&ED is its own line with its own rules.
- **Capital expenditures** — correctly out of scope (post-2014).
- **Contract payments received** (reduces eligible base; line 504 area).
- **Government assistance / ITC received in prior year** (line 513 / 540 area). For multi-year claims this matters.

**Categories where the schema may be too broad:**
- `contract` — should distinguish arm's-length from non-arm's-length. NAL contracts have reduced eligibility (limited to the contractor's allowable cost, not the full contract amount).
- `third_party_payment` — should require linkage to an approved entity (CRA publishes a list). The schema accepts any free-text description.

## Audit-defensibility gaps

What's strong:
- Contemporaneous evidence with server-side timestamps (`evidence_items.created_at`).
- Versioned project narratives (`project_revisions`) — admin can show the version as filed.
- Compensation history with effective dates — defensible against "what rate did you use" questions.
- Per-labour-entry descriptions tied to a date and an employee — basic time-sheet granularity is there.

What's weak / gaps:
1. **No "what fraction of the day was on SR&ED" tracking.** A labour entry has `hours` on `project_id` for `work_date`, and multiple labour entries per day are allowed. So in principle an admin can say "Alice did 4h on ET Grow and 4h on internal training on 2026-04-01". That's the right granularity for CRA's "log how SR&ED time was allocated daily" expectation. **However:** there's no constraint that the sum of hours on a date can't exceed 8 or 10 (the `hours <= 24` check is too loose), and no requirement to log non-SR&ED time at all. A CRA auditor reviewing time records would want to see "did this person actually have non-SR&ED duties, and are we sure they didn't book all 40h/week against SR&ED?" — the schema can't answer that.
2. **No `hypothesis` field on projects.** See F3. The CRA five-question framework expects this explicitly.
3. **No personnel-on-project competency record.** CRA's third prong is "systematic investigation by qualified personnel". The `user_claimants.title` field is the only place that captures qualifications, and it's free-text.
4. **No linkage from evidence to specific uncertainties.** Evidence is attached to a project or a labour entry, but there's no explicit "this evidence resolves uncertainty X". On audit, CRA wants to trace each piece of evidence to a question it answered.
5. **No "date uncertainty was identified" field.** A project starts on `start_date`, but the *moment* the uncertainty was recognised (relevant for the eligibility window — work before that moment isn't SR&ED) isn't captured.
6. **Audit log is append-only (migration 008) — good** — but doesn't include reads. For privacy claims like "who looked at this employee's salary" CRA doesn't ask, but the existing log is sufficient for the "who edited this row" question.
7. **`fx_rate` source not captured** (F4). On audit, "where did this USD→CAD rate come from" is a routine question.
8. **Currency lock-in:** the claimant's `reporting_currency` defaults to CAD (good) but isn't constrained — a hypothetical USD-reporting claimant would have a CAD T661, which is wrong (T661 reports in CAD only, AFAIK). Worth a check constraint.

## Final notes

This review was prepared without live web access. If the team can re-run with `WebSearch`/`WebFetch` enabled and pull canada.ca pages directly, every claim above marked "training recollection" or "from memory" should be cross-checked against:

- T661 form, current version (canada.ca/.../t661.html)
- T4088 *Guide to Form T661*, current edition
- CRA *Salary or Wages Policy*
- CRA *Total Qualified SR&ED Expenditures Policy*
- CRA *Traditional and Proxy Methods Policy*
- CRA *Eligibility of Work for SR&ED Investment Tax Credits Policy*
- Information Circular IC86-4R3
- ITA s.37, s.127, s.248(1) "specified employee", s.248(1) "scientific research and experimental development"

The biggest single risk in the current code is **F1 (specified-employee cap not pro-rated)**. The biggest single quality improvement would be **F2 (line-number labelling in the export)** — almost zero implementation cost, large gain in tax-preparer ergonomics.
