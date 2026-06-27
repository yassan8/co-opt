const zObj = -120;
const zImg = 189.438757;
const zB0 = 20;
const phiB = -0.02;
const B_stroke_max = 43.36;
const targets = [0.025, 0.026];

targets.forEach(phiC => {
  console.log(`\n--- Results for phiC = ${phiC} ---`);
  
  let prevZC;
  let minZC = Infinity;
  let maxZC = -Infinity;
  let zC0;

  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000;
    const zB = zB0 + x * B_stroke_max;
    const s = zB - zObj;
    const zBPrime = zB + s / (phiB * s - 1);
    const L = zImg - zBPrime;
    
    const discriminant = L * L - 4 * L / phiC;
    if (discriminant < 0) {
      console.log(`  x=${x.toFixed(3)}: No real roots (disc=${discriminant.toFixed(6)})`);
      return;
    }
    
    const sqrtD = Math.sqrt(discriminant);
    const zC1 = zBPrime + (L - sqrtD) / 2;
    const zC2 = zBPrime + (L + sqrtD) / 2;
    
    let currentZC;
    if (i === 0) {
      // At x=0, find root nearest 52
      currentZC = Math.abs(zC1 - 52) < Math.abs(zC2 - 52) ? zC1 : zC2;
      zC0 = currentZC;
      console.log(`  Initial zC (x=0) nearest 52: ${zC0.toFixed(6)}`);
    } else {
      // Track the previous root
      currentZC = Math.abs(zC1 - prevZC) < Math.abs(zC2 - prevZC) ? zC1 : zC2;
    }
    
    if (currentZC < minZC) minZC = currentZC;
    if (currentZC > maxZC) maxZC = currentZC;
    prevZC = currentZC;
  }
  
  console.log(`  zC range: [${minZC.toFixed(6)}, ${maxZC.toFixed(6)}]`);
  console.log(`  C offset (zC - zC0) range: [${(minZC - zC0).toFixed(6)}, ${(maxZC - zC0).toFixed(6)}]`);
});
