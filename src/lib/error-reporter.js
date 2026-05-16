// Pluggable error-reporter. Default no-op. To wire up Sentry / Honeybadger /
// any other service, an operator overrides `setErrorReporter()` at boot
// before the error middleware runs:
//
//   import * as Sentry from '@sentry/node';
//   Sentry.init({ dsn: process.env.SENTRY_DSN });
//   setErrorReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }));
//
// Design notes:
//   - The default is a true no-op (not `null`-checked at the call site) so the
//     hot path in errorMiddleware is a single function call with no branch.
//   - `reportError` swallows any throw from the reporter. A misconfigured
//     monitor (bad DSN, network down, exhausted free tier) must NEVER take
//     down the request pipeline — the original error is already on its way
//     to the structured logger, which is the source of truth.
//   - Passing `null` to `setErrorReporter` resets to the no-op. This lets
//     tests (and operators rolling back a bad config) restore default
//     behaviour without re-importing the module.

let reporter = () => {};

export function setErrorReporter(fn) {
  reporter = fn ?? (() => {});
}

export function reportError(err, ctx = {}) {
  try {
    reporter(err, ctx);
  } catch {
    // Never crash on a reporter failure. The logger already captured this
    // error in errorMiddleware; losing the external report is the lesser
    // evil compared to a recursive crash loop in the error path.
  }
}
