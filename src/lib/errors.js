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
  console.error('unhandled error:', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'internal server error' } });
}
