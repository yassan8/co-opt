import {
  requiresExpandedRowsForDesignIntentChange,
  requiresBlockInspectorRefreshForDesignIntentChange,
  requiresZoomUiRefreshForDesignIntentChange,
  reconcileDesignIntentVariableValues,
  syncDesignIntentParameterToVariable,
} from '../ui/design-intent-refresh-policy.ts';

const cases = [
  {
    path: 'variables.frontRadius.value',
    expected: { expanded: false, inspector: false, zoom: false },
  },
  {
    path: 'parameters.radius',
    expected: { expanded: true, inspector: false, zoom: false },
  },
  {
    path: 'parameters.surfType',
    expected: { expanded: true, inspector: true, zoom: false },
  },
  {
    path: 'aperture.s1',
    expected: { expanded: true, inspector: true, zoom: false },
  },
  {
    path: 'parameters.zoomGroupProfiles',
    expected: { expanded: true, inspector: true, zoom: true },
  },
  {
    path: 'parameters.material',
    expected: { expanded: true, inspector: true, zoom: false },
  },
  {
    path: 'parameters.rindex',
    expected: { expanded: true, inspector: true, zoom: false },
  },
  {
    path: 'parameters.abbe2',
    expected: { expanded: true, inspector: true, zoom: false },
  },
];

const results = cases.map((entry) => {
  const actual = {
    expanded: requiresExpandedRowsForDesignIntentChange(entry.path),
    inspector: requiresBlockInspectorRefreshForDesignIntentChange(entry.path),
    zoom: requiresZoomUiRefreshForDesignIntentChange(entry.path),
  };
  return { ...entry, actual, ok: JSON.stringify(actual) === JSON.stringify(entry.expected) };
});

const failed = results.filter((entry) => !entry.ok);

const optimizedQconBlock = {
  parameters: { frontCoef1: 1.25 },
  variables: { frontCoef1: { value: 1.25, optimize: { mode: 'V' } } },
};
optimizedQconBlock.parameters.frontCoef1 = 0;
const syncedZero = syncDesignIntentParameterToVariable(optimizedQconBlock, 'parameters.frontCoef1', 0);
const zeroPreserved = syncedZero === true
  && Object.is(optimizedQconBlock.parameters.frontCoef1, 0)
  && Object.is(optimizedQconBlock.variables.frontCoef1.value, 0);

let repeatedRefreshPreserved = true;
for (let cycle = 0; cycle < 8; cycle += 1) {
  optimizedQconBlock.variables.frontCoef1.value = 1.25;
  reconcileDesignIntentVariableValues(optimizedQconBlock);
  repeatedRefreshPreserved = repeatedRefreshPreserved
    && Object.is(optimizedQconBlock.parameters.frontCoef1, 0)
    && Object.is(optimizedQconBlock.variables.frontCoef1.value, 0);
}

console.log('DI_REFRESH_POLICY_REPORT', JSON.stringify({ results, zeroPreserved, repeatedRefreshPreserved }, null, 2));
if (failed.length > 0 || !zeroPreserved || !repeatedRefreshPreserved) {
  console.error('DI_REFRESH_POLICY_FAIL', JSON.stringify({ failed, zeroPreserved, repeatedRefreshPreserved, optimizedQconBlock }, null, 2));
  process.exit(1);
}

console.log('DI_REFRESH_POLICY_PASS');