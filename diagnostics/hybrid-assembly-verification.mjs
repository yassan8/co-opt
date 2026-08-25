import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { createPatentFig2AssemblyDesign, resolveComponentTransform } from '../analysis/coherent-assembly.ts';
import { worldPortPosition } from '../analysis/coherent-port-layout.ts';
import { readOptionalExampleFixture } from './optional-example-fixture.mjs';
import { getHybridDetectorPlaneOffset } from '../analysis/hybrid-detector-plane.ts';
import {
  calculateImagingDetectorSignal,
  convolveDetectorFieldsWithCoherentPsf,
  convolveDetectorPowerWithPsf,
} from '../analysis/detector-signal.ts';
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
const detectorBlock2 = createDefaultPhysicalBlock('AreaDetector', 'detector-2');
sourceBlock.parameters.totalPowerW = 0.002;
detectorBlock.parameters.pixelCountX = 9;
detectorBlock.parameters.pixelCountY = 7;
detectorBlock.parameters.pixelPitchUm = 4;
detectorBlock2.parameters.pixelCountX = 5;
detectorBlock2.parameters.pixelCountY = 5;

const retrofocusJson = JSON.parse(await readFile(new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url), 'utf8'));
const retrofocusConfig = retrofocusJson.configurations.configurations[0];
const retrofocusRows = expandBlocksToOpticalSystemRows(retrofocusConfig.blocks).rows;
const retrofocusHybridRows = expandBlocksToOpticalSystemRows([
  ...retrofocusConfig.blocks,
  createDefaultPhysicalBlock('BroadbandSource', 'retro-source'),
  createDefaultPhysicalBlock('AreaDetector', 'retro-detector'),
]).rows;
assert.deepEqual(retrofocusHybridRows, retrofocusRows, 'Retrofocus exact surfaces, glass, aspheres and apertures are unchanged by Hybrid physical blocks');

const detectorZReproJson = await readOptionalExampleFixture('20260823_bug_03.json');
if (detectorZReproJson) {
  const detectorZReproConfig = detectorZReproJson.configurations.configurations[0];
  const detectorZReproDesign = buildHybridAssemblyFromConfiguration(detectorZReproConfig);
  const detectorZOffset = getHybridDetectorPlaneOffset(detectorZReproDesign, 'AreaDetector-1');
  assert.equal(detectorZOffset.supported, true, 'direct sequential-to-detector connection supports detector-plane PSF propagation');
  assert.ok(Math.abs(detectorZOffset.defocusMm - 10) < 1e-9, 'Detector Z=10 mm becomes +10 mm exact-lens defocus');
  const movedDetectorConfig = JSON.parse(JSON.stringify(detectorZReproConfig));
  movedDetectorConfig.blocks.find((block) => block.blockId === 'AreaDetector-1').parameters.positionZmm = 25;
  const movedDetectorOffset = getHybridDetectorPlaneOffset(buildHybridAssemblyFromConfiguration(movedDetectorConfig), 'AreaDetector-1');
  assert.ok(Math.abs(movedDetectorOffset.defocusMm - 25) < 1e-9, 'changing Detector Z updates the detector-plane defocus');
}

const baselineRows = expandBlocksToOpticalSystemRows(exactBlocks).rows;
const mixedRows = expandBlocksToOpticalSystemRows([...exactBlocks, sourceBlock, splitterBlock, detectorBlock]).rows;
assert.deepEqual(mixedRows, baselineRows, 'physical blocks never modify exact sequential rows');

const config = {
  id: 1, name: 'Hybrid verification', schemaVersion: '0.2',
  blocks: [...exactBlocks, sourceBlock, splitterBlock, detectorBlock, detectorBlock2],
  designConnections: [
    { id: 'source-splitter', from: { blockId: 'source', portId: 'emit' }, to: { blockId: 'splitter', portId: 'common' }, distanceMm: 20, autoPlace: true, pathLabel: 'common' },
    { id: 'splitter-detector', from: { blockId: 'splitter', portId: 'transmit' }, to: { blockId: 'detector', portId: 'detect' }, distanceMm: 50, autoPlace: true, pathLabel: 'image' },
    { id: 'splitter-detector-2', from: { blockId: 'splitter', portId: 'reflect' }, to: { blockId: 'detector-2', portId: 'detect' }, distanceMm: 35, autoPlace: true, pathLabel: 'monitor' },
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
assert.equal(hybrid.connections.length, 3);
assert.equal(hybrid.detectors.length, 2, 'all physical detectors remain in the Hybrid design');
assert.ok(hybrid.components.some((component) => component.kind === 'sequential-group'));
assert.equal(hybrid.blockSequences.length, 1, 'legacy Config remains one main exact sequential group');
assert.equal(hybrid.blockSequences[0].id, 'sequential:main');
const component = (id) => hybrid.components.find((entry) => entry.id === id);
assert.ok(Math.abs(component('detector').dimensions.widthMm - 0.036) < 1e-12, 'detector width follows Pixels X times pixel pitch');
assert.ok(Math.abs(component('detector').dimensions.heightMm - 0.028) < 1e-12, 'detector height follows Pixels Y times pixel pitch');
const widerPitchConfig = JSON.parse(JSON.stringify(config));
widerPitchConfig.blocks.find((block) => block.blockId === 'detector').parameters.pixelPitchUm = 8;
const widerPitchHybrid = buildHybridAssemblyFromConfiguration(widerPitchConfig);
const widerPitchDetector = widerPitchHybrid.components.find((entry) => entry.id === 'detector');
assert.ok(Math.abs(widerPitchDetector.dimensions.widthMm - 0.072) < 1e-12, 'detector Render width updates when pixel pitch changes');
assert.ok(Math.abs(widerPitchDetector.dimensions.heightMm - 0.056) < 1e-12, 'detector Render height updates when pixel pitch changes');
const gap = (fromId, fromPort, toId, toPort) => {
  const from = worldPortPosition(component(fromId), fromPort, 'from');
  const to = worldPortPosition(component(toId), toPort, 'to');
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
};
assert.ok(Math.abs(gap('source', 'emit', 'splitter', 'common') - 20) < 1e-9, 'source to splitter follows stored port distance');
assert.ok(Math.abs(gap('splitter', 'transmit', 'detector', 'detect') - 50) < 1e-9, 'splitter to detector follows stored port distance');

const multiGroupConfig = JSON.parse(JSON.stringify(config));
multiGroupConfig.sequentialGroups = [
  { id: 'measurement', label: 'Measurement optics', pathLabel: 'measurement', blockIds: ['object', 'lens', 'image'] },
  { id: 'reference', label: 'Reference optics', pathLabel: 'reference', blockIds: ['stop'] },
];
multiGroupConfig.designConnections = [
  { id: 'measurement-detector', from: { blockId: 'sequential-group:measurement', portId: 'out' }, to: { blockId: 'detector', portId: 'detect' }, distanceMm: 12, autoPlace: true, pathLabel: 'measurement' },
  { id: 'reference-detector', from: { blockId: 'sequential-group:reference', portId: 'out' }, to: { blockId: 'detector-2', portId: 'detect' }, distanceMm: 18, autoPlace: true, pathLabel: 'reference' },
];
const multiGroupHybrid = buildHybridAssemblyFromConfiguration(multiGroupConfig);
assert.equal(multiGroupHybrid.blockSequences.length, 2, 'one Config can contain multiple exact sequential groups');
assert.deepEqual(multiGroupHybrid.blockSequences.map((sequence) => sequence.label), ['Measurement optics', 'Reference optics']);
assert.deepEqual(multiGroupHybrid.blockSequences[0].blocks.map((block) => block.blockId), ['object', 'lens', 'image']);
assert.deepEqual(multiGroupHybrid.blockSequences[1].blocks.map((block) => block.blockId), ['stop']);
assert.ok(multiGroupHybrid.components.some((entry) => entry.id === 'sequential-group:measurement'));
assert.ok(multiGroupHybrid.components.some((entry) => entry.id === 'sequential-group:reference'));
assert.equal(multiGroupHybrid.connections.length, 2, 'connections to both exact groups survive Config normalization');
const measurementOffset = getHybridDetectorPlaneOffset(multiGroupHybrid, 'detector');
const referenceOffset = getHybridDetectorPlaneOffset(multiGroupHybrid, 'detector-2');
assert.equal(measurementOffset.sequenceId, 'sequential:measurement');
assert.equal(referenceOffset.sequenceId, 'sequential:reference');
assert.ok(Math.abs(measurementOffset.defocusMm - 12) < 1e-9);
assert.ok(Math.abs(referenceOffset.defocusMm - 18) < 1e-9);
const request = buildNonSequentialTraceRequest(hybrid, 'preview');
const emittedAt = request.sources[0].transform.positionMm;
const sourceEndFace = worldPortPosition(component('source'), 'emit', 'from');
const sourceCentre = resolveComponentTransform(component('source')).positionMm;
assert.deepEqual(emittedAt, sourceEndFace, 'source rays start at the physical Emit end face');
assert.notDeepEqual(emittedAt, sourceCentre, 'source rays do not start inside the source body');
assert.ok(!request.surfaces.some((surface) => surface.interaction.kind === 'thin-lens'), 'exact sequential group is never converted to a thin lens');
const idealSplitterInteraction = request.surfaces.find((surface) => surface.interaction.kind === 'beam-splitter')?.interaction;
assert.ok(idealSplitterInteraction, 'Beam Splitter is present in the non-sequential request');
assert.equal(idealSplitterInteraction.beamSplitterModel, 'ideal', 'default Beam Splitter does not require a substrate index');
assert.ok(request.surfaces.some((surface) => surface.interaction.kind === 'detector'));
assert.equal(request.detectors.length, 2, 'all detectors are sent to one non-sequential trace');
assert.equal(request.surfaces.filter((surface) => surface.interaction.kind === 'detector').length, 2);

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

const combBlock = createDefaultPhysicalBlock('FrequencyCombSource', 'comb-at-sequential-input');
combBlock.parameters.positionXmm = 7;
const combHybrid = buildHybridAssemblyFromConfiguration({
  ...config,
  blocks: [...exactBlocks, combBlock],
  designConnections: [],
});
const combComponent = combHybrid.components.find((entry) => entry.id === combBlock.blockId);
const combSequential = combHybrid.components.find((entry) => entry.id === 'sequential-group:main');
const combEmit = worldPortPosition(combComponent, 'emit', 'from');
const sequentialInput = worldPortPosition(combSequential, 'in', 'to');
assert.ok(Math.abs(combEmit.x - sequentialInput.x - 7) < 1e-9, 'Comb manual X remains an offset from the sequential input');
assert.ok(Math.abs(combEmit.y - sequentialInput.y) < 1e-9, 'Comb Emit aligns vertically with the sequential input');
assert.ok(Math.abs(combEmit.z - sequentialInput.z) < 1e-9, 'Comb Emit end face starts at the exact sequential input plane');

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

const pupilGridMap = new Float64Array(81);
for (const index of [20, 22, 24, 38, 40, 42, 56, 58, 60]) pupilGridMap[index] = 1 / 9;
const collapsedPupilSignal = convolveDetectorPowerWithPsf({
  powerWPerPixel: pupilGridMap, width: 9, height: 9,
  detector: { ...detector, pixelCountX: 9, pixelCountY: 9, pixelPitchUm: 5, saturationElectrons: 1e30 },
  psfData: [[0, 1, 0], [1, 4, 1], [0, 1, 0]], psfPixelSizeUm: 5, wavelengthNm: 500,
  collapseInputToCentroid: true,
});
assert.ok(Math.abs(collapsedPupilSignal.integratedPowerW - 1) < 1e-12, 'collapsed sequential pupil grid conserves detector power');
assert.ok(Math.abs(collapsedPupilSignal.powerWPerPixel[40] - 0.5) < 1e-12, 'regular source-ray grid is replaced by one exact-lens PSF at its centroid');

const complexDelta = [{
  wavelengthUm: 0.5, weight: 1, psfData: [[1]], pixelSizeUm: 5,
  fieldReal: [[1]], fieldImag: [[0]],
}];
const cancelSignal = convolveDetectorFieldsWithCoherentPsf({
  spectralFields: [
    { pixelX: 1, pixelY: 1, coherenceGroupId: 'same', frequencyHz: 6e14, wavelengthNm: 500, fieldRe: 1, fieldIm: 0 },
    { pixelX: 1, pixelY: 1, coherenceGroupId: 'same', frequencyHz: 6e14, wavelengthNm: 500, fieldRe: -1, fieldIm: 0 },
  ],
  width: 3, height: 3, detector, spectralPsf: complexDelta,
});
assert.ok(cancelSignal, 'complex exact-lens propagation is available');
assert.ok(cancelSignal.signal.integratedPowerW < 1e-20, 'opposite fields in one coherent mode cancel before detection');
const incoherentSignal = convolveDetectorFieldsWithCoherentPsf({
  spectralFields: [
    { pixelX: 1, pixelY: 1, coherenceGroupId: 'left', frequencyHz: 6e14, wavelengthNm: 500, fieldRe: 1, fieldIm: 0 },
    { pixelX: 1, pixelY: 1, coherenceGroupId: 'right', frequencyHz: 6e14, wavelengthNm: 500, fieldRe: -1, fieldIm: 0 },
  ],
  width: 3, height: 3, detector, spectralPsf: complexDelta,
});
assert.ok(Math.abs(incoherentSignal.signal.integratedPowerW - 2) < 1e-12, 'different coherence groups add as intensity');
const collapsedComplexSignal = convolveDetectorFieldsWithCoherentPsf({
  spectralFields: [
    { pixelX: 0, pixelY: 1, coherenceGroupId: 'pupil', frequencyHz: 6e14, wavelengthNm: 500, fieldRe: 1, fieldIm: 0 },
    { pixelX: 2, pixelY: 1, coherenceGroupId: 'pupil', frequencyHz: 6e14, wavelengthNm: 500, fieldRe: 1, fieldIm: 0 },
  ],
  width: 3, height: 3, detector, spectralPsf: complexDelta,
  collapseSpatialSamplesPerMode: true,
});
assert.ok(collapsedComplexSignal, 'coherent pupil-grid collapse remains available');
assert.ok(Math.abs(collapsedComplexSignal.signal.integratedPowerW - 2) < 1e-12, 'coherent pupil-grid collapse conserves in-phase mode power');
assert.ok(Math.abs(collapsedComplexSignal.signal.powerWPerPixel[4] - 2) < 1e-12, 'coherent pupil samples form one centered exact-lens image');

const removedConnections = normalizeDesignConnections([sourceBlock, splitterBlock, detectorBlock], []);
assert.equal(removedConnections.length, 0, 'an explicitly empty connection list stays empty after Remove');
const autoConnections = normalizeDesignConnections([sourceBlock, splitterBlock, detectorBlock], undefined);
assert.equal(autoConnections.length, 2, 'legacy Configs without designConnections receive a single auto path');
assert.equal(autoConnections[0].from.portId, 'emit');
assert.equal(autoConnections[1].to.portId, 'detect');
const sequentialConnection = normalizeDesignConnections(
  [sourceBlock, detectorBlock],
  [{ id: 'through-lens', from: { blockId: 'source', portId: 'emit' }, to: { blockId: 'sequential-group:main', portId: 'in' }, distanceMm: 10, autoPlace: true, pathLabel: 'main' }],
  ['sequential-group:main'],
);
assert.equal(sequentialConnection.length, 1, 'connections to the exact sequential group survive normalization');

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
  detectorCount: hybrid.detectors.length,
  detector: {
    integratedPowerW: signal.integratedPowerW,
    peakElectrons: signal.maximumElectronsPerPixel,
    saturatedPixels: signal.saturatedPixelCount,
  },
  migratedPhysicalBlocks: migrated.blocks.length - exactBlocks.length,
}, null, 2));
