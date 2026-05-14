// Unit tests for the active-claimant localStorage helpers exported from
// public/admin.js. These are the "single source of truth" round-trip
// helpers for the header claimant selector (step 2 of the hoist).
// Covered: round-trip works; stored-but-missing id falls back to null;
// null persists as "all claimants".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readActiveClaimantId, writeActiveClaimantId } from '../../public/admin.js';

// Minimal in-memory Storage stub. Matches the read/write surface the
// helpers use; nothing else is exercised.
function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

const SAMPLE_CLAIMANTS = [{ id: 1, legal_name: 'Acme' }, { id: 7, legal_name: 'Globex' }];

test('round-trip: writeActiveClaimantId then read returns the stored id', () => {
  const s = makeStorage();
  writeActiveClaimantId(7, s);
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), 7);
});

test('round-trip: null ("All claimants") persists and reads back as null', () => {
  const s = makeStorage();
  writeActiveClaimantId(null, s);
  // Sanity: it's stored as the literal string "null" so reads are explicit.
  assert.equal(s._data['sred-active-claimant'], 'null');
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), null);
});

test('stored id that no longer exists in the claimants list falls back to null', () => {
  const s = makeStorage({ 'sred-active-claimant': '999' });
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), null);
});

test('empty storage (first-run) reads as null', () => {
  const s = makeStorage();
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), null);
});

test('non-numeric stored value reads as null (no crash)', () => {
  const s = makeStorage({ 'sred-active-claimant': 'banana' });
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), null);
});

test('empty-string stored value reads as null', () => {
  const s = makeStorage({ 'sred-active-claimant': '' });
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), null);
});

test('reads return null when claimants list is empty even if id was stored', () => {
  const s = makeStorage();
  writeActiveClaimantId(7, s);
  assert.equal(readActiveClaimantId([], s), null);
});

test('reads return null when storage is unavailable', () => {
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, null), null);
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, undefined), null);
});

test('writes no-op (do not throw) when storage is unavailable', () => {
  assert.doesNotThrow(() => writeActiveClaimantId(7, null));
  assert.doesNotThrow(() => writeActiveClaimantId(null, null));
});

test('writes swallow storage errors (quota / private mode)', () => {
  const throwing = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.doesNotThrow(() => writeActiveClaimantId(42, throwing));
});

test('writeActiveClaimantId(undefined) is treated as null', () => {
  const s = makeStorage();
  writeActiveClaimantId(undefined, s);
  assert.equal(s._data['sred-active-claimant'], 'null');
  assert.equal(readActiveClaimantId(SAMPLE_CLAIMANTS, s), null);
});
