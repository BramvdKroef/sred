// Tiny structured logger — JSON lines, no deps. Each log() call writes one
// JSON object to stdout (or stderr for warn/error). Operators can pipe
// through jq or ship to a log aggregator (Loki, ELK, Datadog).
//
// Why hand-rolled instead of pino/winston:
//   - Zero new transitive dependencies (review constraint).
//   - The whole surface area we need is "emit a structured line per event"
//     plus a per-request prefix; that's < 100 LOC.
//   - The output format (one JSON object per line, top-level `time`/`level`/
//     `msg` keys, arbitrary additional fields) is the de-facto standard that
//     every shipper / aggregator already speaks.
//
// Level filtering is by env: LOG_LEVEL=debug|info|warn|error (default info).
// Anything below the threshold is dropped before serialising — cheap in the
// hot path. Filtering is evaluated PER CALL (not memoised at import time) so
// tests can mutate process.env.LOG_LEVEL between cases.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdFor(level) {
  return LEVELS[level] ?? LEVELS.info;
}

function currentMinLevel() {
  return thresholdFor(process.env.LOG_LEVEL ?? 'info');
}

function emit(level, msg, fields = {}) {
  if ((LEVELS[level] ?? LEVELS.info) < currentMinLevel()) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...fields,
  }) + '\n');
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info:  (msg, fields) => emit('info',  msg, fields),
  warn:  (msg, fields) => emit('warn',  msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

// Helper for use in middleware: returns a per-request logger that prefixes
// every emit with the request id + user id (if present). Caller-supplied
// fields override the prefix on a per-call basis if they collide.
export function requestLogger(req) {
  const base = { request_id: req.id, user_id: req.user?.id ?? null };
  return {
    debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
    info:  (msg, fields) => emit('info',  msg, { ...base, ...fields }),
    warn:  (msg, fields) => emit('warn',  msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
  };
}
