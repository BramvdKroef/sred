// Unit tests for the pure hash parser/validator exported from public/admin.js.
// This covers the regression where an unknown hash silently kept the previous
// tab — the validator now exposes a `valid` flag so the caller can revert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHashStr, ALLOWED_TABS } from '../../public/admin.js';

test('parseHashStr: known tabs are valid', () => {
  for (const tab of ALLOWED_TABS) {
    const r = parseHashStr('#' + tab);
    assert.equal(r.tab, tab);
    assert.equal(r.valid, true);
  }
});

test('parseHashStr: unknown hash is flagged invalid', () => {
  for (const bad of ['#bogus', '#exports2', '#', '', '#notatab/123']) {
    const r = parseHashStr(bad);
    assert.equal(r.valid, false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
});

test('parseHashStr: projects/<id> extracts projectId', () => {
  const r = parseHashStr('#projects/42');
  assert.equal(r.tab, 'projects');
  assert.equal(r.projectId, 42);
  assert.equal(r.userId, null);
  assert.equal(r.valid, true);
});

test('parseHashStr: employees/<id> extracts userId', () => {
  const r = parseHashStr('#employees/7');
  assert.equal(r.tab, 'employees');
  assert.equal(r.userId, 7);
  assert.equal(r.projectId, null);
  assert.equal(r.valid, true);
});

test('parseHashStr: non-numeric id segments yield null id', () => {
  const r = parseHashStr('#projects/abc');
  assert.equal(r.tab, 'projects');
  assert.equal(r.projectId, null);
  assert.equal(r.valid, true);
});

test('parseHashStr: missing id is null, not undefined', () => {
  const r = parseHashStr('#projects');
  assert.equal(r.projectId, null);
  assert.equal(r.userId, null);
});

test('parseHashStr: accepts hash with or without leading "#"', () => {
  const a = parseHashStr('overview');
  const b = parseHashStr('#overview');
  assert.deepEqual(a, b);
});

test('parseHashStr: handles null/undefined input', () => {
  assert.equal(parseHashStr(undefined).valid, false);
  assert.equal(parseHashStr(null).valid, false);
});
