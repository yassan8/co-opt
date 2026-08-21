import assert from 'node:assert/strict';
import {
  formatOptimizeConsoleHeader,
  formatOptimizeConsoleRow,
} from '../src/app/optimize-console-format.ts';

const header = formatOptimizeConsoleHeader();
const row = formatOptimizeConsoleRow({
  iter: 0,
  elapsedMs: 3723,
  min: 699.7351,
  damping: 6.667e-5,
  rho: 2.006,
  alpha: 2,
  improv: 0.20915,
});

assert.equal(header.includes('Equal.'), false);
assert.equal(header.includes('Inequal.'), false);
assert.equal(header.includes('Elapsed'), true);
assert.equal(header.includes('QPgain'), false);
assert.equal(header.length, row.length);
assert.match(header, /^Iter\s+Elapsed\s+Min\.\s+DFseed\s+rho\s+alpha\s+Improv\.$/);
assert.match(row, /^\s*0\s+00:00:03\.7\s+699\.7351\s+6\.667e-5\s+2\.006\s+2\.0\s+0\.20915$/);

console.log(header);
console.log(row);
console.log('Optimize console format smoke: PASS');
