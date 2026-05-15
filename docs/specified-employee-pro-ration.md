# Specified-employee cap: pro-ration by days-as-specified

**Status:** Design proposal — not implemented. Intended for tax-preparer review.
**Author:** Generated 2026-05-15, against `master` in worktree `agent-a6bd2d4e7e86b03b6`.
**Origin:** F1 in `SRED_DOMAIN_REVIEW.md` (P1 finding).
**Audience:** A qualified tax preparer (to verify the CRA rule), and an implementer (to land the schema + calc changes once verified).

---

## 1. Current behaviour

`src/lib/t661.js` lines 24-40 implement the cap as follows:

```js
// Effective hourly rate (in cents) for a labour entry, with the specified-employee cap applied.
// Returns { hourly_cents, cap_applied, annual_base_cents, effective_annual_cents }.
function effectiveHourly({ comp, isSpecified, workDate }) {
  const yearlyHours = comp.hours_per_year || 2080;
  const annualBase = comp.comp_type === 'salary'
    ? comp.amount_cents
    : comp.amount_cents * yearlyHours;
  const year = Number(workDate.slice(0, 4));
  const cap = isSpecified ? specifiedEmployeeCapCents(year) : null;
  const effectiveAnnual = cap !== null && annualBase > cap ? cap : annualBase;
  return {
    hourly_cents: effectiveAnnual / yearlyHours,
    cap_applied: cap !== null && annualBase > cap,
    annual_base_cents: annualBase,
    effective_annual_cents: effectiveAnnual,
  };
}
```

The flag this branches on is `user_claimants.is_specified_employee` (boolean; `src/db/migrations/001_init.sql` line 79):

```sql
is_specified_employee  INTEGER NOT NULL DEFAULT 0,
```

The flag has **no date dimension**. A person is either flagged for the entire history of the attachment, or not at all.

### Worked example (current code)

- Calendar year 2025. Cap = $357,500 (from `wage-caps.js`).
- Alice: `is_specified_employee = 1`, salary $400,000/yr, 2080 hours-per-year, employed all 12 months, books 1,000 SR&ED hours.
- Code: `annualBase = 40_000_000` cents. `cap = 35_750_000` cents. `effectiveAnnual = 35_750_000`. `hourly_cents = 35_750_000 / 2080 ≈ 17,187`.
- Labour cost on T661 = `1000 × 17,187 = 17,187,500` cents (= **$171,875**).

This is correct for the steady-state case.

### Where it breaks

- **Mid-year specified-status change.** Alice was promoted to officer (specified) on 2025-07-01. CRA's view (see §2 below) is that the cap should be pro-rated to the half of the year she was specified — say, ~$178,750. The code can't represent "she was specified for half the year" — the flag is all-or-nothing.
- **Mid-year hire / departure.** A specified hire on 2025-10-01 with $400k base: code applies the full $357,500 cap as if she earned it over the whole year. CRA wants ~$89,400 (3/12) cap on her three months.
- **Hourly with sporadic work.** Synthesises a full-year salary equivalent, then caps it — the cap almost never bites. Same root cause: no concept of "the portion of the year she was specified".

## 2. The CRA rule (per the prior domain review)

From `SRED_DOMAIN_REVIEW.md` §F1 (caveat: the reviewer flagged this as "training recollection, please verify"):

> ITA s.37(9.1) and s.248(1) "specified employee" definition: the cap is **5× the YMPE** for the calendar year — and the *cap itself* is pro-rated for the number of days in the year the person was a specified employee. So a person hired July 1 has a cap of ~½ × (5 × YMPE), not the full cap.
> The cap is on **salary or wages incurred in the year on SR&ED** (form T661 line 307 in the salary base), not on total salary. The mechanism is: take SR&ED salary actually incurred for this person, and cap it at the prorated cap amount.

### Verify before implementing

The reviewer was working without live web access and flagged the citation as recollected, not verified. Before any code lands:

- Cross-check ITA s.37(9.1) and s.248(1) "specified employee" against the current CRA *Salary or Wages Policy* on canada.ca.
- Confirm the cap is **pro-rated by days-as-specified within the calendar year** (vs. days-as-specified within the fiscal period, vs. some other denominator).
- Confirm the denominator is "days in the calendar year" (365 / 366), not "working days" or anything else.
- Confirm the cap is **applied to SR&ED salary, not to total salary** — i.e., the cap is a ceiling on the line-307 number, not an input to the hourly-rate computation.

If any of those are wrong, the design below changes shape.

## 3. The proposal

### 3.1 Schema

Add two nullable date columns to `user_claimants`:

```sql
ALTER TABLE user_claimants ADD COLUMN specified_from  TEXT;  -- ISO-8601 date, nullable
ALTER TABLE user_claimants ADD COLUMN specified_until TEXT;  -- ISO-8601 date, nullable
```

Interpretation:

| `is_specified_employee` | `specified_from` | `specified_until` | Meaning                                                                                    |
|-------------------------|------------------|-------------------|--------------------------------------------------------------------------------------------|
| 0                       | (ignored)        | (ignored)         | Never specified. No cap applied.                                                           |
| 1                       | NULL             | NULL              | Specified for the whole attachment history. **Backwards-compatible** with current data.    |
| 1                       | `YYYY-MM-DD`     | NULL              | Specified from that date onward, indefinitely (still specified).                           |
| 1                       | NULL             | `YYYY-MM-DD`      | Specified up to and including that date, then no longer specified.                         |
| 1                       | `YYYY-MM-DD`     | `YYYY-MM-DD`      | Specified only within the closed range, inclusive.                                         |

A labour entry's `work_date` is "specified" iff `is_specified_employee = 1` AND `(specified_from IS NULL OR work_date >= specified_from)` AND `(specified_until IS NULL OR work_date <= specified_until)`.

Notes:

- Both columns are nullable so existing rows default to NULL → behaviour unchanged for the steady-state case.
- No `CHECK` constraint on `specified_from <= specified_until` for now; advisory in the API layer is fine. (A future migration could tighten this.)
- The simple two-column shape covers >99% of real cases (promoted to officer, demoted from officer, hired-as-specified mid-year). If a person flips in and out of specified status multiple times in a year (rare), a separate `user_claimant_specified_periods` table would be needed — out of scope for this proposal.

### 3.2 Calculation

Replace the per-labour-entry cap logic. The new flow:

1. For each `user_claimant` whose labour rolls into the period, compute the **pro-rated cap** by calendar year:
   - For each calendar year `Y` that overlaps the fiscal period:
     - `days_in_year` = 365 or 366.
     - `days_as_specified_in_Y` = number of days in `Y` where the person was specified (intersect `[specified_from, specified_until]` with `Y`, falling back to `[Y-01-01, Y-12-31]` when the date columns are NULL).
     - `prorated_cap_cents(Y) = round(specifiedEmployeeCapCents(Y) × days_as_specified_in_Y / days_in_year)`.
2. For each calendar-year-and-employee bucket of labour entries:
   - `uncapped_sred_salary_cents(Y) = Σ over entries with work_date in Y: hours × uncapped_hourly_cents(entry)`
     where `uncapped_hourly_cents` is the existing `findEffectiveComp` -> hours-per-year math (without cap).
   - If the person is specified for **any** part of `Y`, the SR&ED labour cost charged for `Y` for this person is `min(uncapped_sred_salary_cents(Y), prorated_cap_cents(Y))`.
   - If not specified at all in `Y`, no cap.
3. The labour cost per project, per employee, is scaled down proportionally if the cap bit — i.e., apply a single per-employee-per-year scaling factor `min(1, prorated_cap_cents(Y) / uncapped_sred_salary_cents(Y))` to each entry's contribution before summing into project totals.

The shift from "cap the hourly rate" to "cap the year's SR&ED salary, then scale" is the structural change. It is closer to CRA's stated rule and behaves correctly under partial-year specified status.

Pseudocode (for the design — not the actual implementation):

```
for each user_claimant in period:
  for each calendar year Y overlapping the fiscal period:
    days_as_specified = overlap_days(
      [specified_from ?? Y-01-01, specified_until ?? Y-12-31],
      [Y-01-01, Y-12-31],
    )
    if days_as_specified == 0: scaling[uc, Y] = 1.0; continue
    cap_Y = round(annual_cap(Y) * days_as_specified / days_in(Y))
    uncapped_Y = sum(entry.hours * uncapped_hourly(entry) for entry in entries_in_Y[uc])
    scaling[uc, Y] = min(1.0, cap_Y / uncapped_Y)   // == 1.0 when no cap bites

for each labour entry e:
  Y = year_of(e.work_date)
  charged = e.hours * uncapped_hourly(e) * scaling[e.user_claimant_id, Y]
  // accumulate into project/employee/total
```

### 3.3 Worked example (with the proposal)

Same Alice as in §1, but promoted to officer on 2025-07-01:

- `is_specified_employee = 1`, `specified_from = 2025-07-01`, `specified_until = NULL`.
- Salary $400,000/yr. SR&ED hours split 500 in H1, 500 in H2.
- 2025 is not a leap year → `days_in_year = 365`.
- `days_as_specified_in_2025` = days from 2025-07-01 to 2025-12-31 inclusive = **184**.
- `prorated_cap = round(35_750_000 × 184 / 365) = round(18_021_369.86) = 18_021_370` cents ≈ **$180,213.70**.
- `uncapped_hourly = 40_000_000 / 2080 ≈ 19,230.77` cents.
- Uncapped 2025 SR&ED salary for Alice = `1000 × 19,230.77 ≈ 19,230,769` cents.
  - Of that, H1 portion (500h) ≈ $96,154 — not subject to cap.
  - H2 portion (500h) ≈ $96,154 — would be subject to cap.
- Total uncapped = ~$192,308 > prorated cap $180,214 → **cap bites**.
- Scaling factor = `18_021_370 / 19_230_769 ≈ 0.9371`.
- Charged: `19_230_769 × 0.9371 ≈ 18_021_370` cents = **$180,213.70** on T661 for Alice.

Compare with current code (which would just cap the annual to $357,500 with no proration): code would charge `min(40_000_000, 35_750_000) / 2080 × 1000 = 17,187,500` cents = **$171,875**. The proposal claims **$8,339 more** than the current code in this scenario — because under proration, H1 (when she was not specified) goes in uncapped.

Conversely, if Alice were hired specified on 2025-10-01 at $400k and booked 500 SR&ED hours over Q4:

- `days_as_specified = 92`. `prorated_cap ≈ round(35_750_000 × 92 / 365) ≈ 9_010_685` cents ≈ **$90,107**.
- Uncapped Q4 SR&ED salary = `500 × 19,230.77 ≈ 9_615_385` cents ≈ **$96,154**.
- Cap bites. Charged ≈ **$90,107**.
- Current code would charge `500 × 17,187 ≈ 8,593,750` cents ≈ **$85,938** — i.e., under-claiming, because the current code's apportionment-by-hours happens to be slightly tighter than the proportional-by-days cap. Direction of error varies case-by-case.

### 3.4 Note on the cap applying across calendar years in a single fiscal period

Claimants with off-calendar fiscal periods (e.g., year-end 2026-03-31) will have a single period that straddles two calendar years. The cap is per **calendar** year, not per fiscal year. The implementation must bucket entries by calendar year, apply the cap per-bucket, then aggregate up to the fiscal period total.

## 4. Migration strategy

```sql
-- migrations/014_user_claimant_specified_date_range.sql
ALTER TABLE user_claimants ADD COLUMN specified_from  TEXT;
ALTER TABLE user_claimants ADD COLUMN specified_until TEXT;
```

Properties:

- **Additive only.** No data rewrite, no backfill, no down-migration concern.
- **Backwards-compatible.** All existing `is_specified_employee = 1` rows continue to behave identically (treated as "specified the whole time").
- **No-op for existing fully-correct cases.** A full-time year-round specified employee on a calendar-year fiscal period sees no change in T661 totals (the steady-state agreement noted in `SRED_DOMAIN_REVIEW.md` F1).
- **Safe rollback.** Reverting the calc change alone (without dropping the columns) just ignores the date columns — no broken data state.
- **Admin UX** (out of scope for the schema, but to plan for): the existing Add/Edit-employee form needs a "specified-employee period" sub-form (two optional dates, shown only when `is_specified_employee` is checked). Validation: `specified_until` >= `specified_from` if both present.

## 5. Test plan

These tests should be added to `tests/` (likely `tests/t661.test.js` or a new `tests/specified-employee-proration.test.js`):

1. **Steady state still correct.** Specified employee, full calendar year, $400k salary, `specified_from` and `specified_until` both NULL → labour cost charged equals the current code's output to the cent. (Regression guard.)
2. **Mid-year promotion.** Specified from 2025-07-01, NULL until, $400k. SR&ED hours evenly split H1/H2. Result: H1 hours uncapped at full hourly rate; H2 hours capped using prorated cap of `35_750_000 × 184/365`. Assert exact total.
3. **Mid-year hire (specified from day one).** `employment_start_date = 2025-10-01`, `specified_from = 2025-10-01`, `is_specified_employee = 1`, $400k salary base. SR&ED hours all in Q4. Result: capped at `35_750_000 × 92/365`.
4. **Mid-year departure.** `specified_until = 2025-06-30`. SR&ED hours all in H1. Result: capped at `35_750_000 × 181/365`. Any hours after `specified_until` are uncapped.
5. **Below the cap, no proration needed.** Specified employee at $200k (under $357,500 cap), partial year. Uncapped SR&ED salary < prorated cap → no scaling, charged at the full uncapped rate.
6. **Off-fiscal-period straddling two calendar years.** Fiscal period 2025-04-01 to 2026-03-31, specified the whole period, $400k salary, evenly distributed SR&ED hours. Cap applied separately for 2025 and 2026 buckets (using each year's cap value from `wage-caps.js`). Assert that the result equals `cap(2025) × Q2-Q4-fraction + cap(2026) × Q1-fraction`-style decomposition.
7. **(Bonus) Leap-year denominator.** 2024 specified-from 2024-03-01 — denominator must be 366, not 365. Assert the off-by-one isn't off.

## 6. Verification questions for a tax preparer

Yes/no questions to confirm before code lands:

1. Is the specified-employee cap pro-rated by **days the person was a specified employee within the calendar year** (vs. the fiscal year, vs. some other denominator)?
2. Is the denominator **calendar days in the year** (365 or 366), or "working days", or something else?
3. Does the cap apply to **SR&ED salary** (i.e., as a ceiling on the post-attribution amount that lands on T661 line 307), rather than to total salary or to an annualised hourly rate?
4. If a person is a specified employee for only part of a calendar year, is **only the SR&ED salary incurred during the specified portion** subject to the cap, and is salary from the non-specified portion uncapped? (As opposed to: the entire year's SR&ED salary being subject to the pro-rated cap.)
5. For an off-calendar fiscal year that straddles two calendar years, is the cap applied **separately per calendar year** within the fiscal period?

(If the preparer answers #4 differently than this design assumes — e.g., "the prorated cap applies to the entire year's SR&ED salary regardless of when in the year it was incurred" — the calculation in §3.2 needs to be reshaped to apply the cap to the full-year uncapped total rather than only to the specified-window subtotal.)

## 7. Risk

What if this ships with the wrong interpretation?

- **If the rule is actually "cap is NOT pro-rated; full cap applies regardless of partial-year specified status"** (i.e., our prior domain review is wrong): the proposal **under-claims** for mid-year hires/promotions, because we'd be applying a smaller cap than CRA actually allows. Direction: lower refund than entitled. CRA wouldn't push back on audit; the claimant just leaves money on the table.
- **If the rule is "cap IS pro-rated, and is applied to total SR&ED salary including the non-specified portion of the year"**: the proposal **over-claims** by un-capping the non-specified portion. Direction: higher refund than entitled. On audit, CRA would disallow the excess and could assess gross-negligence penalties if the position is indefensible. **This is the worse failure mode**, and the reason verification question #4 is the critical one.
- **If the denominator is wrong (e.g., "working days" not "calendar days")**: small magnitude error, both directions possible.
- **If the cap is per-fiscal-year not per-calendar-year**: meaningful magnitude error for off-calendar fiscal periods; direction depends on which year's cap is higher.

The current code already exhibits the over-claim risk for mid-year hires (it doesn't tighten the cap when it should). Implementing this proposal **reduces** that risk in the steady-state direction the reviewer recommended — but only if the rule interpretation is correct. **A tax preparer must confirm the interpretation before this lands.** A code change that moves the result in the wrong direction is worse than no change, because the existing behaviour is at least documented as a known approximation.

Until verified, this proposal stays as `docs/` only. No schema change, no calc change, no migration ships.
