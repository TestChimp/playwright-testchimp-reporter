import { createRequire } from 'module';

// Copied to `dist/runtime.mjs` after `tsc`. Loads `./runtime.js` (CJS) for side effects + named exports.
const require = createRequire(import.meta.url);
const cjs = require('./runtime.js');

export const installTrueCoverage = cjs.installTrueCoverage;

export * from './worldstate.mjs';
export default cjs;
