// Unit tests for migrateLegacyHash — the pure helper that rewrites the legacy
// `#claimants` / `#users` hash keys into the current `#projects` / `#employees`
// scheme. Returns null when no migration is needed so callers can short-circuit
// without comparing strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateLegacyHash } from '../../public/admin.js';

test('migrateLegacyHash: #claimants → #projects', () => {
  assert.equal(migrateLegacyHash('#claimants'), '#projects');
});

test('migrateLegacyHash: #users → #employees', () => {
  assert.equal(migrateLegacyHash('#users'), '#employees');
});

test('migrateLegacyHash: preserves id suffix on legacy hashes', () => {
  assert.equal(migrateLegacyHash('#claimants/42'), '#projects/42');
  assert.equal(migrateLegacyHash('#users/7'),      '#employees/7');
});

test('migrateLegacyHash: preserves multi-segment tail', () => {
  // Defensive — no caller writes a multi-segment hash today, but the helper
  // shouldn't drop information if one ever does.
  assert.equal(migrateLegacyHash('#claimants/3/edit'), '#projects/3/edit');
});

test('migrateLegacyHash: accepts input without leading #', () => {
  assert.equal(migrateLegacyHash('claimants/5'), '#projects/5');
  assert.equal(migrateLegacyHash('users'),       '#employees');
});

test('migrateLegacyHash: returns null for current hash keys', () => {
  for (const cur of ['#projects', '#employees', '#projects/1', '#employees/2',
                     '#overview', '#review', '#exports', '#audit', '#preferences']) {
    assert.equal(migrateLegacyHash(cur), null, `expected ${cur} to need no migration`);
  }
});

test('migrateLegacyHash: returns null for unknown / empty / nullish input', () => {
  assert.equal(migrateLegacyHash(''), null);
  assert.equal(migrateLegacyHash('#'), null);
  assert.equal(migrateLegacyHash(null), null);
  assert.equal(migrateLegacyHash(undefined), null);
  assert.equal(migrateLegacyHash('#bogus'), null);
  assert.equal(migrateLegacyHash('#claimant'), null);   // not `claimants`
  assert.equal(migrateLegacyHash('#user'), null);       // not `users`
});

test('migrateLegacyHash: does not partial-match inside other keys', () => {
  // A hypothetical future #claimants-of-foo shouldn't be munged into
  // #projects-of-foo — only the exact head segment matches.
  assert.equal(migrateLegacyHash('#claimants-extra'), null);
  assert.equal(migrateLegacyHash('#usersx'), null);
});
