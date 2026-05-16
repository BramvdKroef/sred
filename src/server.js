import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, ROOT_DIR } from './config.js';
import { db } from './db/index.js';
import api from './routes/index.js';
import { errorMiddleware } from './lib/errors.js';
import { cspMiddleware } from './lib/csp.js';
import { log, requestLogger } from './lib/logger.js';

// To enable error monitoring, uncomment and configure:
// import * as Sentry from '@sentry/node';
// Sentry.init({ dsn: process.env.SENTRY_DSN });
// import { setErrorReporter } from './lib/error-reporter.js';
// setErrorReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }));

const app = express();
app.disable('x-powered-by');

// Honour X-Forwarded-For from a reverse proxy. The value is the number of
// proxy hops to trust; '1' is correct for the typical single nginx/Caddy
// hop. Make it configurable via TRUST_PROXY env var — operators behind
// nested proxies bump it; bare-metal demo deploys leave it 0. Without this
// every IP-keyed rate limiter (login/register/recovery/refresh/invite)
// collapses to a single bucket keyed on the proxy's loopback IP — V-04 void.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

// Request id + per-request logger. Mounted before everything else (CSP,
// body parser, routes, auth) so:
//   - 4xx responses from express.json (e.g. malformed body) still carry an
//     x-request-id header an operator can correlate to a log line.
//   - The error middleware can read req.log without an instanceof check.
//   - An inbound x-request-id from the reverse proxy is honoured (so a
//     full trace spans the proxy → app boundary).
// randomUUID() is v4, ~122 bits of entropy, plenty for correlation. We do
// NOT trust the inbound header beyond accepting it as opaque — it goes
// into a JSON log line and a response header, never into a SQL query.
app.use((req, res, next) => {
  req.id = req.header('x-request-id') || randomUUID();
  res.setHeader('x-request-id', req.id);
  req.log = requestLogger(req);
  const start = Date.now();
  res.on('finish', () => {
    // Use originalUrl (full request path including any /api mount prefix
    // and querystring) rather than req.path — Express mutates req.url /
    // req.path as it descends through routers, so by the time `finish`
    // fires those reflect the deepest router's local view, which is
    // useless for a top-level access log.
    req.log.info('http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
  });
  next();
});

app.use(cspMiddleware);
app.use(express.json({ limit: '2mb' }));
// cookie-parser must precede the routes so /api/auth/refresh can read
// req.cookies.sred_refresh (V-11 mitigation). The refresh-token cookie is
// HttpOnly + path-scoped to /api/auth/refresh; no other endpoint reads from
// req.cookies, so the parser overhead on other routes is negligible.
app.use(cookieParser());

// --- Health / readiness probes ---------------------------------------------
//
// Two unauthenticated, dependency-free endpoints intended for orchestrators
// (systemd, k8s, an external load balancer) to distinguish "the process is
// alive" from "the process can serve real traffic":
//
//   GET /healthz  — pure liveness. 200 if the event loop runs. No DB hit,
//                   no external calls, no I/O. A failing /healthz means the
//                   supervisor should restart us.
//   GET /readyz   — readiness. Probes the SQLite handle with `SELECT 1`.
//                   200 if the DB answers; 503 if it doesn't. A failing
//                   /readyz means take this instance out of the LB pool but
//                   do NOT restart — the underlying issue (disk full, DB
//                   handle closed, file locked) won't resolve on bounce.
//
// Mounted before `/api` so they sit outside the API namespace, do not pass
// through any per-route auth or rate limiter, and remain reachable even if
// the API router has a boot-time error. They also are not in the audit log
// path — `audit()` is called from individual route handlers, never here.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/readyz', (_req, res) => {
  try {
    // better-sqlite3 is synchronous; this is a sub-millisecond call against
    // the open handle. If the handle is closed, prepare() throws
    // "The database connection is not open". If the file is gone or locked
    // it surfaces as a SqliteError. Either way we catch and report 503.
    db.prepare('SELECT 1').get();
    res.status(200).json({ ok: true, checks: { db: 'ok' } });
  } catch (err) {
    res.status(503).json({
      ok: false,
      checks: { db: 'fail', error: err instanceof Error ? err.message : String(err) },
    });
  }
});

app.use('/api', api);
app.use(express.static(path.join(ROOT_DIR, 'public')));

// SPA fallback for magic-link landing pages.
app.get(['/enroll', '/login'], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

app.use(errorMiddleware);

const server = app.listen(config.port, () => {
  log.info('server_listening', {
    port: config.port,
    origins: config.origins,
  });
});

// --- Graceful shutdown ------------------------------------------------------
//
// systemctl restart / docker stop / k8s SIGTERM must drain in-flight requests
// (long-running ZIP/PDF streams especially) and flush WAL via db.close()
// before the process exits, or the next boot rolls back the open transaction
// and a client sees a truncated download. The 10s hard timeout matches the
// systemd default TimeoutStopSec/2 — supervisor sends SIGKILL at 90s, we
// self-destruct well before that.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_draining', { signal });
  const forceExitTimer = setTimeout(() => {
    log.error('shutdown_forced_exit', { signal });
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
  server.close(err => {
    if (err) log.error('shutdown_server_close_error', { err: err.message });
    try { db.close(); } catch (e) { log.error('shutdown_db_close_error', { err: e.message }); }
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A stray unhandledRejection means we are in an unknown state — let the
// supervisor restart us rather than soldier on with corrupted invariants.
process.on('unhandledRejection', (err) => {
  log.error('unhandled_rejection', {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

export { app, server, shutdown };
