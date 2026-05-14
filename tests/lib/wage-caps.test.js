// Tests for src/lib/wage-caps.js — specified-employee salary cap lookup.
//
// Strategy:
//   - Pure function, no DB / no env required. Just import and assert.
//   - We cover every year hardcoded in the table, plus both out-of-range paths.
//   - The module documents that gaps log a warning and fall back to the latest
//     known year. We assert that contract, including the console.warn side effect.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { specifiedEmployeeCapCents } from '../../src/lib/wage-caps.js';

// Mirrors the table in src/lib/wage-caps.js. If new years are added there,
// extend this list — the test will tell you which year is missing.
const EXPECTED_CAPS = {
  2023: 33150000,
  2024: 34250000,
  2025: 35750000,
  2026: 36750000,
  2027: 37750000,
};

const KNOWN_YEARS = Object.keys(EXPECTED_CAPS).map(Number).sort((a, b) => a - b);
const LATEST = KNOWN_YEARS[KNOWN_YEARS.length - 1];

// --- Helper: capture console.warn for a single call -------------------------

function withCapturedWarn(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => { calls.push(args); };
  try {
    const result = fn();
    return { result, calls };
  } finally {
    console.warn = original;
  }
}

// --- Tests ------------------------------------------------------------------

test('returns the correct cap for every year in the hardcoded table', () => {
  for (const [year, expected] of Object.entries(EXPECTED_CAPS)) {
    const got = specifiedEmployeeCapCents(Number(year));
    assert.equal(
      got,
      expected,
      `specifiedEmployeeCapCents(${year}) expected ${expected}, got ${got}`,
    );
  }
});

test('a year in the table does NOT log a warning (happy path is silent)', () => {
  const { result, calls } = withCapturedWarn(() => specifiedEmployeeCapCents(2025));
  assert.equal(result, EXPECTED_CAPS[2025]);
  assert.equal(calls.length, 0);
});

test('for a year AFTER the table, falls back to the latest known year', () => {
  const futureYear = LATEST + 5;
  const { result, calls } = withCapturedWarn(
    () => specifiedEmployeeCapCents(futureYear),
  );
  assert.equal(result, EXPECTED_CAPS[LATEST]);
  // Module contract: gap is visible via console.warn.
  assert.equal(calls.length, 1);
  const msg = String(calls[0][0]);
  assert.match(msg, /wage-caps/);
  assert.match(msg, new RegExp(String(futureYear)));
  assert.match(msg, new RegExp(String(LATEST)));
});

test('for a year BEFORE the table, also falls back to the latest known year (not the lowest)', () => {
  // The module has a single fallback path: any unknown year => LATEST_YEAR.
  // This is intentional per the source comment ("fall back to the latest known
  // year"), even for ancient years. We pin that behaviour here so a refactor
  // toward "clamp to nearest" would have to update this test deliberately.
  const ancientYear = KNOWN_YEARS[0] - 10;
  const { result, calls } = withCapturedWarn(
    () => specifiedEmployeeCapCents(ancientYear),
  );
  assert.equal(result, EXPECTED_CAPS[LATEST]);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), new RegExp(String(ancientYear)));
});

test('accepts numeric year input (the documented contract)', () => {
  assert.equal(specifiedEmployeeCapCents(2024), EXPECTED_CAPS[2024]);
});

test('string year inputs are also resolved via the object lookup', () => {
  // CAPS_BY_YEAR[year] with a string key matches the numeric key because JS
  // object keys are strings. We pin this behaviour because callers in the
  // codebase pass `new Date(...).getFullYear()` (always a number), but a
  // future caller passing a string from JSON should not silently get the
  // fallback. If this assumption ever changes, this test will catch it.
  const { result, calls } = withCapturedWarn(
    () => specifiedEmployeeCapCents('2025'),
  );
  assert.equal(result, EXPECTED_CAPS[2025]);
  assert.equal(calls.length, 0);
});
