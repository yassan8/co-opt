import assert from 'node:assert/strict';
import { normalizePortRouteConfiguration, resolvePortRoute } from '../analysis/port-routes.ts';
import { getAssemblyDesignVariableValue, listAssemblyDesignVariables, setAssemblyDesignVariableValue } from '../optimization/design-variables.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { buildHybridAssemblyFromConfiguration } from '../analysis/hybrid-design.ts';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';

const fixture = await readOptionalExampleFixtureOrExit('20260823_bug_03.json');
const config = structuredClone(fixture.configurations.configurations[0]);
const normalized = normalizePortRouteConfiguration(config);
assert.equal(normalized.routes.length, 1, 'legacy pathLabel migrates to one deterministic route');
assert.equal(normalized.resolvedRoutes[0].valid, true, normalized.resolvedRoutes[0].issues.map((issue) => issue.message).join('; '));

config.portRoutes = normalized.routes;
config.routeSets = normalized.routeSets;
config.sequentialGroups = [{
  id: 'main',
  label: 'Exact sequential optics',
  blockIds: config.blocks
    .filter((block) => !['FrequencyCombSource', 'AreaDetector', 'TimeDetector', 'BeamSplitter', 'FoldMirror', 'NDFilter', 'ReflectionGrating', 'Target', 'STLObject'].includes(block.blockType))
    .map((block) => block.blockId),
  pathLabel: 'main',
  rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
  rootTransformVariables: {
    positionY: { value: 0, optimize: { mode: 'V', min: -5, max: 5 } },
  },
}];
config.designConnections = config.designConnections.map((connection, index) => ({
  ...connection,
  allowReverse: true,
  variables: index === 0 ? { distanceMm: { value: connection.distanceMm, optimize: { mode: 'V', min: 0, max: 100 } } } : {},
}));
const reverseRoute = {
  ...normalized.routes[0],
  id: 'round-trip-fragment',
  label: 'Repeated reverse fragment',
  sourceBlockId: undefined,
  detectorBlockId: undefined,
  steps: [
    { connectionId: config.designConnections[1].id, direction: 'forward' },
    { connectionId: config.designConnections[1].id, direction: 'reverse' },
  ],
};
const repeated = resolvePortRoute(config, reverseRoute);
assert.equal(repeated.valid, true, repeated.issues.map((issue) => issue.message).join('; '));
assert.equal(repeated.steps[1].departure.blockId, repeated.steps[0].arrival.blockId, 'same connection can be traversed in reverse');

const variableId = `connection:${config.designConnections[0].id}.distanceMm`;
assert.ok(listAssemblyDesignVariables(config).some((entry) => entry.id === variableId), 'connection F/V variable is enumerated');
const groupVariableId = 'group:main.positionY';
assert.ok(listAssemblyDesignVariables(config).some((entry) => entry.id === groupVariableId), 'Sequential Group pose F/V variable is enumerated');
const baselineTrace = await runPortRoutedTrace(config, { spatialSamples: 9, spectralSamples: 1, renderRayLimit: 0 });
assert.equal(setAssemblyDesignVariableValue(config, variableId, 12.5), true);
assert.equal(getAssemblyDesignVariableValue(config, variableId), 12.5);
assert.equal(setAssemblyDesignVariableValue(config, groupVariableId, 0.25), true);
assert.equal(getAssemblyDesignVariableValue(config, groupVariableId), 0.25);
const firstAssembly = buildHybridAssemblyFromConfiguration(config);
const firstSequence = firstAssembly.blockSequences.find((sequence) => sequence.id === 'sequential:main');
assert.equal(firstSequence.manualOffset.positionMm.y, 0.25, 'authored Group pose is kept separately from the resolved world pose');
const persistedAssemblyConfig = structuredClone(config);
persistedAssemblyConfig.sequentialGroups[0].rootTransform = structuredClone(firstSequence.manualOffset);
const secondAssembly = buildHybridAssemblyFromConfiguration(persistedAssemblyConfig);
const secondSequence = secondAssembly.blockSequences.find((sequence) => sequence.id === 'sequential:main');
assert.deepEqual(secondSequence.rootTransform, firstSequence.rootTransform, 'save/reload does not add the auto placement twice');

const traced = await runPortRoutedTrace(config, { spatialSamples: 9, spectralSamples: 1, renderRayLimit: 50 });
assert.equal(traced.routeMetrics.length, 1, 'saved route is the sole tracing topology');
assert.ok(traced.routeMetrics[0].launchedRays > 0, 'source launches rays through the saved route');
assert.ok(traced.segments.every((segment) => segment.wavelengthNm > 0 && segment.powerW >= 0), 'Render segments retain wavelength and power');
assert.ok(
  traced.segments.filter((segment) => segment.kind === 'exact-sequential').length > traced.routeMetrics[0].reachedRays,
  'Render receives surface-by-surface Exact Sequential segments rather than one straight group chord',
);
assert.notEqual(traced.routeMetrics[0].oplMm, baselineTrace.routeMetrics[0].oplMm, 'connection distance variable changes traced OPL');
assert.notEqual(traced.routeMetrics[0].centroidYmm, baselineTrace.routeMetrics[0].centroidYmm, 'Sequential Group pose variable changes the Detector centroid');
assert.ok(Math.abs(traced.energy.launchedPowerW - 0.001) < 1e-12, 'accepted pupil samples are renormalized to total source power');
assert.ok(Number.isFinite(traced.routeMetrics[0].wavefrontRmsUm) && traced.routeMetrics[0].wavefrontRmsUm >= 0, 'route wavefront RMS is available');
assert.ok(traced.routeMetrics[0].strehl >= 0 && traced.routeMetrics[0].strehl <= 1, 'route Strehl is bounded');
const fieldTrace = await runPortRoutedTrace(config, {
  spatialSamples: 9,
  spectralSamples: 1,
  renderRayLimit: 0,
  fieldObjectRow: { position: 'Rectangle', xHeightAngle: 0, yHeightAngle: 0.5 },
});
assert.notEqual(fieldTrace.routeMetrics[0].centroidYmm, traced.routeMetrics[0].centroidYmm, 'selected finite Object/Field row changes the routed Detector signal');
const selectedLineTrace = await runPortRoutedTrace(config, {
  spatialSamples: 9,
  spectralLineIndex: 50,
  renderRayLimit: 0,
});
assert.ok(Math.abs(selectedLineTrace.routeMetrics[0].receivedPowerW - 0.001 / 101) < 1e-12, 'one selected comb line retains its physical fraction of total source power');

const singleGroupConfig = structuredClone(fixture.configurations.configurations[0]);
const singleRoutes = normalizePortRouteConfiguration(singleGroupConfig);
singleGroupConfig.portRoutes = singleRoutes.routes;
singleGroupConfig.routeSets = singleRoutes.routeSets;
const singleGroupTrace = await runPortRoutedTrace(singleGroupConfig, { spatialSamples: 9, spectralSamples: 1, renderRayLimit: 0 });
const splitGroupConfig = structuredClone(singleGroupConfig);
splitGroupConfig.sequentialGroups = [
  {
    id: 'main', label: 'Front exact group', pathLabel: 'main',
    blockIds: ['ObjectSurface-1', 'Stop-1', 'Paraxial-1', 'Gap-1'],
    rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
  },
  {
    id: 'rear', label: 'Rear exact group', pathLabel: 'main',
    blockIds: ['Paraxial-2', 'Gap-2', 'ImageSurface-1'],
    rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
  },
];
const firstConnection = structuredClone(splitGroupConfig.designConnections[0]);
firstConnection.to = { blockId: 'sequential-group:main', portId: 'front' };
const betweenConnection = {
  id: 'connection-between-exact-groups',
  from: { blockId: 'sequential-group:main', portId: 'back' },
  to: { blockId: 'sequential-group:rear', portId: 'front' },
  distanceMm: 50,
  azimuthDeg: 90,
  elevationDeg: 0,
  autoPlace: true,
  allowReverse: true,
  pathLabel: 'main',
};
const finalConnection = structuredClone(splitGroupConfig.designConnections[1]);
finalConnection.from = { blockId: 'sequential-group:rear', portId: 'back' };
splitGroupConfig.designConnections = [firstConnection, betweenConnection, finalConnection];
splitGroupConfig.portRoutes = [{
  id: 'route-split-exact', label: 'Split exact groups', enabled: true,
  sourceBlockId: 'FrequencyCombSource-1', detectorBlockId: 'AreaDetector-1',
  steps: splitGroupConfig.designConnections.map((connection) => ({ connectionId: connection.id, direction: 'forward' })),
}];
splitGroupConfig.routeSets = [{
  id: 'route-set-split', label: 'Split exact detector', detectorBlockId: 'AreaDetector-1',
  routeIds: ['route-split-exact'], measurementRouteId: 'route-split-exact',
}];
const splitGroupTrace = await runPortRoutedTrace(splitGroupConfig, { spatialSamples: 9, spectralSamples: 1, renderRayLimit: 0 });
assert.equal(splitGroupTrace.routeMetrics[0].valid, true, splitGroupTrace.routeMetrics[0].failureReason);
const fractionalDifference = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(a), Math.abs(b));
assert.ok(fractionalDifference(splitGroupTrace.routeMetrics[0].oplMm, singleGroupTrace.routeMetrics[0].oplMm) <= 0.005, `split-group OPL ${splitGroupTrace.routeMetrics[0].oplMm} vs ${singleGroupTrace.routeMetrics[0].oplMm}`);
assert.ok(fractionalDifference(splitGroupTrace.routeMetrics[0].spotRmsMm, singleGroupTrace.routeMetrics[0].spotRmsMm) <= 0.005, `split-group spot ${splitGroupTrace.routeMetrics[0].spotRmsMm} vs ${singleGroupTrace.routeMetrics[0].spotRmsMm}`);

const shiftedDetectorConfig = structuredClone(config);
const areaDetector = shiftedDetectorConfig.blocks.find((block) => block.blockType === 'AreaDetector');
areaDetector.parameters.positionZmm = Number(areaDetector.parameters.positionZmm ?? 0) + 1;
const shiftedDetectorTrace = await runPortRoutedTrace(shiftedDetectorConfig, { spatialSamples: 9, spectralSamples: 1, renderRayLimit: 0 });
assert.notEqual(
  shiftedDetectorTrace.routeMetrics[0].oplMm,
  traced.routeMetrics[0].oplMm,
  'Detector Z pose changes the physical Port-routed signal path',
);

const multiDetectorConfig = structuredClone(config);
const firstDetectorBlock = multiDetectorConfig.blocks.find((block) => block.blockType === 'AreaDetector');
const secondDetectorBlock = structuredClone(firstDetectorBlock);
secondDetectorBlock.blockId = 'AreaDetector-2';
secondDetectorBlock.parameters.pixelCountX = 256;
secondDetectorBlock.parameters.pixelCountY = 128;
secondDetectorBlock.parameters.pixelPitchUm = 7.5;
multiDetectorConfig.blocks.push(secondDetectorBlock);
const lastConnection = multiDetectorConfig.designConnections[multiDetectorConfig.designConnections.length - 1];
const secondDetectorConnection = structuredClone(lastConnection);
secondDetectorConnection.id = 'connection-second-detector';
secondDetectorConnection.to = { blockId: secondDetectorBlock.blockId, portId: 'detect' };
multiDetectorConfig.designConnections.push(secondDetectorConnection);
const secondRoute = structuredClone(multiDetectorConfig.portRoutes[0]);
secondRoute.id = 'route-second-detector';
secondRoute.label = 'Second detector';
secondRoute.detectorBlockId = secondDetectorBlock.blockId;
secondRoute.steps[secondRoute.steps.length - 1] = { connectionId: secondDetectorConnection.id, direction: 'forward' };
multiDetectorConfig.portRoutes.push(secondRoute);
const multiDetectorTrace = await runPortRoutedTrace(multiDetectorConfig, { spatialSamples: 9, spectralSamples: 1, renderRayLimit: 0 });
assert.equal(multiDetectorTrace.detectors.length, 2, 'multiple Detectors are evaluated independently in one run');
assert.deepEqual(
  multiDetectorTrace.detectors.map((detector) => [detector.width, detector.height, detector.pixelPitchUm]),
  [[1024, 1024, 50], [256, 128, 7.5]],
  'each Detector keeps its own pixel geometry',
);

const timeDetectorConfig = structuredClone(config);
const timeDetectorBlock = timeDetectorConfig.blocks.find((block) => block.blockType === 'AreaDetector');
timeDetectorBlock.blockType = 'TimeDetector';
Object.assign(timeDetectorBlock.parameters, { samplingRateHz: 1e9, detectionBandwidthHz: 450e6, sampleCount: 256, frontOnly: true });
const timeTrace = await runPortRoutedTrace(timeDetectorConfig, { spatialSamples: 9, spectralSamples: 5, renderRayLimit: 0 });
assert.equal(timeTrace.detectors[0].timeSignalW.length, 256, 'Time Detector returns the configured sampled waveform');
assert.ok(timeTrace.detectors[0].rfBeats.length > 0, 'Frequency Comb lines produce in-band RF beats');

console.log(JSON.stringify({
  route: normalized.routes[0],
  metric: traced.routeMetrics[0],
  warnings: traced.warnings,
  splitExactGroups: {
    singleOplMm: singleGroupTrace.routeMetrics[0].oplMm,
    splitOplMm: splitGroupTrace.routeMetrics[0].oplMm,
    singleSpotRmsMm: singleGroupTrace.routeMetrics[0].spotRmsMm,
    splitSpotRmsMm: splitGroupTrace.routeMetrics[0].spotRmsMm,
  },
  shiftedDetectorMetric: shiftedDetectorTrace.routeMetrics[0],
  detectors: multiDetectorTrace.detectors.map((detector) => ({ id: detector.detectorId, width: detector.width, height: detector.height, pitchUm: detector.pixelPitchUm })),
  timeDetector: { samples: timeTrace.detectors[0].timeSignalW.length, rfBeats: timeTrace.detectors[0].rfBeats.length },
  assemblyVariable: { id: variableId, value: getAssemblyDesignVariableValue(config, variableId) },
  groupVariable: { id: groupVariableId, value: getAssemblyDesignVariableValue(config, groupVariableId) },
}, null, 2));
