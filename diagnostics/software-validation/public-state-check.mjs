import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileOpticalSystem } from '../../analysis/optical-system-compiler.ts';
import { normalizePortRouteConfiguration } from '../../analysis/port-routes.ts';

const reports = [];
for (const name of ['Michelson_Interferometer.json', 'Fizeau_Interferometer.json']) {
  const document = JSON.parse(await readFile(new URL(`../../Examples/${name}`, import.meta.url), 'utf8'));
  const restored = JSON.parse(JSON.stringify(document));
  assert.deepEqual(restored, document);
  const configs = restored.configurations.configurations;
  assert.ok(configs.length >= 2, 'The fixture must exercise Config isolation');
  for (const config of configs) {
    const before = JSON.stringify(config);
    const compiled = compileOpticalSystem(config, { pupilSampling: 32 });
    assert.ok(compiled.canRun, JSON.stringify(compiled.issues));
    assert.equal(compiled.paths.length, 2);
    const normalized = normalizePortRouteConfiguration(config);
    assert.ok(normalized.resolvedRoutes.every(route => route.valid));
    const restoredCompiled = compileOpticalSystem(JSON.parse(before), { pupilSampling: 32 });
    assert.deepEqual(restoredCompiled.paths, compiled.paths, 'Serialization changed path order or physical component IDs');
    assert.equal(JSON.stringify(config), before, 'Preflight mutated the input design');
    const staleEndpointLabels = structuredClone(config);
    staleEndpointLabels.portRoutes[0].sourceBlockId = 'old-source-metadata';
    staleEndpointLabels.portRoutes[0].detectorBlockId = 'old-detector-metadata';
    assert.ok(compileOpticalSystem(staleEndpointLabels).canRun, 'Valid connection steps must still migrate stale endpoint metadata');

    const missingDetector = structuredClone(config);
    missingDetector.blocks = missingDetector.blocks.filter(block => !['AreaDetector', 'TimeDetector'].includes(block.blockType));
    const rejected = compileOpticalSystem(missingDetector);
    assert.equal(rejected.canRun, false);
    assert.ok(rejected.issues.some(issue => issue.code === 'missing-detector'));

    const oversized = structuredClone(config);
    Object.assign(oversized.blocks.find(block => block.blockType === 'AreaDetector').parameters, { pixelCountX: 16384, pixelCountY: 16384 });
    const memory = compileOpticalSystem(oversized, { pupilSampling: 256 });
    assert.equal(memory.canRun, false, 'Unsafe Camera allocation must be blocked before tracing');
    assert.ok(memory.issues.some(issue => issue.code === 'memory-budget-exceeded'));

    const broken = structuredClone(config);
    broken.portRoutes[0].steps[0].connectionId = 'nonexistent-validation-link';
    const brokenRoutes = normalizePortRouteConfiguration(broken);
    assert.ok(brokenRoutes.resolvedRoutes.some(route => !route.valid), 'A deleted connection must not leave a valid stale route');
    const brokenCompiled = compileOpticalSystem(broken);
    assert.equal(brokenCompiled.canRun, false, 'Preflight must not silently truncate or rediscover a broken saved path');
    assert.equal(brokenCompiled.routeSource, 'saved-paths');
    const missingPort = structuredClone(config);
    missingPort.portRoutes[0].steps[0].departurePortId = 'nonexistent-validation-port';
    assert.equal(compileOpticalSystem(missingPort).canRun, false, 'A removed port must not fall back to a default port');
    const missingSource = structuredClone(config);
    missingSource.blocks = missingSource.blocks.filter(block => !['BroadbandSource', 'FrequencyCombSource'].includes(block.blockType));
    assert.equal(compileOpticalSystem(missingSource).canRun, false, 'A deleted source must produce an invalid result, not throw');
    reports.push({ file: name, config: config.id, paths: compiled.paths.length,
      estimatedWorkingMiB: compiled.estimatedWorkingBytes / 1024 ** 2, oversizedBlocked: !memory.canRun, missingDetectorBlocked: !rejected.canRun });
  }
  const secondBefore = JSON.stringify(configs[1]);
  configs[0].blocks.find(block => block.blockId === 'measurement-mirror').parameters.positionZmm += 1;
  assert.equal(JSON.stringify(configs[1]), secondBefore, 'Editing Config 1 changed Config 2');
}
console.log(JSON.stringify({ ok: true, reports }, null, 2));
