const zObj = -120;
const zImg = 189.438757;
const zB0 = 20;
const zC0 = 52;
const B_stroke_max = 43.36;
const phiB = -0.02;

let maxPhiC = -Infinity;
let minPhiC = Infinity;
let xAtMaxPhiC = 0;
let minZBPrime = Infinity;
let maxZBPrime = -Infinity;

const results = [];

for (let i = 0; i <= 1000; i++) {
  const x = i / 1000;
  const B_offset = x * B_stroke_max;
  const zB = zB0 + B_offset;
  const s = zB - zObj;
  const zBPrime = zB + s / (phiB * s - 1);
  
  const reqPhiC = 4 / (zImg - zBPrime);
  
  if (reqPhiC > maxPhiC) {
    maxPhiC = reqPhiC;
    xAtMaxPhiC = x;
  }
  if (reqPhiC < minPhiC) {
    minPhiC = reqPhiC;
  }
  if (zBPrime < minZBPrime) minZBPrime = zBPrime;
  if (zBPrime > maxZBPrime) maxZBPrime = zBPrime;
  
  results.push({ x, zBPrime });
}

console.log(`Max req phiC: ${maxPhiC.toFixed(6)} at x=${xAtMaxPhiC}`);
console.log(`Min req phiC: ${minPhiC.toFixed(6)}`);
console.log(`zBPrime range: [${minZBPrime.toFixed(4)}, ${maxZBPrime.toFixed(4)}]`);

const candidates = [0.0205, 0.021, 0.022, 0.025];
candidates.forEach(phiC => {
  let allReal = true;
  let minZC = Infinity;
  let maxZC = -Infinity;
  
  for (const { zBPrime } of results) {
    const L = zImg - zBPrime;
    const discriminant = L * L - 4 * L / phiC;
    if (discriminant < 0) {
      allReal = false;
      break;
    }
    const sqrtD = Math.sqrt(discriminant);
    const zC1 = zBPrime + (L - sqrtD) / 2;
    const zC2 = zBPrime + (L + sqrtD) / 2;
    
    // Choose root nearest zCseed=52
    const zC = Math.abs(zC1 - 52) < Math.abs(zC2 - 52) ? zC1 : zC2;
    
    if (zC < minZC) minZC = zC;
    if (zC > maxZC) maxZC = zC;
  }
  
  if (allReal) {
    console.log(`phiC=${phiC}: Real solutions exist. zC range: [${minZC.toFixed(4)}, ${maxZC.toFixed(4)}]`);
  } else {
    console.log(`phiC=${phiC}: Real solutions DO NOT exist over full sweep.`);
  }
});
