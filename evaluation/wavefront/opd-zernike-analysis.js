/**
 * OPD Zernike Analysis Integration
 * 
 * Adds Zernike polynomial fitting to OPD calculation results
 * Displays wavefront aberration in terms of Zernike coefficients
 */

import { OpticalPathDifferenceCalculator } from './wavefront.js';
import { 
  fitZernikeWeighted, 
  reconstructOPD, 
  getZernikeName,
  jToNM 
} from './zernike-fitting.js';
import { getOpticalSystemRows } from '../../utils/data-utils.js';

/**
 * Calculate OPD grid with Zernike fitting
 * 
 * @param {Object} options - Calculation options
 * @param {number} options.gridSize - Grid resolution (e.g., 64)
 * @param {Object} options.fieldSetting - Field angle {fieldAngle: {x, y}}
 * @param {number} options.wavelength - Wavelength in micrometers
 * @param {number} options.maxZernikeOrder - Maximum Zernike radial order
 * @param {number} options.vignetteThreshold - Weight threshold for vignetting (0-1)
 * @returns {Object} OPD data with Zernike coefficients
 */
export async function calculateOPDWithZernike(options = {}) {
  const {
    gridSize = 64,
    fieldSetting = { fieldAngle: { x: 0, y: 0 } },
    wavelength = 0.5876,
    maxZernikeOrder = 6,
    vignetteThreshold = 0.5
  } = options;
  
  const opticalSystemRows = getOpticalSystemRows();
  const calc = new OpticalPathDifferenceCalculator(opticalSystemRows, wavelength);
  
  // Set reference ray
  calc.setReferenceRay(fieldSetting);
  
  // Generate pupil grid
  const points = [];
  const opdData = [];
  
  for (let j = 0; j < gridSize; j++) {
    const v = -1 + (2 * j) / (gridSize - 1);
    for (let i = 0; i < gridSize; i++) {
      const u = -1 + (2 * i) / (gridSize - 1);
      const rho = Math.sqrt(u * u + v * v);
      
      if (rho <= 1.0) {
        const opd = calc.calculateOPD(u, v, fieldSetting);
        
        // Vignetting detection: if OPD is NaN or invalid, assign zero weight
        let weight = 1.0;
        if (!Number.isFinite(opd)) {
          weight = 0;
        }
        
        points.push({
          x: u,
          y: v,
          opd: Number.isFinite(opd) ? opd : 0,
          weight: weight
        });
        
        opdData.push({
          u, v, 
          opd: Number.isFinite(opd) ? opd : null,
          vignetted: weight < vignetteThreshold
        });
      }
    }
  }
  
  // Fit Zernike polynomials
  console.log(`🔬 Fitting Zernike polynomials (order ${maxZernikeOrder})...`);
  const fitResult = fitZernikeWeighted(points, maxZernikeOrder, {
    epsilon: 0, // No central obscuration (use 0.3 for annular pupil)
    removePiston: true,
    removeTilt: true
  });
  
  console.log(`✅ Zernike fit complete: ${fitResult.numPoints} points, RMS=${(fitResult.rms * 1000).toFixed(3)} nm`);
  
  // Reconstruct wavefront from Zernike coefficients
  const reconstructed = [];
  for (const pt of opdData) {
    if (pt.opd !== null) {
      const recon = reconstructOPD(fitResult.coefficients, pt.u, pt.v);
      reconstructed.push({
        ...pt,
        reconstructed: recon,
        residual: pt.opd - recon
      });
    } else {
      reconstructed.push({
        ...pt,
        reconstructed: null,
        residual: null
      });
    }
  }
  
  return {
    fieldSetting,
    wavelength,
    gridSize,
    opdData: reconstructed,
    zernike: {
      coefficients: fitResult.coefficients,
      rms: fitResult.rms,
      pv: fitResult.pv,
      numPoints: fitResult.numPoints,
      maxOrder: maxZernikeOrder
    },
    statistics: calculateStatistics(reconstructed)
  };
}

/**
 * Calculate statistics from OPD data
 */
function calculateStatistics(opdData) {
  const validData = opdData.filter(pt => pt.opd !== null);
  
  if (validData.length === 0) {
    return {
      opdRMS: 0,
      opdPV: 0,
      residualRMS: 0,
      residualPV: 0,
      validPoints: 0,
      totalPoints: opdData.length
    };
  }
  
  const opds = validData.map(pt => pt.opd);
  const residuals = validData.map(pt => pt.residual).filter(r => r !== null);
  
  const opdMin = Math.min(...opds);
  const opdMax = Math.max(...opds);
  const opdPV = opdMax - opdMin;
  
  const opdMean = opds.reduce((s, v) => s + v, 0) / opds.length;
  const opdRMS = Math.sqrt(opds.reduce((s, v) => s + (v - opdMean) ** 2, 0) / opds.length);
  
  let residualRMS = 0;
  let residualPV = 0;
  if (residuals.length > 0) {
    const residualMean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
    residualRMS = Math.sqrt(residuals.reduce((s, v) => s + (v - residualMean) ** 2, 0) / residuals.length);
    const residualMin = Math.min(...residuals);
    const residualMax = Math.max(...residuals);
    residualPV = residualMax - residualMin;
  }
  
  return {
    opdRMS,
    opdPV,
    residualRMS,
    residualPV,
    validPoints: validData.length,
    totalPoints: opdData.length
  };
}

/**
 * Format Zernike coefficients for display
 * 
 * @param {Array<number>} coefficients - Zernike coefficients
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} topN - Number of top terms to display
 * @returns {string} Formatted text
 */
export function formatZernikeCoefficients(coefficients, wavelength = 0.5876, topN = 15) {
  const lines = [];
  lines.push('═══════════════════════════════════════════════════');
  lines.push('         Zernike Polynomial Coefficients           ');
  lines.push('═══════════════════════════════════════════════════');
  lines.push(`Wavelength: ${wavelength} μm`);
  lines.push('');
  lines.push('OSA/ANSI Standard (j = n(n+2)/2 + m)');
  lines.push('─────────────────────────────────────────────────── ');
  lines.push('  j   n   m   Name                      Coeff (λ)  Coeff (nm)');
  lines.push('─────────────────────────────────────────────────── ');
  
  // Sort by magnitude
  const indexed = coefficients.map((c, j) => ({ j, c: c, absC: Math.abs(c) }));
  indexed.sort((a, b) => b.absC - a.absC);
  
  const wavelengthNm = wavelength * 1000;
  
  for (let i = 0; i < Math.min(topN, indexed.length); i++) {
    const { j, c, absC } = indexed[i];
    if (absC < 1e-10) break; // Skip negligible terms
    
    const { n, m } = jToNM(j);
    const name = getZernikeName(j);
    const coeffWaves = c.toFixed(6);
    const coeffNm = (c * wavelengthNm).toFixed(3);
    
    lines.push(`${j.toString().padStart(3)}  ${n.toString().padStart(2)}  ${m.toString().padStart(2)}   ${name.padEnd(22)}  ${coeffWaves.padStart(9)}  ${coeffNm.padStart(10)}`);
  }
  
  lines.push('═══════════════════════════════════════════════════');
  
  return lines.join('\n');
}

/**
 * Display OPD Zernike analysis results
 * 
 * @param {Object} result - Result from calculateOPDWithZernike
 */
export function displayZernikeAnalysis(result) {
  console.log('\n' + '='.repeat(60));
  console.log('  OPD Zernike Polynomial Analysis  ');
  console.log('='.repeat(60));
  
  console.log(`\nField: (${result.fieldSetting.fieldAngle?.x || 0}°, ${result.fieldSetting.fieldAngle?.y || 0}°)`);
  console.log(`Wavelength: ${result.wavelength} μm`);
  console.log(`Grid: ${result.gridSize} × ${result.gridSize}`);
  
  console.log('\n' + formatZernikeCoefficients(result.zernike.coefficients, result.wavelength, 15));
  
  console.log('\n' + '─'.repeat(60));
  console.log('Statistics:');
  console.log('─'.repeat(60));
  console.log(`Valid pupil points: ${result.statistics.validPoints} / ${result.statistics.totalPoints}`);
  console.log(`OPD RMS:           ${(result.statistics.opdRMS * 1000).toFixed(3)} nm`);
  console.log(`OPD P-V:           ${(result.statistics.opdPV * 1000).toFixed(3)} nm`);
  console.log(`Residual RMS:      ${(result.statistics.residualRMS * 1000).toFixed(3)} nm`);
  console.log(`Residual P-V:      ${(result.statistics.residualPV * 1000).toFixed(3)} nm`);
  console.log(`Fit Quality:       ${((1 - result.statistics.residualRMS / Math.max(result.statistics.opdRMS, 1e-10)) * 100).toFixed(2)}%`);
  console.log('═'.repeat(60) + '\n');
}

/**
 * Export Zernike analysis to JSON
 * 
 * @param {Object} result - Result from calculateOPDWithZernike
 * @returns {string} JSON string
 */
export function exportZernikeAnalysisJSON(result) {
  const { n, m } = jToNM;
  
  const termsWithNames = result.zernike.coefficients.map((c, j) => {
    const nm = jToNM(j);
    return {
      j,
      n: nm.n,
      m: nm.m,
      name: getZernikeName(j),
      coefficient_waves: c,
      coefficient_nm: c * result.wavelength * 1000
    };
  });
  
  return JSON.stringify({
    field: result.fieldSetting.fieldAngle,
    wavelength_um: result.wavelength,
    grid_size: result.gridSize,
    zernike: {
      max_order: result.zernike.maxOrder,
      terms: termsWithNames
    },
    statistics: {
      opd_rms_nm: result.statistics.opdRMS * 1000,
      opd_pv_nm: result.statistics.opdPV * 1000,
      residual_rms_nm: result.statistics.residualRMS * 1000,
      residual_pv_nm: result.statistics.residualPV * 1000,
      fit_quality_percent: (1 - result.statistics.residualRMS / Math.max(result.statistics.opdRMS, 1e-10)) * 100,
      valid_points: result.statistics.validPoints,
      total_points: result.statistics.totalPoints
    }
  }, null, 2);
}

// Export for browser console usage
if (typeof window !== 'undefined') {
  window.calculateOPDWithZernike = calculateOPDWithZernike;
  window.displayZernikeAnalysis = displayZernikeAnalysis;
  window.exportZernikeAnalysisJSON = exportZernikeAnalysisJSON;
}
