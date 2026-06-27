/**
 * PSF Serialization Utilities
 * 
 * Converts PSFCalculator output to worker-friendly format
 * Extracts PSF grid for MTF computation parallelization
 */

/**
 * Extract PSF grid from PSFCalculator result
 * 
 * The PSFCalculator returns a complex object with various properties.
 * We extract just the 2D PSF intensity grid and its dimensions.
 */
export function extractPSFGridFromCalculatorResult(
    psfResult: any
): {
    psfGrid: Float64Array;
    rows: number;
    cols: number;
    success: boolean;
    error?: string;
} {
    try {
        if (!psfResult) {
            return { psfGrid: new Float64Array(), rows: 0, cols: 0, success: false, error: 'No PSF result provided' };
        }

        // PSFCalculator returns { psfData, strehlRatio, fwhm, encircledEnergy, wavelength, metadata, options }
        const psfData = psfResult.psfData || psfResult.psf || psfResult.data;

        if (!psfData) {
            return { psfGrid: new Float64Array(), rows: 0, cols: 0, success: false, error: 'PSF data not found in result' };
        }

        // Determine dimensions
        let rows = 0;
        let cols = 0;

        if (Array.isArray(psfData)) {
            // 2D array format [[...], [...], ...]
            rows = psfData.length;
            cols = rows > 0 && Array.isArray(psfData[0]) ? psfData[0].length : 0;

            if (cols === 0) {
                return { psfGrid: new Float64Array(), rows: 0, cols: 0, success: false, error: 'Invalid PSF array dimensions' };
            }

            // Flatten to Float64Array (row-major order)
            const grid = new Float64Array(rows * cols);
            for (let r = 0; r < rows; r++) {
                const rowData = psfData[r];
                if (!Array.isArray(rowData)) {
                    return { psfGrid: new Float64Array(), rows: 0, cols: 0, success: false, error: `Row ${r} is not an array` };
                }
                for (let c = 0; c < cols; c++) {
                    const val = Number(rowData[c]);
                    grid[r * cols + c] = Number.isFinite(val) ? val : 0;
                }
            }

            return { psfGrid: grid, rows, cols, success: true };
        } else if (psfData instanceof Float64Array || psfData instanceof Float32Array) {
            // Already a flat array, need dimensions from metadata
            const size = psfResult.metadata?.gridSize || psfResult.options?.samplingSize;
            if (!size) {
                return { psfGrid: new Float64Array(), rows: 0, cols: 0, success: false, error: 'Cannot determine PSF dimensions' };
            }

            rows = size;
            cols = size;

            // Convert to Float64Array if needed
            const grid = psfData instanceof Float64Array ? psfData : new Float64Array(psfData);
            return { psfGrid: grid, rows, cols, success: true };
        }

        return { psfGrid: new Float64Array(), rows: 0, cols: 0, success: false, error: 'Unsupported PSF data format' };
    } catch (error) {
        return {
            psfGrid: new Float64Array(),
            rows: 0,
            cols: 0,
            success: false,
            error: String(error instanceof Error ? error.message : error)
        };
    }
}

/**
 * Validate PSF grid dimensions
 */
export function validatePSFGrid(
    grid: Float64Array,
    rows: number,
    cols: number
): { valid: boolean; error?: string } {
    if (!grid || grid.length === 0) {
        return { valid: false, error: 'PSF grid is empty' };
    }

    if (rows <= 0 || cols <= 0) {
        return { valid: false, error: `Invalid dimensions: ${rows}×${cols}` };
    }

    const expectedSize = rows * cols;
    if (grid.length !== expectedSize) {
        return { valid: false, error: `Grid size ${grid.length} does not match dimensions ${rows}×${cols} (expected ${expectedSize})` };
    }

    // Check for NaN/Inf values
    let nanCount = 0;
    let infCount = 0;
    for (let i = 0; i < grid.length; i++) {
        const val = grid[i];
        if (!Number.isFinite(val)) {
            if (Number.isNaN(val)) nanCount++;
            else infCount++;
        }
    }

    if (nanCount > 0 || infCount > 0) {
        return { valid: false, error: `PSF contains ${nanCount} NaN and ${infCount} Inf values` };
    }

    return { valid: true };
}

/**
 * Normalize PSF grid (optional preprocessing)
 * 
 * Useful for PSF intensity grids to ensure proper MTF range
 */
export function normalizePSFGrid(grid: Float64Array): Float64Array {
    if (grid.length === 0) return grid;

    // Find max value
    let maxVal = 0;
    for (let i = 0; i < grid.length; i++) {
        const val = Math.abs(grid[i]);
        if (val > maxVal) maxVal = val;
    }

    if (maxVal <= 0) return grid;

    // Normalize by max
    const normalized = new Float64Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
        normalized[i] = grid[i] / maxVal;
    }

    return normalized;
}

/**
 * Extract grid metadata from PSFCalculator result
 */
export function extractPSFMetadata(psfResult: any): {
    wavelengthMicrons?: number;
    pupilDiameterMm?: number;
    gridSize?: number;
    pixelSizeUm?: number;
} {
    return {
        wavelengthMicrons: psfResult?.wavelength,
        pupilDiameterMm: psfResult?.options?.pupilDiameter,
        gridSize: psfResult?.options?.samplingSize,
        pixelSizeUm: psfResult?.metadata?.pixelSize
    };
}
