import { log } from './logger.js';
import { reportError } from './error-reporter.js';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest    = (msg, details) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized  = (msg = 'unauthorized') => new HttpError(401, 'unauthorized', msg);
export const forbidden     = (msg = 'forbidden')    => new HttpError(403, 'forbidden', msg);
export const notFound      = (msg = 'not found')    => new HttpError(404, 'not_found', msg);
export const conflict      = (msg, details) => new HttpError(409, 'conflict', msg, details);
export const unprocessable = (msg, details) => new HttpError(422, 'unprocessable', msg, details);

export function errorMiddleware(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  // Forward to the pluggable external error reporter (Sentry / Honeybadger /
  // etc.) BEFORE we touch the logger, so even a logger-side failure won't
  // hide the incident from the monitoring service. Default is a no-op; an
  // operator wires this up in src/server.js via `setErrorReporter()`.
  // `reportError` swallows its own failures, so this call is fire-and-forget.
  reportError(err, {
    request_id: req?.id,
    route: req?.originalUrl,
    user_id: req?.user?.id ?? null,
  });
  // Prefer the per-request logger (carries request_id + user_id) so the
  // operator can correlate a 500 to a specific incoming request. Fall back
  // to the bare logger if the error fired before the request-id middleware
  // attached one (shouldn't happen in normal flow, but keep the safety
  // net — req.log is set by the very first middleware in src/server.js).
  const logger = req?.log ?? log;
  logger.error('unhandled_error', {
    method: req?.method,
    path: req?.originalUrl,
    err: err?.message,
    stack: err?.stack,
  });
  res.status(500).json({ error: { code: 'internal_error', message: 'internal server error' } });
}
