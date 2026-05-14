// Content-Security-Policy middleware. Defence-in-depth alongside the
// href-scheme sanitisation in V-01: even if a `javascript:` URL leaks
// through to the DOM, the browser refuses to execute it under this
// policy.
//
// Allowances (each is required by something the SPA actually uses):
//   - script-src jsdelivr  → public/app.js imports @simplewebauthn/browser
//                            from https://cdn.jsdelivr.net/npm/.../+esm
//   - style-src  fonts.googleapis.com + 'unsafe-inline'
//                          → SPA renders inline style="..." attributes
//                            on dynamically-built elements (see admin/projects.js)
//   - font-src   fonts.gstatic.com → Montserrat woff2
//   - img-src    data:    → small inline images / placeholders
//   - connect-src fonts.googleapis.com + fonts.gstatic.com
//                          → the <link rel=stylesheet> fetch for the
//                            Google Fonts CSS shim goes through connect-src
//                            in some browsers; without these the console
//                            spews CSP refusals on every page load.
//
// frame-ancestors / base-uri / form-action / object-src are tightened as
// far as the SPA tolerates.

const POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const CSP_HEADER_VALUE = POLICY;

export function cspMiddleware(_req, res, next) {
  res.setHeader('Content-Security-Policy', POLICY);
  next();
}
