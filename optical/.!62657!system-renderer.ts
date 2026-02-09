/**
 * Optical system renderer for 3D visualization
 */



import * as THREE from 'three';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin, drawToricSurfaceWithOrigin,
         drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, 
         drawSemidiaRingWithOriginAndSurface, drawRectApertureWithOriginAndSurface, asphericSurfaceZ, toricSurfaceZ, addMirrorBackText } from './surface.ts';

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const COORD_BREAK_DEBUG_STORAGE_KEY = 'coopt.debug.coordTrans';

function __coopt_isCoordTransDebugEnabled() {
    try {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        if (g && g.__COOPT_DEBUG_COORD_BREAK) return true;
        // If running inside an iframe, allow enabling from parent.
        try {
            if (g && g.parent && g.parent !== g && g.parent.__COOPT_DEBUG_COORD_BREAK) return true;
        } catch (_) {}
        // Also allow enabling via localStorage so both parent/child frames can see it.
        try {
            if (typeof localStorage !== 'undefined') {
                const v = String(localStorage.getItem(COORD_BREAK_DEBUG_STORAGE_KEY) ?? '').trim();
                if (v && v !== '0' && v.toLowerCase() !== 'false') return true;
            }
        } catch (_) {}
    } catch (_) {}
    return false;
}

function __coopt_isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function __coopt_parseColorToInt(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (/^0x[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(1), 16);
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function __coopt_surfaceColorKey(surface, index0) {
    try {
        const bid = String(surface?._blockId ?? '').trim();
        const role = String(surface?._surfaceRole ?? '').trim();
        if (bid && role) return `p:${bid}|${role}`;
    } catch (_) {}

    try {
        const sid = Number(surface?.id);
        if (Number.isFinite(sid)) return `id:${Math.floor(sid)}`;
    } catch (_) {}

    return `i:${Math.floor(Number(index0) || 0)}`;
}

function __coopt_parseNumberOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function __coopt_getRenderSemidiaMm(surface) {
    if (!surface || typeof surface !== 'object') return null;

    // CB rows propagate the prior surface's semidia in a dedicated field
    // to avoid confusing it with decenterX (which reuses the semidia column).
    const cbActual = __coopt_parseNumberOrNull(surface.__cooptActualSemidia);
    if (cbActual !== null && cbActual > 0) return cbActual;

    const candidates = [
        surface.semidia,
        surface.SemiDia,
        surface['Semi Dia'],
        surface['semi dia'],
        surface['Semi Diameter'],
        surface['semi diameter'],
        surface.semiDia,
        surface.semiDiameter,
        surface.semidiameter,
        surface['semi_diameter'],
        surface['semi-diameter'],
    ];

    for (const c of candidates) {
        const n = __coopt_parseNumberOrNull(c);
        if (n !== null && n > 0) return n;
    }

    // Stop surfaces may supply diameter-like aperture.
    try {
        const objTypeRaw = surface['object type'] ?? surface.object ?? surface.objectType ?? surface.type;
        const objType = String(objTypeRaw ?? '').trim().toLowerCase();
        const isStop = objType === 'stop' || objType === 'sto';
        if (isStop) {
            const ap = __coopt_parseNumberOrNull(surface.aperture ?? surface.Aperture ?? surface.diameter);
            if (ap !== null && ap > 0) return ap / 2;
        }
    } catch (_) {}

    return null;
}

function __coopt_getRenderApertureShape(surface) {
    const raw = surface?._apertureShape ?? surface?.apertureShape ?? surface?.ApertureShape;
    const s = String(raw ?? '').trim();
    if (!s) return 'Circular';
    const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
    if (key === 'circle' || key === 'circular') return 'Circular';
    if (key === 'square' || key === 'sq') return 'Square';
    if (key === 'rect' || key === 'rectangle' || key === 'rectangular') return 'Rectangular';
    return 'Circular';
}

function __coopt_getRenderApertureDims(surface) {
    const wRaw = surface?._apertureWidth ?? surface?.apertureWidth ?? surface?.apertureX ?? surface?.apertureWidthMm;
    const hRaw = surface?._apertureHeight ?? surface?.apertureHeight ?? surface?.apertureY ?? surface?.apertureHeightMm;
    const w = __coopt_parseNumberOrNull(wRaw);
    const h = __coopt_parseNumberOrNull(hRaw);
    return { width: w, height: h };
}

function __coopt_getCrosshairHalfExtents(surface, fallbackSemidia) {
    const shape = __coopt_getRenderApertureShape(surface);
    const { width, height } = __coopt_getRenderApertureDims(surface);
    const fallback = (Number.isFinite(fallbackSemidia) && fallbackSemidia > 0) ? fallbackSemidia : 0;

    if (shape === 'Square') {
        const side = (width !== null && width > 0) ? width : ((height !== null && height > 0) ? height : (fallback > 0 ? fallback * 2 : 0));
        const half = side > 0 ? side / 2 : fallback;
        return { halfX: half, halfY: half };
    }

    if (shape === 'Rectangular') {
        const w = (width !== null && width > 0) ? width : ((height !== null && height > 0) ? height : (fallback > 0 ? fallback * 2 : 0));
        const h = (height !== null && height > 0) ? height : ((width !== null && width > 0) ? width : (fallback > 0 ? fallback * 2 : 0));
        return { halfX: w > 0 ? w / 2 : fallback, halfY: h > 0 ? h / 2 : fallback };
    }

    return { halfX: fallback, halfY: fallback };
}

function __coopt_drawApertureOutline(scene, surface, semidia, origin, rotationMatrix, color) {
    const shape = __coopt_getRenderApertureShape(surface);
    const { width, height } = __coopt_getRenderApertureDims(surface);

    if (shape === 'Square') {
        const side = (width !== null) ? width : height;
        if (side !== null && side > 0) {
            drawRectApertureWithOriginAndSurface(scene, side, side, 128, color, origin, rotationMatrix, surface);
            return;
        }
    }

    if (shape === 'Rectangular') {
        if (width !== null && width > 0 && height !== null && height > 0) {
            drawRectApertureWithOriginAndSurface(scene, width, height, 128, color, origin, rotationMatrix, surface);
            return;
        }
    }

    drawSemidiaRingWithOriginAndSurface(scene, semidia, 100, color, origin, rotationMatrix, surface);
}

function __coopt_loadSurfaceColorOverrides() {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return __coopt_isPlainObject(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

/**
 * Draw optical system surfaces
 * @param {Object} options - Drawing options
 * @param {boolean} options.crossSectionOnly - Only draw cross-sections
 * @param {THREE.Scene} options.scene - Three.js scene
 * @param {boolean} options.showSurfaceOrigins - Show surface origins
 * @param {boolean} options.showSemidiaRing - Show semidia rings
 * @param {boolean} options.showMirrorBackText - Show mirror back text
 * @param {string} options.crossSectionDirection - Cross-section direction (YZ or XZ)
 * @param {number} options.crossSectionCenterOffset - Center offset for cross-section
 * @param {Array} options.opticalSystemData - Optical system data
 */
export function drawOpticalSystemSurfaces(options = {}) {
    
    const {
        crossSectionOnly = false,
        scene,
        showSurfaceOrigins = false,
        showSemidiaRing = false,
        showMirrorBackText = false,
        crossSectionDirection = 'YZ',
        viewPlane = null,
        crossSectionCenterOffset = 0,
        opticalSystemData
    } = options;

