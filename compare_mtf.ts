globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {}, createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }), body: { appendChild: () => {} } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

import { runNativeFieldMtfMap } from './src/desktop/ipc/client.ts';
import { calculateMtfAsync } from './evaluation/pop-ups/mtf.ts';

const opticalSystemRows = [
  { 'object type': 'Object', thickness: 'INF' },
  { 'object type': 'Stop', surfType: 'Standard', radius: 'INF', thickness: 0, semidia: 10, aperture: 10 },
  { _blockType: 'Paraxial', _surfaceRole: 'front', 'object type': 'Standard', surfType: 'Standard', radius: 'INF', thickness: 0, semidia: 25, _thinLensFocalLengthX: 50, _thinLensFocalLengthY: 50 },
  { _blockType: 'Paraxial', _surfaceRole: 'back', 'object type': 'Standard', surfType: 'Standard', radius: 'INF', thickness: 50, semidia: 25, _thinLensFocalLengthX: 50, _thinLensFocalLengthY: 50 },
  { 'object type': 'Image', surfType: 'Standard', radius: 'INF', thickness: 0, semidia: 25 }
];
const sourceRows = [{ wavelength: 0.5876, primary: true }];
const objectRows = [{ position: 'Angle', fieldType: 'Angle', xHeightAngle: 0, yHeightAngle: 0, x: 0, y: 0, displayName: 'on-axis', objectIndex: 0 }];

async function run() {
  try {
    const fieldResp = await runNativeFieldMtfMap({
      opticalSystemRows,
      sourceRows,
      objectRows,
      objectIndex: 0,
      wavelengths: [0.5876],
      firstFrequencyLpmm: 10,
      secondFrequencyLpmm: 30,
      fieldMin: 0,
      fieldMax: 0,
      steps: 1,
      samplingSize: 128,
      zeroPadTo: 0,
      opdDisplayMode: 'pistonTiltRemoved',
      fieldAxisMode: 'angle',
    });

    const onAxisResp = await calculateMtfAsync(
        opticalSystemRows,
        0,
        [0.5876],
        128,
        0,
        'pistonTiltRemoved',
        { requireRustWasm: false }
    );

    const fs = fieldResp.series?.[0] || {};
    const os = onAxisResp?.[0] || {};

    console.log(JSON.stringify({
      fieldMtf: {
        backend: fieldResp.backend,
        m1: fs.meridionalFirst?.[0], 
        s1: fs.sagittalFirst?.[0],
        diag0: fs.fieldDiagnostics?.[0]
      },
      onAxisMtf: {
        mtf10: os.mtfData?.find(d => Math.abs(d.frequencyLpmm - 10) < 0.1)?.meridionalMtf,
        mtf30: os.mtfData?.find(d => Math.abs(d.frequencyLpmm - 30) < 0.1)?.meridionalMtf,
        diffLimit10: os.diffractionLimitMtfData?.find(d => Math.abs(d.frequencyLpmm - 10) < 0.1)?.meridionalMtf,
        diffLimit30: os.diffractionLimitMtfData?.find(d => Math.abs(d.frequencyLpmm - 30) < 0.1)?.meridionalMtf
      }
    }, null, 2));
  } catch (e) {
    console.log('Error:', e.message);
  }
}

run();
