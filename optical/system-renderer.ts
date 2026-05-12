/**
 * Optical system renderer for 3D visualization
 */

import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin, drawToricSurfaceWithOrigin,
         drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, 
         drawSemidiaRingWithOriginAndSurface, drawRectApertureWithOriginAndSurface, asphericSurfaceZ, toricSurfaceZ, addMirrorBackText,
         drawConnectionCornerRings3D } from './surface.ts';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { calculatePrincipalPointPositions } from '../raytracing/core/ray-paraxial.ts';

type CooptPerfCounter = {
    count: number;
    totalMs: number;
    maxMs: number;
    lastMs: number;
};

function recordCooptPerfSample(name, durationMs) {
    const safeDuration = Number(durationMs);
    if (!name || !Number.isFinite(safeDuration) || safeDuration < 0) return;
    try {
        const g = globalThis;
        if (!g.__cooptPerf || typeof g.__cooptPerf !== 'object') {
            g.__cooptPerf = { samples: {} };
        }
        if (!g.__cooptPerf.samples || typeof g.__cooptPerf.samples !== 'object') {
            g.__cooptPerf.samples = {};
        }
        const current = g.__cooptPerf.samples[name] || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
        current.count += 1;
        current.totalMs += safeDuration;
        current.maxMs = Math.max(current.maxMs, safeDuration);
        current.lastMs = safeDuration;
        g.__cooptPerf.samples[name] = current;
    } catch (_) {}
}

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const COORD_BREAK_DEBUG_STORAGE_KEY = 'coopt.debug.coordTrans';
const RENDER_LABEL_TOGGLE_STORAGE_KEY = 'coopt.render.showDesignIntentLabels';
const RENDER_PRINCIPAL_POINT_LABEL_TOGGLE_STORAGE_KEY = 'coopt.render.showPrincipalPointLabels';
const RENDER_SURFACE_NUMBER_LABEL_TOGGLE_STORAGE_KEY = 'coopt.render.showSurfaceNumberLabels';

function __coopt_isCoordTransDebugEnabled() {
    try {
        const g: any = (typeof globalThis !== 'undefined') ? globalThis : null;
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
    if (__coopt_isCoordTransSurface(surface)) {
        const cbActual = __coopt_parseNumberOrNull(surface.__cooptActualSemidia);
        if (cbActual !== null && cbActual > 0) return cbActual;
    }

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

    // Paraxial/ThinLens is an ideal zero-thickness element. Existing projects may
    // not carry an explicit aperture/semidia, but it still needs a finite visual
    // height so the ideal-lens symbol and principal-point dimensions can render.
    try {
        if (__coopt_isThinLensSurface(surface)) return 10;
    } catch (_) {}

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

function __coopt_isGapSurface(surface) {
    if (!surface || typeof surface !== 'object') return false;

    const blockType = String(surface._blockType ?? surface.blockType ?? '').trim().toLowerCase();
    if (blockType === 'gap' || blockType === 'airgap') return true;

    const objType = String(surface['object type'] ?? surface.object ?? surface.objectType ?? surface.type ?? '').trim().toLowerCase();
    if (objType === 'gap' || objType === 'airgap' || objType === 'air gap') return true;

    const role = String(surface._surfaceRole ?? '').trim().toLowerCase();
    if (role === 'gap' || role === 'airgap') return true;

    return false;
}

function __coopt_isCoordTransSurface(surface) {
    if (!surface || typeof surface !== 'object') return false;

    const values = [
        surface.surfType, surface.type, surface.surfaceType, surface.surface_type,
        surface['object type'], surface.object, surface.Object,
        surface.comment, surface.Comment,
        surface._blockType, surface.blockType, surface.block_type, surface.blockTypeName,
    ];

    return values.some((value) => {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized) return false;
        return normalized === 'ct'
            || normalized === 'coordtrans'
            || normalized === 'coordinatebreak'
            || normalized === 'coord trans'
            || normalized === 'coordinate break'
            || normalized.includes('coord trans')
            || normalized.includes('coordinate break');
    });
}

function __coopt_isThinLensSurface(surface) {
    if (!surface || typeof surface !== 'object') return false;
    const blockType = String(surface._blockType ?? surface.blockType ?? '').trim().toLowerCase();
    return blockType === 'thinlens' || blockType === 'paraxial';
}

function __coopt_isThinLensBackSurface(surface) {
    return __coopt_isThinLensSurface(surface)
        && String(surface._surfaceRole ?? '').trim().toLowerCase() === 'back';
}

function __coopt_makeFlatThinLensSurface(surface) {
    if (!__coopt_isThinLensSurface(surface)) return surface;
    return {
        ...surface,
        surfType: 'Spherical',
        radius: 'INF',
        radiusX: 'INF',
        radiusY: 'INF',
        conic: '',
        axis: '',
        coef1: '', coef2: '', coef3: '', coef4: '', coef5: '',
        coef6: '', coef7: '', coef8: '', coef9: '', coef10: ''
    };
}

function __coopt_isStopSurface(surface) {
    if (!surface || typeof surface !== 'object') return false;

    const candidates = [
        surface.type,
        surface.surfType,
        surface['object type'],
        surface.object,
        surface.objectType,
    ];

    for (const value of candidates) {
        const normalized = String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, '');
        if (normalized === 'stop' || normalized === 'sto' || normalized === 'aperturestop') {
            return true;
        }
    }

    return false;
}

function __coopt_isObjectSurface(surface) {
    if (!surface || typeof surface !== 'object') return false;
    const objType = String(surface['object type'] ?? surface.object ?? surface.objectType ?? surface.type ?? '')
        .trim()
        .toLowerCase()
    .replace(/[\s_-]+/g, '');
    const blockType = String(surface._blockType ?? surface.blockType ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
    return objType === 'object' || objType === 'objectsurface' || blockType === 'objectsurface';
}

function __coopt_isImageSurface(surface) {
    if (!surface || typeof surface !== 'object') return false;
    const objType = String(surface['object type'] ?? surface.object ?? surface.objectType ?? surface.type ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
    const surfType = String(surface.surfType ?? surface.type ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
    const blockType = String(surface._blockType ?? surface.blockType ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
    return surfType === 'imagesurface' || objType === 'image' || objType === 'imagesurface' || blockType === 'imagesurface';
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

function __coopt_getImageSemidiaWarningColor(surface, fallbackColor) {
    const shortfall = Number(surface?.__cooptRenderImageSemidiaWarning?.shortfall);
    if (Number.isFinite(shortfall) && shortfall > 1e-6) return 0xd92d20;
    return fallbackColor;
}

function __coopt_withSurfaceRenderMeta(surface, surfaceIndex0) {
    if (!surface || typeof surface !== 'object') return surface;
    return {
        ...surface,
        __cooptSurfaceIndex0: surfaceIndex0,
    };
}

function __coopt_computeRenderableCenter(object3d) {
    try {
        const posAttr = object3d?.geometry?.getAttribute?.('position');
        if (!posAttr || !Number.isFinite(Number(posAttr.count)) || posAttr.count <= 0) return null;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (let i = 0; i < posAttr.count; i += 1) {
            sx += Number(posAttr.getX(i)) || 0;
            sy += Number(posAttr.getY(i)) || 0;
            sz += Number(posAttr.getZ(i)) || 0;
        }
        const inv = 1 / posAttr.count;
        return { x: sx * inv, y: sy * inv, z: sz * inv };
    } catch (_) {
        return null;
    }
}

function __coopt_removeSceneObject(scene, object3d) {
    if (!scene || !object3d) return;
    try { scene.remove(object3d); } catch (_) {}
    try { object3d.geometry?.dispose?.(); } catch (_) {}
    try {
        if (Array.isArray(object3d.material)) {
            object3d.material.forEach((m) => m?.dispose?.());
        } else {
            object3d.material?.dispose?.();
        }
    } catch (_) {}
}

function __coopt_isImageSurfaceDiagEnabled() {
    try {
        const w = (typeof window !== 'undefined') ? window : null;
        if (w && (w as any).__cooptImageSurfaceDiag === true) return true;
    } catch (_) {}
    return false;
}

let __coopt_lastImageSurfaceDiagRunAtMs = 0;
function __coopt_shouldRunImageSurfaceDiag() {
    if (!__coopt_isImageSurfaceDiagEnabled()) return false;
    const now = Date.now();
    if (now - __coopt_lastImageSurfaceDiagRunAtMs < 1200) return false;
    __coopt_lastImageSurfaceDiagRunAtMs = now;
    return true;
}

function __coopt_getExpectedImageOriginFromPreviousRow(opticalSystemData, surfaceOrigins, imageIndex0) {
    if (!Array.isArray(opticalSystemData) || !Array.isArray(surfaceOrigins)) return null;
    if (!Number.isInteger(imageIndex0) || imageIndex0 <= 0) return null;
    const prevRow = opticalSystemData[imageIndex0 - 1];
    const prevEntry = surfaceOrigins[imageIndex0 - 1];
    if (!prevRow || !prevEntry?.origin) return null;

    const hasAttachedGap = (prevRow as any)?.__cooptGapApplied === true;
    const spacingRaw = hasAttachedGap
        ? ((prevRow as any).__cooptGapThickness ?? prevRow?.thickness)
        : (prevRow?.thickness ?? (prevRow as any).__cooptGapThickness);
    const spacing = __coopt_parseNumberOrNull(spacingRaw);
    if (spacing === null || !Number.isFinite(spacing) || spacing === 0) return null;

    const prevRot = prevEntry.rotationMatrix;
    const axis = (Array.isArray(prevRot) && prevRot.length >= 3)
        ? {
            x: Number(prevRot?.[0]?.[2]) || 0,
            y: Number(prevRot?.[1]?.[2]) || 0,
            z: Number(prevRot?.[2]?.[2]) || 1,
        }
        : { x: 0, y: 0, z: 1 };

    return {
        x: Number(prevEntry.origin.x || 0) + axis.x * spacing,
        y: Number(prevEntry.origin.y || 0) + axis.y * spacing,
        z: Number(prevEntry.origin.z || 0) + axis.z * spacing,
    };
}

function __coopt_dedupeImageSurfaceArtifacts(scene, imageSurfaceIndex0, expectedOrigin) {
    if (!scene || !Number.isInteger(imageSurfaceIndex0)) return;
    const expected = expectedOrigin || { x: 0, y: 0, z: 0 };
    const rings = [];
    const crossY = [];
    const crossX = [];

    scene.traverse((child) => {
        const ud = child?.userData;
        if (!ud || typeof ud !== 'object') return;
        if (ud.type === 'semidiaRing' && Number(ud.surfaceIndex0) === imageSurfaceIndex0) {
            rings.push(child);
            return;
        }
        if (ud.type === 'plane-crosshair' && Number(ud.surfaceIndex) === imageSurfaceIndex0) {
            const dir = String(ud.direction || '').toLowerCase();
            if (dir === 'vertical') crossY.push(child);
            if (dir === 'horizontal') crossX.push(child);
        }
    });

    const distance2 = (obj) => {
        const c = __coopt_computeRenderableCenter(obj);
        if (!c) return Number.POSITIVE_INFINITY;
        const dx = c.x - expected.x;
        const dy = c.y - expected.y;
        const dz = c.z - expected.z;
        return dx * dx + dy * dy + dz * dz;
    };

    const dedupeList = (items) => {
        if (!Array.isArray(items) || items.length <= 1) return;
        const sorted = [...items].sort((a, b) => distance2(a) - distance2(b));
        for (let i = 1; i < sorted.length; i += 1) {
            __coopt_removeSceneObject(scene, sorted[i]);
        }
    };

    dedupeList(rings);
    dedupeList(crossY);
    dedupeList(crossX);
}

function __coopt_pruneNearbyNonImageRings(scene, imageSurfaceIndex0, expectedOrigin, toleranceMm = 2.0) {
    if (!scene || !Number.isInteger(imageSurfaceIndex0) || !expectedOrigin) return;
    const tol = Number(toleranceMm);
    if (!Number.isFinite(tol) || tol <= 0) return;

    const expected = {
        x: Number(expectedOrigin.x || 0),
        y: Number(expectedOrigin.y || 0),
        z: Number(expectedOrigin.z || 0),
    };

    const nearby = [];
    scene.traverse((child) => {
        const ud = child?.userData;
        if (!ud || ud.type !== 'semidiaRing') return;
        const ringSurfaceIndex0 = Number(ud.surfaceIndex0);
        if (Number.isInteger(ringSurfaceIndex0) && ringSurfaceIndex0 === imageSurfaceIndex0) return;

        const center = __coopt_computeRenderableCenter(child);
        if (!center) return;
        const dx = center.x - expected.x;
        const dy = center.y - expected.y;
        const dz = center.z - expected.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Number.isFinite(dist) && dist <= tol) {
            nearby.push({ child, dist, surfaceIndex0: Number.isInteger(ringSurfaceIndex0) ? ringSurfaceIndex0 : null });
        }
    });

    if (nearby.length <= 3) return;

    const sorted = nearby.sort((a, b) => a.dist - b.dist);
    const indexedBySurface = new Map();
    const unindexedEntries = [];

    for (const entry of sorted) {
        if (entry.surfaceIndex0 === null) {
            unindexedEntries.push(entry);
            continue;
        }
        const key = String(entry.surfaceIndex0);
        if (!indexedBySurface.has(key)) {
            indexedBySurface.set(key, entry);
        }
    }

    const keepObjects = new Set(
        Array.from(indexedBySurface.values())
            .sort((a, b) => {
                if (b.surfaceIndex0 !== a.surfaceIndex0) return b.surfaceIndex0 - a.surfaceIndex0;
                return a.dist - b.dist;
            })
            .slice(0, 3)
            .map((entry) => entry.child)
    );

    if (keepObjects.size === 0 && unindexedEntries.length > 0) {
        keepObjects.add(unindexedEntries[0].child);
    }

    const toRemove = sorted
        .filter((entry) => !keepObjects.has(entry.child))
        .map((entry) => entry.child);

    if (toRemove.length > 0) {
        for (const obj of toRemove) {
            __coopt_removeSceneObject(scene, obj);
        }
        if (__coopt_isImageSurfaceDiagEnabled()) {
            console.log('[ImageSurfaceDiag] pruned nearby non-image rings', {
                imageSurfaceIndex0,
                removedCount: toRemove.length,
                toleranceMm: tol,
            });
        }
    }
}

function __coopt_removeUnindexedSemidiaRings(scene) {
    if (!scene) return;
    const toRemove = [];
    scene.traverse((child) => {
        const ud = child?.userData;
        if (!ud || ud.type !== 'semidiaRing') return;
        const idx = Number(ud.surfaceIndex0);
        if (!Number.isInteger(idx)) {
            toRemove.push(child);
        }
    });

    if (toRemove.length > 0) {
        for (const obj of toRemove) {
            __coopt_removeSceneObject(scene, obj);
        }
        if (__coopt_isImageSurfaceDiagEnabled()) {
            console.log('[ImageSurfaceDiag] removed unindexed semidia rings', {
                removedCount: toRemove.length,
            });
        }
    }
}

function __coopt_pruneNearbyConnectionCornerRings(scene, expectedOrigin, toleranceMm = 8.0) {
    if (!scene || !expectedOrigin) return;
    const tol = Number(toleranceMm);
    if (!Number.isFinite(tol) || tol <= 0) return;

    const expected = {
        x: Number(expectedOrigin.x || 0),
        y: Number(expectedOrigin.y || 0),
        z: Number(expectedOrigin.z || 0),
    };

    const toRemove = [];
    scene.traverse((child) => {
        const ud = child?.userData;
        if (!ud || ud.type !== 'connectionCornerRing') return;
        const center = __coopt_computeRenderableCenter(child);
        if (!center) return;
        const dx = center.x - expected.x;
        const dy = center.y - expected.y;
        const dz = center.z - expected.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Number.isFinite(dist) && dist <= tol) {
            toRemove.push(child);
        }
    });

    if (toRemove.length > 0) {
        for (const obj of toRemove) {
            __coopt_removeSceneObject(scene, obj);
        }
        if (__coopt_isImageSurfaceDiagEnabled()) {
            console.log('[ImageSurfaceDiag] pruned nearby connection corner rings', {
                removedCount: toRemove.length,
                toleranceMm: tol,
            });
        }
    }
}

function __coopt_translateRenderableGeometry(object3d, dx, dy, dz) {
    if (!object3d?.geometry || (!dx && !dy && !dz)) return;
    try {
        const posAttr = object3d.geometry.getAttribute?.('position');
        if (!posAttr || !Number.isFinite(Number(posAttr.count)) || posAttr.count <= 0) return;
        for (let i = 0; i < posAttr.count; i += 1) {
            posAttr.setXYZ(
                i,
                (Number(posAttr.getX(i)) || 0) + dx,
                (Number(posAttr.getY(i)) || 0) + dy,
                (Number(posAttr.getZ(i)) || 0) + dz
            );
        }
        posAttr.needsUpdate = true;
        object3d.geometry.computeBoundingSphere?.();
        object3d.geometry.computeBoundingBox?.();
    } catch (_) {}
}

function __coopt_snapImageSurfaceArtifactsToOrigin(scene, imageSurfaceIndex0, expectedOrigin) {
    if (!scene || !Number.isInteger(imageSurfaceIndex0) || !expectedOrigin) return;
    const targets = [];
    scene.traverse((child) => {
        const ud = child?.userData;
        if (!ud || typeof ud !== 'object') return;
        if (ud.type === 'semidiaRing' && Number(ud.surfaceIndex0) === imageSurfaceIndex0) {
            targets.push(child);
            return;
        }
        if (ud.type === 'plane-crosshair' && Number(ud.surfaceIndex) === imageSurfaceIndex0) {
            targets.push(child);
        }
    });

    for (const obj of targets) {
        const center = __coopt_computeRenderableCenter(obj);
        if (!center) continue;
        const dx = Number(expectedOrigin.x || 0) - center.x;
        const dy = Number(expectedOrigin.y || 0) - center.y;
        const dz = Number(expectedOrigin.z || 0) - center.z;
        const err2 = dx * dx + dy * dy + dz * dz;
        if (err2 > 1e-10) {
            __coopt_translateRenderableGeometry(obj, dx, dy, dz);
        }
    }
}

function __coopt_logImageRingDiagnostics(scene, imageSurfaceIndex0, expectedOrigin) {
    if (!__coopt_shouldRunImageSurfaceDiag()) return;
    if (!scene || !Number.isInteger(imageSurfaceIndex0)) return;

    const expected = expectedOrigin || { x: 0, y: 0, z: 0 };
    const ringRows = [];
    const crossRows = [];
    const cornerRingRows = [];

    const distMm = (center) => {
        if (!center) return Number.POSITIVE_INFINITY;
        const dx = Number(center.x || 0) - Number(expected.x || 0);
        const dy = Number(center.y || 0) - Number(expected.y || 0);
        const dz = Number(center.z || 0) - Number(expected.z || 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    scene.traverse((child) => {
        const ud = child?.userData;
        if (!ud || typeof ud !== 'object') return;

        if (ud.type === 'semidiaRing') {
            const center = __coopt_computeRenderableCenter(child);
            ringRows.push({
                surfaceIndex0: Number.isInteger(Number(ud.surfaceIndex0)) ? Number(ud.surfaceIndex0) : null,
                semidia: Number.isFinite(Number(ud.semidia)) ? Number(ud.semidia) : null,
                center,
                distanceToExpectedMm: distMm(center),
                name: String(child?.name || ''),
            });
            return;
        }

        if (ud.type === 'plane-crosshair') {
            const center = __coopt_computeRenderableCenter(child);
            crossRows.push({
                surfaceIndex: Number.isInteger(Number(ud.surfaceIndex)) ? Number(ud.surfaceIndex) : null,
                direction: String(ud.direction || ''),
                center,
                distanceToExpectedMm: distMm(center),
                name: String(child?.name || ''),
            });
            return;
        }

        if (ud.type === 'connectionCornerRing') {
            const center = __coopt_computeRenderableCenter(child);
            cornerRingRows.push({
                surfaceIndex: Number.isInteger(Number(ud.surfaceIndex)) ? Number(ud.surfaceIndex) : null,
                direction: String(ud.direction || ''),
                center,
                distanceToExpectedMm: distMm(center),
                name: String(child?.name || ''),
            });
        }
    });

    const countsBySurfaceIndex0 = {};
    for (const row of ringRows) {
        const key = String(row.surfaceIndex0);
        countsBySurfaceIndex0[key] = (Number(countsBySurfaceIndex0[key]) || 0) + 1;
    }

    const nearExpectedRings = ringRows
        .filter((row) => Number.isFinite(Number(row.distanceToExpectedMm)) && Number(row.distanceToExpectedMm) <= 2.0)
        .sort((a, b) => Number(a.distanceToExpectedMm) - Number(b.distanceToExpectedMm));

    const imageCrossRows = crossRows
        .filter((row) => row.surfaceIndex === imageSurfaceIndex0)
        .sort((a, b) => Number(a.distanceToExpectedMm) - Number(b.distanceToExpectedMm));

    const nearExpectedCornerRings = cornerRingRows
        .filter((row) => Number.isFinite(Number(row.distanceToExpectedMm)) && Number(row.distanceToExpectedMm) <= 8.0)
        .sort((a, b) => Number(a.distanceToExpectedMm) - Number(b.distanceToExpectedMm));

    console.log('[ImageSurfaceDiag] render summary', {
        imageSurfaceIndex0,
        expectedOrigin: {
            x: Number(expected.x || 0),
            y: Number(expected.y || 0),
            z: Number(expected.z || 0),
        },
        ringCount: ringRows.length,
        crosshairCount: crossRows.length,
        connectionCornerRingCount: cornerRingRows.length,
        ringCountsBySurfaceIndex0: countsBySurfaceIndex0,
        nearExpectedRingCount: nearExpectedRings.length,
        nearExpectedConnectionCornerRingCount: nearExpectedCornerRings.length,
        imageCrosshairCount: imageCrossRows.length,
    });

    console.log('[ImageSurfaceDiag] near-expected rings (<=2mm)', nearExpectedRings.slice(0, 12));
    console.log('[ImageSurfaceDiag] near-expected connection corner rings (<=8mm)', nearExpectedCornerRings.slice(0, 12));
    console.log('[ImageSurfaceDiag] image crosshairs', imageCrossRows.slice(0, 12));
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

function __coopt_shouldShowDesignIntentLabels(value) {
    if (typeof value === 'boolean') return value;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = String(localStorage.getItem(RENDER_LABEL_TOGGLE_STORAGE_KEY) ?? '').trim().toLowerCase();
            if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
            if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
        }
    } catch (_) {}
    return false;
}

function __coopt_shouldShowPrincipalPointLabels(value) {
    if (typeof value === 'boolean') return value;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = String(localStorage.getItem(RENDER_PRINCIPAL_POINT_LABEL_TOGGLE_STORAGE_KEY) ?? '').trim().toLowerCase();
            if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
            if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
        }
    } catch (_) {}
    return false;
}

function __coopt_shouldShowSurfaceNumberLabels(value) {
    if (typeof value === 'boolean') return value;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = String(localStorage.getItem(RENDER_SURFACE_NUMBER_LABEL_TOGGLE_STORAGE_KEY) ?? '').trim().toLowerCase();
            if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
            if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
        }
    } catch (_) {}
    return false;
}

function __coopt_normalizeBlockDisplayType(blockType) {
    const raw = String(blockType ?? '').trim();
    if (!raw) return '';
    if (raw === 'PositiveLens') return 'Lens';
    if (raw === 'Paraxial') return 'Paraxial';
    if (raw === 'ObjectPlane') return 'ObjectSurface';
    return raw;
}

function __coopt_isRenderableDesignIntentBlockType(blockType) {
    const t = __coopt_normalizeBlockDisplayType(blockType).toLowerCase();
    if (!t) return false;
    return !(t === 'coordtrans' || t === 'coord trans' || t === 'coordinate transform' || t === 'coordinatebreak' || t === 'coordinate break');
}

function __coopt_getActiveDesignIntentBlocks() {
    try {
        const w = (typeof window !== 'undefined') ? window : null;
        if (!w) return [];
        const systemConfig = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
            ? w.loadSystemConfigurationsFromTableConfig()
            : ((typeof w.loadSystemConfigurations === 'function') ? w.loadSystemConfigurations() : null);
        const activeId = systemConfig?.activeConfigId;
        const activeCfg = Array.isArray(systemConfig?.configurations)
            ? (systemConfig.configurations.find((cfg) => cfg && String(cfg.id) === String(activeId)) || systemConfig.configurations[0])
            : null;
        const blocks = Array.isArray(activeCfg?.blocks) ? activeCfg.blocks : [];
        return blocks.filter((block) => block && __coopt_isRenderableDesignIntentBlockType(block.blockType));
    } catch (_) {
        return [];
    }
}

function __coopt_vectorFromOriginEntry(entry) {
    const origin = entry?.origin || entry || {};
    return new THREE.Vector3(
        Number(origin?.x) || 0,
        Number(origin?.y) || 0,
        Number(origin?.z) || 0
    );
}

function __coopt_averageOriginForRange(surfaceOrigins, minIdx, maxIdx) {
    if (!Array.isArray(surfaceOrigins) || surfaceOrigins.length === 0) return null;
    const start = Math.max(0, Math.min(surfaceOrigins.length - 1, Number(minIdx) || 0));
    const end = Math.max(start, Math.min(surfaceOrigins.length - 1, Number(maxIdx) || start));
    const acc = new THREE.Vector3(0, 0, 0);
    let count = 0;
    for (let i = start; i <= end; i += 1) {
        const v = __coopt_vectorFromOriginEntry(surfaceOrigins[i]);
        acc.add(v);
        count += 1;
    }
    return count > 0 ? acc.multiplyScalar(1 / count) : null;
}

function __coopt_buildSurfRangeByBlockId(opticalSystemData) {
    const surfRangeByBlockId = new Map();
    if (!Array.isArray(opticalSystemData)) return surfRangeByBlockId;
    for (let i = 0; i < opticalSystemData.length; i += 1) {
        const row = opticalSystemData[i];
        const blockId = String(row?._blockId ?? '').trim();
        if (!blockId) continue;

        const blockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase();
        const surfaceRole = String(row?._surfaceRole ?? row?.surfaceRole ?? '').trim().toLowerCase();
        if ((blockType === 'paraxial' || blockType === 'thinlens') && surfaceRole === 'back') continue;

        const prev = surfRangeByBlockId.get(blockId);
        if (!prev) surfRangeByBlockId.set(blockId, { min: i, max: i });
        else {
            if (i < prev.min) prev.min = i;
            if (i > prev.max) prev.max = i;
        }
    }
    return surfRangeByBlockId;
}

function __coopt_formatSurfRangeText(range) {
    if (!range || !Number.isFinite(Number(range.min)) || !Number.isFinite(Number(range.max))) return '';
    return (range.min === range.max)
        ? `Surf ${range.min}`
        : `Surf ${range.min}–${range.max}`;
}

function __coopt_getDesignIntentDisplayBase(blockType, blockId) {
    const normalized = __coopt_normalizeBlockDisplayType(blockType);
    if (normalized === 'PositiveLens' || normalized === 'Lens') return 'Lens';
    if (normalized === 'Paraxial') return 'Paraxial';
    if (normalized === 'AirGap' || normalized === 'Gap') return 'Gap';
    if (normalized === 'Doublet' || normalized === 'Triplet' || normalized === 'Mirror' || normalized === 'Stop' || normalized === 'SingleSurface') return normalized;

    const id = String(blockId ?? '').trim();
    if (/^Lens-/i.test(id)) return 'Lens';
    if (/^(Gap|AirGap)-/i.test(id)) return 'Gap';
    if (/^Doublet-/i.test(id)) return 'Doublet';
    if (/^Triplet-/i.test(id)) return 'Triplet';
    if (/^Mirror-/i.test(id)) return 'Mirror';
    if (/^Stop-/i.test(id)) return 'Stop';
    if (/^Surf-/i.test(id)) return 'SingleSurface';

    return '';
}

function __coopt_makeSequentialDesignIntentLabel(displayCounts, blockType, blockId) {
    const base = __coopt_getDesignIntentDisplayBase(blockType, blockId);
    if (!base) return String(blockId ?? '').trim() || String(blockType ?? '').trim();
    const next = (displayCounts.get(base) || 0) + 1;
    displayCounts.set(base, next);
    return `${base}-${next}`;
}

function __coopt_indexToAlphabetLabel(index) {
    let value = Math.max(0, Math.floor(Number(index) || 0));
    let label = '';
    do {
        label = String.fromCharCode(65 + (value % 26)) + label;
        value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return label;
}

function __coopt_makeStandaloneParaxialPrincipalLabel(displayCounts) {
    const key = '__standalone_paraxial_principal_label__';
    const next = Number(displayCounts.get(key) || 0);
    displayCounts.set(key, next + 1);
    return __coopt_indexToAlphabetLabel(next);
}

function __coopt_getDesignIntentLabelStyle(blockType, blockId) {
    const base = __coopt_getDesignIntentDisplayBase(blockType, blockId);
    if (base === 'Lens' || base === 'Paraxial' || base === 'Doublet' || base === 'Triplet') {
        return {
            fillStyle: 'rgba(223,241,255,0.96)',
            strokeStyle: '#bfdbfe',
            textStyle: '#1d4ed8',
            lineColor: 0x93c5fd,
        };
    }
    return {
        fillStyle: 'rgba(255,255,255,0.94)',
        strokeStyle: '#475569',
        textStyle: '#111827',
        lineColor: 0x475569,
    };
}

function __coopt_buildDesignIntentLabelDescriptors(opticalSystemData, surfaceOrigins) {
    const descriptors = [];
    const blocks = __coopt_getActiveDesignIntentBlocks();
    const surfRangeByBlockId = __coopt_buildSurfRangeByBlockId(opticalSystemData);
    const seenIds = new Set();
    const displayCounts = new Map();

    const objectAnchor = Array.isArray(surfaceOrigins) && surfaceOrigins.length > 0 ? __coopt_vectorFromOriginEntry(surfaceOrigins[0]) : null;
    const imageAnchor = Array.isArray(surfaceOrigins) && surfaceOrigins.length > 0 ? __coopt_vectorFromOriginEntry(surfaceOrigins[surfaceOrigins.length - 1]) : null;

    const pushDescriptor = (id, text, anchor, style = null, metadata = null) => {
        const safeId = String(id ?? '').trim();
        if (!safeId || !text || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.z)) return;
        if (seenIds.has(safeId)) return;
        seenIds.add(safeId);
        descriptors.push({
            id: safeId,
            text: String(text),
            anchor,
            style: style || __coopt_getDesignIntentLabelStyle('', safeId),
            blockType: String(metadata?.blockType ?? '').trim(),
            isGap: metadata?.isGap === true,
        });
    };

    if (blocks.length > 0) {
        const findNeighborAnchor = (startIndex, direction) => {
            for (let i = startIndex + direction; i >= 0 && i < blocks.length; i += direction) {
                const block = blocks[i];
                const blockType = __coopt_normalizeBlockDisplayType(block?.blockType);
                const blockId = String(block?.blockId ?? '').trim();
                if (blockType === 'ObjectSurface' && objectAnchor) return objectAnchor.clone();
                if (blockType === 'ImageSurface' && imageAnchor) return imageAnchor.clone();
                const range = blockId ? surfRangeByBlockId.get(blockId) : null;
                if (range) {
                    const idx = direction < 0 ? range.max : range.min;
                    return __coopt_vectorFromOriginEntry(surfaceOrigins[idx]);
                }
            }
            return null;
        };

        for (let i = 0; i < blocks.length; i += 1) {
            const block = blocks[i];
            const blockType = __coopt_normalizeBlockDisplayType(block?.blockType);
            const blockId = String(block?.blockId ?? '').trim() || blockType || `Block-${i + 1}`;
            let anchor = null;

            if (blockType === 'ObjectSurface') {
                continue;
            } else if (blockType === 'ImageSurface') {
                anchor = imageAnchor ? imageAnchor.clone() : null;
            } else {
                const range = surfRangeByBlockId.get(blockId);
                if (range) {
                    anchor = __coopt_averageOriginForRange(surfaceOrigins, range.min, range.max);
                } else if (blockType === 'Gap' || blockType === 'AirGap') {
                    const prevAnchor = findNeighborAnchor(i, -1);
                    const nextAnchor = findNeighborAnchor(i, 1);
                    if (prevAnchor && nextAnchor) anchor = prevAnchor.clone().lerp(nextAnchor, 0.5);
                    else anchor = prevAnchor || nextAnchor;
                }
            }

            const displayText = __coopt_makeSequentialDesignIntentLabel(displayCounts, blockType, blockId);
            const labelStyle = __coopt_getDesignIntentLabelStyle(blockType, blockId);
            pushDescriptor(blockId, displayText, anchor, labelStyle, {
                blockType,
                isGap: blockType === 'Gap' || blockType === 'AirGap',
            });
        }
    }

    if (descriptors.length > 0) return descriptors;

    for (const [blockId, range] of surfRangeByBlockId.entries()) {
        const anchor = __coopt_averageOriginForRange(surfaceOrigins, range.min, range.max);
        if (/^Object(Surface|Plane)?/i.test(String(blockId))) continue;
        const displayText = __coopt_makeSequentialDesignIntentLabel(displayCounts, '', blockId);
        const displayBase = __coopt_getDesignIntentDisplayBase('', blockId);
        pushDescriptor(blockId, displayText, anchor, __coopt_getDesignIntentLabelStyle('', blockId), {
            blockType: displayBase,
            isGap: displayBase === 'Gap',
        });
    }

    return descriptors;
}

function __coopt_addDesignIntentLabelPolyline(scene, points, color = 0x475569) {
    if (!scene || !Array.isArray(points) || points.length < 2) return;
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 65000;
    line.frustumCulled = false;
    line.userData = { type: 'design-intent-label-line', isOpticalElement: true };
    scene.add(line);
}

function __coopt_addDesignIntentLabelSprite(scene, text, position, style = {}) {
    if (!scene || !text || !position) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    const fontPt = Number(style?.fontPt) > 0 ? Number(style.fontPt) : 25;
    const paddingX = Number(style?.paddingX) >= 0 ? Number(style.paddingX) : 10;
    const paddingY = Number(style?.paddingY) >= 0 ? Number(style.paddingY) : 5;
    const fillStyle = String(style?.fillStyle || 'rgba(255,255,255,0.94)');
    const strokeStyle = String(style?.strokeStyle || '#475569');
    const textStyle = String(style?.textStyle || '#111827');
    const fontWeight = String(style?.fontWeight || '600');
    const fontFamily = String(style?.fontFamily || 'Arial, sans-serif');
    const drawFrame = style?.drawFrame !== false;
    const rotation = Number(style?.rotation || 0);
    context.font = `${fontWeight} ${fontPt}pt ${fontFamily}`;
    const metrics = context.measureText(String(text));
    const textHeight = Math.ceil(fontPt * 1.55);
    canvas.width = Math.ceil(metrics.width + paddingX * 2);
    canvas.height = Math.ceil(textHeight + paddingY * 2);

    context.font = `${fontWeight} ${fontPt}pt ${fontFamily}`;
    if (drawFrame) {
        context.fillStyle = fillStyle;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = strokeStyle;
        context.lineWidth = 1;
        context.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    }
    context.fillStyle = textStyle;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(text), canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    spriteMaterial.rotation = rotation;
    sprite.center.set(0.5, 0.5);
    sprite.scale.set(canvas.width / 13, canvas.height / 13, 1);
    sprite.position.copy(position);
    sprite.renderOrder = 65010;
    sprite.frustumCulled = false;
    sprite.userData = { type: 'design-intent-label', isOpticalElement: true, labelText: String(text) };
    scene.add(sprite);
}

function __coopt_measureDesignIntentLabelWorldSize(text, style = {}) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return { width: 24, height: 6 };

    const fontPt = Number(style?.fontPt) > 0 ? Number(style.fontPt) : 25;
    const paddingX = Number(style?.paddingX) >= 0 ? Number(style.paddingX) : 10;
    const paddingY = Number(style?.paddingY) >= 0 ? Number(style.paddingY) : 5;
    const fontWeight = String(style?.fontWeight || '600');
    const fontFamily = String(style?.fontFamily || 'Arial, sans-serif');
    context.font = `${fontWeight} ${fontPt}pt ${fontFamily}`;
    const metrics = context.measureText(String(text));
    const textHeight = Math.ceil(fontPt * 1.55);
    const canvasWidth = Math.ceil(metrics.width + paddingX * 2);
    const canvasHeight = Math.ceil(textHeight + paddingY * 2);

    return {
        width: canvasWidth / 13,
        height: canvasHeight / 13,
    };
}

function __coopt_addDesignIntentLabelsToScene(scene, opticalSystemData, surfaceOrigins, options = {}) {
    if (!scene || !Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return;
    if (!Array.isArray(surfaceOrigins) || surfaceOrigins.length === 0) return;

    const descriptors = __coopt_buildDesignIntentLabelDescriptors(opticalSystemData, surfaceOrigins);
    if (!descriptors.length) return;

    const axis = (String(options?.axis ?? 'YZ').trim().toUpperCase() === 'XZ') ? 'XZ' : 'YZ';
    const getVerticalCoord = (vec) => axis === 'XZ' ? vec.x : vec.y;
    const getDepthCoord = (vec) => axis === 'XZ' ? vec.y : vec.x;
    const makePoint = (vertical, depth, z) => {
        return axis === 'XZ'
            ? new THREE.Vector3(vertical, depth, z)
            : new THREE.Vector3(depth, vertical, z);
    };
    const makeMostlyVerticalLabelPoint = (anchor, labelVertical, zShift) => {
        const anchorVertical = getVerticalCoord(anchor);
        const vertical = Math.abs(labelVertical - anchorVertical) < 0.5 ? (anchorVertical + (labelVertical >= anchorVertical ? 0.5 : -0.5)) : labelVertical;
        return makePoint(vertical, getDepthCoord(anchor), Number(anchor?.z || 0) + zShift);
    };

    let surfaceTop = Number.NEGATIVE_INFINITY;
    let surfaceBottom = Number.POSITIVE_INFINITY;
    for (let i = 0; i < opticalSystemData.length; i += 1) {
        const surface = opticalSystemData[i];
        if (!surface || __coopt_isGapSurface(surface)) continue;
        const originVec = __coopt_vectorFromOriginEntry(surfaceOrigins[i]);
        const semidia = __coopt_getRenderSemidiaMm(surface);
        const cross = __coopt_getCrosshairHalfExtents(surface, semidia ?? 0);
        const halfExtent = axis === 'XZ'
            ? Math.max(Number(cross?.halfX) || 0, Number(semidia) || 0)
            : Math.max(Number(cross?.halfY) || 0, Number(semidia) || 0);
        surfaceTop = Math.max(surfaceTop, getVerticalCoord(originVec) + halfExtent);
        surfaceBottom = Math.min(surfaceBottom, getVerticalCoord(originVec) - halfExtent);
    }
    if (!Number.isFinite(surfaceTop)) {
        surfaceTop = Math.max(...descriptors.map((d) => getVerticalCoord(d.anchor)));
    }
    if (!Number.isFinite(surfaceBottom)) {
        surfaceBottom = Math.min(...descriptors.map((d) => getVerticalCoord(d.anchor)));
    }

    const primaryEntries = descriptors.filter((entry) => entry?.isGap !== true);
    const gapEntries = descriptors.filter((entry) => entry?.isGap === true);

    const layoutGroup = (entries, baseVertical, verticalDir = 1) => {
        const ordered = [...entries];
        const center = (ordered.length - 1) / 2;
        for (let i = 0; i < ordered.length; i += 1) {
            const entry = ordered[i];
            const zShift = (i - center) * 4;
            const verticalOffset = ordered.length > 6 ? Math.floor(i / 6) * 6 : 0;
            const labelVertical = baseVertical + verticalDir * verticalOffset;
            const labelAnchor = makeMostlyVerticalLabelPoint(entry.anchor, labelVertical, zShift);

            __coopt_addDesignIntentLabelPolyline(scene, [entry.anchor.clone(), labelAnchor.clone()], Number(entry?.style?.lineColor ?? 0x475569));
            __coopt_addDesignIntentLabelSprite(scene, entry.text, labelAnchor, entry?.style || {});
        }
    };

    const primaryBase = surfaceTop + 10;
    const gapBase = surfaceBottom - 16;

    layoutGroup(primaryEntries, primaryBase, 1);
    layoutGroup(gapEntries, gapBase, -1);
}

function __coopt_shouldLabelSurfaceNumber(surface) {
    if (!surface || __coopt_isGapSurface(surface) || __coopt_isCoordTransSurface(surface)) return false;
    if (__coopt_isThinLensBackSurface(surface)) return false;
    if (__coopt_isObjectSurface(surface)) return false;
    if (__coopt_isImageSurface(surface)) return false;
    if (__coopt_isStopSurface(surface)) return false;
    return true;
}

function __coopt_addSurfaceNumberLabelsToScene(scene, opticalSystemData, surfaceOrigins, options = {}) {
    if (!scene || !Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return;
    if (!Array.isArray(surfaceOrigins) || surfaceOrigins.length === 0) return;

    const axis = (String(options?.axis ?? 'YZ').trim().toUpperCase() === 'XZ') ? 'XZ' : 'YZ';
    const planeOffset = Number(options?.crossSectionCenterOffset) || 0;
    const getVerticalCoord = (vec) => axis === 'XZ' ? vec.x : vec.y;
    const getHorizontalCoord = (vec) => vec.z;
    const projectPointToSectionPlane = (vec) => {
        return axis === 'XZ'
            ? new THREE.Vector3(Number(vec?.x || 0), planeOffset, Number(vec?.z || 0))
            : new THREE.Vector3(planeOffset, Number(vec?.y || 0), Number(vec?.z || 0));
    };
    const makePoint = (vertical, horizontal) => {
        return axis === 'XZ'
            ? new THREE.Vector3(vertical, planeOffset, horizontal)
            : new THREE.Vector3(planeOffset, vertical, horizontal);
    };

    const labeledRows = [];
    for (let i = 0; i < opticalSystemData.length; i += 1) {
        const surface = opticalSystemData[i];
        if (!__coopt_shouldLabelSurfaceNumber(surface)) continue;
        const anchor = __coopt_vectorFromOriginEntry(surfaceOrigins[i]);
        if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.z)) continue;
        const projectedAnchor = projectPointToSectionPlane(anchor);
        const semidia = __coopt_getRenderSemidiaMm(surface);
        const cross = __coopt_getCrosshairHalfExtents(surface, semidia ?? 0);
        const halfExtent = axis === 'XZ'
            ? Math.max(Number(cross?.halfX) || 0, Number(semidia) || 0)
            : Math.max(Number(cross?.halfY) || 0, Number(semidia) || 0);
        labeledRows.push({
            index0: i,
            anchor: projectedAnchor,
            halfExtent,
            vertical: getVerticalCoord(projectedAnchor),
            horizontal: getHorizontalCoord(projectedAnchor),
        });
    }
    if (!labeledRows.length) return;

    labeledRows.sort((left, right) => {
        const horizontalDelta = left.horizontal - right.horizontal;
        if (Math.abs(horizontalDelta) > 1e-6) return horizontalDelta;
        return left.index0 - right.index0;
    });

    const baseVertical = labeledRows.reduce((maxValue, entry) => {
        return Math.max(maxValue, Number(entry.vertical) + Number(entry.halfExtent));
    }, Number.NEGATIVE_INFINITY) + 10;
    const surfaceNumberLabelStyle = {
        fontPt: 25,
        paddingX: 2,
        paddingY: 1,
        fontWeight: '700',
    };
    const layoutEntries = labeledRows.map((entry, visibleIndex) => {
        const labelText = `S${visibleIndex + 1}`;
        const worldSize = __coopt_measureDesignIntentLabelWorldSize(labelText, surfaceNumberLabelStyle);
        return {
            ...entry,
            labelText,
            width: Math.max(5, Number(worldSize?.width || 0)),
            desiredCenter: Number(entry.horizontal),
            assignedCenter: Number(entry.horizontal),
        };
    });

    const desiredMin = layoutEntries.reduce((minValue, entry) => Math.min(minValue, Number(entry.desiredCenter)), Number.POSITIVE_INFINITY);
    const desiredMax = layoutEntries.reduce((maxValue, entry) => Math.max(maxValue, Number(entry.desiredCenter)), Number.NEGATIVE_INFINITY);
    const desiredMid = Number.isFinite(desiredMin) && Number.isFinite(desiredMax)
        ? (desiredMin + desiredMax) * 0.5
        : 0;
    const minLabelGap = 0;
    const totalPackedWidth = layoutEntries.reduce((sum, entry, index) => {
        const width = Number(entry.width) || 0;
        return sum + width + (index > 0 ? minLabelGap : 0);
    }, 0);
    let cursor = desiredMid - totalPackedWidth * 0.5;
    for (let i = 0; i < layoutEntries.length; i += 1) {
        const entry = layoutEntries[i];
        const halfWidth = entry.width * 0.5;
        cursor += halfWidth;
        entry.assignedCenter = cursor;
        cursor += halfWidth + minLabelGap;
    }

    for (let i = 0; i < layoutEntries.length; i += 1) {
        const entry = layoutEntries[i];
        const assignedHorizontal = entry.assignedCenter;
        const labelAnchor = makePoint(baseVertical, assignedHorizontal);
        __coopt_addDesignIntentLabelPolyline(scene, [entry.anchor.clone(), labelAnchor.clone()], 0x000000);
        __coopt_addDesignIntentLabelSprite(scene, entry.labelText, labelAnchor, {
            ...surfaceNumberLabelStyle,
            fillStyle: 'rgba(248,250,252,0.94)',
            strokeStyle: '#94a3b8',
            textStyle: '#0f172a',
        });
    }
}

function __coopt_getZoomGroupName(block) {
    try {
        const params = (block && typeof block.parameters === 'object') ? block.parameters : null;
        const raw = String(params?.zoomGroup ?? '').trim();
        if (!raw) return '';
        return /^fixed$/i.test(raw) ? '' : raw;
    } catch (_) {
        return '';
    }
}

function __coopt_isPrincipalPointGroupBlockType(blockType) {
    const t = __coopt_normalizeBlockDisplayType(blockType).toLowerCase();
    if (!t) return false;
    return !(t === 'objectsurface'
        || t === 'imagesurface'
        || t === 'gap'
        || t === 'airgap'
        || t === 'stop'
        || t === 'coordtrans'
        || t === 'coord trans'
        || t === 'coordinate transform'
        || t === 'coordinatebreak'
        || t === 'coordinate break');
}

function __coopt_buildPrincipalPointSubsystem(opticalSystemData, startIdx, endIdx) {
    if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
    const start = Math.max(0, Math.min(opticalSystemData.length - 1, Number(startIdx) || 0));
    const end = Math.max(start, Math.min(opticalSystemData.length - 1, Number(endIdx) || start));

    const subsystem = [{
        surface: 0,
        'object type': 'Object',
        thickness: Infinity,
        radius: Infinity,
        comment: 'Virtual Object'
    }];

    for (let i = start; i <= end; i += 1) {
        const row = opticalSystemData[i];
        if (!row || typeof row !== 'object') continue;
        if (__coopt_isGapSurface(row) || __coopt_isCoordTransSurface(row)) continue;
        const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image') continue;
        subsystem.push({ ...row });
    }

    if (subsystem.length <= 1) return null;
    subsystem.push({
        surface: subsystem.length,
        'object type': 'Image',
        thickness: 0,
        radius: Infinity,
        comment: 'Virtual Image'
    });
    return subsystem;
}

function __coopt_getPrincipalPointPhysicalRange(opticalSystemData, startIdx, endIdx) {
    if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

    const start = Math.max(0, Math.min(opticalSystemData.length - 1, Number(startIdx) || 0));
    const end = Math.max(start, Math.min(opticalSystemData.length - 1, Number(endIdx) || start));

    let physicalStart = null;
    for (let i = start; i <= end; i += 1) {
        const row = opticalSystemData[i];
        if (!row || __coopt_isGapSurface(row) || __coopt_isCoordTransSurface(row)) continue;
        const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image') continue;
        physicalStart = i;
        break;
    }

    if (!Number.isInteger(physicalStart)) return null;

    let physicalEnd = physicalStart;
    for (let i = end; i >= physicalStart; i -= 1) {
        const row = opticalSystemData[i];
        if (!row || __coopt_isGapSurface(row) || __coopt_isCoordTransSurface(row)) continue;
        const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image') continue;
        physicalEnd = i;
        break;
    }

    return { startIdx: physicalStart, endIdx: physicalEnd };
}

function __coopt_expandPrincipalPointRangeForThinLensBack(opticalSystemData, range) {
    if (!Array.isArray(opticalSystemData) || !range) return range;

    const startIdx = Math.max(0, Math.min(opticalSystemData.length - 1, Number(range.startIdx) || 0));
    let endIdx = Math.max(startIdx, Math.min(opticalSystemData.length - 1, Number(range.endIdx) || startIdx));
    const endRow = opticalSystemData[endIdx];
    const endBlockId = String(endRow?._blockId ?? '').trim();
    const endBlockType = String(endRow?._blockType ?? endRow?.blockType ?? '').trim().toLowerCase();

    if ((endBlockType === 'paraxial' || endBlockType === 'thinlens') && endBlockId) {
        for (let i = endIdx + 1; i < opticalSystemData.length; i += 1) {
            const row = opticalSystemData[i];
            const rowBlockId = String(row?._blockId ?? '').trim();
            const rowBlockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase();
            const rowSurfaceRole = String(row?._surfaceRole ?? row?.surfaceRole ?? '').trim().toLowerCase();

            if (rowBlockId !== endBlockId) break;
            if ((rowBlockType === 'paraxial' || rowBlockType === 'thinlens') && rowSurfaceRole === 'back') {
                endIdx = i;
                break;
            }
        }
    }

    return { startIdx, endIdx };
}

function __coopt_buildZoomGroupPrincipalPointDescriptors(opticalSystemData, surfaceOrigins, wavelengthUm = 0.5876, axis = 'YZ') {
    const blocks = __coopt_getActiveDesignIntentBlocks();
    const surfRangeByBlockId = __coopt_buildSurfRangeByBlockId(opticalSystemData);
    const groups = new Map();
    const standaloneDisplayCounts = new Map();

    const registerGroup = (groupKey, zoomGroupLabel, range, order) => {
        if (!groupKey || !zoomGroupLabel || !range) return;
        const existing = groups.get(groupKey) || {
            zoomGroup: zoomGroupLabel,
            startIdx: range.min,
            endIdx: range.max,
            order,
        };
        existing.startIdx = Math.min(existing.startIdx, range.min);
        existing.endIdx = Math.max(existing.endIdx, range.max);
        groups.set(groupKey, existing);
    };

    for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        const blockType = String(block?.blockType ?? '').trim();
        if (!__coopt_isPrincipalPointGroupBlockType(blockType)) continue;

        const normalizedBlockType = __coopt_normalizeBlockDisplayType(blockType);
        const zoomGroup = __coopt_getZoomGroupName(block);
        const standaloneParaxialLabel = (!zoomGroup && normalizedBlockType === 'Paraxial')
            ? __coopt_makeStandaloneParaxialPrincipalLabel(standaloneDisplayCounts)
            : '';
        if (!zoomGroup && !standaloneParaxialLabel) continue;

        const blockId = String(block?.blockId ?? '').trim();
        if (!blockId) continue;
        const range = surfRangeByBlockId.get(blockId);
        if (!range) continue;

        const groupKey = zoomGroup || `__standalone_paraxial__:${blockId}`;
        registerGroup(groupKey, zoomGroup || standaloneParaxialLabel, range, i);
    }

    if (groups.size === 0) {
        const fallbackEntries = Array.from(surfRangeByBlockId.entries())
            .map(([blockId, range]) => ({ blockId, range }))
            .sort((a, b) => a.range.min - b.range.min);

        for (let i = 0; i < fallbackEntries.length; i += 1) {
            const entry = fallbackEntries[i];
            const row = opticalSystemData?.[entry.range.min] || null;
            const blockType = __coopt_normalizeBlockDisplayType(row?._blockType ?? row?.blockType ?? '');
            if (!__coopt_isPrincipalPointGroupBlockType(blockType)) continue;

            const zoomGroupLabel = blockType === 'Paraxial'
                ? __coopt_makeStandaloneParaxialPrincipalLabel(standaloneDisplayCounts)
                : __coopt_makeSequentialDesignIntentLabel(standaloneDisplayCounts, blockType, entry.blockId);

            registerGroup(`__fallback_principal__:${entry.blockId}`, zoomGroupLabel, entry.range, entry.range.min);
        }
    }

    const orderedGroups = Array.from(groups.values()).sort((a, b) => {
        if (a.startIdx !== b.startIdx) return a.startIdx - b.startIdx;
        return a.order - b.order;
    });

    const descriptors = [];
    for (const group of orderedGroups) {
        const rawPhysicalRange = __coopt_getPrincipalPointPhysicalRange(opticalSystemData, group.startIdx, group.endIdx);
        if (!rawPhysicalRange) continue;
        const physicalRange = __coopt_expandPrincipalPointRangeForThinLensBack(opticalSystemData, rawPhysicalRange);
        const leadSurface = opticalSystemData?.[rawPhysicalRange.startIdx];
        const isSingleThinLensGroup = rawPhysicalRange.startIdx === rawPhysicalRange.endIdx
            && __coopt_isThinLensSurface(leadSurface);

        const subsystem = __coopt_buildPrincipalPointSubsystem(opticalSystemData, physicalRange.startIdx, physicalRange.endIdx);
        if (!subsystem) continue;

        const meridian = String(axis).trim().toUpperCase() === 'XZ' ? 'sagittal' : 'tangential';
        const principal = calculatePrincipalPointPositions(subsystem, wavelengthUm, meridian);
        if (!principal) continue;

        const startOrigin = __coopt_vectorFromOriginEntry(surfaceOrigins[physicalRange.startIdx]);
        const endOrigin = __coopt_vectorFromOriginEntry(surfaceOrigins[physicalRange.endIdx]);
        const anchor = __coopt_averageOriginForRange(surfaceOrigins, physicalRange.startIdx, physicalRange.endIdx)
            || startOrigin.clone().lerp(endOrigin, 0.5);
        const frontGlobal = anchor.clone();
        const rearGlobal = anchor.clone();
        if (isSingleThinLensGroup) {
            const lensPlaneZ = Number(startOrigin.z || 0);
            frontGlobal.z = lensPlaneZ;
            rearGlobal.z = lensPlaneZ;
        } else {
            frontGlobal.z = Number(startOrigin.z || 0) + Number(principal.frontPrincipalFromFirstSurfaceMm || 0);
            rearGlobal.z = Number(endOrigin.z || 0) + Number(principal.rearPrincipalFromLastSurfaceMm || 0);
        }

        descriptors.push({
            zoomGroup: group.zoomGroup,
            startIdx: physicalRange.startIdx,
            endIdx: physicalRange.endIdx,
            anchor,
            frontGlobal,
            rearGlobal,
            isSingleThinLensGroup,
            frontFromFirstSurfaceMm: isSingleThinLensGroup ? 0 : Number(principal.frontPrincipalFromFirstSurfaceMm || 0),
            rearFromLastSurfaceMm: isSingleThinLensGroup ? 0 : Number(principal.rearPrincipalFromLastSurfaceMm || 0),
            rearFromFirstSurfaceMm: isSingleThinLensGroup ? 0 : Number(principal.rearPrincipalFromFirstSurfaceMm || 0),
            effectiveFocalLengthMm: Number(principal.effectiveFocalLengthMm),
        });
    }

    return descriptors;
}

function __coopt_getSurfaceRangeVerticalBounds(opticalSystemData, surfaceOrigins, startIdx, endIdx, axis) {
    const normalizedAxis = (String(axis).trim().toUpperCase() === 'XZ') ? 'XZ' : 'YZ';
    const getVerticalCoord = (vec) => normalizedAxis === 'XZ' ? vec.x : vec.y;

    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    for (let i = startIdx; i <= endIdx; i += 1) {
        const surface = opticalSystemData[i];
        if (!surface || __coopt_isGapSurface(surface)) continue;
        const originVec = __coopt_vectorFromOriginEntry(surfaceOrigins[i]);
        const semidia = __coopt_getRenderSemidiaMm(surface);
        const cross = __coopt_getCrosshairHalfExtents(surface, semidia ?? 0);
        const halfExtent = normalizedAxis === 'XZ'
            ? Math.max(Number(cross?.halfX) || 0, Number(semidia) || 0)
            : Math.max(Number(cross?.halfY) || 0, Number(semidia) || 0);
        top = Math.max(top, getVerticalCoord(originVec) + halfExtent);
        bottom = Math.min(bottom, getVerticalCoord(originVec) - halfExtent);
    }

    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
    return { top, bottom };
}

function __coopt_addPrincipalPointVerticalMarker(scene, axis, position, verticalMin, verticalMax, color, userType) {
    if (!scene || !position || !Number.isFinite(verticalMin) || !Number.isFinite(verticalMax)) return;
    const points = (String(axis).trim().toUpperCase() === 'XZ')
        ? [
            new THREE.Vector3(verticalMin, Number(position.y || 0), Number(position.z || 0)),
            new THREE.Vector3(verticalMax, Number(position.y || 0), Number(position.z || 0)),
          ]
        : [
            new THREE.Vector3(Number(position.x || 0), verticalMin, Number(position.z || 0)),
            new THREE.Vector3(Number(position.x || 0), verticalMax, Number(position.z || 0)),
          ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.78,
        depthTest: false,
        depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 65020;
    line.frustumCulled = false;
    line.userData = { type: userType, isOpticalElement: true };
    scene.add(line);
}

function __coopt_addPrincipalPointCadDimension(scene, axis, startPoint, endPoint, dimensionCoord, color, userType, labelOffset = 2.8, labelCoord = null, extensionVerticals = null, arrowAtEnd = false, dotAtStart = false) {
    if (!scene || !startPoint || !endPoint || !Number.isFinite(dimensionCoord)) return null;

    const normalizedAxis = (String(axis).trim().toUpperCase() === 'XZ') ? 'XZ' : 'YZ';
    const useXAsVertical = normalizedAxis === 'XZ';
    const getVertical = (vec) => useXAsVertical ? Number(vec?.x || 0) : Number(vec?.y || 0);
    const getDepth = (vec) => useXAsVertical ? Number(vec?.y || 0) : Number(vec?.x || 0);
    const getZ = (vec) => Number(vec?.z || 0);
    const makePoint = (vertical, depth, z) => useXAsVertical
        ? new THREE.Vector3(vertical, depth, z)
        : new THREE.Vector3(depth, vertical, z);

    const startVertical = getVertical(startPoint);
    const endVertical = getVertical(endPoint);
    const startDepth = getDepth(startPoint);
    const endDepth = getDepth(endPoint);
    const startZ = getZ(startPoint);
    const endZ = getZ(endPoint);

    const extensionStartVertical = Number.isFinite(extensionVerticals?.start)
        ? Number(extensionVerticals.start)
        : startVertical;
    const extensionEndVertical = Number.isFinite(extensionVerticals?.end)
        ? Number(extensionVerticals.end)
        : endVertical;

    const dimStart = makePoint(dimensionCoord, startDepth, startZ);
    const dimEnd = makePoint(dimensionCoord, endDepth, endZ);
    const extStart = makePoint(extensionStartVertical, startDepth, startZ);
    const extEnd = makePoint(extensionEndVertical, endDepth, endZ);

    __coopt_addDesignIntentLabelPolyline(scene, [extStart, dimStart], color);
    __coopt_addDesignIntentLabelPolyline(scene, [extEnd, dimEnd], color);
    __coopt_addDesignIntentLabelPolyline(scene, [dimStart, dimEnd], color);
    if (dotAtStart) {
        const dotGeometry = new THREE.SphereGeometry(0.45, 10, 10);
        const dotMaterial = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.92,
            depthTest: false,
            depthWrite: false,
        });
        const dot = new THREE.Mesh(dotGeometry, dotMaterial);
        dot.position.copy(dimStart);
        dot.renderOrder = 65021;
        dot.frustumCulled = false;
        dot.userData = { type: userType, isOpticalElement: true };
        scene.add(dot);
    }
    if (arrowAtEnd) {
        const arrowWidth = 1.6;
        const arrowHeight = 0.9;
        const arrowBaseZ = endZ + (endZ >= startZ ? -arrowWidth : arrowWidth);
        __coopt_addDesignIntentLabelPolyline(scene, [
            makePoint(dimensionCoord + arrowHeight, endDepth, arrowBaseZ),
            dimEnd,
        ], color);
        __coopt_addDesignIntentLabelPolyline(scene, [
            makePoint(dimensionCoord - arrowHeight, endDepth, arrowBaseZ),
            dimEnd,
        ], color);
    }

    const resolvedLabelCoord = Number.isFinite(labelCoord)
        ? Number(labelCoord)
        : dimensionCoord + Number(labelOffset || 0);

    return makePoint(
        resolvedLabelCoord,
        (startDepth + endDepth) / 2,
        (startZ + endZ) / 2,
    );
}

function __coopt_formatZoomGroupSpanLabel(entry) {
    if (!entry) return '';
    const zoomGroup = String(entry.zoomGroup || '').trim();
    if (zoomGroup) return zoomGroup;
    const startLabel = `S${Number(entry.startIdx) + 1}`;
    const endLabel = `S${Number(entry.endIdx) + 1}`;
    return `${startLabel}→${endLabel}`;
}

function __coopt_formatZoomGroupDistanceLabel(current, next, distanceMm) {
    const currentLabel = __coopt_formatZoomGroupSpanLabel(current);
    const nextLabel = __coopt_formatZoomGroupSpanLabel(next);
    const useDash = /^[A-Z]+$/.test(currentLabel) && /^[A-Z]+$/.test(nextLabel);
    const connector = useDash ? '-' : '→';
    return `${currentLabel}${connector}${nextLabel} ${Number(distanceMm || 0).toFixed(2)}`;
}

function __coopt_addZoomGroupSpanBrace(scene, axis, verticalCoord, depthCoord, startZ, endZ, color) {
    if (!scene || !Number.isFinite(verticalCoord) || !Number.isFinite(depthCoord) || !Number.isFinite(startZ) || !Number.isFinite(endZ)) return;

    const normalizedAxis = (String(axis).trim().toUpperCase() === 'XZ') ? 'XZ' : 'YZ';
    const makePoint = (vertical, depth, z) => normalizedAxis === 'XZ'
        ? new THREE.Vector3(vertical, depth, z)
        : new THREE.Vector3(depth, vertical, z);

    const minZ = Math.min(startZ, endZ);
    const maxZ = Math.max(startZ, endZ);
    const midZ = (minZ + maxZ) / 2;
    const span = Math.max(6, maxZ - minZ);
    const endPostHeight = Math.min(2.4, Math.max(1.2, span * 0.05));
    const stemHeight = Math.min(4.2, Math.max(2.4, span * 0.1));
    __coopt_addDesignIntentLabelPolyline(scene, [
        makePoint(verticalCoord, depthCoord, minZ),
        makePoint(verticalCoord + endPostHeight, depthCoord, minZ),
    ], color);
    __coopt_addDesignIntentLabelPolyline(scene, [
        makePoint(verticalCoord, depthCoord, minZ),
        makePoint(verticalCoord, depthCoord, maxZ),
    ], color);
    __coopt_addDesignIntentLabelPolyline(scene, [
        makePoint(verticalCoord, depthCoord, midZ),
        makePoint(verticalCoord - stemHeight, depthCoord, midZ),
    ], color);
    __coopt_addDesignIntentLabelPolyline(scene, [
        makePoint(verticalCoord, depthCoord, maxZ),
        makePoint(verticalCoord + endPostHeight, depthCoord, maxZ),
    ], color);
}

function __coopt_addZoomGroupPrincipalPointLabelsToScene(scene, opticalSystemData, surfaceOrigins, options = {}) {
    if (!scene || !Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return;
    if (!Array.isArray(surfaceOrigins) || surfaceOrigins.length === 0) return;

    let wavelengthUm = Number(options?.wavelengthUm);
    if (!Number.isFinite(wavelengthUm) || wavelengthUm <= 0) {
        try {
            if (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function') {
                const resolved = Number(window.getPrimaryWavelength());
                if (Number.isFinite(resolved) && resolved > 0) {
                    wavelengthUm = resolved;
                }
            }
        } catch (_) {}
    }
    if (!Number.isFinite(wavelengthUm) || wavelengthUm <= 0) {
        wavelengthUm = 0.5876;
    }

    const descriptors = __coopt_buildZoomGroupPrincipalPointDescriptors(opticalSystemData, surfaceOrigins, wavelengthUm, options?.axis ?? 'YZ');
    if (!descriptors.length) return;

    const axis = (String(options?.axis ?? 'YZ').trim().toUpperCase() === 'XZ') ? 'XZ' : 'YZ';
    const getVerticalCoord = (vec) => axis === 'XZ' ? vec.x : vec.y;
    const getDepthCoord = (vec) => axis === 'XZ' ? vec.y : vec.x;
    const makePoint = (vertical, depth, z) => {
        return axis === 'XZ'
            ? new THREE.Vector3(vertical, depth, z)
            : new THREE.Vector3(depth, vertical, z);
    };

    let surfaceTop = Number.NEGATIVE_INFINITY;
    let surfaceBottom = Number.POSITIVE_INFINITY;
    for (let i = 0; i < opticalSystemData.length; i += 1) {
        const surface = opticalSystemData[i];
        if (!surface || __coopt_isGapSurface(surface)) continue;
        const originVec = __coopt_vectorFromOriginEntry(surfaceOrigins[i]);
        const semidia = __coopt_getRenderSemidiaMm(surface);
        const cross = __coopt_getCrosshairHalfExtents(surface, semidia ?? 0);
        const halfExtent = axis === 'XZ'
            ? Math.max(Number(cross?.halfX) || 0, Number(semidia) || 0)
            : Math.max(Number(cross?.halfY) || 0, Number(semidia) || 0);
        surfaceTop = Math.max(surfaceTop, getVerticalCoord(originVec) + halfExtent);
        surfaceBottom = Math.min(surfaceBottom, getVerticalCoord(originVec) - halfExtent);
    }
    if (!Number.isFinite(surfaceTop) || !Number.isFinite(surfaceBottom)) return;

    const frontColor = 0xf97316;
    const rearColor = 0x14b8a6;
    const distanceColor = 0x0f766e;
    const topLabelBase = surfaceTop + 12;
    const topLabelLaneStep = 8;
    const principalDimBase = surfaceTop + 18;
    const groupDimBase = surfaceBottom - 8;
    const groupLabelCoord = groupDimBase - 3.2;
    const groupSpanBase = groupLabelCoord - 4.4;
    const lowerExtensionGap = 1.4;
    const descriptorBounds = descriptors.map((entry) => __coopt_getSurfaceRangeVerticalBounds(
        opticalSystemData,
        surfaceOrigins,
        entry.startIdx,
        entry.endIdx,
        axis,
    ));

    const topLabelItems = [];

    descriptors.forEach((entry, index) => {
        const bounds = descriptorBounds[index];
        const markerBottom = Number.isFinite(bounds?.bottom) ? Number(bounds.bottom) : surfaceBottom;
        const markerTop = Number.isFinite(bounds?.top) ? Number(bounds.top) : surfaceTop;
        if (!entry.isSingleThinLensGroup) {
            __coopt_addPrincipalPointVerticalMarker(scene, axis, entry.frontGlobal, markerBottom, markerTop, frontColor, 'principal-point-front-marker');
            __coopt_addPrincipalPointVerticalMarker(scene, axis, entry.rearGlobal, markerBottom, markerTop, rearColor, 'principal-point-rear-marker');
        }

        const principalDimCoord = principalDimBase + index * 8;
        const frontText = `${entry.zoomGroup} H ${entry.frontFromFirstSurfaceMm.toFixed(2)}`;
        const rearText = `${entry.zoomGroup} H' ${entry.rearFromLastSurfaceMm.toFixed(2)}`;

        if (!entry.isSingleThinLensGroup) {
            topLabelItems.push({
                text: frontText,
                sourcePoint: entry.frontGlobal.clone(),
                depth: getDepthCoord(entry.anchor),
                z: Number(entry.frontGlobal.z || 0),
                color: frontColor,
                style: {
                    fillStyle: 'rgba(255,247,237,0.96)',
                    strokeStyle: '#ea580c',
                    textStyle: '#9a3412',
                    lineColor: frontColor,
                },
            });
            topLabelItems.push({
                text: rearText,
                sourcePoint: entry.rearGlobal.clone(),
                depth: getDepthCoord(entry.anchor),
                z: Number(entry.rearGlobal.z || 0),
                color: rearColor,
                style: {
                    fillStyle: 'rgba(240,253,250,0.96)',
                    strokeStyle: '#0f766e',
                    textStyle: '#115e59',
                    lineColor: rearColor,
                },
            });
        }

    });

    const laneLastMaxByIndex = [];
    const laneGap = 6;
    topLabelItems
        .map((item) => {
            const size = __coopt_measureDesignIntentLabelWorldSize(item.text);
            return {
                ...item,
                widthWorld: Math.max(18, Number(size.width) || 0),
            };
        })
        .sort((a, b) => a.z - b.z)
        .forEach((item) => {
            const halfWidth = item.widthWorld / 2;
            const minZ = item.z - halfWidth;
            const maxZ = item.z + halfWidth;
            let laneIndex = 0;
            while (laneIndex < laneLastMaxByIndex.length) {
                const lastMax = laneLastMaxByIndex[laneIndex];
                if (!Number.isFinite(lastMax) || minZ > lastMax + laneGap) break;
                laneIndex += 1;
            }
            laneLastMaxByIndex[laneIndex] = maxZ;

            const labelPoint = makePoint(topLabelBase + laneIndex * topLabelLaneStep, item.depth, item.z);
            __coopt_addDesignIntentLabelPolyline(scene, [item.sourcePoint.clone(), labelPoint.clone()], item.color);
            __coopt_addDesignIntentLabelSprite(scene, item.text, labelPoint, item.style);
        });

    descriptors.forEach((entry) => {
        const startOrigin = __coopt_vectorFromOriginEntry(surfaceOrigins[entry.startIdx]);
        const endOrigin = __coopt_vectorFromOriginEntry(surfaceOrigins[entry.endIdx]);
        const startZ = Number(startOrigin?.z || 0);
        const endZ = Number(endOrigin?.z || 0);
        const minZ = Math.min(startZ, endZ);
        const maxZ = Math.max(startZ, endZ);
        const midZ = (minZ + maxZ) / 2;
        const span = Math.max(6, maxZ - minZ);
        const stemHeight = Math.min(4.2, Math.max(2.4, span * 0.1));
        const groupLabelPoint = makePoint(groupSpanBase - stemHeight - 3.2, getDepthCoord(entry.anchor), midZ);
        const groupFocalPoint = makePoint(groupSpanBase - stemHeight - 6.0, getDepthCoord(entry.anchor), midZ);

        __coopt_addZoomGroupSpanBrace(scene, axis, groupSpanBase, getDepthCoord(entry.anchor), minZ, maxZ, distanceColor);
        __coopt_addDesignIntentLabelSprite(scene, __coopt_formatZoomGroupSpanLabel(entry), groupLabelPoint, {
            drawFrame: false,
            fillStyle: 'rgba(0,0,0,0)',
            strokeStyle: 'rgba(0,0,0,0)',
            textStyle: '#134e4a',
            paddingX: 2,
            paddingY: 0,
            fontWeight: '600',
        });
        if (Number.isFinite(entry.effectiveFocalLengthMm)) {
            __coopt_addDesignIntentLabelSprite(scene, `f ${entry.effectiveFocalLengthMm.toFixed(2)}`, groupFocalPoint, {
                drawFrame: false,
                fillStyle: 'rgba(0,0,0,0)',
                strokeStyle: 'rgba(0,0,0,0)',
                textStyle: '#0f766e',
                paddingX: 2,
                paddingY: 0,
            });
        }
    });

    for (let i = 0; i < descriptors.length - 1; i += 1) {
        const current = descriptors[i];
        const next = descriptors[i + 1];
        const currentBounds = descriptorBounds[i];
        const nextBounds = descriptorBounds[i + 1];
        const distanceMm = Number(next.frontGlobal.z || 0) - Number(current.rearGlobal.z || 0);
        const labelPoint = __coopt_addPrincipalPointCadDimension(
            scene,
            axis,
            current.rearGlobal,
            next.frontGlobal,
            groupDimBase,
            distanceColor,
            'principal-point-intergroup-dimension',
            -2.8,
            groupLabelCoord,
            {
                start: Number.isFinite(currentBounds?.bottom) ? Number(currentBounds.bottom) - lowerExtensionGap : null,
                end: Number.isFinite(nextBounds?.bottom) ? Number(nextBounds.bottom) - lowerExtensionGap : null,
            },
            true,
            true,
        );
        if (labelPoint) {
            __coopt_addDesignIntentLabelSprite(scene, __coopt_formatZoomGroupDistanceLabel(current, next, distanceMm), labelPoint, {
                fillStyle: 'rgba(240,253,250,0.98)',
                strokeStyle: '#0f766e',
                textStyle: '#134e4a',
                lineColor: distanceColor,
            });
        }
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
export function drawOpticalSystemSurfaces(options: any = {}) {
    const totalStartMs = performance.now();
    
    const {
        crossSectionOnly = false,
        scene,
        showSurfaceOrigins = false,
        showSemidiaRing = false,
        showMirrorBackText = false,
        showDesignIntentLabels = false,
        showPrincipalPointLabels = false,
        showSurfaceNumberLabels = false,
        surfaceMeshSegments = 100,
        toricMeshSegments = 256,
        crossSectionDirection = 'YZ',
        viewPlane = null,
        crossSectionCenterOffset = 0,
        opticalSystemData,
        surfaceOrigins: precomputedSurfaceOrigins = null
    } = options;

    // viewPlaneパラメータをcrossSectionDirectionに変換
    const actualCrossSectionDirection = viewPlane ? viewPlane.toUpperCase() : crossSectionDirection;

    if (!scene) {
        console.error('Scene not provided to drawOpticalSystemSurfaces');
        return;
    }

    if (!opticalSystemData || opticalSystemData.length === 0) {
        console.error('💡 光学系データが取得できません。JSONファイルをロードしてください。');
        alert('光学系データがありません。JSONファイルをロードしてください。');
        return;
    }



    // Clear existing optical elements before drawing new ones
    const clearStartMs = performance.now();
    clearExistingOpticalElements(scene);
    recordCooptPerfSample('surfaceRenderer.clear', performance.now() - clearStartMs);

    // Surface origins calculation - NOW with the correct parameter
    const originsStartMs = performance.now();
    const surfaceOrigins = Array.isArray(precomputedSurfaceOrigins) && precomputedSurfaceOrigins.length === opticalSystemData.length
        ? precomputedSurfaceOrigins
        : calculateSurfaceOrigins(opticalSystemData);
    recordCooptPerfSample('surfaceRenderer.origins', performance.now() - originsStartMs);

    // Opt-in Coord Break debug: helps verify that decenter params are numeric at render time.
    try {
        const DEBUG_CB = __coopt_isCoordTransDebugEnabled();
        if (DEBUG_CB && Array.isArray(surfaceOrigins)) {
            const cbRows = [];
            for (let i = 0; i < opticalSystemData.length; i++) {
                const row = opticalSystemData[i];
                if (!row) continue;
                if (String(row.surfType || '') !== 'Coord Break') continue;
                const origin = surfaceOrigins[i]?.origin;
                const cbParams = surfaceOrigins[i]?.cbParams;
                cbRows.push({
                    i,
                    blockId: row._blockId || null,
                    raw: {
                        semidia: row.semidia,
                        material: row.material,
                        thickness: row.thickness,
                        rindex: row.rindex,
                        abbe: row.abbe,
                        conic: row.conic,
                        coef1: row.coef1,
                        decenterX: row.decenterX,
                        decenterY: row.decenterY,
                        decenterZ: row.decenterZ,
                        tiltX: row.tiltX,
                        tiltY: row.tiltY,
                        tiltZ: row.tiltZ,
                        order: row.order
                    },
                    parsed: cbParams || null,
                    origin: origin ? { x: origin.x, y: origin.y, z: origin.z } : null
                });
            }
            if (cbRows.length) {
                const tableRows = cbRows.map(r => ({
                    i: r.i,
                    blockId: r.blockId,
                    raw_material: r.raw.material,
                    raw_semidia: r.raw.semidia,
                    raw_thickness: r.raw.thickness,
                    decX: r.parsed?.decenterX,
                    decY: r.parsed?.decenterY,
                    decZ: r.parsed?.decenterZ,
                    tiltX: r.parsed?.tiltX,
                    tiltY: r.parsed?.tiltY,
                    tiltZ: r.parsed?.tiltZ,
                    order: r.parsed?.transformOrder,
                    ox: r.origin?.x,
                    oy: r.origin?.y,
                    oz: r.origin?.z
                }));

                // Print table outside of groups so it's visible even when groups are collapsed.
                console.table(tableRows);

                console.groupCollapsed(`🧭 [CO-OPT] Coord Break debug (${cbRows.length} rows)`);
                for (const r of tableRows) {
                }
                console.log(cbRows);
                console.groupEnd();
            }
        }
    } catch (_) {}

    const surfaceColorOverrides = __coopt_loadSurfaceColorOverrides();
    


    // Draw 3D surfaces (skip if crossSectionOnly is true)
    if (!crossSectionOnly) {
        const draw3DStartMs = performance.now();
        const isImageLikeSurface = (row) => {
            const surfType = String(row?.surfType ?? row?.type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            const objType = String(row?.['object type'] ?? row?.object ?? row?.objectType ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            const blockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            return surfType === 'imagesurface' || objType === 'image' || objType === 'imagesurface' || blockType === 'imagesurface';
        };
        const lastImageSurfaceIndex = (() => {
            for (let idx = opticalSystemData.length - 1; idx >= 0; idx -= 1) {
                if (isImageLikeSurface(opticalSystemData[idx])) return idx;
            }
            return -1;
        })();
        for (let i = 0; i < opticalSystemData.length; i++) {
            const surface = opticalSystemData[i];
            const renderSurfaceMeta = __coopt_withSurfaceRenderMeta(surface, i);
            const isStopSurface = __coopt_isStopSurface(surface);

            // Gap/AirGap rows are spacing-only and should never be rendered as physical surfaces.
            if (__coopt_isGapSurface(surface)) {
                continue;
            }
            
            
            // Object面のスキップ判定
            const objectType = surface["object type"] || "";
            const isImageSurfaceCurrent = isImageLikeSurface(surface);
            if (isImageSurfaceCurrent && lastImageSurfaceIndex >= 0 && i !== lastImageSurfaceIndex) {
                continue;
            }
            if (objectType === "Object") {
                const objectThickness = surface.thickness;
                const isInfiniteThickness = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
                
                if (isInfiniteThickness) {
                    // 無限系のObject面はスキップ（angle判定も考慮）
                    let isAngleObject = false;
                    try {
                        const objectRows = window.getObjectRows ? window.getObjectRows() : [];
                        if (objectRows && objectRows.length > 0) {
                            const firstObject = objectRows[0];
                            const position = firstObject.position || (Array.isArray(firstObject) ? firstObject[3] : null);
                            isAngleObject = position === 'angle' || position === 'Angle';
                        }
                    } catch (error) {
                        console.warn(`⚠️ 3D Surface ${i}: Object data取得エラー:`, error);
                    }
                    
                    // 無限系のObject面は常にスキップ
                    continue;
                } else {
                    // 有限系のObject面を描画
                    
                    try {
                        // surfaceOriginsの確認
                        
                        // semidiaの取得（ObjectテーブルのRectangle座標から計算）
                        let planeSemidia = __coopt_getRenderSemidiaMm(surface);
                        if (planeSemidia === null) {
                            const objectRows = window.getObjectRows ? window.getObjectRows() : [];
                            if (objectRows && objectRows.length > 0) {
                                let maxCoord = 0;
                                objectRows.forEach(obj => {
                                    const xHeight = Math.abs(Number(obj.xHeightAngle) || 0);
                                    const yHeight = Math.abs(Number(obj.yHeightAngle) || 0);
                                    maxCoord = Math.max(maxCoord, xHeight, yHeight);
                                });
                                if (maxCoord > 0) {
                                    planeSemidia = maxCoord;
                                }
                            }
                        }
                        // 球面メッシュがある場合、radius から semidia を推定
                        if (planeSemidia === null && surface.radius !== undefined && surface.radius !== null && 
                            surface.radius !== 'INF' && surface.radius !== Infinity && 
                            !isNaN(Number(surface.radius))) {
                            const radius = Math.abs(Number(surface.radius));
                            if (radius > 0) {
                                // 球面 radius から semidia を推定（sag が radius の 20% 程度まで）
                                planeSemidia = Math.sqrt(radius * radius / 5);
                            }
                        }
                        if (planeSemidia === null) planeSemidia = 20;
                        
                        // Object面は通常、座標変換が不要なため、単純な座標で描画
                        const objOrigin = { x: 0, y: 0, z: 0 };
                        const objRotMat = null; // Object面には回転を適用しない
                        
                        // Object面が球面メッシュを指定しているか確認
                        const hasObjectSphere = (
                            (surface.radius !== undefined && surface.radius !== null && 
                             surface.radius !== 'INF' && surface.radius !== Infinity && 
                             !isNaN(Number(surface.radius)) && Number(surface.radius) !== 0)
                        );
                        
                        if (hasObjectSphere) {
                            // 球面メッシュを描画
                            try {
                                const radius = Number(surface.radius);
                                const conic = Number(surface.conic) || 0;
                                const params = {
                                    radius: radius,
                                    conic: conic,
                                    coef1: Number(surface.coef1) || 0,
                                    coef2: Number(surface.coef2) || 0,
                                    coef3: Number(surface.coef3) || 0,
                                    coef4: Number(surface.coef4) || 0,
                                    coef5: Number(surface.coef5) || 0,
                                    coef6: Number(surface.coef6) || 0,
                                    coef7: Number(surface.coef7) || 0,
                                    coef8: Number(surface.coef8) || 0,
                                    coef9: Number(surface.coef9) || 0,
                                    coef10: Number(surface.coef10) || 0
                                };
                                
                                // Object 面の球面メッシュを描画
                                drawLensSurfaceWithOrigin(
                                    scene,
                                    { ...params, __cooptSurfaceIndex0: i },
                                    objOrigin,
                                    objRotMat,
                                    'even',
                                    60,
                                    0x00ccff,
                                    0.3,
                                    'Spherical'
                                );
                            } catch (error) {
                                console.error(`❌ OBJECT Surface ${i}: 球面メッシュ描画エラー:`, error);
                            }
                        }
                        
                        // リング描画
                        __coopt_drawApertureOutline(
                            scene,
                            surface,
                            planeSemidia,
                            objOrigin,
                            objRotMat,
                            0x808080 // グレー
                        );
                        
                        // 十字線描画
                        
                        const { halfX: crossHalfX, halfY: crossHalfY } = __coopt_getCrosshairHalfExtents(surface, planeSemidia);

                        // Toric面の場合のパラメータ準備
                        let toricParams = null;
                        const isToric = surface && surface.surfType === 'Toric';
                        if (isToric) {
                            const radiusX = (surface.radiusX === "INF" || surface.radiusX === Infinity) ? Infinity : parseFloat(surface.radiusX);
                            const radiusY = (surface.radiusY === "INF" || surface.radiusY === Infinity || surface.radius === "INF" || surface.radius === Infinity) 
                                             ? Infinity 
                                             : parseFloat(surface.radiusY || surface.radius);
                            
                            if ((isFinite(radiusX) || radiusX === Infinity) && (isFinite(radiusY) || radiusY === Infinity)) {
                                toricParams = {
                                    radiusX: radiusX,
                                    radiusY: radiusY,
                                    conic: Number(surface.conic) || 0
                                };
                            }
                        }

                        // 縦線（Y方向、黒） - 複数セグメントで描画
                        const pointsVertical = [];
                        const vSegments = 20; // 十字線のセグメント数
                        for (let j = 0; j <= vSegments; j++) {
                            const y = -crossHalfY + (2 * crossHalfY * j / vSegments);
                            let z = 0;
                            if (toricParams) {
                                z = toricSurfaceZ(0, y, toricParams);
                                if (!isFinite(z)) z = 0;
                            } else if (hasObjectSphere) {
                                // 球面の Z 座標を計算
                                const radius = Number(surface.radius);
                                const conic = Number(surface.conic) || 0;
                                const asphericParams = {
                                    radius: radius,
                                    conic: conic,
                                    coef1: Number(surface.coef1) || 0,
                                    coef2: Number(surface.coef2) || 0,
                                    coef3: Number(surface.coef3) || 0,
                                    coef4: Number(surface.coef4) || 0,
                                    coef5: Number(surface.coef5) || 0,
                                    coef6: Number(surface.coef6) || 0,
                                    coef7: Number(surface.coef7) || 0
                                };
                                z = asphericSurfaceZ(Math.abs(y), asphericParams, 'even');
                                if (!isFinite(z)) z = 0;
                            }
                            const point = new THREE.Vector3(0, y, z);
                            pointsVertical.push(point);
                        }
                        if (pointsVertical.length >= 2) {
                            const geometryV = new THREE.BufferGeometry().setFromPoints(pointsVertical);
                            const materialV = new THREE.LineBasicMaterial({ 
                                color: 0x000000, 
                                linewidth: 2,
                                depthTest: false
                            });
                            const lineV = new THREE.Line(geometryV, materialV);
                            lineV.renderOrder = 999;
                            lineV.userData = { type: 'plane-crosshair', direction: 'vertical', surfaceIndex: i };
                            scene.add(lineV);
                        }
                        
                        // 横線（X方向、赤） - 複数セグメントで描画
                        const pointsHorizontal = [];
                        const hSegments = 20;
                        for (let j = 0; j <= hSegments; j++) {
                            const x = -crossHalfX + (2 * crossHalfX * j / hSegments);
                            let z = 0;
                            if (toricParams) {
                                z = toricSurfaceZ(x, 0, toricParams);
                                if (!isFinite(z)) z = 0;
                            } else if (hasObjectSphere) {
                                // 球面の Z 座標を計算
                                const radius = Number(surface.radius);
                                const conic = Number(surface.conic) || 0;
                                const asphericParams = {
                                    radius: radius,
                                    conic: conic,
                                    coef1: Number(surface.coef1) || 0,
                                    coef2: Number(surface.coef2) || 0,
                                    coef3: Number(surface.coef3) || 0,
                                    coef4: Number(surface.coef4) || 0,
                                    coef5: Number(surface.coef5) || 0,
                                    coef6: Number(surface.coef6) || 0,
                                    coef7: Number(surface.coef7) || 0
                                };
                                z = asphericSurfaceZ(Math.abs(x), asphericParams, 'even');
                                if (!isFinite(z)) z = 0;
                            }
                            const point = new THREE.Vector3(x, 0, z);
                            pointsHorizontal.push(point);
                        }
                        if (pointsHorizontal.length >= 2) {
                            const geometryH = new THREE.BufferGeometry().setFromPoints(pointsHorizontal);
                            const materialH = new THREE.LineBasicMaterial({ 
                                color: 0xff0000, 
                                linewidth: 2,
                                depthTest: false
                            });
                            const lineH = new THREE.Line(geometryH, materialH);
                            lineH.renderOrder = 999;
                            lineH.userData = { type: 'plane-crosshair', direction: 'horizontal', surfaceIndex: i };
                            scene.add(lineH);
                        }
                        
                    } catch (error) {
                        console.error(`❌ Error drawing Object plane for surface ${i}:`, error);
                    }
                    continue; // Object面の処理終了
                }
            }

            // Image面のスキップ判定（無限系のみスキップ、有限系では描画）
            if (isImageSurfaceCurrent) {
                // 有限系かどうかを判定するため、Object面のthicknessを確認
                const firstSurface = opticalSystemData[0];
                const objectThickness = firstSurface?.thickness;
                const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
                
                
                try {
                        // semidiaの取得
                        let planeSemidia = __coopt_getRenderSemidiaMm(surface);
                        // Image面のリングは他面のsemidiaを流用しない。
                        // semidia未指定時はこの面自身の情報だけで推定し、最後に既定値へフォールバックする。
                        // 球面メッシュがある場合、radius から semidia を推定
                        if (planeSemidia === null && surface.radius !== undefined && surface.radius !== null && 
                            surface.radius !== 'INF' && surface.radius !== Infinity && 
                            !isNaN(Number(surface.radius))) {
                            const radius = Math.abs(Number(surface.radius));
                            if (radius > 0) {
                                // 球面 radius から semidia を推定（sag が radius の 20% 程度までを想定）
                                planeSemidia = Math.sqrt(radius * radius / 5);
                            }
                        }
                        if (planeSemidia === null) planeSemidia = 20;
                        
                        // Image面の位置を計算（surfaceOriginsから取得）
                        let imgOrigin = { x: 0, y: 0, z: 0 };
                        let imgRotMat = null;
                        
                        if (surfaceOrigins && surfaceOrigins[i]) {
                            imgOrigin = surfaceOrigins[i].origin || imgOrigin;
                            imgRotMat = surfaceOrigins[i].rotationMatrix || null;
                        } else {
                        }

                        // Reconcile image render origin with previous-surface spacing.
                        // Some imports store the final gap as attached metadata on the previous
                        // physical surface (__cooptGapApplied/__cooptGapThickness) rather than a
                        // standalone Gap row. In that case, force Image rendering to the advanced
                        // position so the ring does not remain at the pre-gap vertex.
                        try {
                            const prevRow = (i > 0) ? opticalSystemData[i - 1] : null;
                            if (prevRow && Array.isArray(surfaceOrigins) && surfaceOrigins[i - 1]) {
                                const prevEntry = surfaceOrigins[i - 1];
                                const prevOrigin = prevEntry?.origin;
                                const prevRot = prevEntry?.rotationMatrix;
                                const hasAttachedGap = (prevRow as any)?.__cooptGapApplied === true;
                                const spacingRaw = hasAttachedGap
                                    ? ((prevRow as any).__cooptGapThickness ?? prevRow?.thickness)
                                    : (prevRow?.thickness ?? (prevRow as any).__cooptGapThickness);
                                const spacing = __coopt_parseNumberOrNull(spacingRaw);

                                if (prevOrigin && spacing !== null && Number.isFinite(spacing) && spacing !== 0) {
                                    const axis = (Array.isArray(prevRot) && prevRot.length >= 3)
                                        ? {
                                            x: Number(prevRot?.[0]?.[2]) || 0,
                                            y: Number(prevRot?.[1]?.[2]) || 0,
                                            z: Number(prevRot?.[2]?.[2]) || 1,
                                        }
                                        : { x: 0, y: 0, z: 1 };

                                    const expectedFromGap = {
                                        x: Number(prevOrigin.x || 0) + axis.x * spacing,
                                        y: Number(prevOrigin.y || 0) + axis.y * spacing,
                                        z: Number(prevOrigin.z || 0) + axis.z * spacing,
                                    };

                                    const dx = Number(imgOrigin.x || 0) - expectedFromGap.x;
                                    const dy = Number(imgOrigin.y || 0) - expectedFromGap.y;
                                    const dz = Number(imgOrigin.z || 0) - expectedFromGap.z;
                                    const err2 = dx * dx + dy * dy + dz * dz;

                                    if (err2 > 1e-10) {
                                        imgOrigin = expectedFromGap;
                                    }
                                }
                            }
                        } catch (_) {}
                        
                        // Image面が球面メッシュを指定しているか確認
                        const hasSphereRadius = (
                            (surface.radius !== undefined && surface.radius !== null && 
                             surface.radius !== 'INF' && surface.radius !== Infinity && 
                             !isNaN(Number(surface.radius)) && Number(surface.radius) !== 0)
                        );
                        
                        if (hasSphereRadius) {
                            // 球面メッシュを描画
                            try {
                                const radius = Number(surface.radius);
                                const conic = Number(surface.conic) || 0;
                                const params = {
                                    radius: radius,
                                    conic: conic,
                                    coef1: Number(surface.coef1) || 0,
                                    coef2: Number(surface.coef2) || 0,
                                    coef3: Number(surface.coef3) || 0,
                                    coef4: Number(surface.coef4) || 0,
                                    coef5: Number(surface.coef5) || 0,
                                    coef6: Number(surface.coef6) || 0,
                                    coef7: Number(surface.coef7) || 0,
                                    coef8: Number(surface.coef8) || 0,
                                    coef9: Number(surface.coef9) || 0,
                                    coef10: Number(surface.coef10) || 0
                                };
                                
                                // Image 面の球面メッシュを描画
                                drawLensSurfaceWithOrigin(
                                    scene,
                                    params,
                                    imgOrigin,
                                    imgRotMat,
                                    'even',
                                    60,
                                    0x00ccff,
                                    0.3,
                                    'Spherical'
                                );
                            } catch (error) {
                                console.error(`❌ IMAGE Surface ${i}: 球面メッシュ描画エラー:`, error);
                            }
                        }
                        
                        // Image 面のリングは表示する。近傍の重複だけ後段で整理する。
                        const imageRingColor = __coopt_getImageSemidiaWarningColor(renderSurfaceMeta, 0x404040);
                        __coopt_drawApertureOutline(
                            scene,
                            renderSurfaceMeta,
                            planeSemidia,
                            imgOrigin,
                            imgRotMat,
                            imageRingColor
                        );
                        
                        const { halfX: crossHalfX, halfY: crossHalfY } = __coopt_getCrosshairHalfExtents(surface, planeSemidia);

                        // 十字線描画
                        
                        // Toric面の場合のパラメータ準備
                        let toricParams = null;
                        const isToric = surface && surface.surfType === 'Toric';
                        if (isToric) {
                            const radiusX = (surface.radiusX === "INF" || surface.radiusX === Infinity) ? Infinity : parseFloat(surface.radiusX);
                            const radiusY = (surface.radiusY === "INF" || surface.radiusY === Infinity || surface.radius === "INF" || surface.radius === Infinity) 
                                             ? Infinity 
                                             : parseFloat(surface.radiusY || surface.radius);
                            
                            if ((isFinite(radiusX) || radiusX === Infinity) && (isFinite(radiusY) || radiusY === Infinity)) {
                                toricParams = {
                                    radiusX: radiusX,
                                    radiusY: radiusY,
                                    conic: Number(surface.conic) || 0
                                };
                            }
                        }
                        
                        // 縦線（Y方向、黒） - 複数セグメントで描画
                        const pointsVertical = [];
                        const vSegments = 20;
                        for (let j = 0; j <= vSegments; j++) {
                            const y = -crossHalfY + (2 * crossHalfY * j / vSegments);
                            let z = 0;
                            if (toricParams) {
                                z = toricSurfaceZ(0, y, toricParams);
                                if (!isFinite(z)) z = 0;
                            } else if (hasSphereRadius) {
                                // 球面の Z 座標を計算
                                const radius = Number(surface.radius);
                                const conic = Number(surface.conic) || 0;
                                const asphericParams = {
                                    radius: radius,
                                    conic: conic,
                                    coef1: Number(surface.coef1) || 0,
                                    coef2: Number(surface.coef2) || 0,
                                    coef3: Number(surface.coef3) || 0,
                                    coef4: Number(surface.coef4) || 0,
                                    coef5: Number(surface.coef5) || 0,
                                    coef6: Number(surface.coef6) || 0,
                                    coef7: Number(surface.coef7) || 0
                                };
                                z = asphericSurfaceZ(Math.abs(y), asphericParams, 'even');
                                if (!isFinite(z)) z = 0;
                            }
                            let point = new THREE.Vector3(0, y, z);
                            if (imgRotMat && Array.isArray(imgRotMat) && imgRotMat.length >= 3) {
                                // 回転行列を適用
                                const newX = imgRotMat[0][0] * point.x + imgRotMat[0][1] * point.y + imgRotMat[0][2] * point.z;
                                const newY = imgRotMat[1][0] * point.x + imgRotMat[1][1] * point.y + imgRotMat[1][2] * point.z;
                                const newZ = imgRotMat[2][0] * point.x + imgRotMat[2][1] * point.y + imgRotMat[2][2] * point.z;
                                point = new THREE.Vector3(newX, newY, newZ);
                            }
                            point.x += imgOrigin.x;
                            point.y += imgOrigin.y;
                            point.z += imgOrigin.z;
                            pointsVertical.push(point);
                        }
                        if (pointsVertical.length >= 2) {
                            const geometryV = new THREE.BufferGeometry().setFromPoints(pointsVertical);
                            const materialV = new THREE.LineBasicMaterial({ 
                                color: 0x000000, 
                                linewidth: 2,
                                depthTest: false
                            });
                            const lineV = new THREE.Line(geometryV, materialV);
                            lineV.renderOrder = 999;
                            lineV.userData = { type: 'plane-crosshair', direction: 'vertical', surfaceIndex: i };
                            scene.add(lineV);
                        }
                        
                        // 横線（X方向、赤） - 複数セグメントで描画
                        const pointsHorizontal = [];
                        const hSegments = 20;
                        for (let j = 0; j <= hSegments; j++) {
                            const x = -crossHalfX + (2 * crossHalfX * j / hSegments);
                            let z = 0;
                            if (toricParams) {
                                z = toricSurfaceZ(x, 0, toricParams);
                                if (!isFinite(z)) z = 0;
                            } else if (hasSphereRadius) {
                                // 球面の Z 座標を計算
                                const radius = Number(surface.radius);
                                const conic = Number(surface.conic) || 0;
                                const asphericParams = {
                                    radius: radius,
                                    conic: conic,
                                    coef1: Number(surface.coef1) || 0,
                                    coef2: Number(surface.coef2) || 0,
                                    coef3: Number(surface.coef3) || 0,
                                    coef4: Number(surface.coef4) || 0,
                                    coef5: Number(surface.coef5) || 0,
                                    coef6: Number(surface.coef6) || 0,
                                    coef7: Number(surface.coef7) || 0
                                };
                                z = asphericSurfaceZ(Math.abs(x), asphericParams, 'even');
                                if (!isFinite(z)) z = 0;
                            }
                            let point = new THREE.Vector3(x, 0, z);
                            if (imgRotMat && Array.isArray(imgRotMat) && imgRotMat.length >= 3) {
                                // 回転行列を適用
                                const newX = imgRotMat[0][0] * point.x + imgRotMat[0][1] * point.y + imgRotMat[0][2] * point.z;
                                const newY = imgRotMat[1][0] * point.x + imgRotMat[1][1] * point.y + imgRotMat[1][2] * point.z;
                                const newZ = imgRotMat[2][0] * point.x + imgRotMat[2][1] * point.y + imgRotMat[2][2] * point.z;
                                point = new THREE.Vector3(newX, newY, newZ);
                            }
                            point.x += imgOrigin.x;
                            point.y += imgOrigin.y;
                            point.z += imgOrigin.z;
                            pointsHorizontal.push(point);
                        }
                        if (pointsHorizontal.length >= 2) {
                            const geometryH = new THREE.BufferGeometry().setFromPoints(pointsHorizontal);
                            const materialH = new THREE.LineBasicMaterial({ 
                                color: 0xff0000, 
                                linewidth: 2,
                                depthTest: false
                            });
                            const lineH = new THREE.Line(geometryH, materialH);
                            lineH.renderOrder = 999;
                            lineH.userData = { type: 'plane-crosshair', direction: 'horizontal', surfaceIndex: i };
                            scene.add(lineH);
                        }
                        
                    } catch (error) {
                        console.error(`❌ Error drawing Image plane for surface ${i}:`, error);
                    }
                    continue; // Image面の処理終了
                }

            // Coord Break surfaces are transform-only and must not be drawn in 3D.
            const surfType = String(surface?.surfType ?? surface?.type ?? '').trim().toLowerCase();
            const objType = String(surface?.['object type'] ?? surface?.object ?? '').trim().toLowerCase();
            const isCB = (
                surfType === 'coord break' || surfType === 'coordinate break' || surfType === 'cb' ||
                surfType === 'coordtrans' || surfType === 'coordinatebreak' ||
                objType === 'coord break' || objType === 'coordinate break' || objType === 'cb' ||
                objType === 'coordtrans' || objType === 'coordinatebreak'
            );
            if (isCB) {
                continue;
            }

            if (__coopt_isThinLensBackSurface(surface)) {
                continue;
            }
            
            try {
                if (isStopSurface) {
                    // Stop面の場合は特別な処理 - アパーチャ枠のみ描画、十字線なし
                    if (showSemidiaRing) {
                        try {
                            const ringSemidia = __coopt_getRenderSemidiaMm(surface);
                            if (ringSemidia === null) {
                            } else {
                            __coopt_drawApertureOutline(
                                scene,
                                surface,
                                ringSemidia,
                                surfaceOrigins[i]?.origin || {x: 0, y: 0, z: 0},
                                surfaceOrigins[i]?.rotationMatrix || null,
                                0x000000
                            );
                            }
                        } catch (stopRingError) {
                            console.error(`❌ Error drawing Stop ring for surface ${i}:`, stopRingError);
                        }
                    }
                    continue; // Stop面の処理終了、十字線描画をスキップ
                } else if (surface.type === 'Mirror' || surface.material === 'MIRROR') {
                    // Mirror面の処理
                    const mirrorDefaultColor = 0xc0c0c0;
                    const mirrorKey = __coopt_surfaceColorKey(surface, i);
                    const mirrorOverride = __coopt_parseColorToInt(surfaceColorOverrides?.[mirrorKey]);
                    const mirrorColor = (mirrorOverride !== null) ? mirrorOverride : mirrorDefaultColor;
                    drawLensSurfaceWithOrigin(
                        scene, 
                        renderSurfaceMeta,           // params オブジェクト全体
                        surfaceOrigins[i].origin,    // origin から .origin プロパティを使用
                        surfaceOrigins[i].rotationMatrix, // rotation matrix
                        "even",                      // mode
                        surfaceMeshSegments,         // segments
                        mirrorColor,                // color
                        0.8,                        // opacity
                        'Mirror'                     // surfaceType
                    );
                    
                    if (showMirrorBackText) {
                        addMirrorBackText(
                            scene, 
                            surfaceOrigins[i].origin,
                            surfaceOrigins[i].rotationMatrix
                        );
                    }
                } else if (surface.surfType === 'Toric' && !__coopt_isThinLensSurface(surface)) {
                    // Toric surface rendering
                    
                    const toricDefaultColor = 0x00ccff;
                    const toricKey = __coopt_surfaceColorKey(surface, i);
                    const toricOverride = __coopt_parseColorToInt(surfaceColorOverrides?.[toricKey]);
                    const toricColor = (toricOverride !== null) ? toricOverride : toricDefaultColor;
                    
                    drawToricSurfaceWithOrigin(
                        scene,
                        renderSurfaceMeta,               // params with radiusX, radiusY, conic, semidia
                        surfaceOrigins[i].origin,
                        surfaceOrigins[i].rotationMatrix,
                        toricMeshSegments,
                        toricColor,                      // color
                        0.5                              // opacity
                    );
                } else {
                    // 通常のレンズ面の処理
                    
                    // 3D表面を描画
                    const isThinLens = __coopt_isThinLensSurface(surface);
                    const renderSurface = isThinLens ? __coopt_makeFlatThinLensSurface(surface) : surface;
                    const renderSurfaceWithMeta = __coopt_withSurfaceRenderMeta(renderSurface, i);
                    const lensDefaultColor = isThinLens ? 0x66ccff : 0x00ccff;
                    const lensKey = __coopt_surfaceColorKey(surface, i);
                    const lensOverride = __coopt_parseColorToInt(surfaceColorOverrides?.[lensKey]);
                    const lensColor = (lensOverride !== null) ? lensOverride : lensDefaultColor;
                    drawLensSurfaceWithOrigin(
                        scene, 
                        renderSurfaceWithMeta,        // params オブジェクト全体
                        surfaceOrigins[i].origin,    // origin から .origin プロパティを使用
                        surfaceOrigins[i].rotationMatrix, // rotation matrix
                        "even",                      // mode
                        surfaceMeshSegments,         // segments
                        lensColor,                  // color
                        isThinLens ? 0.25 : 0.5,    // opacity
                        renderSurface.type          // surfaceType
                    );
                }
                
                // Surface origins表示（デバッグ用の追加表示のみ）
                if (showSurfaceOrigins) {
                    // 原点マーカーとして小さな球を描画
                    const geometry = new THREE.SphereGeometry(2, 8, 8);
                    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.8 });
                    const marker = new THREE.Mesh(geometry, material);
                    const origin = surfaceOrigins[i]?.origin || {x: 0, y: 0, z: 0};
                    marker.position.set(origin.x, origin.y, origin.z);
                    marker.userData = { type: 'surface-origin-marker', surfaceIndex: i };
                    scene.add(marker);
                }
                
                // Semidia ring表示（Stop面、Coord Trans面は除外）
                if (showSemidiaRing && !isStopSurface && !isCB) {
                    
                    try {
                        const ringSemidia = __coopt_getRenderSemidiaMm(surface);
                        if (ringSemidia === null) {
                        } else {
                        __coopt_drawApertureOutline(
                            scene,
                            renderSurfaceMeta,
                            ringSemidia,
                            surfaceOrigins[i]?.origin || {x: 0, y: 0, z: 0},
                            surfaceOrigins[i]?.rotationMatrix || null,
                            0x000000
                        );
                        }
                    } catch (ringError) {
                        console.error(`❌ Error drawing semidia ring for surface ${i}:`, ringError);
                    }
                }
                
            } catch (error) {
                console.error(`❌ Error drawing surface ${i}:`, error);
            }
        }

        // 3Dビュー専用: 接続直角部リングを描画
        drawConnectionCornerRings3D(scene, opticalSystemData, surfaceOrigins);

        // Hard guard: keep only one ImageSurface ring/crosshair set in 3D Render.
        if (lastImageSurfaceIndex >= 0) {
            const expectedImageOrigin = __coopt_getExpectedImageOriginFromPreviousRow(
                opticalSystemData,
                surfaceOrigins,
                lastImageSurfaceIndex
            ) || (surfaceOrigins?.[lastImageSurfaceIndex]?.origin ?? null);
            __coopt_snapImageSurfaceArtifactsToOrigin(scene, lastImageSurfaceIndex, expectedImageOrigin);
            __coopt_pruneNearbyNonImageRings(scene, lastImageSurfaceIndex, expectedImageOrigin, 2.0);
            __coopt_dedupeImageSurfaceArtifacts(scene, lastImageSurfaceIndex, expectedImageOrigin);
            __coopt_removeUnindexedSemidiaRings(scene);
            __coopt_pruneNearbyConnectionCornerRings(scene, expectedImageOrigin, 8.0);
            __coopt_logImageRingDiagnostics(scene, lastImageSurfaceIndex, expectedImageOrigin);
        }

        recordCooptPerfSample('surfaceRenderer.draw3d', performance.now() - draw3DStartMs);
    } else {
    }

    // Draw cross-sections
    const crossSectionStartMs = performance.now();
    if (actualCrossSectionDirection === 'YZ') {
        drawLensCrossSectionWithSurfaceOrigins(
            scene, 
            opticalSystemData, 
            surfaceOrigins
        );
    } else if (actualCrossSectionDirection === 'XZ') {
        drawLensCrossSectionWithSurfaceOrigins(
            scene, 
            opticalSystemData, 
            surfaceOrigins
        );
    }
    recordCooptPerfSample('surfaceRenderer.crossSection', performance.now() - crossSectionStartMs);

    const showDesignLabels = __coopt_shouldShowDesignIntentLabels(showDesignIntentLabels);
    const showPrincipalLabels = __coopt_shouldShowPrincipalPointLabels(showPrincipalPointLabels);
    const showSurfaceLabels = __coopt_shouldShowSurfaceNumberLabels(showSurfaceNumberLabels);

    if (showDesignLabels || showPrincipalLabels || showSurfaceLabels) {
        const labelsStartMs = performance.now();
        try {
            if (showDesignLabels) {
                __coopt_addDesignIntentLabelsToScene(scene, opticalSystemData, surfaceOrigins, {
                    axis: actualCrossSectionDirection,
                    crossSectionOnly,
                });
            }
            if (showPrincipalLabels) {
                __coopt_addZoomGroupPrincipalPointLabelsToScene(scene, opticalSystemData, surfaceOrigins, {
                    axis: actualCrossSectionDirection,
                    crossSectionOnly,
                    wavelengthUm: (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
                        ? Number(window.getPrimaryWavelength()) || 0.5876
                        : 0.5876,
                });
            }
            if (showSurfaceLabels) {
                __coopt_addSurfaceNumberLabelsToScene(scene, opticalSystemData, surfaceOrigins, {
                    axis: actualCrossSectionDirection,
                    crossSectionOnly,
                });
            }
        } catch (labelErr) {
            console.warn('⚠️ Failed to draw design intent labels:', labelErr);
        } finally {
            recordCooptPerfSample('surfaceRenderer.labels', performance.now() - labelsStartMs);
        }
    }

    recordCooptPerfSample('surfaceRenderer.total', performance.now() - totalStartMs);
}

/**
 * Find stop surface in optical system
 * @param {Array} opticalSystemRows - Optical system data
 * @param {Array} surfaceOrigins - Surface origins (optional)
 * @returns {Object|null} Stop surface data or null if not found
 */
export function findStopSurface(opticalSystemRows, surfaceOrigins = null) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        return null;
    }

    const DEBUG_STOP = !!(typeof globalThis !== 'undefined' && globalThis.__COOPT_DEBUG_STOP_SURFACE);
    if (DEBUG_STOP) {
        // 光学系データ全体をデバッグ出力
    }
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        // console.log(`🔍 [findStopSurface] Surface ${i}:`, surface);
        // console.log(`🔍 [findStopSurface] Surface ${i} keys:`, Object.keys(surface));
        // console.log(`🔍 [findStopSurface] Surface ${i} type:`, surface.type);
        // console.log(`🔍 [findStopSurface] Surface ${i} object type:`, surface['object type']);
        
        // Stop surface can be tagged in multiple ways depending on the import/source:
        // - type: 'Stop'
        // - object type: 'Stop'
        // - Zemax-style: object/object type: 'STO'
        const objTypeRaw = surface['object type'] ?? surface.object ?? surface.objectType;
        const objTypeNorm = String(objTypeRaw ?? '').trim().toUpperCase();
        if (surface.type === 'Stop' || surface['object type'] === 'Stop' || objTypeNorm === 'STO') {
            // console.log(`🎯 [findStopSurface] Stop面発見! Surface ${i}`);
            
            // Stop面の位置を計算（CB対応）
            let stopX = 0;
            let stopY = 0;
            let stopZ = 0;
            if (surfaceOrigins && surfaceOrigins[i]) {
                // calculateSurfaceOrigins() returns entries like { origin: {x,y,z}, rotationMatrix, ... }
                const o = surfaceOrigins[i].origin || surfaceOrigins[i];
                const ox = Number(o?.x);
                const oy = Number(o?.y);
                const oz = Number(o?.z);
                if (Number.isFinite(ox)) stopX = ox;
                if (Number.isFinite(oy)) stopY = oy;
                if (Number.isFinite(oz)) stopZ = oz;
            } else {
                // surfaceOriginsが無い場合は累積距離で計算
                for (let j = 0; j < i; j++) {
                    const thickness = opticalSystemRows[j].thickness;
                    if (thickness !== undefined && thickness !== null && thickness !== 'INF' && thickness !== 'Infinity') {
                        stopZ += parseFloat(thickness) || 0;
                    }
                }
            }
            
            // stopZが数値であることを確認
            stopZ = Number(stopZ) || 0;
            
            // Stop面の半径を取得（複数のフィールド名を試す）
            let stopRadius = 10; // デフォルト値
            // console.log(`🔍 [findStopSurface] Stop面データ:`, surface);
            // console.log(`🔍 [findStopSurface] Stop面の全プロパティ:`, JSON.stringify(surface, null, 2));
            
            // より多くのフィールド名を試す
            const radiusFields = [
                'semidia',          // 実際のフィールド名！
                'semiDiameter', 'semi-diameter', 'semi_diameter',
                'radius', 'aperture', 'diameter', 'semi-dia',
                'semiDia', 'aper', 'halfDiameter', 'half-diameter',
                'Clear_Aperture', 'clearAperture', 'clear_aperture'
            ];
            
            // console.log(`🔍 [findStopSurface] 半径候補チェック:`);
            for (const field of radiusFields) {
                const value = surface[field];
                // console.log(`  ${field}: ${value} (type: ${typeof value})`);
                if (value !== undefined && value !== null && value !== '') {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        stopRadius = numValue;
                        // console.log(`🎯 [findStopSurface] フィールド "${field}" を使用: ${stopRadius}`);
                        break;
                    }
                }
            }
            
            // 手動で設定された半径値があるかチェック
            if (window.forceStopRadius && !isNaN(window.forceStopRadius)) {
                console.log(`🔧 [findStopSurface] 手動設定の半径を使用: ${window.forceStopRadius}`);
                stopRadius = window.forceStopRadius;
            }
            
            // NaNチェック
            if (isNaN(stopRadius)) {
                console.warn(`⚠️ [findStopSurface] 半径値が無効、デフォルト値10を使用`);
                stopRadius = 10;
            }
            
            // console.log(`🔍 [findStopSurface] 最終的な半径: ${stopRadius}`);
            
            return {
                surface: surface,
                index: i,
                center: { x: stopX, y: stopY, z: stopZ },  // centerプロパティを追加（CB対応）
                position: { x: stopX, y: stopY, z: stopZ },  // 互換性のために保持
                radius: stopRadius,  // 正しい半径値を使用
                origin: surfaceOrigins ? surfaceOrigins[i] : null
            };
        }
    }
    
    console.warn(`⚠️ [findStopSurface] Stop面が見つかりません`);
    return null;
}

/**
 * Clear all optical elements from scene
 * @param {THREE.Scene} scene - Three.js scene
 */
export function clearAllOpticalElements(scene) {
    if (!scene) {
        console.error('Scene not provided to clearAllOpticalElements');
        return;
    }
    
    const objectsToRemove = [];
    
    scene.traverse((child) => {
        // Keep popup cross-section debug/fill overlays alive unless explicitly cleared by popup-specific logic.
        if (child?.userData?.type === 'popupLensFill' || child?.userData?.isUltraDebugOverlay === true) {
            return;
        }

        // Surface and lens objects by name
        if (child.name && 
            (child.name.startsWith('surface') || 
             child.name.startsWith('lens') ||
             child.name.startsWith('cross-section') ||
             child.name.startsWith('semidia') ||
             child.name.startsWith('mirror') ||
             child.name.includes('Profile') ||
             child.name.includes('Ring') ||
             child.name.includes('Connection'))) {
            objectsToRemove.push(child);
        }
        
        // Semidia ring objects specifically (for thickness change bug fix)
        if (child.userData && (
            child.userData.type === 'semidiaRing' ||
            child.userData.type === 'ring' ||
            child.userData.surfaceType === 'ring' ||
            child.name.includes('semidiaRing')
        )) {
            objectsToRemove.push(child);
        }
        
        // Ray objects by userData
        if (child.userData && (
            child.userData.isRayLine || 
            child.userData.type === 'ray'
        )) {
            objectsToRemove.push(child);
        }
        
        // Objects by userData type
        if (child.userData && (
            child.userData.isLensSurface ||
            child.userData.surfaceType === '3DSurface' ||
            child.userData.type === 'ring' ||
            child.userData.type === 'pupil' ||
            child.userData.type === 'crossSection'
        )) {
            objectsToRemove.push(child);
        }
        
        // Objects by material properties (lens surfaces are often transparent)
        if (child.material && child.material.transparent && 
            child.material.opacity && child.material.opacity < 1 &&
            child.type !== 'GridHelper' && child.type !== 'AxesHelper') {
            objectsToRemove.push(child);
        }
    });
    
    // Remove duplicates
    const uniqueObjects = [...new Set(objectsToRemove)];
    
    
    uniqueObjects.forEach(obj => {
        scene.remove(obj);
        
        // Dispose of geometry and material to free memory
        if (obj.geometry) {
            obj.geometry.dispose();
        }
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(material => material.dispose());
            } else {
                obj.material.dispose();
            }
        }
    });
}

/**
 * Clear existing optical elements from the scene
 * @param {THREE.Scene} scene - The THREE.js scene
 */
function clearExistingOpticalElements(scene) {
    const elementsToRemove = [];
    
    scene.traverse((child) => {
        if (child?.userData?.type === 'popupLensFill' || child?.userData?.isUltraDebugOverlay === true) {
            return;
        }

        // Clear renderables (Mesh/Line/Sprite/Points) created by the optical renderer.
        // Sprites are used for labels (e.g., mirrorBackText) and must be cleared too.
        if (!(child.isMesh || child.isLine || child.isSprite || child.isPoints)) return;

        const ud = child.userData;
        const isOptical = !!(ud && ud.isOpticalElement);

        // Remove optical surfaces, rings, markers, and labels
        if (isOptical || (ud && (
            ud.type === 'lensSurface' ||
            ud.isLensSurface ||
            ud.surfaceType === '3DSurface' ||
            ud.type === 'ring' ||
            ud.type === 'semidiaRing' ||
            ud.type === 'pupil' ||
            ud.type === 'surface-origin-marker' ||
            ud.surfaceIndex !== undefined
        )) || child.name.includes('LensSurface') || child.name.includes('Surface') || child.name.includes('semidiaRing')) {
            elementsToRemove.push(child);
        }
    });
    
    elementsToRemove.forEach(element => {
        scene.remove(element);
        if (element.geometry) element.geometry.dispose();
        if (element.material) {
            if (Array.isArray(element.material)) {
                element.material.forEach(mat => mat.dispose());
            } else {
                element.material.dispose();
            }
        }
        // Sprites often own a texture map that should be disposed.
        try {
            const m = element.material;
            const mats = Array.isArray(m) ? m : (m ? [m] : []);
            for (const mm of mats) {
                if (mm && mm.map && typeof mm.map.dispose === 'function') mm.map.dispose();
            }
        } catch (_) {}
    });
    
}
