// precomputed-surface-data.ts
// Phase 3 Optimization: Pre-compute surface parameters for faster ray tracing
// Eliminates repeated parsing and property access during ray trace loops
// 
// ⚠️ STATUS: Foundation implemented, integration pending
// This module provides the infrastructure for pre-computing surface data.
// Full integration requires refactoring traceRay() and related functions.
// Estimated impact: 3-5% improvement
// Estimated effort: 1-2 days of careful refactoring + testing
// 
// To integrate:
// 1. Modify traceRay() to accept PrecomputedSurfaceData[] instead of raw rows
// 2. Update calculateSurfaceOrigins() to populate transform data
// 3. Update all call sites in wavefront.ts, mtf-plot.ts, etc.
// 4. Extensive testing for coordinate transformation correctness

/**
 * Pre-computed surface data structure
 * Contains all data needed for ray tracing in optimized format
 */
export interface PrecomputedSurfaceData {
  // Original row reference (for compatibility)
  row: any;
  
  // Surface type
  type: string;
  isReflective: boolean;
  isStop: boolean;
  isObject: boolean;
  isCoordTrans: boolean;
  isImage: boolean;
  
  // Geometry parameters
  radius: number;
  conic: number;
  thickness: number;
  semidia: number;
  
  // Aspheric coefficients (pre-extracted)
  asphericParams: {
    radius: number;
    conic: number;
    coef1: number;
    coef2: number;
    coef3: number;
    coef4: number;
    coef5: number;
    coef6: number;
    coef7: number;
    coef8: number;
    coef9: number;
    coef10: number;
    semidia: number;
    mode: string; // "even" or "odd"
  };
  
  // Material data
  material: string;
  refractiveIndexCache: Map<number, number>; // wavelength -> n
  
  // Coordinate transformation (if available)
  hasTransform: boolean;
  origin?: { x: number; y: number; z: number };
  rotationMatrix?: number[][]; // 3x3 matrix
  inverseMatrix?: number[][]; // 3x3 inverse
  
  // Aperture check data
  apertureType: string; // "circular", "rectangular", "elliptical", etc.
  apertureParams: any;
}

/**
 * Pre-compute surface data for an optical system
 * @param tableOpticalSystem - Optical system table data
 * @returns Array of pre-computed surface data
 */
export function preprocessOpticalSystem(tableOpticalSystem: any[]): PrecomputedSurfaceData[] {
  if (!Array.isArray(tableOpticalSystem)) {
    return [];
  }
  
  const result: PrecomputedSurfaceData[] = [];
  
  for (let i = 0; i < tableOpticalSystem.length; i++) {
    const row = tableOpticalSystem[i];
    if (!row) {
      continue;
    }
    
    // Extract surface type
    const type = String(row.type || '').toLowerCase();
    const isReflective = (type === 'reflect' || type === 'mirror');
    const isStop = (type === 'stop');
    const isObject = (type === 'object');
    const isCoordTrans = (type === 'coordtrans');
    const isImage = (type === 'image');
    
    // Extract geometry
    const radius = Number(row.radius);
    const conic = Number(row.conic !== undefined ? row.conic : 0) || 0;
    const thickness = Number(row.thickness) || 0;
    const semidia = Number(row.semidia) || 0;
    
    // Extract aspheric parameters
    const asphericMode = String(row.aspheric_mode || row.asphericMode || 'even').toLowerCase();
    const asphericParams = {
      radius,
      conic,
      coef1: Number(row.A4 !== undefined ? row.A4 : row.coef1 !== undefined ? row.coef1 : 0) || 0,
      coef2: Number(row.A6 !== undefined ? row.A6 : row.coef2 !== undefined ? row.coef2 : 0) || 0,
      coef3: Number(row.A8 !== undefined ? row.A8 : row.coef3 !== undefined ? row.coef3 : 0) || 0,
      coef4: Number(row.A10 !== undefined ? row.A10 : row.coef4 !== undefined ? row.coef4 : 0) || 0,
      coef5: Number(row.A12 !== undefined ? row.A12 : row.coef5 !== undefined ? row.coef5 : 0) || 0,
      coef6: Number(row.A14 !== undefined ? row.A14 : row.coef6 !== undefined ? row.coef6 : 0) || 0,
      coef7: Number(row.A16 !== undefined ? row.A16 : row.coef7 !== undefined ? row.coef7 : 0) || 0,
      coef8: Number(row.A18 !== undefined ? row.A18 : row.coef8 !== undefined ? row.coef8 : 0) || 0,
      coef9: Number(row.A20 !== undefined ? row.A20 : row.coef9 !== undefined ? row.coef9 : 0) || 0,
      coef10: Number(row.A22 !== undefined ? row.A22 : row.coef10 !== undefined ? row.coef10 : 0) || 0,
      semidia,
      mode: asphericMode
    };
    
    // Extract material
    const material = String(row.material || row.glass || '');
    const refractiveIndexCache = new Map<number, number>();
    
    // Pre-cache common wavelengths if material is known
    // (This will be populated on-demand during ray tracing)
    
    // Coordinate transformation (placeholder - will be computed by calculateSurfaceOrigins)
    const hasTransform = false;
    
    // Aperture type
    const apertureType = String(row.aperture_type || row.apertureType || 'circular').toLowerCase();
    const apertureParams = {
      semidia,
      // Additional aperture parameters can be added here
    };
    
    result.push({
      row,
      type,
      isReflective,
      isStop,
      isObject,
      isCoordTrans,
      isImage,
      radius,
      conic,
      thickness,
      semidia,
      asphericParams,
      material,
      refractiveIndexCache,
      hasTransform,
      apertureType,
      apertureParams
    });
  }
  
  return result;
}

/**
 * Cache for pre-computed surface data
 * Uses WeakMap to allow GC when optical system is no longer referenced
 */
const precomputedDataCache = new WeakMap<any[], PrecomputedSurfaceData[]>();

/**
 * Get or create pre-computed surface data for an optical system
 * @param tableOpticalSystem - Optical system table data
 * @returns Cached or newly computed surface data
 */
export function getPrecomputedSurfaceData(tableOpticalSystem: any[]): PrecomputedSurfaceData[] {
  if (!Array.isArray(tableOpticalSystem)) {
    return [];
  }
  
  // Check cache first
  let cached = precomputedDataCache.get(tableOpticalSystem);
  if (cached) {
    return cached;
  }
  
  // Compute and cache
  const computed = preprocessOpticalSystem(tableOpticalSystem);
  precomputedDataCache.set(tableOpticalSystem, computed);
  return computed;
}

/**
 * Invalidate pre-computed data cache for an optical system
 * Call this when optical system is modified
 * @param tableOpticalSystem - Optical system table data
 */
export function invalidatePrecomputedData(tableOpticalSystem: any[]): void {
  if (Array.isArray(tableOpticalSystem)) {
    precomputedDataCache.delete(tableOpticalSystem);
  }
}
