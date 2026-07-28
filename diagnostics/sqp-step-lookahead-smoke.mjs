import assert from 'node:assert/strict';
import {
  buildSqpLineSearchAlphas,
  isBetterSqpLookaheadCandidate,
} from '../optimization/sqp-step-lookahead.ts';

assert.deepEqual(buildSqpLineSearchAlphas(4, true), [1, 1.5, 2, 0.5, 0.25, 0.125]);
assert.deepEqual(buildSqpLineSearchAlphas(4, false), [1, 0.5, 0.25, 0.125]);

const selected = { score: 100, maxViolation: 0.5 };
assert.equal(isBetterSqpLookaheadCandidate(selected, { score: 80, maxViolation: 0.5 }), true);
assert.equal(isBetterSqpLookaheadCandidate(selected, { score: 80, maxViolation: 0.6 }), false);
assert.equal(isBetterSqpLookaheadCandidate(selected, { score: 120, maxViolation: 0.4 }), false);
assert.equal(isBetterSqpLookaheadCandidate(selected, { score: Number.NaN, maxViolation: 0.4 }), false);

console.log('SQP step lookahead smoke: PASS');