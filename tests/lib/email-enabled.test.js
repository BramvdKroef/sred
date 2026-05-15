// Tests for src/lib/email.js — the SMTP-enabled branch (success / failure
// / timeout).
//
// Strategy:
//   - email.js constructs the nodemailer transport ONCE, at module load
//     time, capturing whatever `nodemailer.createTransport(opts)` returns
//     into a module-private `mailer` const. To stub the transport we
//     monkey-patch `nodemailer.createTransport` BEFORE the dynamic import
//     of email.js, recording the options it was called with and returning
//     a fake transport whose `sendMail` is swapped per-test.
//   - We set SMTP_HOST to a non-empty placeholder so email.js takes the
//     "enabled" branch and calls our stub. SMTP_PORT etc. are set to
//     sentinels we can assert on.
//   - The disabled-branch tests live in email-disabled.test.js (separate
//     test file => separate child process => fresh module cache, so the
//     module-load-time `mailer` const for that file is null while ours is
//     our fake).
//   - We also stub the structured logger writes to keep the runner's
//     output clean and to assert that the expected events are emitted.
//
// What's intentionally NOT tested here:
//   - A real SMTP handshake. No mailpit, no captive server.
//   - The route-level glue (POST /api/users/:id/invite). That's covered in
//     tests/routes/invite-smtp-delivery.test.js.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import nodemailer from 'nodemailer';

// --- Env: MUST be set before importing email.js (or config.js) ----------

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-' + crypto.randomBytes(24).toString('hex');
}

// A non-empty host flips email.js into the "build a transport" branch. We
// never actually connect anywhere — the createTransport stub below returns
// our fake.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '24999';          // arbitrary; we never dial it
process.env.SMTP_USER = 'mock-user';
process.env.SMTP_PASS = 'mock-pass';
process.env.SMTP_FROM = 'Mock <mock@example.test>';

// --- Transport stub --------------------------------------------------------

// Captured for the "transport options are wired" test.
let lastCreateTransportOpts = null;

// Per-test swappable sendMail implementation.
let sendMailImpl = async () => ({ messageId: 'unset' });

// Per-test counter so we can assert "called exactly once".
let sendMailCalls = [];

const origCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = (opts) => {
  lastCreateTransportOpts = opts;
  return {
    sendMail: (mail) => {
      sendMailCalls.push(mail);
      return sendMailImpl(mail);
    },
  };
};

// Restore at process exit so a stray import elsewhere in this worker
// doesn't get our stub. (`before` of email.js below has already taken
// its reference; restoring later is safe.)
process.on('exit', () => { nodemailer.createTransport = origCreateTransport; });

// --- Module under test ---------------------------------------------------

let sendMagicLink;
let SEND_TIMEOUT_MS;
let config;

before(async () => {
  ({ sendMagicLink, SEND_TIMEOUT_MS } = await import('../../src/lib/email.js'));
  ({ config } = await import('../../src/config.js'));
});

// --- Log capture ---------------------------------------------------------

function captureWrites(stream, sink) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split('\n')) {
      if (line.startsWith('{')) {
        try { sink.push(JSON.parse(line)); }
        catch { /* not our JSON */ }
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

// Each test resets sendMail's behaviour and the call log so order doesn't
// matter.
function resetTransport(impl) {
  sendMailImpl = impl;
  sendMailCalls = [];
}

// --- Tests ----------------------------------------------------------------

test('createTransport is configured with explicit per-phase timeouts (~5s) so a black-holed SMTP host cannot stall a request', () => {
  // The module-load-time call to nodemailer.createTransport happened during
  // the `before` hook, populating lastCreateTransportOpts. We pin every
  // setting that the comment in email.js promises operators.
  assert.ok(lastCreateTransportOpts, 'expected createTransport to have been called at module load');
  assert.equal(lastCreateTransportOpts.host, '127.0.0.1');
  assert.equal(lastCreateTransportOpts.port, 24999);
  assert.equal(lastCreateTransportOpts.secure, false);
  assert.equal(lastCreateTransportOpts.ignoreTLS, true);

  // The three timeout knobs are the whole reason this fix exists — if a
  // future refactor drops any of them, an unreachable SMTP host can wedge
  // /invite for two minutes (nodemailer's defaults). Pin them hard.
  assert.equal(lastCreateTransportOpts.connectionTimeout, 5000);
  assert.equal(lastCreateTransportOpts.greetingTimeout, 5000);
  assert.equal(lastCreateTransportOpts.socketTimeout, 5000);

  // Auth was passed through because both user+pass were set in the env.
  assert.deepEqual(lastCreateTransportOpts.auth, { user: 'mock-user', pass: 'mock-pass' });
});

test('SEND_TIMEOUT_MS is exported and is shorter than the default nodemailer wall-clock (~2min)', () => {
  // The outer race exists so a slow-but-accepting SMTP host can't keep the
  // route waiting. 8s is the documented value; assert the magnitude (not
  // the exact number) so a tweak to 7000/10000 doesn't break us, but a
  // regression to "no cap" or "60s" would.
  assert.equal(typeof SEND_TIMEOUT_MS, 'number');
  assert.ok(SEND_TIMEOUT_MS >= 1000 && SEND_TIMEOUT_MS <= 30_000,
    `SEND_TIMEOUT_MS=${SEND_TIMEOUT_MS} is outside the sane 1s..30s range`);
});

test('sendMagicLink on success: calls sendMail with from/to/subject/text and returns delivered:true + messageId', async () => {
  resetTransport(async () => ({ messageId: '<abc@mock>' }));
  const { result } = await withCapture(() =>
    sendMagicLink({
      to: 'alice@example.com',
      name: 'Alice',
      purpose: 'invite',
      link: 'http://localhost:3000/enroll?token=A1',
    }),
  );

  assert.equal(result.delivered, true);
  assert.equal(result.messageId, '<abc@mock>');

  assert.equal(sendMailCalls.length, 1, 'sendMail must be called exactly once');
  const mail = sendMailCalls[0];
  assert.equal(mail.from, config.smtp.from);
  assert.equal(mail.to, 'alice@example.com');
  // SUBJECTS.invite is "You are invited to the SR&ED tracker".
  assert.match(mail.subject, /invited/i);
  // The body must mention the user's name and contain the magic link
  // verbatim (so anti-phishing tooling can scrape it, and so the recipient
  // can copy-paste if their client mangles the autolink).
  assert.ok(typeof mail.text === 'string', 'sendMail.text must be a string');
  assert.match(mail.text, /Alice/);
  assert.match(mail.text, /http:\/\/localhost:3000\/enroll\?token=A1/);
  // V-06 (defence in depth): we never claimed to render HTML, so we
  // shouldn't be emitting an `html` field that could escape escaping rules.
  // If a future change adds an html body, this assertion needs revisiting
  // together with the XSS surface — flag, don't silently accept.
  assert.equal(mail.html, undefined,
    'unexpected html body in mail payload — review for XSS before allowing');
});

test('sendMagicLink on success logs email_sent with messageId', async () => {
  resetTransport(async () => ({ messageId: '<xyz@mock>' }));
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  try {
    const { out } = await withCapture(() =>
      sendMagicLink({
        to: 'carol@example.com',
        name: 'Carol',
        purpose: 'recovery',
        link: 'http://localhost:3000/enroll?token=R1',
      }),
    );
    const evt = out.find(e => e.msg === 'email_sent');
    assert.ok(evt, `expected an email_sent log line; got ${JSON.stringify(out)}`);
    assert.equal(evt.to, 'carol@example.com');
    assert.equal(evt.purpose, 'recovery');
    assert.equal(evt.message_id, '<xyz@mock>');
  } finally {
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
  }
});

test('sendMagicLink subject varies by purpose (invite/recovery/add_device)', async () => {
  const subjects = {};
  for (const purpose of ['invite', 'recovery', 'add_device']) {
    resetTransport(async () => ({ messageId: 'm' }));
    await withCapture(() =>
      sendMagicLink({ to: 'x@e.com', name: 'X', purpose, link: 'http://x/y' }),
    );
    subjects[purpose] = sendMailCalls[0].subject;
  }
  // All three are distinct (no copy-paste collision in SUBJECTS).
  assert.notEqual(subjects.invite, subjects.recovery);
  assert.notEqual(subjects.invite, subjects.add_device);
  assert.notEqual(subjects.recovery, subjects.add_device);
  // Each is a non-empty string.
  for (const [k, v] of Object.entries(subjects)) {
    assert.ok(typeof v === 'string' && v.length > 0, `subject for ${k} is empty`);
  }
});

test('sendMagicLink falls back to a generic subject for an unknown purpose', async () => {
  // SUBJECTS uses `??` so an unknown key gets the default "SR&ED tracker".
  // Pin that so a future caller passing a typo'd purpose still gets a sane
  // subject rather than `undefined`.
  resetTransport(async () => ({ messageId: 'm' }));
  await withCapture(() =>
    sendMagicLink({ to: 'x@e.com', name: 'X', purpose: 'no_such_purpose', link: 'http://x/y' }),
  );
  assert.equal(sendMailCalls[0].subject, 'SR&ED tracker');
});

test('sendMagicLink on send failure returns delivered:false with reason="send_failed" and the error message', async () => {
  resetTransport(async () => { throw new Error('mock connection refused'); });
  const { result } = await withCapture(() =>
    sendMagicLink({
      to: 'dan@example.com',
      name: 'Dan',
      purpose: 'invite',
      link: 'http://localhost:3000/enroll?token=F1',
    }),
  );
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'send_failed');
  assert.equal(result.error, 'mock connection refused');
  // The route handler will surface `error` to the admin UI; if it ever goes
  // missing here, /invite would silently lie about the failure mode.
  assert.equal(typeof result.error, 'string');
});

test('sendMagicLink on send failure logs email_failed (stderr) and email_fallback_link (stdout)', async () => {
  resetTransport(async () => { throw new Error('boom'); });
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  try {
    const link = 'http://localhost:3000/enroll?token=FB1';
    const { out, err } = await withCapture(() =>
      sendMagicLink({ to: 'e@e.com', name: 'E', purpose: 'invite', link }),
    );
    // Failure event on stderr with reason+err.
    const failed = err.find(e => e.msg === 'email_failed');
    assert.ok(failed, `expected email_failed on stderr; got ${JSON.stringify(err)}`);
    assert.equal(failed.reason, 'send_failed');
    assert.equal(failed.err, 'boom');
    assert.equal(failed.to, 'e@e.com');
    // Fallback link on stdout so an operator tailing the journal can deliver
    // it out-of-band even though SMTP misfired.
    const fb = out.find(e => e.msg === 'email_fallback_link');
    assert.ok(fb, `expected email_fallback_link on stdout; got ${JSON.stringify(out)}`);
    assert.equal(fb.link, link);
  } finally {
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
  }
});

test('sendMagicLink times out the sendMail call via Promise.race (reason="timeout")', async () => {
  // Hang forever; the SEND_TIMEOUT_MS race should fire before the test
  // runner gets bored. We don't want to wait the real 8s on every CI
  // run, so we make sure the race trips quickly enough via a "never
  // settles" promise and a tight assertion on the result shape.
  //
  // We DON'T fake timers because email.js's withTimeout uses real
  // setTimeout; if we faked them the race wouldn't resolve at all in
  // this test process. Instead we trust the configured cap (8s) and
  // accept up to ~10s of wall clock on the slowest CI worker.
  resetTransport(() => new Promise(() => { /* never resolves */ }));
  const t0 = Date.now();
  const { result } = await withCapture(() =>
    sendMagicLink({
      to: 'slow@example.com',
      name: 'Slow',
      purpose: 'invite',
      link: 'http://localhost:3000/enroll?token=T1',
    }),
  );
  const dt = Date.now() - t0;

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'timeout');
  // The error string comes from withTimeout's "sendMail timed out after ${ms}ms".
  assert.match(result.error, /timed out/i);

  // We expect the cap to fire roughly at SEND_TIMEOUT_MS. Allow generous
  // slack on both sides — slow CI can drift, but anything < 1s would mean
  // the race tripped wrongly (e.g. a bug rejecting immediately) and
  // anything > 20s would mean the cap is broken.
  assert.ok(dt >= 1000, `sendMail returned too fast (${dt}ms) — race not engaged?`);
  assert.ok(dt < 20_000, `sendMail took too long (${dt}ms) — timeout cap not engaging`);
});
