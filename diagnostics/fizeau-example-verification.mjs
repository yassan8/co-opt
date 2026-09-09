import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileOpticalSystem } from '../analysis/optical-system-compiler.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { convolveDetectorFieldsWithCoherentPsf } from '../analysis/detector-signal.ts';

const { preloadRustRayTracingWasm } = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await preloadRustRayTracingWasm();
assert.ok(api);
(await import('../core/wasm-service.ts')).setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
const document = JSON.parse(fs.readFileSync(new URL('../Examples/Fizeau_Interferometer.json', import.meta.url), 'utf8'));
const traceOptions = { samplePurpose: 'detector', spectralFieldsOnly: true, renderRayLimit: 0 };
const print = console.log;
console.log = () => {};
const report = [];
try {
  for (const config of document.configurations.configurations) {
    const compiled = compileOpticalSystem(config, { pupilSampling: 32 });
    assert.ok(compiled.canRun, JSON.stringify(compiled.issues));
    const trace = await runPortRoutedTrace(config, traceOptions);
    assert.ok(trace.routeMetrics.every(r => r.valid && r.launchedRays === r.reachedRays), JSON.stringify(trace.routeMetrics));
    const detector = trace.detectors[0];
    const spec = config.blocks.find(b => b.blockType === 'AreaDetector').parameters;
    const convert = spectralFields => convolveDetectorFieldsWithCoherentPsf({ spectralFields, detector: spec, width: detector.width, height: detector.height, spectralPsf: [], inputPlane: 'detector' });
    const combined = convert(detector.spectralFields);
    assert.equal(combined.interferingModeCount, 1);
    assert.equal(combined.warning, '', 'Wavefront must be resolved, not sparse ray splats');
    const arms = ['measurement', 'reference'].map(id => convert(detector.spectralFields.filter(f => f.routeId === id)).signal);
    assert.ok(Math.abs(arms[0].integratedPowerW / 9.216e-7 - 1) < 1e-9);
    assert.ok(Math.abs(arms[1].integratedPowerW / 1e-6 - 1) < 1e-9);
    assert.equal(combined.signal.saturatedPixelCount, 0);
    const intensity = combined.signal.powerWPerPixel;
    const contrast = [];
    for (let y = 0; y < detector.height; y++) for (let x = 0; x < detector.width; x++) {
      if (Math.hypot(x - 63.5, y - 63.5) > 35) continue;
      const i = y * detector.width + x;
      const a = arms[0].powerWPerPixel[i], b = arms[1].powerWPerPixel[i];
      assert.ok(a > 0 && b > 0, 'Both returns must cover the Camera interior');
      contrast.push({ x, y, value: (intensity[i] - a - b) / (2 * Math.sqrt(a * b)) });
    }
    let fringeRms = null, pistonComplementError = null;
    if (config.id === 1) {
      const theta = config.blocks.find(b => b.blockId === 'measurement-mirror').parameters.rotationXdeg * Math.PI / 180;
      const carrier = 2 * Math.PI * Math.sin(2 * theta) / 0.0006328 * spec.pixelPitchUm * 1e-3;
      let cc = 0, ss = 0, cs = 0, vc = 0, vs = 0;
      for (const p of contrast) {
        const c = Math.cos(carrier * (p.y - 63.5)), s = Math.sin(carrier * (p.y - 63.5));
        cc += c*c; ss += s*s; cs += c*s; vc += p.value*c; vs += p.value*s;
      }
      const determinant = cc * ss - cs * cs;
      const c = (vc * ss - vs * cs) / determinant, s = (vs * cc - vc * cs) / determinant;
      fringeRms = Math.sqrt(contrast.reduce((sum, p) => sum + (p.value - c * Math.cos(carrier * (p.y - 63.5)) - s * Math.sin(carrier * (p.y - 63.5)))**2, 0) / contrast.length);
      assert.ok(fringeRms < 0.02, `Incorrect straight fringes: ${fringeRms}`);
      assert.ok(Math.abs(Math.hypot(c, s) - 1) < 0.02);
    } else {
      assert.ok(Math.max(...contrast.map(p => p.value)) - Math.min(...contrast.map(p => p.value)) < 1e-5, 'Parallel collimated flats must not create rings');
      const phaseStepped = structuredClone(config);
      phaseStepped.blocks.find(b => b.blockId === 'measurement-mirror').parameters.positionZmm += 0.0001582;
      const steppedTrace = await runPortRoutedTrace(phaseStepped, traceOptions);
      const stepped = convert(steppedTrace.detectors[0].spectralFields).signal;
      let error = 0, dcPower = 0;
      for (let i = 0; i < intensity.length; i++) {
        const dc = arms[0].powerWPerPixel[i] + arms[1].powerWPerPixel[i];
        error += Math.abs(intensity[i] + stepped.powerWPerPixel[i] - 2 * dc);
        dcPower += 2 * dc;
      }
      pistonComplementError = error / dcPower;
      assert.ok(pistonComplementError < 1e-5, 'A lambda/4 test displacement must reverse the measured interference term');
    }
    const flat = structuredClone(config);
    const test = flat.blocks.find(b => b.blockId === 'measurement-mirror');
    test.parameters.rotationXdeg = 0;
    const chiefOptions = { ...traceOptions, spatialSamples: 1 };
    const nominal = await runPortRoutedTrace(flat, chiefOptions);
    const opd = r => r.routeMetrics.find(m => m.routeId === 'measurement').oplMm - r.routeMetrics.find(m => m.routeId === 'reference').oplMm;
    assert.ok(Math.abs(opd(nominal) - 40) < 1e-8, 'Only the 20 mm air cavity is differential');
    test.parameters.positionZmm += 0.001;
    const shifted = await runPortRoutedTrace(flat, chiefOptions);
    assert.ok(Math.abs(opd(shifted) - opd(nominal) - 0.002) < 1e-8, '1 um test displacement must give 2 um OPD');
    const sharedGlass = structuredClone(config);
    sharedGlass.blocks.find(b => b.blockId === 'measurement-mirror').parameters.rotationXdeg = 0;
    // Use an explicit custom index to avoid relying on a catalog spelling.
    Object.assign(sharedGlass.blocks.find(b => b.blockId === 'reference-flat').parameters, { substrateMaterial: '', substrateIndexNd: 1.8, substrateAbbeNumber: 0 });
    const otherGlass = await runPortRoutedTrace(sharedGlass, chiefOptions);
    assert.ok(Math.abs(opd(otherGlass) - opd(nominal)) < 1e-8, 'Shared reference-plate OPL must cancel');
    report.push({ config: config.name, routes: trace.routeMetrics.map(r => ({ id: r.routeId, launched: r.launchedRays, reached: r.reachedRays })), powerW: combined.signal.integratedPowerW, singleArmPowerW: arms.map(a => a.integratedPowerW), interiorPixels: contrast.length, fringeRms, pistonComplementError, nominalOpdMm: opd(nominal), deltaOpdUm: (opd(shifted) - opd(nominal))*1000, saturatedPixels: combined.signal.saturatedPixelCount });
  }
} finally { console.log = print; }
print(JSON.stringify({ ok: true, report }, null, 2));
