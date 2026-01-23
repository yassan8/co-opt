/**
 * Test script for glass refractive index calculations
 * Tests Sellmeier, Schott (CDGM), and Sumita formulas
 */

import { 
  calculateRefractiveIndex, 
  calculateRefractiveIndexSchott,
  calculateRefractiveIndexSumita,
  calculateGlassRefractiveIndex,
  getGlassDataWithSellmeier
} from './data/glass.js';

console.log('=== Glass Refractive Index Formula Tests ===\n');

// Test 1: Sellmeier formula (HOYA)
console.log('1. Sellmeier Formula Test (HOYA FCD1)');
const hoyaGlass = getGlassDataWithSellmeier('FCD1');
if (hoyaGlass) {
  console.log(`   Glass: ${hoyaGlass.name}`);
  console.log(`   nd (587.6nm): ${hoyaGlass.nd}`);
  const n_d = calculateGlassRefractiveIndex(hoyaGlass, 0.5876); // d-line
  const n_F = calculateGlassRefractiveIndex(hoyaGlass, 0.4861); // F-line
  const n_C = calculateGlassRefractiveIndex(hoyaGlass, 0.6563); // C-line
  console.log(`   Calculated n(d): ${n_d.toFixed(5)}`);
  console.log(`   Calculated n(F): ${n_F.toFixed(5)}`);
  console.log(`   Calculated n(C): ${n_C.toFixed(5)}`);
  console.log(`   Calculated vd: ${((n_d - 1) / (n_F - n_C)).toFixed(2)}`);
}

console.log('\n2. Schott Formula Test (CDGM H-FK61)');
const cdgmGlass = getGlassDataWithSellmeier('H-FK61');
if (cdgmGlass) {
  console.log(`   Glass: ${cdgmGlass.name}`);
  console.log(`   nd (587.6nm): ${cdgmGlass.nd}`);
  console.log(`   vd: ${cdgmGlass.vd}`);
  const n_d = calculateGlassRefractiveIndex(cdgmGlass, 0.5876); // d-line
  const n_F = calculateGlassRefractiveIndex(cdgmGlass, 0.4861); // F-line
  const n_C = calculateGlassRefractiveIndex(cdgmGlass, 0.6563); // C-line
  console.log(`   Calculated n(d): ${n_d.toFixed(5)}`);
  console.log(`   Calculated n(F): ${n_F.toFixed(5)}`);
  console.log(`   Calculated n(C): ${n_C.toFixed(5)}`);
  console.log(`   Calculated vd: ${((n_d - 1) / (n_F - n_C)).toFixed(2)}`);
  console.log(`   Error in nd: ${Math.abs(n_d - cdgmGlass.nd).toFixed(6)}`);
}

console.log('\n3. Sumita Formula Test (K-CaFK95)');
const sumitaGlass = getGlassDataWithSellmeier('K-CaFK95');
if (sumitaGlass) {
  console.log(`   Glass: ${sumitaGlass.name}`);
  console.log(`   nd (587.6nm): ${sumitaGlass.nd}`);
  console.log(`   vd: ${sumitaGlass.vd}`);
  const n_d = calculateGlassRefractiveIndex(sumitaGlass, 0.5876); // d-line
  const n_F = calculateGlassRefractiveIndex(sumitaGlass, 0.4861); // F-line
  const n_C = calculateGlassRefractiveIndex(sumitaGlass, 0.6563); // C-line
  console.log(`   Calculated n(d): ${n_d.toFixed(5)}`);
  console.log(`   Calculated n(F): ${n_F.toFixed(5)}`);
  console.log(`   Calculated n(C): ${n_C.toFixed(5)}`);
  console.log(`   Calculated vd: ${((n_d - 1) / (n_F - n_C)).toFixed(2)}`);
  console.log(`   Error in nd: ${Math.abs(n_d - sumitaGlass.nd).toFixed(6)}`);
}

console.log('\n4. Dispersion Curve Test (CDGM H-FK61)');
if (cdgmGlass) {
  console.log(`   Wavelength (μm)  |  Refractive Index`);
  console.log(`   -----------------+------------------`);
  const wavelengths = [0.365, 0.404, 0.486, 0.546, 0.588, 0.656, 0.706, 1.014];
  wavelengths.forEach(lambda => {
    const n = calculateGlassRefractiveIndex(cdgmGlass, lambda);
    console.log(`   ${lambda.toFixed(3)}            |  ${n.toFixed(5)}`);
  });
}

console.log('\n=== All Tests Complete ===');
