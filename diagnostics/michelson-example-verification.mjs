import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { compileOpticalSystem } from '../analysis/optical-system-compiler.ts';
import { convolveDetectorFieldsWithCoherentPsf } from '../analysis/detector-signal.ts';

// Same WASM OPD/complex PSF and Camera conversion used by Coherent Signal.
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api);
(await import('../core/wasm-service.ts')).setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
globalThis.self = new EventTarget();
globalThis.addEventListener = self.addEventListener.bind(self);
globalThis.removeEventListener = self.removeEventListener.bind(self);
globalThis.dispatchEvent = self.dispatchEvent.bind(self);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };
const { runNativeOpdMap, runNativePsfMap } = await import('../src/desktop/ipc/client.ts');
// Execute the real popup boundary, not just its underlying IPC function.
const eventHandlers = fs.readFileSync(new URL('../ui/event-handlers.ts', import.meta.url), 'utf8');
const start = eventHandlers.indexOf('async function runDesktopNativePsfMapForPopup(');
const end = eventHandlers.indexOf('w.runDesktopNativePsfMapForPopup =', start);
assert.ok(start >= 0 && end > start);
const wrapperSource = transformSync(eventHandlers.slice(start, end), { loader: 'ts', format: 'cjs' }).code;
let popupRequests = 0;
const popupPsf = new Function('runNativePsfMap', 'listen', 'logNativeReferenceModeForPopup',
  wrapperSource + '\nreturn runDesktopNativePsfMapForPopup;')(
  request => { assert.equal(request.includeComplexField, true, 'Popup dropped complex-field request'); popupRequests++; return runNativePsfMap(request); },
  async () => () => {}, () => {},
);
const { calculateImageSpaceDiffractionParams } = await import('../raytracing/core/ray-paraxial.ts');
const { calculatePsfImagePixelSizeUm } = await import('../src/app/psf-scale-model.ts');
const doc = JSON.parse(fs.readFileSync(new URL('../Examples/Michelson_Interferometer.json', import.meta.url), 'utf8'));
const print = console.log;
console.log = () => {};
const reports = [];
try {
  for (const config of doc.configurations.configurations) {
    if (process.env.MICHELSON_CONFIG && config.id !== Number(process.env.MICHELSON_CONFIG)) continue;
    const compiled = compileOpticalSystem(config, { pupilSampling: 64 });
    assert.ok(compiled.canRun, JSON.stringify(compiled.issues));
    assert.equal(compiled.paths.length, 2);
    const planes = [];
    const pupils = [];
    for (const row of config.source) {
      const wavelengthUm = row.wavelength;
      const opd = await runNativeOpdMap({ opticalSystemRows: config.opticalSystem, sourceRows: config.source, objectRows: config.object, objectIndex: 0, surfaceIndex: config.opticalSystem.length - 1, gridSize: 64, wavelengthUm, opdWaveNormalization: 'trace', pupilSamplingMode: 'entrance', chiefRayMode: 'stop-center', pupilNormalizationMode: 'fixed-entrance-pupil', exitPupilReferencePointMode: 'chief-ray-intersection', referenceMode: 'exit-pupil', opdDisplayMode: 'raw' });
      const mask = opd.rawOpdGrid.map(r => r.map(v => v != null && Number.isFinite(v)));
      const count = mask.flat().filter(Boolean).length;
      assert.ok(count > 0, `No valid pupil at ${wavelengthUm} um`);
      const diffraction = calculateImageSpaceDiffractionParams(config.opticalSystem, wavelengthUm);
      assert.ok(diffraction.fNumberWorking > 0);
      const pixelSizeUm = calculatePsfImagePixelSizeUm(wavelengthUm, diffraction.fNumberWorking, 64, 128);
      const psf = await popupPsf({ gridOpd: opd.rawOpdGrid.map(r => r.map(v => (v ?? 0) * wavelengthUm)), gridAmplitude: mask.map(r => r.map(v => v ? 1 : 0)), pupilMask: mask, wavelengthUm, pixelSizeUm, removeTilt: false, zeroPadTo: 128, recenterIfWrapped: false, includeComplexField: true, suppressProgressHud: true });
      assert.ok(psf.fieldReal?.length && psf.fieldImag?.length, 'Complex PSF unavailable');
      planes.push({ wavelengthUm, weight: 1, psfData: psf.psfData, fieldReal: psf.fieldReal, fieldImag: psf.fieldImag, pixelSizeUm });
      pupils.push({ wavelengthUm, validSamples: count, pixelSizeUm });
      if (process.env.MICHELSON_IMAGE_DATA) {
        fs.mkdirSync(process.env.MICHELSON_IMAGE_DATA, { recursive: true });
        fs.writeFileSync(`${process.env.MICHELSON_IMAGE_DATA}/psf-${config.id}-${wavelengthUm}.json`, JSON.stringify({ psf, opd, pixelSizeUm }));
      }
    }
    const traceOptions = { samplePurpose: 'detector', spectralFieldsOnly: true, renderRayLimit: 0 };
    const result = await runPortRoutedTrace(config, traceOptions);
    assert.ok(result.routeMetrics.every(r => r.valid && r.reachedRays === r.launchedRays), JSON.stringify(result.routeMetrics));
    const d = result.detectors[0];
    const detector = config.blocks.find(b => b.blockType === 'AreaDetector').parameters;
    const convert = (fields) => convolveDetectorFieldsWithCoherentPsf({ spectralFields: fields, width: d.width, height: d.height, detector, spectralPsf: [], inputPlane: 'detector' });
    const coherent = convert(d.spectralFields);
    if (process.env.MICHELSON_IMAGE_DATA) {
      const delta = convolveDetectorFieldsWithCoherentPsf({ spectralFields: d.spectralFields, width: d.width, height: d.height, detector,
        spectralPsf: [{ wavelengthUm: config.source[0].wavelength, weight: 1, psfData: [[1]], fieldReal: [[1]], fieldImag: [[0]], pixelSizeUm: detector.pixelPitchUm }] });
      fs.writeFileSync(`${process.env.MICHELSON_IMAGE_DATA}/no-psf-${config.id}.json`, JSON.stringify({ width: d.width, height: d.height, pixelPitchUm: detector.pixelPitchUm, powerWPerPixel: Array.from(delta.signal.powerWPerPixel) }));
    }
    assert.ok(coherent?.interferingModeCount > 0, 'No interfering modes');
    assert.ok(!coherent.warning.includes('intensity only'), 'Phase must not silently become zero');
    assert.ok(!coherent.warning.includes('without continuous interpolation'), 'Michelson wavefront reconstruction failed');
    const power = coherent.signal.powerWPerPixel;
    assert.ok(power.every(v => Number.isFinite(v) && v >= 0));
    if (process.env.MICHELSON_IMAGE_DATA) {
      fs.mkdirSync(process.env.MICHELSON_IMAGE_DATA, { recursive: true });
      fs.writeFileSync(`${process.env.MICHELSON_IMAGE_DATA}/config-${config.id}.json`, JSON.stringify({
        width: d.width, height: d.height, pixelPitchUm: detector.pixelPitchUm,
        powerWPerPixel: Array.from(power), title: config.name,
      }));
    }
    const isolated = ['measurement', 'reference'].map(id => convert(d.spectralFields.filter(f => f.routeId === id)).signal.powerWPerPixel);
    let crossPower = 0, incoherentPower = 0, energy = 0;
    for (let i = 0; i < power.length; i++) {
      const sum = isolated[0][i] + isolated[1][i];
      crossPower += Math.abs(power[i] - sum);
      incoherentPower += sum;
      energy += power[i];
    }
    assert.ok(crossPower / incoherentPower > 0.005, 'Camera intensity has no interference contribution');
    // Measure the interior DC coverage, not the fringe minima themselves.
    let interiorPixels = 0, missingPixels = 0;
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
      if (Math.hypot(x - (d.width - 1) / 2, y - (d.height - 1) / 2) > 35) continue;
      interiorPixels++;
      if (isolated[0][y * d.width + x] + isolated[1][y * d.width + x] <= 0) missingPixels++;
    }
    assert.equal(missingPixels, 0, 'Spiral or missing Camera samples');
    let rayCountImageDifference = null;
    let straightFringeRms = null;
    let phaseStepImageChange = null;
    if (config.id === 1) {
      // An ideal unit-magnification Michelson relay with mirror tilt theta
      // produces a planar relative carrier 2*pi*sin(2*theta)/lambda.
      // Remove each arm's measured envelope, then fit only the global phase.
      const theta = config.blocks.find(b => b.blockId === 'measurement-mirror').parameters.rotationXdeg * Math.PI / 180;
      const carrier = 2 * Math.PI * Math.sin(2 * theta) / (config.source[0].wavelength * 1e-3) * detector.pixelPitchUm * 1e-3;
      const fit = [];
      let cc = 0, ss = 0, cs = 0, vc = 0, vs = 0;
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        if (Math.hypot(x - 63.5, y - 63.5) > 35) continue;
        const i = y * d.width + x;
        const a = isolated[0][i], b = isolated[1][i];
        const v = (power[i] - a - b) / (2 * Math.sqrt(a * b));
        const c = Math.cos(carrier * (y - 63.5)), s = Math.sin(carrier * (y - 63.5));
        cc += c*c; ss += s*s; cs += c*s; vc += v*c; vs += v*s;
        fit.push({ v, c, s });
      }
      const determinant = cc * ss - cs * cs;
      const cosine = (vc * ss - vs * cs) / determinant, sine = (vs * cc - vc * cs) / determinant;
      straightFringeRms = Math.sqrt(fit.reduce((sum, {v,c,s}) => sum + (v - cosine*c - sine*s)**2, 0) / fit.length);
      assert.ok(straightFringeRms < 0.02, `Non-physical grid or spiral in the actual Camera: ${straightFringeRms}`);
      assert.ok(Math.abs(Math.hypot(cosine, sine) - 1) < 0.02, 'Incorrect fringe contrast');
      const denser = await runPortRoutedTrace(config, { ...traceOptions, spatialSamples: 8192 });
      const densePower = convert(denser.detectors[0].spectralFields).signal.powerWPerPixel;
      rayCountImageDifference = power.reduce((s, p, i) => s + Math.abs(p - densePower[i]), 0) / energy;
      assert.ok(rayCountImageDifference < 0.1, 'Doubling rays must not generate a different interference pattern');
      const phaseStepped = structuredClone(config);
      const wavelengthMm = config.source[0].wavelength * 1e-3;
      phaseStepped.blocks.find(b => b.blockId === 'measurement-mirror').parameters.positionZmm += wavelengthMm / 4;
      const shiftedTrace = await runPortRoutedTrace(phaseStepped, traceOptions);
      const shiftedPower = convert(shiftedTrace.detectors[0].spectralFields).signal.powerWPerPixel;
      phaseStepImageChange = power.reduce((s, p, i) => s + Math.abs(p - shiftedPower[i]), 0) / energy;
      assert.ok(phaseStepImageChange > 0.1, 'A half-wave OPD step must change the Camera interference image');
    }
    // Untilting equal arms should cancel OPL; move M1 by 1 um -> OPD +2 um.
    const flat = structuredClone(config);
    const mirror = flat.blocks.find(b => b.blockId === 'measurement-mirror');
    mirror.parameters.rotationXdeg = 0;
    const chiefOptions = { spatialSamples: 1, spectralSamples: 1, spectralFieldsOnly: true, renderRayLimit: 0 };
    const a = await runPortRoutedTrace(flat, chiefOptions);
    const nominalOpd = a.routeMetrics[0].oplMm - a.routeMetrics[1].oplMm;
    assert.ok(Math.abs(nominalOpd) < 1e-8);
    mirror.parameters.positionZmm += 0.001;
    const b = await runPortRoutedTrace(flat, chiefOptions);
    const deltaOpd = b.routeMetrics[0].oplMm - b.routeMetrics[1].oplMm - nominalOpd;
    assert.ok(Math.abs(deltaOpd - 0.002) < 1e-8);
    reports.push({ config: config.id, pupils, routes: result.routeMetrics.map(r => ({ route: r.routeId, launched: r.launchedRays, reached: r.reachedRays })), interferingModes: coherent.interferingModeCount, integratedPowerW: energy, interferenceFraction: crossPower / incoherentPower, interiorPixels, missingPixels, saturatedPixels: coherent.signal.saturatedPixelCount, straightFringeRms, rayCountImageDifference, phaseStepImageChange, equalArmOpdMm: nominalOpd, opdChangeFor1umMirrorShiftUm: deltaOpd * 1000 });
  }
} finally { console.log = print; }
print(JSON.stringify({ ok: true, popupRequests, reports }, null, 2));
