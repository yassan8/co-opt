import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildHybridAssemblyFromConfiguration } from '../analysis/hybrid-design.ts';
import { buildNonSequentialTraceRequest } from '../analysis/nonsequential-trace.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';

const fixture = await readOptionalExampleFixtureOrExit('JPA_2026126953_Figure2_fiber_NA0p1.json');
const config = structuredClone(fixture.configurations.configurations[0]);
const sourceBlock = config.blocks.find((block) => block.blockId === 'BroadbandSource-11');
assert.ok(sourceBlock, 'Figure 2 source block is present');
sourceBlock.parameters.renderSpatialSamples = 9;
sourceBlock.parameters.detectorSpatialSamples = 25;

const design = buildHybridAssemblyFromConfiguration(config);
assert.equal(design.source.renderSpatialSamples, 9, 'Render ray setting is carried into the assembly source');
assert.equal(design.source.detectorSpatialSamples, 25, 'Detector ray setting is carried into the assembly source');

const renderRequest = buildNonSequentialTraceRequest(design, 'preview');
const detectorRequest = buildNonSequentialTraceRequest(design, 'full');
assert.equal(renderRequest.sources[0].spatialSamples, 9, 'non-sequential Render uses the Source Render count');
assert.equal(detectorRequest.sources[0].spatialSamples, 25, 'non-sequential Detector calculation uses the Source Detector count');

const renderProgress = [];
const renderTrace = await runPortRoutedTrace(config, {
  routeIds: ['route-sc-reference'],
  samplePurpose: 'render',
  spectralSamples: 1,
  renderRayLimit: 0,
  onProgress: (progress) => renderProgress.push(progress),
});
const detectorProgress = [];
const detectorTrace = await runPortRoutedTrace(config, {
  routeIds: ['route-sc-reference'],
  samplePurpose: 'detector',
  spectralSamples: 1,
  renderRayLimit: 0,
  onProgress: (progress) => detectorProgress.push(progress),
});
assert.ok(
  detectorTrace.routeMetrics[0].launchedRays > renderTrace.routeMetrics[0].launchedRays,
  'Port-routed Detector calculation launches the larger Source sampling setting',
);
assert.equal(renderTrace.routeMetrics[0].launchedRays, 9, 'Render ray count is the requested per-wavelength count');
assert.equal(detectorTrace.routeMetrics[0].launchedRays, 25, 'Detector ray count is the requested per-wavelength count');
assert.equal(renderProgress[0].percent, 0, 'Port trace progress starts at zero');
assert.equal(renderProgress.at(-1).percent, 100, 'Port trace progress reaches 100 only after Detector accumulation');
assert.ok(renderProgress.some((entry) => entry.percent > 0 && entry.percent < 100), 'Port trace reports intermediate route progress');
assert.equal(detectorProgress.at(-1).message, 'Detector route trace complete');

const coherentSignalSource = await readFile(new URL('../src/app/CoherentSignalPage.tsx', import.meta.url), 'utf8');
assert.match(coherentSignalSource, /samplePurpose: quality === 'preview' \? 'render' : 'detector'/, 'Coherent Signal requests the Detector-specific Source sampling');
assert.match(coherentSignalSource, /role="progressbar"/, 'Coherent Signal exposes a visible accessible progress bar');

console.log(JSON.stringify({
  source: {
    renderSpatialSamples: design.source.renderSpatialSamples,
    detectorSpatialSamples: design.source.detectorSpatialSamples,
  },
  portRouted: {
    renderLaunchedRays: renderTrace.routeMetrics[0].launchedRays,
    detectorLaunchedRays: detectorTrace.routeMetrics[0].launchedRays,
    progressUpdates: detectorProgress.length,
  },
}, null, 2));
