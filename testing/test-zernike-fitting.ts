/**
 * Test Zernike Fitting with Vignetting
 * 
 * Run in browser console:
 *   (async () => { const result = await testZernikeFitting(); console.log(result); })();
 *   displayZernikeAnalysis(window.zernikeResult);
 */

import { calculateOPDWithZernike, displayZernikeAnalysis, exportZernikeAnalysisJSON } from '../evaluation/wavefront/opd-zernike-analysis.ts';

/**
 * Test Zernike fitting on current optical system
 */
export async function testZernikeFitting() {
  console.log('🧪 Testing Zernike Polynomial Fitting with Vignetting Support\n');
  
  // Test on-axis field
  console.log('═══ Test 1: On-Axis Field ═══');
  const result1 = await calculateOPDWithZernike({
    gridSize: 64,
    fieldSetting: { fieldAngle: { x: 0, y: 0 } },
    wavelength: 0.5876,
    maxZernikeOrder: 6,
    vignetteThreshold: 0.5
  });
  
  displayZernikeAnalysis(result1);
  
  // Test off-axis field
  console.log('\n═══ Test 2: Off-Axis Field (10°) ═══');
  const result2 = await calculateOPDWithZernike({
    gridSize: 64,
    fieldSetting: { fieldAngle: { x: 10, y: 0 } },
    wavelength: 0.5876,
    maxZernikeOrder: 6,
    vignetteThreshold: 0.5
  });
  
  displayZernikeAnalysis(result2);
  
  // Export to JSON
  console.log('\n═══ JSON Export Example ═══');
  const json = exportZernikeAnalysisJSON(result1);
  console.log(json);
  
  return { onAxis: result1, offAxis: result2 };
}

/**
 * Test with simulated vignetting
 */
export async function testVignettedPupil() {
  console.log('🧪 Testing Zernike Fitting with Simulated Vignetting\n');
  
  // Simulate partial vignetting by adding artificial weight pattern
  const result = await calculateOPDWithZernike({
    gridSize: 64,
    fieldSetting: { fieldAngle: { x: 0, y: 0 } },
    wavelength: 0.5876,
    maxZernikeOrder: 8,
    vignetteThreshold: 0.3 // Lower threshold to detect more vignetting
  });
  
  displayZernikeAnalysis(result);
  
  // Count vignetted points
  const vignetted = result.opdData.filter(pt => pt.vignetted).length;
  const total = result.opdData.length;
  console.log(`\nVignetting: ${vignetted}/${total} points (${(vignetted/total*100).toFixed(1)}%)`);
  
  return result;
}

/**
 * Compare Zernike orders
 */
export async function compareZernikeOrders() {
  console.log('🧪 Comparing Zernike Fitting at Different Orders\n');
  
  const orders = [3, 6, 9, 12];
  const results = [];
  
  for (const order of orders) {
    console.log(`═══ Zernike Order ${order} ═══`);
    const result = await calculateOPDWithZernike({
      gridSize: 64,
      fieldSetting: { fieldAngle: { x: 5, y: 0 } },
      wavelength: 0.5876,
      maxZernikeOrder: order,
      vignetteThreshold: 0.5
    });
    
    const numTerms = (order + 1) * (order + 2) / 2;
    console.log(`Terms: ${numTerms}`);
    console.log(`Residual RMS: ${(result.statistics.residualRMS * 1000).toFixed(3)} nm`);
    console.log(`Fit Quality: ${((1 - result.statistics.residualRMS / Math.max(result.statistics.opdRMS, 1e-10)) * 100).toFixed(2)}%`);
    console.log('');
    
    results.push({
      order,
      numTerms,
      residualRMS: result.statistics.residualRMS * 1000,
      fitQuality: (1 - result.statistics.residualRMS / Math.max(result.statistics.opdRMS, 1e-10)) * 100
    });
  }
  
  console.log('\n═══ Summary ═══');
  console.table(results);
  
  return results;
}

// Export for browser console
if (typeof window !== 'undefined') {
  window['testZernikeFitting'] = testZernikeFitting;
  window['testVignettedPupil'] = testVignettedPupil;
  window['compareZernikeOrders'] = compareZernikeOrders;
}
