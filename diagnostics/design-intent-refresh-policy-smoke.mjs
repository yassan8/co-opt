import {
  requiresExpandedRowsForDesignIntentChange,
  requiresBlockInspectorRefreshForDesignIntentChange,
  requiresZoomUiRefreshForDesignIntentChange,
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

console.log('DI_REFRESH_POLICY_REPORT', JSON.stringify(results, null, 2));
if (failed.length > 0) {
  console.error('DI_REFRESH_POLICY_FAIL', JSON.stringify(failed, null, 2));
  process.exit(1);
}

console.log('DI_REFRESH_POLICY_PASS');