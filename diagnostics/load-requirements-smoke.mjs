import assert from 'node:assert/strict';
import { normalizeDesign } from '../optimization/normalize-design.ts';

const topLevelRequirements = [{ id: 1, operand: 'EFFL' }];

const emptyNested = normalizeDesign({
  configurations: {
    configurations: [{ id: 1 }],
    activeConfigId: 1,
    systemRequirements: [],
  },
  systemRequirements: topLevelRequirements,
}).normalized;

assert.deepEqual(
  emptyNested?.configurations?.systemRequirements,
  topLevelRequirements,
  'top-level Requirements should fill an empty nested array',
);

const nestedRequirements = [{ id: 2, operand: 'FNO' }];
const populatedNested = normalizeDesign({
  configurations: {
    configurations: [{ id: 1 }],
    activeConfigId: 1,
    systemRequirements: nestedRequirements,
  },
  systemRequirements: topLevelRequirements,
}).normalized;

assert.deepEqual(
  populatedNested?.configurations?.systemRequirements,
  nestedRequirements,
  'existing nested Requirements should remain authoritative',
);

console.log('Load Requirements smoke: PASS');