import assert from 'node:assert/strict';
import {
  buildDetectorDisplayRaster,
  calculateDetectorSignalFromPowerMap,
  reconstructSampledDetectorIrradiance,
} from '../analysis/detector-signal.ts';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';

const sparsePower = new Float64Array(32 * 32);
sparsePower[2 * 32 + 3] = 0.25;
sparsePower[27 * 32 + 29] = 0.75;
const reconstructedPower = reconstructSampledDetectorIrradiance({
  powerWPerPixel: sparsePower,
  width: 32,
  height: 32,
  sampleCount: 2,
});
const reconstructedTotal = reconstructedPower.reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(reconstructedTotal - 1) < 1e-12, 'sampled irradiance reconstruction preserves detector power');
assert.ok(
  reconstructedPower.reduce((count, value) => count + Number(value > 0), 0) > 2,
  'sampled irradiance reconstruction fills the finite footprint around sparse ray hits',
);

const fixture = await readOptionalExampleFixtureOrExit('JPA_2026126953_Figure2_fiber_NA0p1.json');
const config = structuredClone(fixture.configurations.configurations[0]);
const detectorBlock = config.blocks.find((block) => block.blockId === 'AreaDetector-80');
assert.ok(detectorBlock, 'Figure 2 Area Detector is present');

const reports = [];
for (const routeIds of [
  ['route-sc-measurement'],
  ['route-sc-reference'],
  ['route-sc-measurement', 'route-sc-reference'],
]) {
  const result = await runPortRoutedTrace(config, {
    routeIds,
    spatialSamples: 81,
    spectralSamples: 3,
    renderRayLimit: 0,
  });
  const detector = result.detectors.find((entry) => entry.detectorId === 'AreaDetector-80');
  const routeReceivedPowerW = result.routeMetrics.reduce((sum, route) => sum + route.receivedPowerW, 0);
  const nonzeroPixels = detector
    ? detector.intensityW.reduce((count, value) => count + Number(value > 0), 0)
    : 0;
  const converted = detector
    ? calculateDetectorSignalFromPowerMap({
      powerWPerPixel: detector.intensityW,
      width: detector.width,
      height: detector.height,
      detector: detectorBlock.parameters,
      wavelengthNm: 650,
      inputPowerW: routeReceivedPowerW,
    })
    : null;
  const display = converted
    ? buildDetectorDisplayRaster(converted.aduPerPixel, converted.width, converted.height)
    : null;
  reports.push({
    routeIds,
    metrics: result.routeMetrics,
    detector: detector && {
      hitCount: detector.hitCount,
      totalPowerW: detector.totalPowerW,
      nonzeroPixels,
      maximumWPerPixel: detector.intensityW.reduce((maximum, value) => Math.max(maximum, value), 0),
    },
    converted: converted && {
      integratedPowerW: converted.integratedPowerW,
      maximumPowerWPerPixel: converted.maximumPowerWPerPixel,
      maximumElectronsPerPixel: converted.maximumElectronsPerPixel,
      maximumAdu: converted.aduPerPixel.reduce((maximum, value) => Math.max(maximum, value), 0),
      nonzeroPowerPixels: converted.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0),
      nonzeroElectronPixels: converted.electronsPerPixel.reduce((count, value) => count + Number(value > 0), 0),
      nonzeroAduPixels: converted.aduPerPixel.reduce((count, value) => count + Number(value > 0), 0),
    },
    display: display && {
      width: display.width,
      height: display.height,
      maximum: display.maximum,
      nonzeroPixels: display.values.reduce((count, value) => count + Number(value > 0), 0),
      downsampled: display.downsampled,
    },
  });
}

const referenceReport = reports.find((report) => report.routeIds.length === 1 && report.routeIds[0] === 'route-sc-reference');
assert.ok(referenceReport?.detector?.hitCount > 0, 'reference route reaches the detector');
assert.ok(referenceReport?.converted?.nonzeroAduPixels > 0, 'received power produces visible detector ADU values');
assert.equal(referenceReport?.display?.width, 512, 'large Detector is reduced to a display-sized raster');
assert.ok(referenceReport?.display?.nonzeroPixels > 0, 'peak-preserving display reduction keeps isolated Detector hits visible');

console.log(JSON.stringify(reports, null, 2));
