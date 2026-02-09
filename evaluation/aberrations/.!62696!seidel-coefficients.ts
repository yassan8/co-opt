/**
 * Seidel Aberration Coefficients Calculator
 * 
 * Calculates the five primary Seidel aberration coefficients:
 * - S1: Spherical Aberration (SPHA)
 * - S2: Coma (COMA)
 * - S3: Astigmatism (ASTI)
 * - S4: Field Curvature (FCUR)
 * - S5: Distortion (DIST)
 * 
 * Also calculates:
 * - LCA: Longitudinal Chromatic Aberration (normalized)
 * - TCA: Transverse Chromatic Aberration (normalized)
 */

import { calculateRefractiveIndex, getGlassDataWithSellmeier } from '../../data/glass.ts';
import { 
    getSafeRadius, 
    getSafeThickness, 
    getRefractiveIndex as getRefractiveIndexFromSurface,
    findStopSurfaceIndex,
    calculateFocalLength,
    calculateBackFocalLength,
    calculatePupilsByNewSpec,
    calculateFullSystemParaxialTrace,
    isCoordTransSurface
} from '../../raytracing/core/ray-paraxial.ts';
import { tableSource, loadTableData as loadSourceTableData } from '../../data/table-source.ts';

function getSourceRowsSafe() {
    try {
        if (tableSource && typeof tableSource.getData === 'function') {
            const d = tableSource.getData();
            return Array.isArray(d) ? d : [];
        }
    } catch (_) {
        // ignore and fall back
    }
    try {
        const d = loadSourceTableData();
        return Array.isArray(d) ? d : [];
    } catch (_) {
        return [];
    }
}

/**
 * Check if the optical system is afocal (infinite focal length)
