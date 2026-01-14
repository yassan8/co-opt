/**
 * Zernike Polynomial Fitting with Vignetting Support
 * 
 * References:
 * - Dai & Mahajan (2007) "Zernike annular polynomials and atmospheric turbulence" JOSA A
 * - Swantner & Chow (1994) "Gram-Schmidt orthogonalization of Zernike polynomials for general aperture shapes"
 * - Noll (1976) "Zernike polynomials and atmospheric turbulence" JOSA
 * 
 * Implements weighted least-squares Zernike fitting for pupils with vignetting/obscuration
 */

/**
 * OSA/ANSI Standard Zernike Polynomials
 * Single index j = n(n+2)/2 + m
 * 
 * @param {number} n - Radial degree
 * @param {number} m - Azimuthal frequency (signed)
 * @param {number} rho - Normalized radial coordinate (0 to 1)
 * @param {number} theta - Azimuthal angle (radians)
 * @returns {number} Zernike polynomial value
 */
export function zernikePolynomial(n, m, rho, theta) {
  if (rho < 0 || rho > 1) return 0;
  
  const R = zernikeRadial(n, Math.abs(m), rho);
  
  // OSA/ANSI normalization: N_nm = sqrt(2(n+1) / (1 + delta_m0))
  const delta_m0 = (m === 0) ? 1 : 0;
  const N = Math.sqrt(2 * (n + 1) / (1 + delta_m0));
  
  if (m >= 0) {
    return N * R * Math.cos(m * theta);
  } else {
    return N * R * Math.sin(Math.abs(m) * theta);
  }
}

/**
 * Radial Zernike polynomial
 * R_n^m(ρ) = Σ_{k=0}^{(n-m)/2} (-1)^k * (n-k)! / (k! * ((n+m)/2-k)! * ((n-m)/2-k)!) * ρ^(n-2k)
 * 
 * @param {number} n - Radial degree
 * @param {number} m - Azimuthal frequency (unsigned)
 * @param {number} rho - Normalized radial coordinate
 * @returns {number} Radial polynomial value
 */
function zernikeRadial(n, m, rho) {
  if ((n - m) % 2 !== 0) return 0; // n - m must be even
  if (m > n) return 0;
  
  let R = 0;
  const kMax = (n - m) / 2;
  
  for (let k = 0; k <= kMax; k++) {
    const sign = (k % 2 === 0) ? 1 : -1;
    const coeff = sign * factorial(n - k) / 
                  (factorial(k) * factorial((n + m) / 2 - k) * factorial((n - m) / 2 - k));
    R += coeff * Math.pow(rho, n - 2 * k);
  }
  
  return R;
}

/**
 * Factorial function with memoization
 */
const factorialCache = [1];
function factorial(n) {
  if (n < 0) return 0;
  if (n === 0 || n === 1) return 1;
  
  if (factorialCache[n]) return factorialCache[n];
  
  for (let i = factorialCache.length; i <= n; i++) {
    factorialCache[i] = factorialCache[i - 1] * i;
  }
  
  return factorialCache[n];
}

/**
 * Convert OSA/ANSI single index to (n, m) indices
 * j = (n(n+1) + m) / 2  (OSA/ANSI standard)
 * 
 * For each radial order n, m ranges from -n to +n in steps of 2:
 * - n=0: m=0           → j=0
 * - n=1: m=-1,+1       → j=1,2
 * - n=2: m=-2,0,+2     → j=3,4,5
 * - n=3: m=-3,-1,+1,+3 → j=6,7,8,9
 * 
 * @param {number} j - OSA/ANSI single index (0-based)
 * @returns {{n: number, m: number}} Radial and azimuthal indices
 */
export function jToNM(j) {
  // Find n: solve n(n+1)/2 + n = j_max where j_max is last j for order n
  // This gives n(n+2)/2 = j_max, so n ≈ sqrt(2*j)
  let n = Math.floor((-1 + Math.sqrt(1 + 8 * j)) / 2);
  
  // First j index for this n
  const j0 = n * (n + 1) / 2;
  
  // Position within this radial order
  const offset = j - j0;
  
  // For radial order n, we have m = -n, -n+2, ..., n-2, n
  // The offset tells us which m value
  const m = -n + 2 * offset;
  
  return { n, m };
}

/**
 * Convert (n, m) indices to OSA/ANSI single index
 * 
 * @param {number} n - Radial degree
 * @param {number} m - Azimuthal frequency (signed)
 * @returns {number} OSA/ANSI single index
 */
export function nmToJ(n, m) {
  return n * (n + 2) / 2 + m;
}

/**
 * Weighted Least-Squares Zernike Fitting with Vignetting Support
 * 
 * Fits OPD data to Zernike polynomials using weighted least squares.
 * Weight function handles vignetting (partial pupil obscuration).
 * 
 * @param {Array<{x: number, y: number, opd: number, weight: number}>} points - Pupil points with OPD values and weights
 * @param {number} maxOrder - Maximum radial order (n) to fit
 * @param {Object} options - Fitting options
 * @param {number} options.epsilon - Annular obscuration ratio (0 = circular, >0 = annular)
 * @param {boolean} options.removePiston - Remove piston (Z0) term
 * @param {boolean} options.removeTilt - Remove tilt (Z1, Z2) terms
 * @param {boolean} options.skipPiston - Skip piston term in fitting (for hybrid approach)
 * @param {boolean} options.skipTilt - Skip tilt terms in fitting (for hybrid approach)
 * @returns {{coefficients: Array<number>, rms: number, pv: number}} Zernike coefficients and residual statistics
 */
export function fitZernikeWeighted(points, maxOrder, options = {}) {
  const epsilon = options.epsilon || 0; // Annular obscuration ratio
  const removePiston = options.removePiston !== false;
  const removeTilt = options.removeTilt || false;
  const skipPiston = options.skipPiston || false;
  const skipTilt = options.skipTilt || false;
  
  // Calculate number of Zernike terms
  const numTerms = (maxOrder + 1) * (maxOrder + 2) / 2;
  
  // Build design matrix A and weighted observation vector b
  const A = [];
  const b = [];
  const weights = [];
  
  for (const pt of points) {
    const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
    const theta = Math.atan2(pt.y, pt.x);
    const w = pt.weight || 1.0;
    
    // Skip points outside unit circle or inside obscuration
    if (rho > 1.0 || rho < epsilon) continue;
    
    const row = [];
    for (let j = 0; j < numTerms; j++) {
      const { n, m } = jToNM(j);
      if (n > maxOrder) break; // 最大次数を超えたら終了
      
      // skipPistonオプションでピストン項（j=0）をスキップ
      if (skipPiston && j === 0) continue;
      
      // skipTiltオプションでチルト項（j=1, j=2）をスキップ
      if (skipTilt && (j === 1 || j === 2)) continue;
      
      const Z = zernikePolynomial(n, m, rho, theta);
      row.push(Z);
    }
    
    A.push(row);
    b.push(pt.opd);
    weights.push(w);
  }
  
  // Solve weighted least squares: (A^T W A) c = A^T W b
  // where W is diagonal weight matrix
  const c = solveWeightedLeastSquares(A, b, weights);
  
  // skipPistonまたはskipTiltの場合、係数配列に0を挿入
  if (skipPiston) {
    c.unshift(0); // j=0（ピストン）に0を追加
  }
  if (skipTilt) {
    // j=1, j=2に0を挿入（skipPistonの有無で位置が変わる）
    if (skipPiston) {
      c.splice(1, 0, 0, 0);  // 位置1と2に挿入
    } else {
      c[1] = 0;
      c[2] = 0;
    }
  }
  
  // Optionally remove piston and tilt
  if (removePiston && c.length > 0) {
    c[0] = 0;
  }
  if (removeTilt && c.length > 2) {
    c[1] = 0;
    c[2] = 0;
  }
  
  // Calculate residuals
  let sumSquaredResidual = 0;
  let minResidual = Infinity;
  let maxResidual = -Infinity;
  
  for (let i = 0; i < A.length; i++) {
    let fitted = 0;
    for (let j = 0; j < c.length; j++) {
      fitted += A[i][j] * c[j];
    }
    const residual = b[i] - fitted;
    sumSquaredResidual += residual * residual * weights[i];
    minResidual = Math.min(minResidual, residual);
    maxResidual = Math.max(maxResidual, residual);
  }
  
  const rms = Math.sqrt(sumSquaredResidual / A.length);
  const pv = maxResidual - minResidual;
  
  return {
    coefficients: c,
    rms,
    pv,
    numPoints: A.length
  };
}

/**
 * Solve weighted least squares problem
 * (A^T W A) x = A^T W b
 * 
 * @param {Array<Array<number>>} A - Design matrix [m x n]
 * @param {Array<number>} b - Observation vector [m]
 * @param {Array<number>} weights - Weight vector [m]
 * @returns {Array<number>} Solution vector [n]
 */
function solveWeightedLeastSquares(A, b, weights) {
  const m = A.length; // Number of observations
  const n = A[0].length; // Number of parameters
  

  // Compute A^T W A
  const ATWA = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < m; k++) {
        sum += A[k][i] * weights[k] * A[k][j];
      }
      ATWA[i][j] = sum;
    }
  }
  
  // Compute A^T W b
  const ATWb = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < m; k++) {
      sum += A[k][i] * weights[k] * b[k];
    }
    ATWb[i] = sum;
  }
  
  // Solve ATWA * x = ATWb using Cholesky decomposition
  return solveSymmetricSystem(ATWA, ATWb);
}

/**
 * Solve symmetric positive definite system using Cholesky decomposition
 * 
 * @param {Array<Array<number>>} A - Symmetric positive definite matrix
 * @param {Array<number>} b - Right-hand side vector
 * @returns {Array<number>} Solution vector
 */
function solveSymmetricSystem(A, b) {
  const n = A.length;
  
  // Cholesky decomposition: A = L L^T
  const L = Array(n).fill(0).map(() => Array(n).fill(0));
  
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(0, A[i][i] - sum));
      } else {
        if (L[j][j] !== 0) {
          L[i][j] = (A[i][j] - sum) / L[j][j];
        }
      }
    }
  }
  
  // Forward substitution: L y = b
  const y = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < i; j++) {
      sum += L[i][j] * y[j];
    }
    y[i] = L[i][i] !== 0 ? (b[i] - sum) / L[i][i] : 0;
  }
  
  // Back substitution: L^T x = y
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += L[j][i] * x[j];
    }
    x[i] = L[i][i] !== 0 ? (y[i] - sum) / L[i][i] : 0;
  }
  
  return x;
}

/**
 * Reconstruct OPD from Zernike coefficients
 * 
 * @param {Array<number>} coefficients - Zernike coefficients (OSA/ANSI ordering)
 * @param {number} x - Normalized X coordinate (-1 to 1)
 * @param {number} y - Normalized Y coordinate (-1 to 1)
 * @returns {number} Reconstructed OPD value
 */
export function reconstructOPD(coefficients, x, y) {
  const rho = Math.sqrt(x * x + y * y);
  if (rho > 1.0) return 0;
  
  const theta = Math.atan2(y, x);
  
  let opd = 0;
  for (let j = 0; j < coefficients.length; j++) {
    const { n, m } = jToNM(j);
    opd += coefficients[j] * zernikePolynomial(n, m, rho, theta);
  }
  
  return opd;
}

/**
 * Get Zernike term name (OSA/ANSI standard)
 * 
 * @param {number} j - OSA/ANSI index
 * @returns {string} Term name
 */
export function getZernikeName(j) {
  const names = [
    'Piston',
    'Tilt Y',
    'Tilt X',
    'Oblique Astigmatism',
    'Defocus',
    'Vertical Astigmatism',
    'Vertical Trefoil',
    'Vertical Coma',
    'Horizontal Coma',
    'Oblique Trefoil',
    'Oblique Quadrafoil',
    'Oblique Secondary Astigmatism',
    'Primary Spherical',
    'Vertical Secondary Astigmatism',
    'Vertical Quadrafoil'
  ];
  
  return names[j] || `Z${j}`;
}
