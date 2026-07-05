// Scan ImageHeight solver output for the real 3G source.
// Run: node --experimental-strip-types diagnostics/imageheight-solver-scan.mjs
import fs from 'node:fs';
import { parseZMXTextToOpticalSystemRows } from '../import-export/zemax-import.ts';
import { convertImageHeightToEffectiveObject } from '../optical/ray-renderer.ts';

const zmx = fs.readFileSync('diagnostics/3g_images_source.zmx', 'utf8');
const parsed = parseZMXTextToOpticalSystemRows(zmx);
const rows = parsed.rows;
const objects = parsed.objectRows;
const wavelength = parsed.sourceRows.find(r => String(r.primary || '').includes('Primary'))?.wavelength ?? 0.5876;

console.log('idx,targetY,solvedYdeg,mode,solver,residual,hitY,chiefDirY,chiefDirZ');
for (let i = 0; i < objects.length; i += 1) {
  const obj = objects[i];
  try {
    const effective = convertImageHeightToEffectiveObject(obj, rows, wavelength, 'infinite', {
      skipTsValidation: true,
      validationTraceBackend: 'rust',
      disableSolveCache: true,
      disableWarmStartCache: true,
    });
    const solve = effective?.__cooptImageHeightSolve || {};
    const targetY = Number(obj.yHeightAngle);
    const solvedY = Number(effective?.yHeightAngle);
    const hitY = Number(solve?.hit?.y);
    const residual = Number.isFinite(hitY) ? hitY - targetY : NaN;
    const dirY = Number(solve?.chiefRay?.dir?.y);
    const dirZ = Number(solve?.chiefRay?.dir?.z);
    console.log([
      i + 1,
      targetY.toFixed(6),
      Number.isFinite(solvedY) ? solvedY.toFixed(9) : 'NaN',
      solve.mode || '',
      solve.solver || '',
      Number.isFinite(residual) ? residual.toExponential(6) : 'NaN',
      Number.isFinite(hitY) ? hitY.toFixed(9) : 'NaN',
      Number.isFinite(dirY) ? dirY.toExponential(6) : 'NaN',
      Number.isFinite(dirZ) ? dirZ.toExponential(6) : 'NaN',
    ].join(','));
  } catch (error) {
    console.log(`${i + 1},${obj.yHeightAngle},ERROR,${String(error?.message || error)}`);
  }
}
