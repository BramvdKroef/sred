// Per-route rate limiters. Defence-in-depth against magic-link/recovery
// floods, refresh-token brute force, and webauthn_challenges table-fill DoS.
//
// In-memory store (default) is fine for a single-instance demo. Each limiter
// keys by IP. Handlers return the same JSON error shape as the rest of the
// API (see src/lib/errors.js) so the client treats 429 like any other
// HttpError.
//
// Windows are sized so legitimate use (including seed scripts on localhost
// during boot) doesn't get rate-limited, but bursts large enough to threaten
// the auth surface get cut off cheaply.

import rateLimit from 'express-rate-limit';

function jsonHandler(code, message) {
  return (req, res /*, next, options */) => {
    res.status(429).json({
      error: { code, message },
    });
  };
}

function make({ windowMs, max, code, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: jsonHandler(code, message),
  });
}

// 10 / minute / IP — webauthn ceremony halves. Tight enough to limit
// challenge-row growth, loose enough for legit retries on flaky USB keys.
export const webauthnLimiter = make({
  windowMs: 60_000,
  max: 10,
  code: 'rate_limited',
  message: 'too many webauthn requests; slow down',
});

// 5 / minute / IP and 30 / hour / IP — magic-link / recovery flood guard.
// Two layered limiters; both must pass.
export const recoveryShortLimiter = make({
  windowMs: 60_000,
  max: 5,
  code: 'rate_limited',
  message: 'too many recovery requests; try again in a minute',
});

export const recoveryHourLimiter = make({
  windowMs: 60 * 60_000,
  max: 30,
  code: 'rate_limited',
  message: 'too many recovery requests this hour',
});

// 30 / minute / IP — refresh tokens. Legit users may refresh repeatedly on
// tab focus / network blips; 30/min comfortably covers that while still
// neutering offline brute force against the random-32 token space.
export const refreshLimiter = make({
  windowMs: 60_000,
  max: 30,
  code: 'rate_limited',
  message: 'too many refresh attempts; slow down',
});

// 30 / hour / IP — admin invite endpoint. Bounded even though it's behind
// an admin session, so a compromised admin token can't be used to flood
// users' inboxes.
export const inviteLimiter = make({
  windowMs: 60 * 60_000,
  max: 30,
  code: 'rate_limited',
  message: 'too many invite requests this hour',
});
