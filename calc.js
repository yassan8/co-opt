const x = 0.175;
const B_start = 0;
const B_end = 43.36;
const phiB = -0.02;
const phiC = 0.015;
const zObj = -120;
const zImg = 189.438757;
const zB0 = 20;
const zC0 = 52;

const B_offset = x * (B_end - B_start);
const zB = zB0 + B_offset;
const s = zB - zObj;
const zBPrime = s / (phiB * s - 1) + zB;

// Quadratic for zC: 1/s' + 1/s = phiC where s = zC - zBPrime and s' = zImg - zC
// (zImg - zC + zC - zBPrime) / ((zC - zBPrime)(zImg - zC)) = phiC
// (zImg - zBPrime) = phiC * (zC*(zImg + zBPrime) - zC^2 - zBPrime*zImg)
// phiC*zC^2 - phiC*(zImg + zBPrime)*zC + (zImg - zBPrime + phiC*zBPrime*zImg) = 0
const a = phiC;
const b = -phiC * (zImg + zBPrime);
const c = (zImg - zBPrime) + phiC * zBPrime * zImg;
const discriminant = b * b - 4 * a * c;

const phi_min = 4 / (zImg - zBPrime);

console.log('B offset:', B_offset.toFixed(4));
console.log('zB:', zB.toFixed(4));
console.log('zBPrime:', zBPrime.toFixed(4));
console.log('Discriminant:', discriminant.toFixed(4));
console.log('phi_min:', phi_min.toFixed(6));
