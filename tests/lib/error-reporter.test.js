// Tests for src/lib/error-reporter.js — the pluggable error-monitoring hook.
//
// The module is a singleton (one module-level `reporter` variable), so each
// test that mutates it MUST reset to the no-op default via
// `setErrorReporter(null)` in a finally block. Tests are sequential
// (node:test default), so we don't have to worry about parallel writers
// to that singleton, but we still pay the courtesy of leaving it clean for
// the next test in the same process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setErrorReporter, reportError } from '../../src/lib/error-reporter.js';

test('default reporter is a no-op (does not throw, returns undefined)', () => {
  // No setErrorReporter call: we rely on the module's initial state.
  // Verify both that the call completes and that it returns nothing
  // observable — callers in errorMiddleware ignore the return value.
  const result = reportError(new Error('boom'), { request_id: 'r-1' });
  assert.equal(result, undefined);
});

test('setErrorReporter installs a custom hook that receives err + ctx', () => {
  const calls = [];
  setErrorReporter((err, ctx) => calls.push({ err, ctx }));
  try {
    const e = new Error('explode');
    reportError(e, { request_id: 'req-xyz', route: '/api/things', user_id: 7 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].err, e, 'reporter should receive the exact same Error instance');
    assert.deepEqual(calls[0].ctx, {
      request_id: 'req-xyz',
      route: '/api/things',
      user_id: 7,
    });
  } finally {
    setErrorReporter(null);
  }
});

test('reportError defaults ctx to {} when caller omits it', () => {
  // Pins the documented contract: callers may pass a single arg and the
  // reporter still receives a plain object (not undefined) as the second
  // argument. A Sentry hook reading ctx.request_id would otherwise NPE
  // for unhandled errors that fired before the request-id middleware.
  let receivedCtx;
  setErrorReporter((_err, ctx) => { receivedCtx = ctx; });
  try {
    reportError(new Error('no-ctx'));
    assert.deepEqual(receivedCtx, {});
  } finally {
    setErrorReporter(null);
  }
});

test('a reporter that throws does not crash reportError', () => {
  // The error-monitor integration must NEVER take down the request
  // pipeline. A bad DSN, exhausted Sentry quota, or a logic bug inside
  // the hook should be swallowed silently — the structured logger has
  // already captured the original error in errorMiddleware.
  setErrorReporter(() => { throw new Error('monitor exploded'); });
  try {
    // The assertion is simply: this call returns rather than propagating.
    // assert.doesNotThrow gives a clearer failure message than a try/catch
    // wrapper around `reportError(...)`.
    assert.doesNotThrow(() => reportError(new Error('original'), { route: '/x' }));
  } finally {
    setErrorReporter(null);
  }
});

test('setErrorReporter(null) resets to the default no-op', () => {
  // Roundtrip: install, verify it fires, reset, verify it stops firing.
  let count = 0;
  setErrorReporter(() => { count += 1; });
  reportError(new Error('one'));
  assert.equal(count, 1);

  setErrorReporter(null);
  reportError(new Error('two'));
  assert.equal(count, 1, 'after reset, the previous hook must not be called');
});

test('setErrorReporter(undefined) also resets to the default no-op', () => {
  // `fn ?? (() => {})` treats undefined the same as null. Pin that
  // behaviour explicitly so a future refactor to `fn || ...` (which would
  // also collapse a valid falsy function to no-op — unlikely, but pin it)
  // doesn't regress the "explicit reset" contract.
  let count = 0;
  setErrorReporter(() => { count += 1; });
  setErrorReporter(undefined);
  reportError(new Error('after-reset'));
  assert.equal(count, 0);
});

test('errorMiddleware integration: reporter fires for non-HttpError', async () => {
  // End-to-end: drive the real errorMiddleware with a plain Error and
  // confirm the installed reporter receives it with the expected ctx
  // shape (request_id, route, user_id). HttpError instances are handled
  // separately and intentionally do NOT call the reporter — those are
  // expected, client-driven 4xxs, not incidents.
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const calls = [];
  setErrorReporter((err, ctx) => calls.push({ err, ctx }));
  try {
    const err = new Error('kaboom');
    const req = {
      id: 'req-42',
      originalUrl: '/api/widgets/7',
      method: 'GET',
      user: { id: 99 },
      // Stub req.log so errorMiddleware's structured-log path doesn't
      // hit the real stdout writer during the test run.
      log: { error: () => {} },
    };
    const res = {
      status() { return this; },
      json() { return this; },
    };
    errorMiddleware(err, req, res, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].err, err);
    assert.equal(calls[0].ctx.request_id, 'req-42');
    assert.equal(calls[0].ctx.route, '/api/widgets/7');
    assert.equal(calls[0].ctx.user_id, 99);
  } finally {
    setErrorReporter(null);
  }
});
