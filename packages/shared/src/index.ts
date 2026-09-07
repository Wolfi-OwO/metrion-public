// `export type *`, not `export *`: a plain star re-export survives compilation
// as a real runtime statement, and this package must erase to nothing. The
// collector deploys `dist/` with zero runtime dependencies and no `npm install`
// on the VPS, so anything left in the emitted JS is a broken deploy.
export type * from './metric-envelope.js';
export type * from './legacy-metrics-sample.js';
