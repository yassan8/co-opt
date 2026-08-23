import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { createPatentFig2AssemblyDesign } from '../analysis/coherent-assembly.ts';
import { worldPortPosition } from '../analysis/coherent-port-layout.ts';
import { calculateImagingDetectorSignal, convolveDetectorPowerWithPsf } from '../analysis/detector-signal.ts';
import {
  buildHybridAssemblyFromConfiguration,
  createDefaultPhysicalBlock,
  migrateLegacyCoherentDesign,
  normalizeDesignConnections,
} from '../analysis/hybrid-design.ts';
import { buildNonSequentialTraceRequest } from '../analysis/nonsequential-trace.ts';

const exactBlocks = [
  { blockId: 'object', blockType: 'ObjectSurface', constraints: {}, parameters: { objectDistanceMode: 'Infinite' }, variables: {}, metadata: {} },
  { blockId: 'lens', blockType: 'Lens', constraints: {}, parameters: { frontRadius: 50, backRadius: -50, centerThickness: 5, material: 'N-BK7', frontSurfType: 'Spherical', backSurfType: 'Spherical' }, aperture: { front: 10, back: 10 }, variables: {}, metadata: {} },
  { blockId: 'stop', blockType: 'Stop', constraints: {}, parameters: { semiDiameter: 5 }, variables: {}, metadata: {} },
  { blockId: 'image', blockType: 'ImageSurface', constraints: {}, parameters: { semidia: 10, semidiaMode: 'Manual' }, metadata: {} },
];
const sourceBlock = createDefaultPhysicalBlock('BroadbandSource', 'source');
const splitterBlock = createDefaultPhysicalBlock('BeamSplitter', 'splitter');
const detectorBlock = createDefaultPhysicalBlock('AreaDetector', 'detector');
sourceBlock.parameters.totalPowerW = 0.002;
detectorBlock.parameters.pixelCountX = 9;
detectorBlock.parameters.pixelCountY = 7;
detectorBlock.parameters.pixelPitchUm = 4;

const retrofocusJson = JSON.parse(await readFile(new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url), 'utf8'));
const retrofocusConfig = retrofocusJson.configurations.configurations[0];
const retrofocusRows = expandBlocksToOpticalSystemRows(retrofocusConfig.blocks).rows;
const retrofocusHybridRows = expandBlocksToOpticalSystemRows([
  ...retrofocusConfig.blocks,
  createDefaultPhysicalBlock('BroadbandSource', 'retro-source'),
  createDefaultPhysicalBlock('AreaDetector', 'retro-detector'),
]).rows;
assert.deepEqual(retrofocusHybridRows, retrofocusRows, 'Retrofocus exact surfaces, glass, aspheres and apertures are unchanged by Hybrid physical blocks');

const baselineRows = expandBlocksToOpticalSystemRows(exactBlocks).rows;
const mixedRows = expandBlocksToOpticalSystemRows([...exactBlocks, sourceBlock, splitterBlock, detectorBlock]).rows;
assert.deepEqual(mixedRows, baselineRows, 'physical blocks never modify exact sequential rows');

const config = {
  id: 1, name: 'Hybrid verification', schemaVersion: '0.2',
  blocks: [...exactBlocks, sourceBlock, splitterBlock, detectorBlock],
  designConnections: [
    { id: 'source-splitter', from: { blockId: 'source', portId: 'emit' }, to: { blockId: 'splitter', portId: 'common' }, distanceMm: 20, autoPlace: true, pathLabel: 'common' },
    { id: 'splitter-detector', from: { blockId: 'splitter', portId: 'transmit' }, to: { blockId: 'detector', portId: 'detect' }, distanceMm: 50, autoPlace: true, pathLabel: 'image' },
  ],
  source: [{ wavelength: 0.5875618, weight: 1, primary: 'Primary Wavelength' }],
  object: [{ position: 'Angle', xHeightAngle: 0, yHeightAngle: 0 }], opticalSystem: baselineRows,
  systemData: { referenceFocalLength: '' },
  metadata: { created: new Date(0).toISOString(), modified: new Date(0).toISOString(), locked: false },
};
const hybrid = buildHybridAssemblyFromConfiguration(config);
assert.equal(hybrid.preset, 'custom-hybrid');
assert.equal(hybrid.source.totalPowerW, 0.002);
assert.equal(hybrid.detector.pixelCountX, 9);
assert.equal(hybrid.detector.pixelCountY, 7);
assert.equal(hybrid.connections.length, 2);
assert.ok(hybrid.components.some((component) => component.kind === 'sequential-group'));
const component = (id) => hybrid.components.find((entry) => entry.id === id);
const gap = (fromId, fromPort, toId, toPort) => {
  const from = worldPortPosition(component(fromId), fromPort, 'from');
  const to = worldPortPosition(component(toId), toPort, 'to');
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
};
assert.ok(Math.abs(gap('source', 'emit', 'splitter', 'common') - 20) < 1e-9, 'source to splitter follows stored port distance');
assert.ok(Math.abs(gap('splitter', 'transmit', 'detector', 'detect') - 50) < 1e-9, 'splitter to detector follows stored port distance');
const request = buildNonSequentialTraceRequest(hybrid, 'preview');
assert.ok(!request.surfaces.some((surface) => surface.interaction.kind === 'thin-lens'), 'exact sequential group is never converted to a thin lens');
const idealSplitterInteraction = request.surfaces.find((surface) => surface.interaction.kind === 'beam-splitter')?.interaction;
assert.ok(idealSplitterInteraction, 'Beam Splitter is present in the non-sequential request');
assert.equal(idealSplitterInteraction.beamSplitterModel, 'ideal', 'default Beam Splitter does not require a substrate index');
assert.ok(request.surfaces.some((surface) => surface.interaction.kind === 'detector'));

const physicalConfig = JSON.parse(JSON.stringify(config));
const physicalSplitter = physicalConfig.blocks.find((block) => block.blockType === 'BeamSplitter');
Object.assign(physicalSplitter.parameters, {
  beamSplitterModel: 'plate',
  substrateMaterial: 'N-BK7',
  substrateIndexNd: 1.5168,
  substrateAbbeNumber: 64.17,
  substrateThicknessMm: 3,
  wedgeDeg: 0.1,
  backSurfaceReflectance: 0.04,
});
const physicalHybrid = buildHybridAssemblyFromConfiguration(physicalConfig);
const physicalRequest = buildNonSequentialTraceRequest(physicalHybrid, 'preview');
const physicalInteraction = physicalRequest.surfaces.find((surface) => surface.interaction.kind === 'beam-splitter')?.interaction;
assert.equal(physicalHybrid.beamSplitter.model, 'plate');
assert.equal(physicalInteraction.beamSplitterModel, 'plate');
assert.equal(physicalInteraction.substrateIndexNd, 1.5168);
assert.equal(physicalInteraction.substrateThicknessMm, 3);
assert.equal(physicalInteraction.backSurfaceReflectance, 0.04);

const disconnectedHybrid = buildHybridAssemblyFromConfiguration({ ...config, designConnections: [] });
assert.equal(disconnectedHybrid.connections.length, 0);
assert.equal(disconnectedHybrid.paths.length, 0, 'removed connections do not leave stale Optical path labels');

const delta = [
  [0, 0, 0],
  [0, 1, 0],
  [0, 0, 0],
];
const detector = {
  kind: 'area', pixelCountX: 3, pixelCountY: 3, pixelPitchUm: 5,
  responsivity: 1, fillFactor: 1, exposureTimeS: 0.01,
  saturationElectrons: 1000, bitDepth: 12,
  quantumEfficiency: [{ wavelengthNm: 500, value: 0.5 }],
};
const signal = calculateImagingDetectorSignal({
  spectralPsf: [{ wavelengthUm: 0.5, weight: 1, psfData: delta, pixelSizeUm: 5 }],
  detector, totalPowerW: 1,
});
assert.ok(Math.abs(signal.integratedPowerW - 1) < 1e-12, 'detector PSF integration conserves in-bounds power');
assert.ok(Math.abs(signal.powerWPerPixel[4] - 1) < 1e-12, 'center PSF sample maps to center detector pixel');
const expectedElectrons = 1 * 0.01 / (6.62607015e-34 * 299792458 / 5e-7) * 0.5;
assert.ok(Math.abs(signal.electronsPerPixel[4] / expectedElectrons - 1) < 1e-12, 'photon energy and QE produce analytic electron count');
assert.equal(signal.saturatedPixelCount, 1);
assert.equal(signal.aduPerPixel[4], 4095);

const largePixelSignal = calculateImagingDetectorSignal({
  spectralPsf: [{ wavelengthUm: 0.5, weight: 1, psfData: [[1, 1], [1, 1]], pixelSizeUm: 2 }],
  detector: { ...detector, pixelCountX: 1, pixelCountY: 1, pixelPitchUm: 4, saturationElectrons: 1e30 },
  totalPowerW: 0.25,
});
assert.ok(Math.abs(largePixelSignal.integratedPowerW - 0.25) < 1e-12, 'non-integer pitch rebinning remains energy conserving');

const physicalMap = new Float64Array(25);
physicalMap[12] = 1;
const hybridSignal = convolveDetectorPowerWithPsf({
  powerWPerPixel: physicalMap, width: 5, height: 5,
  detector: { ...detector, pixelCountX: 5, pixelCountY: 5, pixelPitchUm: 5, saturationElectrons: 1e30 },
  psfData: [[0, 1, 0], [1, 4, 1], [0, 1, 0]], psfPixelSizeUm: 5, wavelengthNm: 500,
});
assert.ok(Math.abs(hybridSignal.integratedPowerW - 1) < 1e-12, 'physical detector map times exact PSF conserves in-bounds power');
assert.ok(Math.abs(hybridSignal.powerWPerPixel[12] - 0.5) < 1e-12, 'exact PSF shapes the physical-path center hit');

const removedConnections = normalizeDesignConnections([sourceBlock, splitterBlock, detectorBlock], []);
assert.equal(removedConnections.length, 0, 'an explicitly empty connection list stays empty after Remove');
const autoConnections = normalizeDesignConnections([sourceBlock, splitterBlock, detectorBlock], undefined);
assert.equal(autoConnections.length, 2, 'legacy Configs without designConnections receive a single auto path');
assert.equal(autoConnections[0].from.portId, 'emit');
assert.equal(autoConnections[1].to.portId, 'detect');

const legacy = createPatentFig2AssemblyDesign();
const migrated = migrateLegacyCoherentDesign(legacy, exactBlocks);
assert.ok(migrated.blocks.some((block) => block.blockType === 'BroadbandSource'));
assert.ok(migrated.blocks.some((block) => block.blockType === 'ReflectionGrating'));
assert.ok(migrated.blocks.some((block) => block.blockType === 'AreaDetector'));
assert.ok(!migrated.blocks.some((block) => block.blockType === 'Lens' && String(block.blockId).startsWith('assembly:')), 'legacy thin proxy lenses are not migrated');
assert.ok(migrated.designConnections.length > 0);

console.log(JSON.stringify({
  ok: true,
  exactSurfaceRows: baselineRows.length,
  retrofocusExactSurfaceRows: retrofocusRows.length,
  physicalBlocks: hybrid.components.filter((component) => component.kind !== 'sequential-group').length,
  connections: hybrid.connections.length,
  detector: {
    integratedPowerW: signal.integratedPowerW,
    peakElectrons: signal.maximumElectronsPerPixel,
    saturatedPixels: signal.saturatedPixelCount,
  },
  migratedPhysicalBlocks: migrated.blocks.length - exactBlocks.length,
}, null, 2));