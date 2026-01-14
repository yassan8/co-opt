# Zernike Polynomial Fitting with Vignetting Support

## Overview

This implementation provides Zernike polynomial fitting for wavefront analysis with support for vignetting (pupil obscuration). It follows the OSA/ANSI standard indexing scheme and implements weighted least-squares fitting for robust handling of partial pupil coverage.

## Features

- **Weighted Least-Squares Fitting**: Handles vignetting by assigning weights to pupil points
- **OSA/ANSI Standard**: Uses j = n(n+2)/2 + m indexing scheme
- **Annular Pupil Support**: Optional central obscuration parameter (epsilon)
- **High-Order Fitting**: Supports up to arbitrary Zernike orders
- **Statistical Analysis**: RMS, P-V, and residual analysis
- **Piston/Tilt Removal**: Optional removal of rigid-body modes

## Theory

### Zernike Polynomials

Zernike polynomials form an orthogonal basis over the unit circle:

**Even polynomials (m ≥ 0):**
```
Z_n^m(ρ, θ) = R_n^m(ρ) cos(mθ)
```

**Odd polynomials (m < 0):**
```
Z_n^(-m)(ρ, θ) = R_n^m(ρ) sin(mθ)
```

**Radial polynomial:**
```
R_n^m(ρ) = Σ_{k=0}^{(n-m)/2} (-1)^k (n-k)! / [k! ((n+m)/2-k)! ((n-m)/2-k)!] ρ^(n-2k)
```

### Vignetting Handling

When vignetting is present, standard Zernike fitting fails because:

1. **Orthogonality breaks down**: Zernike polynomials are orthogonal over the full unit circle
2. **Incomplete pupil**: Missing data creates bias in coefficients
3. **Weight distribution**: Different pupil regions have different validity

**Solution: Weighted Least-Squares**

The fitting problem becomes:
```
minimize: Σ_i w_i (OPD_i - Σ_j c_j Z_j(ρ_i, θ_i))²
```

where:
- `w_i` = weight for point i (0 for vignetted, 1 for valid)
- `c_j` = Zernike coefficient for term j
- `Z_j` = Zernike polynomial value

This reduces to:
```
(A^T W A) c = A^T W b
```

where `W` is the diagonal weight matrix.

### Annular Pupils

For systems with central obscuration (e.g., Cassegrain telescopes), set epsilon:

```javascript
fitZernikeWeighted(points, maxOrder, {
  epsilon: 0.3  // 30% central obscuration
})
```

Annular Zernike polynomials are automatically computed by restricting the domain to ε ≤ ρ ≤ 1.

## Usage

### Basic Usage

```javascript
import { calculateOPDWithZernike, displayZernikeAnalysis } from './opd-zernike-analysis.js';

// Calculate OPD with Zernike fitting
const result = await calculateOPDWithZernike({
  gridSize: 64,
  fieldSetting: { fieldAngle: { x: 0, y: 0 } },
  wavelength: 0.5876,  // d-line
  maxZernikeOrder: 6,
  vignetteThreshold: 0.5
});

// Display results
displayZernikeAnalysis(result);
```

### Browser Console Usage

```javascript
// Run test
const result = await testZernikeFitting();

// Display analysis
displayZernikeAnalysis(result.onAxis);

// Export to JSON
const json = exportZernikeAnalysisJSON(result.onAxis);
console.log(json);
```

### Advanced Options

```javascript
const result = await calculateOPDWithZernike({
  gridSize: 128,                    // Higher resolution
  fieldSetting: { 
    fieldAngle: { x: 10, y: 5 }     // Off-axis field
  },
  wavelength: 0.6563,               // C-line (red)
  maxZernikeOrder: 12,              // Higher order fitting
  vignetteThreshold: 0.3            // More sensitive vignetting detection
});
```

## API Reference

### `fitZernikeWeighted(points, maxOrder, options)`

Fits Zernike polynomials to OPD data using weighted least squares.

**Parameters:**
- `points` (Array): Pupil points with `{x, y, opd, weight}` properties
- `maxOrder` (number): Maximum radial order n
- `options` (Object):
  - `epsilon` (number): Central obscuration ratio (0-1, default: 0)
  - `removePiston` (boolean): Remove piston term (default: true)
  - `removeTilt` (boolean): Remove tilt terms (default: false)

**Returns:**
```javascript
{
  coefficients: Array<number>,  // Zernike coefficients in waves
  rms: number,                  // Residual RMS in waves
  pv: number,                   // Residual P-V in waves
  numPoints: number             // Number of fitted points
}
```

### `calculateOPDWithZernike(options)`

Calculates OPD grid and fits Zernike polynomials.

**Parameters:**
- `gridSize` (number): Grid resolution (e.g., 64)
- `fieldSetting` (Object): Field angle specification
- `wavelength` (number): Wavelength in micrometers
- `maxZernikeOrder` (number): Maximum Zernike order
- `vignetteThreshold` (number): Weight threshold (0-1)

**Returns:**
```javascript
{
  fieldSetting: Object,
  wavelength: number,
  gridSize: number,
  opdData: Array,               // Raw OPD data with reconstruction
  zernike: {
    coefficients: Array,
    rms: number,
    pv: number,
    numPoints: number,
    maxOrder: number
  },
  statistics: {
    opdRMS: number,
    opdPV: number,
    residualRMS: number,
    residualPV: number,
    validPoints: number,
    totalPoints: number
  }
}
```

### `reconstructOPD(coefficients, x, y)`

Reconstructs OPD from Zernike coefficients.

**Parameters:**
- `coefficients` (Array): Zernike coefficients
- `x` (number): Normalized X coordinate (-1 to 1)
- `y` (number): Normalized Y coordinate (-1 to 1)

**Returns:** Reconstructed OPD value (number)

## Zernike Index Schemes

### OSA/ANSI Standard (Used in this implementation)

```
j = n(n+2)/2 + m

j  | n  m  | Name
---|-------|------------------------
0  | 0  0  | Piston
1  | 1 -1  | Tilt Y
2  | 1  1  | Tilt X
3  | 2 -2  | Oblique Astigmatism
4  | 2  0  | Defocus
5  | 2  2  | Vertical Astigmatism
6  | 3 -3  | Vertical Trefoil
7  | 3 -1  | Vertical Coma
8  | 3  1  | Horizontal Coma
9  | 3  3  | Oblique Trefoil
10 | 4 -4  | Oblique Quadrafoil
11 | 4 -2  | Oblique Secondary Astigmatism
12 | 4  0  | Primary Spherical
13 | 4  2  | Vertical Secondary Astigmatism
14 | 4  4  | Vertical Quadrafoil
```

### Convert between indices

```javascript
import { jToNM, nmToJ } from './zernike-fitting.js';

const { n, m } = jToNM(12);  // j=12 → n=4, m=0 (Spherical)
const j = nmToJ(4, 0);        // n=4, m=0 → j=12
```

## References

### Academic Papers

1. **Dai, G.-m. & Mahajan, V. N. (2007)**
   "Zernike annular polynomials and atmospheric turbulence"
   *Journal of the Optical Society of America A*, 24(1), 139-155.
   - Comprehensive treatment of annular Zernike polynomials
   - Atmospheric turbulence applications
   - Fourier transforms of Zernike polynomials

2. **Swantner, W. & Chow, W. W. (1994)**
   "Gram-Schmidt orthogonalization of Zernike polynomials for general aperture shapes"
   *Applied Optics*, 33(10), 1832-1837.
   - General method for arbitrary pupil shapes
   - Gram-Schmidt orthogonalization procedure
   - Non-circular and non-annular pupils

3. **Noll, R. J. (1976)**
   "Zernike polynomials and atmospheric turbulence"
   *Journal of the Optical Society of America*, 66(3), 207-211.
   - Classic reference for Zernike indexing
   - Noll's sequential indices (alternative scheme)
   - Atmospheric turbulence characterization

4. **Mahajan, V. N. (1981)**
   "Zernike annular polynomials for imaging systems with annular pupils"
   *Journal of the Optical Society of America*, 71(1), 75-85.
   - Original annular Zernike polynomial paper
   - Imaging with central obscuration
   - Orthogonality over annular domains

### Standards

- **ANSI Z80.28-2017**: Ophthalmics - Methods for reporting optical aberrations of eyes
- **ISO 24157:2008**: Ophthalmic optics and instruments - Reporting aberrations of the human eye

### Books

- Born, M. & Wolf, E. (1999). *Principles of Optics* (7th ed.), Cambridge University Press, pp. 986-988.
- Malacara, D. (2007). *Optical Shop Testing* (3rd ed.), Wiley, Chapter 13.

### Online Resources

- [Wikipedia: Zernike Polynomials](https://en.wikipedia.org/wiki/Zernike_polynomials)
- [Optica Publishing Group: Zernike Resources](https://opg.optica.org/)
- [ZEMAX/Ansys OpticStudio: Zernike Coefficients](https://www.ansys.com/products/optics/ansys-zemax-opticstudio)

## Implementation Notes

### Numerical Stability

1. **Cholesky Decomposition**: Used for solving symmetric positive definite systems
2. **Factorial Memoization**: Caches factorial values to avoid recomputation
3. **Epsilon Handling**: Careful handling of near-zero denominators

### Performance

- **Grid Size**: 64×64 typical (4,096 points), 128×128 high-res (16,384 points)
- **Zernike Order**: Order 6 covers most aberrations, order 12 for detailed analysis
- **Computation Time**: ~100ms for 64×64 grid with order 6 (JavaScript)

### Known Limitations

1. **High-Order Ringing**: Orders >15 may show ringing near pupil edge
2. **Vignetting Detection**: Assumes invalid OPD = vignetting (may need refinement)
3. **Annular Normalization**: Currently uses standard Zernike (not true annular)

### Future Enhancements

- [ ] True annular Zernike polynomials (orthogonal over ε ≤ ρ ≤ 1)
- [ ] Gram-Schmidt orthogonalization for arbitrary shapes
- [ ] WASM acceleration for high-order fitting
- [ ] Interactive visualization of individual Zernike terms
- [ ] Export to ZEMAX/CodeV format

## Testing

Run tests in browser console:

```javascript
// Basic test
await testZernikeFitting();

// Test with vignetting
await testVignettedPupil();

// Compare different orders
await compareZernikeOrders();
```

## License

Part of the co-opt optical design software.

## Contact

For questions or issues, please refer to the main co-opt repository.
