import assert from 'node:assert/strict';
import {
  initializeAdaptiveSqpDamping,
  sqpHessianDiagonalScale,
  updateAdaptiveSqpDamping,
} from '../optimization/adaptive-sqp-damping.ts';

const hessianScale = sqpHessianDiagonalScale([
  [1000, 0],
  [0, 10],
]);
assert.equal(hessianScale, 1000);

let state = initializeAdaptiveSqpDamping(2e-4, hessianScale, 1e-3);
assert.equal(state.damping, 1);
assert.equal(state.rejectMultiplier, 2);

state = updateAdaptiveSqpDamping(state, {
  accepted: true,
  gainRatio: 0.9,
  hessianScale,
});
assert.ok(state.damping < 1);
assert.equal(state.rejectMultiplier, 2);

const beforePoorAccept = state.damping;
state = updateAdaptiveSqpDamping(state, {
  accepted: true,
  gainRatio: 0.01,
  hessianScale,
});
assert.ok(state.damping > beforePoorAccept);

const beforeReject = state.damping;
state = updateAdaptiveSqpDamping(state, {
  accepted: false,
  gainRatio: 0,
  hessianScale,
});
assert.equal(state.damping, beforeReject * 2);
assert.equal(state.rejectMultiplier, 4);

const beforeSecondReject = state.damping;
state = updateAdaptiveSqpDamping(state, {
  accepted: false,
  gainRatio: 0,
  hessianScale,
});
assert.equal(state.damping, beforeSecondReject * 4);
assert.equal(state.rejectMultiplier, 8);

let stalled = { damping: 1e-12, rejectMultiplier: 2 };
for (let attempt = 0; attempt < 7; attempt++) {
  stalled = updateAdaptiveSqpDamping(stalled, {
    accepted: false,
    gainRatio: 0,
    hessianScale: 1,
  });
}
assert.ok(stalled.damping >= 1e-4);

console.log('Adaptive SQP damping smoke: PASS');