import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
const { runNativeSphericalAberration } = await import('../src/desktop/ipc/client.ts');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const input = JSON.parse(fs.readFileSync(new URL('../Examples/default-load.json', import.meta.url), 'utf8'));
const configurations = input.configurations.configurations;
const summaries = [];
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};

for (const configuration of configurations) {
  const result = await runNativeSphericalAberration({
    opticalSystemRows: configuration.opticalSystem,
    sourceRows: input.source,
    objectRows: configuration.object,
    rayCount: 51,
    wavelengthMode: 'all',
    referenceFocusMode: 'current-paraxial',
  });

  for (const axis of ['meridionalData', 'sagittalData']) {
    for (const series of result[axis] || []) {
      const points = [...(series.points || [])]
        .filter((point) => Number.isFinite(point.pupilCoordinate) && Number.isFinite(point.longitudinalAberration))
        .sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
      const jumps = [];
      for (let index = 1; index < points.length; index += 1) {
        jumps.push({
          index,
          dp: points[index].pupilCoordinate - points[index - 1].pupilCoordinate,
          dx: points[index].longitudinalAberration - points[index - 1].longitudinalAberration,
        });
      }
      jumps.sort((a, b) => Math.abs(b.dx) - Math.abs(a.dx));
      const largest = jumps[0] || { index: 0, dp: 0, dx: 0 };
      const start = Math.max(0, largest.index - 2);
      const end = Math.min(points.length, largest.index + 3);
      summaries.push({
        configuration: configuration.name,
        axis,
        wavelength: series.wavelength,
        pointCount: points.length,
        pupilMin: points[0]?.pupilCoordinate ?? null,
        pupilMax: points.at(-1)?.pupilCoordinate ?? null,
        largestJump: largest,
        neighborhood: points.slice(start, end).map((point) => ({
          pupil: point.pupilCoordinate,
          aberration: point.longitudinalAberration,
        })),
      });
      assert.ok(
        Math.abs(largest.dx) < 0.15,
        `${configuration.name} ${axis} ${series.wavelength}: discontinuous jump ${largest.dx} mm`,
      );
    }
  }
}

console.log = originalLog;
console.warn = originalWarn;
originalLog(JSON.stringify({ ok: true, summaries }, null, 2));
