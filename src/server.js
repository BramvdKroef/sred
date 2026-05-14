import express from 'express';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { db } from './db/index.js';
import api from './routes/index.js';
import { errorMiddleware } from './lib/errors.js';
import { cspMiddleware } from './lib/csp.js';

const app = express();
app.disable('x-powered-by');

// Honour X-Forwarded-For from a reverse proxy. The value is the number of
// proxy hops to trust; '1' is correct for the typical single nginx/Caddy
// hop. Make it configurable via TRUST_PROXY env var — operators behind
// nested proxies bump it; bare-metal demo deploys leave it 0. Without this
// every IP-keyed rate limiter (login/register/recovery/refresh/invite)
// collapses to a single bucket keyed on the proxy's loopback IP — V-04 void.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

app.use(cspMiddleware);
app.use(express.json({ limit: '2mb' }));

app.use('/api', api);
app.use(express.static(path.join(ROOT_DIR, 'public')));

// SPA fallback for magic-link landing pages.
app.get(['/enroll', '/login'], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

app.use(errorMiddleware);

const server = app.listen(config.port, () => {
  console.log(`sred listening on ${config.origins.join(', ')} (port ${config.port})`);
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
  console.log(`[shutdown] ${signal} received, draining`);
  const forceExitTimer = setTimeout(() => {
    console.error('[shutdown] timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
  server.close(err => {
    if (err) console.error('[shutdown] server.close error:', err);
    try { db.close(); } catch (e) { console.error('[shutdown] db.close error:', e); }
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A stray unhandledRejection means we are in an unknown state — let the
// supervisor restart us rather than soldier on with corrupted invariants.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  process.exit(1);
});

export { app, server, shutdown };
