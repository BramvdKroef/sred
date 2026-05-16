// Thin re-export shim — preserves the existing `import … from '../api.js'`
// surface used across both shells. The implementation lives in four
// single-concern modules:
//
//   session.js   JWT/refresh storage + handleAuthFailure
//   fetch.js     api() / apiUpload() with refresh-on-401 retry
//   dom.js       esc / cents / dollar inputs / form helpers / banners
//   features.js  activity feed, preferences page, inline edit forms, chart
//
// New code should import directly from the concrete module rather than
// growing this shim. See TODO P3 "Split public/api.js".

export * from './session.js';
export * from './fetch.js';
export * from './dom.js';
export * from './features.js';
