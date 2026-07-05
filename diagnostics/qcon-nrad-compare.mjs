// Compare qconNrad = 16 (importer halves XDAT2) vs 32 (XDAT2 as-is) for real SURF12/13.
// DIAM in .zmx = 16 (semi-aperture). So rays reach r up to ~16.
// Run: node --experimental-strip-types diagnostics/qcon-nrad-compare.mjs
import { evaluateQconSagDeviation, evaluateQconSagDerivative } from '../optical/qcon-basis.ts';

const surfs = [
  { label: 'SURF12', radius: -19.780070723, coefs: [1.04543217,1.80472429,0.339289379,-0.245947139,-0.32030333,-0.150543431,-0.0394380297,0,0,0] },
  { label: 'SURF13', radius: -55.354275094, coefs: [1.98950194,0.672366625,0.194094848,0.113035204,0.0288526524,0.00855756778,-0.00173184141,0,0,0] },
];

for (const s of surfs) {
  console.log(`\n=== ${s.label} : sag deviation & qcon-slope at semi-aperture edge (r=8, r=16) ===`);
  for (const nrad of [16, 32]) {
    const p = { radius: s.radius, conic: 0, qconNrad: nrad };
    const row = [8, 16].map(r => {
      const sag = evaluateQconSagDeviation(r, p, s.coefs);
      const slope = evaluateQconSagDerivative(r, p, s.coefs);
      return `r=${r}: sag=${sag.toExponential(3)} slope=${slope.toExponential(3)}`;
    });
    console.log(`  qconNrad=${String(nrad).padStart(2)}  |  ${row.join('   |   ')}`);
  }
}
