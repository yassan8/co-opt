import assert from 'node:assert/strict';
import {
  adaptiveSpotIterationsUntilNextTransition,
  adaptiveSpotRayCountAtIteration,
  annularRingCountForRayCount,
  createAdaptiveSpotSamplingPlan,
} from '../optimization/adaptive-spot-sampling.ts';

assert.equal(annularRingCountForRayCount(16), 2);
assert.equal(annularRingCountForRayCount(49), 6);
assert.equal(annularRingCountForRayCount(64), 8);

const defaultGridPlan = createAdaptiveSpotSamplingPlan(8 * 8, 10, true, 0.25);
assert.deepEqual(defaultGridPlan, {
  enabled: true,
  coarseRayCount: 4 * 4,
  mediumRayCount: 21,
  finalRayCount: 8 * 8,
  transitionIteration: 4,
  finalTransitionIteration: 7,
});
assert.equal(adaptiveSpotRayCountAtIteration(defaultGridPlan, 0), 4 * 4);
assert.equal(adaptiveSpotRayCountAtIteration(defaultGridPlan, 4), 21);
assert.equal(adaptiveSpotRayCountAtIteration(defaultGridPlan, 6), 21);
assert.equal(adaptiveSpotRayCountAtIteration(defaultGridPlan, 7), 8 * 8);
assert.equal(adaptiveSpotRayCountAtIteration(defaultGridPlan, 0, true), 8 * 8);
assert.equal(adaptiveSpotIterationsUntilNextTransition(defaultGridPlan, 0), 4);
assert.equal(adaptiveSpotIterationsUntilNextTransition(defaultGridPlan, 5), 2);
assert.equal(adaptiveSpotIterationsUntilNextTransition(defaultGridPlan, 7), Number.MAX_SAFE_INTEGER);

const minimumGridPlan = createAdaptiveSpotSamplingPlan(4 * 4, 10);
assert.equal(minimumGridPlan.enabled, false);
assert.equal(adaptiveSpotRayCountAtIteration(minimumGridPlan, 0), 4 * 4);
assert.equal(adaptiveSpotIterationsUntilNextTransition(minimumGridPlan, 0), Number.MAX_SAFE_INTEGER);

const singleIterationPlan = createAdaptiveSpotSamplingPlan(8 * 8, 1);
assert.equal(singleIterationPlan.enabled, false);
assert.equal(adaptiveSpotRayCountAtIteration(singleIterationPlan, 0), 8 * 8);

const disabledPlan = createAdaptiveSpotSamplingPlan(16 * 16, 20, false);
assert.equal(disabledPlan.enabled, false);
assert.equal(adaptiveSpotRayCountAtIteration(disabledPlan, 0), 16 * 16);

console.log('adaptive Spot sampling smoke: PASS');