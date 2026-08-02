import assert from 'node:assert/strict';
import {
  getOptimizedResultApplySnapshots,
  injectActiveOpticalRows,
  selectCanonicalOptimizedRows,
} from '../src/app/optimized-result-sync.ts';

const snapshot = {
  activeConfigId: 'wide',
  configurations: [{
    id: 'wide',
    blocks: [{ blockId: 'lens-1', parameters: { frontRadius: 42 } }],
    opticalSystem: [{ radius: 100 }],
  }],
};
const staleDirectRows = [{ radius: 200 }];
const canonicalRows = selectCanonicalOptimizedRows(
  snapshot,
  staleDirectRows,
  blocks => ({ rows: [{ radius: blocks[0].parameters.frontRadius }] }),
);

assert.deepEqual(canonicalRows, [{ radius: 42 }]);
const injected = injectActiveOpticalRows(snapshot, canonicalRows);
assert.deepEqual(injected.configurations[0].opticalSystem, [{ radius: 42 }]);
assert.deepEqual(snapshot.configurations[0].opticalSystem, [{ radius: 100 }]);

const received = getOptimizedResultApplySnapshots({
  rows: canonicalRows,
  afterConfigSnapshot: snapshot,
  afterRowsSnapshot: staleDirectRows,
});
assert.deepEqual(received.afterConfig.configurations[0].blocks, snapshot.configurations[0].blocks);
assert.deepEqual(received.afterConfig.configurations[0].opticalSystem, canonicalRows);
assert.deepEqual(received.afterRows, staleDirectRows);

console.log('optimized result sync smoke: PASS');