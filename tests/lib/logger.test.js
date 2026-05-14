// Tests for src/lib/logger.js — the tiny structured logger.
//
// Strategy:
//   - We stub process.stdout.write and process.stderr.write so the test
//     captures the raw bytes the logger emits, then JSON-parses each line.
//   - LOG_LEVEL is mutated per-test; the logger reads it lazily on every
//     emit (see currentMinLevel in src/lib/logger.js), so a fresh import
//     between cases is not needed.
//   - requestLogger() is exercised against a synthetic `req` that mirrors
//     what the server middleware attaches (id + optional user.id).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { log, requestLogger } from '../../src/lib/logger.js';

// --- Capture helpers --------------------------------------------------------

// Replace `stream.write` with one that parses every emitted JSON line into
// `sink` while still passing the bytes through to the real stream. Returns
// a restore function. We pass through (instead of swallowing) so the
// test runner's own output still shows up if something fails — silently
// eating stderr during a failure makes debugging miserable.
function captureWrites(stream, sink) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split('\n')) {
      if (line.startsWith('{')) {
        try { sink.push(JSON.parse(line)); }
        catch { /* not our JSON; ignore (e.g. the test runner's own writes) */ }
      }
    }
    return original(chunk, ...rest);
  };
  return () => { stream.write = original; };
}

function withCapture(fn) {
  const out = [];
  const err = [];
  const restoreOut = captureWrites(process.stdout, out);
  const restoreErr = captureWrites(process.stderr, err);
  try { fn(); }
  finally { restoreOut(); restoreErr(); }
  return { out, err };
}

// Helper to run with a specific LOG_LEVEL and restore it afterwards.
function withLogLevel(level, fn) {
  const prev = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
}

// --- Tests ------------------------------------------------------------------

test('log.info writes a parseable JSON line to stdout', () => {
  const { out, err } = withCapture(() => {
    withLogLevel('info', () => log.info('hello_world', { foo: 'bar', n: 42 }));
  });
  assert.equal(err.length, 0, `expected no stderr lines, got ${JSON.stringify(err)}`);
  assert.equal(out.length, 1);
  const entry = out[0];
  assert.equal(entry.level, 'info');
  assert.equal(entry.msg, 'hello_world');
  assert.equal(entry.foo, 'bar');
  assert.equal(entry.n, 42);
  // `time` is an ISO-8601 string — sanity-check the prefix shape.
  assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('log.error writes to stderr (not stdout)', () => {
  const { out, err } = withCapture(() => {
    withLogLevel('info', () => log.error('boom', { code: 'E1' }));
  });
  assert.equal(out.length, 0, `expected no stdout lines, got ${JSON.stringify(out)}`);
  assert.equal(err.length, 1);
  assert.equal(err[0].level, 'error');
  assert.equal(err[0].msg, 'boom');
  assert.equal(err[0].code, 'E1');
});

test('log.warn writes to stderr too', () => {
  const { out, err } = withCapture(() => {
    withLogLevel('info', () => log.warn('careful', {}));
  });
  assert.equal(out.length, 0);
  assert.equal(err.length, 1);
  assert.equal(err[0].level, 'warn');
});

test('LOG_LEVEL=warn suppresses info and debug', () => {
  const { out, err } = withCapture(() => {
    withLogLevel('warn', () => {
      log.debug('verbose');
      log.info('chatty');
      log.warn('attention');
      log.error('boom');
    });
  });
  // Info/debug dropped; warn + error survive (both on stderr).
  assert.equal(out.length, 0);
  assert.equal(err.length, 2);
  assert.deepEqual(err.map(e => e.msg), ['attention', 'boom']);
});

test('LOG_LEVEL=debug emits debug lines on stdout', () => {
  const { out, err } = withCapture(() => {
    withLogLevel('debug', () => log.debug('whisper', { k: 'v' }));
  });
  assert.equal(err.length, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'debug');
  assert.equal(out[0].k, 'v');
});

test('default LOG_LEVEL (unset) is info — drops debug, keeps info+', () => {
  const { out, err } = withCapture(() => {
    withLogLevel(undefined, () => {
      log.debug('dropped');
      log.info('kept');
      log.warn('also_kept');
    });
  });
  assert.equal(out.length, 1, `expected only info on stdout; got ${JSON.stringify(out)}`);
  assert.equal(out[0].msg, 'kept');
  assert.equal(err.length, 1);
  assert.equal(err[0].msg, 'also_kept');
});

test('requestLogger(req).info includes request_id and user_id', () => {
  const req = { id: 'req-abc-123', user: { id: 42 } };
  const { out } = withCapture(() => {
    withLogLevel('info', () => requestLogger(req).info('something', { foo: 1 }));
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].request_id, 'req-abc-123');
  assert.equal(out[0].user_id, 42);
  assert.equal(out[0].foo, 1);
  assert.equal(out[0].msg, 'something');
});

test('requestLogger handles a req without a user (unauthenticated request)', () => {
  // The middleware mounts the request logger BEFORE auth, so a request that
  // never reaches a requireAuth-protected route still needs a sane log shape.
  const req = { id: 'req-anon' };
  const { out } = withCapture(() => {
    withLogLevel('info', () => requestLogger(req).info('event'));
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].request_id, 'req-anon');
  assert.equal(out[0].user_id, null);
});

test('caller-supplied fields override request-scoped prefix on collision', () => {
  // Tests the documented contract that explicit fields beat the base prefix.
  // Useful when a route handler wants to log on behalf of a different user
  // (e.g. an admin acting on a target user id).
  const req = { id: 'req-1', user: { id: 7 } };
  const { out } = withCapture(() => {
    withLogLevel('info', () =>
      requestLogger(req).info('admin_action', { user_id: 99, target: 'user' }));
  });
  assert.equal(out[0].user_id, 99);
  assert.equal(out[0].request_id, 'req-1');
});

test('log entries are valid newline-delimited JSON (one line per emit)', () => {
  // Pin the wire format: every emit terminates with a single \n, and no
  // single line contains more than one JSON object. Aggregators (Loki,
  // Fluent Bit) tail by newline and would silently drop / mis-parse a
  // multi-object line.
  const original = process.stdout.write.bind(process.stdout);
  const raw = [];
  process.stdout.write = (chunk) => {
    raw.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    withLogLevel('info', () => {
      log.info('one');
      log.info('two');
    });
  } finally {
    process.stdout.write = original;
  }
  const combined = raw.join('');
  const lines = combined.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(typeof parsed.time === 'string');
    assert.ok(typeof parsed.level === 'string');
  }
});
