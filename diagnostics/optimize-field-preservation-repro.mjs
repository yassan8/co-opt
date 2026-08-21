import assert from 'node:assert/strict';
import { cloneOptimizeConfigWithLiveObjectRows } from '../src/app/optimize-run-config.ts';

const persisted = {
  activeConfigId: 'cfg-1',
  configurations: [
    {
      id: 'cfg-1',
      name: 'Config 1',
      object: [
        { id: 1, position: 'ImageHeight', yHeightAngle: 0 },
        { id: 2, position: 'ImageHeight', yHeightAngle: 21.6 },
      ],
    },
    {
      id: 'cfg-2',
      name: 'Config 2',
      object: [{ id: 1, position: 'Angle', yHeightAngle: 5 }],
    },
  ],
};

const liveRows = Array.from({ length: 11 }, (_, index) => ({
  id: index + 1,
  position: 'ImageHeight',
  xHeightAngle: 0,
  yHeightAngle: 2.16 * index,
}));

const synchronized = cloneOptimizeConfigWithLiveObjectRows(persisted, liveRows);

assert.notEqual(synchronized, persisted, 'configuration must be cloned');
assert.equal(synchronized.configurations[0].object.length, 11, 'all live Field rows must be retained');
assert.deepEqual(synchronized.configurations[0].object, liveRows);
assert.deepEqual(
  synchronized.configurations[1].object,
  persisted.configurations[1].object,
  'inactive configurations must not be changed',
);
assert.equal(persisted.configurations[0].object.length, 2, 'persisted input must not be mutated');

liveRows[0].yHeightAngle = 999;
assert.equal(
  synchronized.configurations[0].object[0].yHeightAngle,
  0,
  'live rows must be deeply cloned',
);

const unchangedForEmptyLiveTable = cloneOptimizeConfigWithLiveObjectRows(persisted, []);
assert.deepEqual(unchangedForEmptyLiveTable, persisted, 'an unavailable live table must not erase fields');

console.log('PASS optimize Field preservation: 2 stale rows -> 11 live rows');
