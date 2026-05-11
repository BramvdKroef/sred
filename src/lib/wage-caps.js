// Specified-employee salary cap per ITA s.37 / T661 line 307.
// Updated by code change when CRA publishes new figures (~5× YMPE).
// If a labour-entry year is missing here, fall back to the latest known year
// and log a warning so the gap is visible.

const CAPS_BY_YEAR = {
  2023: 33150000, // $331,500
  2024: 34250000, // $342,500
  2025: 35750000, // $357,500 — verify
  2026: 36750000, // $367,500 — verify
  2027: 37750000, // $377,500 — verify
};

const KNOWN_YEARS = Object.keys(CAPS_BY_YEAR).map(Number).sort((a, b) => a - b);
const LATEST_YEAR = KNOWN_YEARS[KNOWN_YEARS.length - 1];

export function specifiedEmployeeCapCents(year) {
  if (CAPS_BY_YEAR[year] !== undefined) return CAPS_BY_YEAR[year];
  console.warn(`[wage-caps] no cap for ${year}; falling back to ${LATEST_YEAR}`);
  return CAPS_BY_YEAR[LATEST_YEAR];
}
