/**
 * Conjugate type detection utility
 * 
 * Provides unified detection of infinite vs finite conjugate systems
 * to prevent conflicts between detection logic in different modules.
 */

export type ConjugateType = 'infinite' | 'finite';

export interface ConjugateDetectionOptions {
    forceInfiniteObject?: boolean;
    forceFiniteObject?: boolean;
}

/**
 * Detect whether an optical system is infinite or finite conjugate
 * based on the Object surface thickness.
 * 
 * @param opticalSystemRows - Optical system configuration
 * @param options - Optional force flags
 * @returns 'infinite' or 'finite'
 */
export function detectConjugateType(
    opticalSystemRows: any[] | null | undefined,
    options: ConjugateDetectionOptions = {}
): ConjugateType {
    // Explicit force flags take precedence
    if (options.forceInfiniteObject === true) {
        return 'infinite';
    }
    if (options.forceFiniteObject === true) {
        return 'finite';
    }

    // Get Object surface (first row)
    const objectRow = Array.isArray(opticalSystemRows) && opticalSystemRows.length > 0
        ? opticalSystemRows[0]
        : null;

    if (!objectRow) {
        // Default to finite if no object row
        return 'finite';
    }

    const thicknessRaw = objectRow.thickness
        ?? objectRow.Thickness
        ?? objectRow.distance;
    const thicknessStr = (thicknessRaw !== undefined && thicknessRaw !== null)
        ? String(thicknessRaw).trim().toUpperCase()
        : '';
    const thicknessVal = Number(thicknessRaw);

    // Check for infinite conjugate indicators
    const isInfinite = (
        thicknessRaw === Infinity ||
        thicknessRaw === -Infinity ||
        thicknessStr === 'INF' ||
        thicknessStr === '-INF' ||
        thicknessStr === 'INFINITY' ||
        thicknessStr === '-INFINITY' ||
        thicknessStr === '∞' ||
        thicknessStr === '-∞' ||
        (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
    );

    return isInfinite ? 'infinite' : 'finite';
}

/**
 * Check if the given conjugate type is infinite
 */
export function isInfiniteConjugate(conjugateType: ConjugateType): boolean {
    return conjugateType === 'infinite';
}

/**
 * Check if the given conjugate type is finite
 */
export function isFiniteConjugate(conjugateType: ConjugateType): boolean {
    return conjugateType === 'finite';
}
