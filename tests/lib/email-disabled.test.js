// Tests for src/lib/email.js — the SMTP-disabled branch.
//
// Strategy:
//   - email.js captures the nodemailer transport at module load time
//     (`const mailer = config.smtp.host ? createTransport(...) : null`), so
//     the SMTP-disabled branch is locked in for the lifetime of the module.
//     We therefore live in a dedicated file where SMTP_HOST is forced empty
//     BEFORE the dynamic import, and the matching "SMTP enabled" branches
//     live in email-enabled.test.js (which runs in its own child process —
//     `node --test` doesn't share module caches across files).
//   - We also monkey-patch nodemailer.createTransport so that even if some
//     future change re-evaluated the host check, no real transport could be
//     constructed during these tests. Defence in depth.
//   - Logger output is captured by stubbing process.stdout.write /
//     process.stderr.write the same way tests/lib/logger.test.js does, so
//     we can assert on the structured log lines without leaking SMTP creds
//     into the runner's own output.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import nodemailer from 'nodemailer';

// --- Env: must be set before dynamic imports below ------------------------

// JWT_SECRET is required by config.js at module load; pick a fresh random
// one if the runner didn't already supply one.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-' + crypto.randomBytes(24).toString('hex');
}

// Force the SMTP-disabled branch. Empty string (not unset) matches the
// production "operator hasn't configured SMTP yet" path that config.js
// normalises to `config.smtp.host === ''`.
process.env.SMTP_HOST = '';

// Belt-and-braces: if email.js ever did try to construct a transport during
// these tests, fail loudly rather than silently dialling a real SMTP host.
const origCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = () => {
  throw new Error(
    'nodemailer.createTransport must not be called when SMTP_HOST is empty',
  );
};

let sendMagicLink;

before(async () => {
  ({ sendMagicLink } = await import('../../src/lib/email.js'));
});

// --- Capture helpers ------------------------------------------------------

// Mirror of the helper in tests/lib/logger.test.js. We swap process.stdout/
// stderr.write with one that parses each JSON line into a sink and still
// passes the bytes through (so test-runner output stays visible on failure).
function captureWrites(stream, sink) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split('\n')) {
      if (line.startsWith('{')) {
        try { sink.push(JSON.parse(line)); }
        catch { /* not our JSON, ignore */ }
      }
    }
    return original(chunk, ...rest);
  };
  return () => { stream.write = original; };
}

async function withCapture(fn) {
  const out = [];
  const err = [];
  const restoreOut = captureWrites(process.stdout, out);
  const restoreErr = captureWrites(process.stderr, err);
  try { return { result: await fn(), out, err }; }
  finally { restoreOut(); restoreErr(); }
}

// --- Tests ----------------------------------------------------------------

test('sendMagicLink returns delivered:false with reason="smtp_disabled" when SMTP_HOST is empty', async () => {
  const { result } = await withCapture(() =>
    sendMagicLink({
      to: 'alice@example.com',
      name: 'Alice',
      purpose: 'invite',
      link: 'http://localhost:3000/enroll?token=abc',
    }),
  );
  assert.deepEqual(result, { delivered: false, reason: 'smtp_disabled' });
});

test('sendMagicLink logs the link at info on the SMTP-disabled path (operator fallback)', async () => {
  // When SMTP is disabled the response carries no link (V-06: never leak
  // tokens in API responses), so the *log* is the operator's only channel
  // to consume the token. The structured event must include the link.
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  try {
    const link = 'http://localhost:3000/enroll?token=deadbeef';
    const { out, err } = await withCapture(() =>
      sendMagicLink({
        to: 'bob@example.com',
        name: 'Bob',
        purpose: 'invite',
        link,
      }),
    );
    // log.info goes to stdout per src/lib/logger.js.
    const evt = out.find(e => e.msg === 'email_smtp_disabled');
    assert.ok(evt, `expected an email_smtp_disabled log line; got stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`);
    assert.equal(evt.level, 'info');
    assert.equal(evt.to, 'bob@example.com');
    assert.equal(evt.purpose, 'invite');
    assert.equal(evt.link, link);
  } finally {
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
  }
});

test('sendMagicLink handles every documented purpose on the disabled path without throwing', async () => {
  // The SUBJECTS / ACTIONS tables in email.js cover invite/recovery/add_device;
  // even though the disabled-path doesn't build the body, the function must
  // accept all of them without crashing. (Future regression guard: if someone
  // moves the subject/action lookup above the mailer check, an unknown purpose
  // shouldn't take the route handler down.)
  for (const purpose of ['invite', 'recovery', 'add_device']) {
    const { result } = await withCapture(() =>
      sendMagicLink({ to: 't@e.com', name: 'T', purpose, link: 'http://x/y' }),
    );
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'smtp_disabled');
  }
});

test('sendMagicLink: nodemailer.createTransport is NOT called when SMTP_HOST is empty', () => {
  // The whole point of the disabled branch is to avoid touching the SMTP
  // libraries at all. Our `before` hook replaces createTransport with a
  // thrower; if email.js ever called it during the prior tests we'd have
  // already crashed. This test just pins the contract explicitly so a
  // future refactor that tries to "lazy-init" the transport here gets caught.
  assert.equal(typeof nodemailer.createTransport, 'function');
  // Sanity: the stub is still in place — i.e. nothing has restored it.
  assert.throws(() => nodemailer.createTransport({}), /must not be called/);
  // We intentionally don't restore origCreateTransport at process exit; the
  // worker is going away anyway, and leaving the throw-stub in place would
  // catch a stray import elsewhere in the same file.
  void origCreateTransport;
});
