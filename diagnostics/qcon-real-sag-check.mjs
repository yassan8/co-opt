// Validate real SURF12/13 Qcon sag & slope across aperture (qconNrad=16, DIAM=16 → semi-ap 8).
// Run: node --experimental-strip-types diagnostics/qcon-real-sag-check.mjs
import { evaluateQconSagDeviation, evaluateQconSagDerivative, evaluateConicBaseSagDerivative } from '../optical/qcon-basis.ts';

const S12 = {
  label: 'SURF12 r=-19.78',
  params: { radius: -19.780070723, conic: 0, qconNrad: 16 },
  coefs: [1.04543217, 1.80472429, 0.339289379, -0.245947139, -0.32030333, -0.150543431, -0.0394380297, 0, 0, 0],
};
const S13 = {
  label: 'SURF13 r=-55.35',
  params: { radius: -55.354275094, conic: 0, qconNrad: 16 },
  coefs: [1.98950194, 0.672366625, 0.194094848, 0.113035204, 0.0288526524, 0.00855756778, -0.00173184141, 0, 0, 0],
};

for (const s of [S12, S13]) {
  console.log(`\n=== ${s.label} (qconNrad=${s.params.qconNrad}) ===`);
  console.log('   r      sagDev      qconSlope    baseSlope    totalSlope');
  for (const r of [0, 1, 2, 4, 6, 8, 10, 12, 14, 16]) {
    const sag = evaluateQconSagDeviation(r, s.params, s.coefs);
    const qs = evaluateQconSagDerivative(r, s.params, s.coefs);
    const bs = evaluateConicBaseSagDerivative(r, s.params);
    const ts = (Number.isFinite(bs) ? bs : NaN) + qs;
    console.log(`  ${String(r).padStart(3)}  ${sag.toExponential(4).padStart(12)}  ${qs.toExponential(4).padStart(12)}  ${(Number.isFinite(bs)?bs.toExponential(4):'   NaN').padStart(12)}  ${ts.toExponential(4).padStart(12)}`);
  }
}
