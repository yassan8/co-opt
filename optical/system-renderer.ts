/**
 * Optical system renderer for 3D visualization
 */



import * as THREE from 'three';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin, drawToricSurfaceWithOrigin,
         drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, 
         drawSemidiaRingWithOriginAndSurface, drawRectApertureWithOriginAndSurface, asphericSurfaceZ, toricSurfaceZ, addMirrorBackText,
         drawConnectionCornerRings3D } from './surface.ts';

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const COORD_BREAK_DEBUG_STORAGE_KEY = 'coopt.debug.coordTrans';
const RENDER_LABEL_TOGGLE_STORAGE_KEY = 'coopt.render.showDesignIntentLabels';

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

function __coopt_getDesignIntentLabelStyle(blockType, blockId) {
    const base = __coopt_getDesignIntentDisplayBase(blockType, blockId);
    if (base === 'Lens' || base === 'Doublet' || base === 'Triplet') {
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

    const pushDescriptor = (id, text, anchor, style = null) => {
        const safeId = String(id ?? '').trim();
        if (!safeId || !text || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.z)) return;
        if (seenIds.has(safeId)) return;
        seenIds.add(safeId);
        descriptors.push({ id: safeId, text: String(text), anchor, style: style || __coopt_getDesignIntentLabelStyle('', safeId) });
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
            pushDescriptor(blockId, displayText, anchor, labelStyle);
        }
    }

    if (descriptors.length > 0) return descriptors;

    for (const [blockId, range] of surfRangeByBlockId.entries()) {
        const anchor = __coopt_averageOriginForRange(surfaceOrigins, range.min, range.max);
        if (/^Object(Surface|Plane)?/i.test(String(blockId))) continue;
        const displayText = __coopt_makeSequentialDesignIntentLabel(displayCounts, '', blockId);
        pushDescriptor(blockId, displayText, anchor, __coopt_getDesignIntentLabelStyle('', blockId));
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

    const fontPt = 25;
    const paddingX = 10;
    const paddingY = 5;
    const fillStyle = String(style?.fillStyle || 'rgba(255,255,255,0.94)');
    const strokeStyle = String(style?.strokeStyle || '#475569');
    const textStyle = String(style?.textStyle || '#111827');
    context.font = `600 ${fontPt}pt Arial, sans-serif`;
    const metrics = context.measureText(String(text));
    const textHeight = Math.ceil(fontPt * 1.55);
    canvas.width = Math.ceil(metrics.width + paddingX * 2);
    canvas.height = Math.ceil(textHeight + paddingY * 2);

    context.font = `600 ${fontPt}pt Arial, sans-serif`;
    context.fillStyle = fillStyle;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = strokeStyle;
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
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
    sprite.center.set(0.5, 0.5);
    sprite.scale.set(canvas.width / 13, canvas.height / 13, 1);
    sprite.position.copy(position);
    sprite.renderOrder = 65010;
    sprite.frustumCulled = false;
    sprite.userData = { type: 'design-intent-label', isOpticalElement: true, labelText: String(text) };
    scene.add(sprite);
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

    const primaryEntries = descriptors.filter((entry) => !/^(Gap|AirGap)/i.test(String(entry.id)));
    const gapEntries = descriptors.filter((entry) => /^(Gap|AirGap)/i.test(String(entry.id)));

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
    const gapBase = surfaceBottom - 9;

    layoutGroup(primaryEntries, primaryBase, 1);
    layoutGroup(gapEntries, gapBase, -1);
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
    
    const {
        crossSectionOnly = false,
        scene,
        showSurfaceOrigins = false,
        showSemidiaRing = false,
        showMirrorBackText = false,
        showDesignIntentLabels = false,
        crossSectionDirection = 'YZ',
        viewPlane = null,
        crossSectionCenterOffset = 0,
        opticalSystemData
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
    clearExistingOpticalElements(scene);

    // Surface origins calculation - NOW with the correct parameter
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemData);

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
        for (let i = 0; i < opticalSystemData.length; i++) {
            const surface = opticalSystemData[i];
            const isStopSurface = __coopt_isStopSurface(surface);

            // Gap/AirGap rows are spacing-only and should never be rendered as physical surfaces.
            if (__coopt_isGapSurface(surface)) {
                continue;
            }
            
            
            // Object面のスキップ判定
            const objectType = surface["object type"] || "";
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
                                    params,
                                    objOrigin,
                                    objRotMat,
                                    'even',
                                    60,
                                    0x00ccff,
                                    0.3,
                                    'Spherical'
                                );
                                console.log(`✅ OBJECT Surface ${i}: 球面メッシュを描画`, { radius, conic });
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
                                console.log(`[OBJECT Crosshair] Toric params: radiusX=${radiusX}, radiusY=${radiusY}`);
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
            if (objectType === "Image") {
                // 有限系かどうかを判定するため、Object面のthicknessを確認
                const firstSurface = opticalSystemData[0];
                const objectThickness = firstSurface?.thickness;
                const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
                
                
                try {
                        // semidiaの取得
                        let planeSemidia = __coopt_getRenderSemidiaMm(surface);
                        if (planeSemidia === null) {
                            // 近くの面からsemidiaを取得
                            for (let j = 0; j < opticalSystemData.length; j++) {
                                const nearSemidia = __coopt_getRenderSemidiaMm(opticalSystemData[j]);
                                if (nearSemidia !== null) {
                                    planeSemidia = nearSemidia;
                                    break;
                                }
                            }
                        }
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
                                console.log(`✅ IMAGE Surface ${i}: 球面メッシュを描画`, { radius, conic });
                            } catch (error) {
                                console.error(`❌ IMAGE Surface ${i}: 球面メッシュ描画エラー:`, error);
                            }
                        }
                        
                        // アパーチャ枠描画
                        __coopt_drawApertureOutline(
                            scene,
                            surface,
                            planeSemidia,
                            imgOrigin,
                            imgRotMat,
                            0x404040 // 暗いグレー
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
                                console.log(`[IMAGE Crosshair] Toric params: radiusX=${radiusX}, radiusY=${radiusY}`);
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
                        surface,                     // params オブジェクト全体
                        surfaceOrigins[i].origin,    // origin から .origin プロパティを使用
                        surfaceOrigins[i].rotationMatrix, // rotation matrix
                        "even",                      // mode
                        100,                         // segments
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
                        surface,                         // params with radiusX, radiusY, conic, semidia
                        surfaceOrigins[i].origin,
                        surfaceOrigins[i].rotationMatrix,
                        256,                             // 256x256 grid mesh for smooth surface
                        toricColor,                      // color
                        0.5                              // opacity
                    );
                } else {
                    // 通常のレンズ面の処理
                    
                    // 3D表面を描画
                    const isThinLens = __coopt_isThinLensSurface(surface);
                    const renderSurface = isThinLens ? __coopt_makeFlatThinLensSurface(surface) : surface;
                    const lensDefaultColor = isThinLens ? 0x66ccff : 0x00ccff;
                    const lensKey = __coopt_surfaceColorKey(surface, i);
                    const lensOverride = __coopt_parseColorToInt(surfaceColorOverrides?.[lensKey]);
                    const lensColor = (lensOverride !== null) ? lensOverride : lensDefaultColor;
                    drawLensSurfaceWithOrigin(
                        scene, 
                        renderSurface,                // params オブジェクト全体
                        surfaceOrigins[i].origin,    // origin から .origin プロパティを使用
                        surfaceOrigins[i].rotationMatrix, // rotation matrix
                        "even",                      // mode
                        100,                         // segments
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
                            surface,
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
    } else {
    }

    // Draw cross-sections
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

    if (__coopt_shouldShowDesignIntentLabels(showDesignIntentLabels)) {
        try {
            __coopt_addDesignIntentLabelsToScene(scene, opticalSystemData, surfaceOrigins, {
                axis: actualCrossSectionDirection,
                crossSectionOnly,
            });
        } catch (labelErr) {
            console.warn('⚠️ Failed to draw design intent labels:', labelErr);
        }
    }
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
