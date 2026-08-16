/**
 * Ray rendering utilities for optical system visualization
 */

import * as THREE from 'three';
import { traceRay, traceRayHitPoint, traceRayHitPointBatch, solveRayOriginsToStopPointsWithRustMeta, calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { findStopSurface } from './system-renderer.ts';
import { asphericSurfaceZ } from './surface.ts';
import { findInfiniteSystemChiefRayOrigin } from '../raytracing/generation/gen-ray-cross-infinite.ts';
import { findFiniteSystemChiefRayDirection } from '../raytracing/generation/gen-ray-cross-finite.ts';
import { detectConjugateType, ConjugateType } from '../utils/conjugate-detection.ts';
import { getRustRayTracingWasmSync } from '../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import { calculateParaxialData } from '../raytracing/core/ray-paraxial.ts';

function getAsphericModeFromSurfType(surfType) {
    const normalized = String(surfType ?? '').trim().toLowerCase();
    if (normalized.includes('qcon')) return 'qcon';
    return normalized.includes('odd') ? 'odd' : 'even';
}

const RENDER_TS_TRACE_OPTIONS = {
    allowNonStrict: true,
    requireWasmRayTracing: false,
    useRustWasm: false,
    requireRustWasm: false,
    disableWasmRayTracing: true,
    __renderRayTracingTsOnly: true
};

const RENDER_RUST_TRACE_OPTIONS = {
    allowNonStrict: true,
    useRustWasm: true,
    requireRustWasm: false,
    disableWasmRayTracing: false,
    __renderRayTracingRustPreferred: true
};

function traceRayHitPointForRenderTs(opticalSystemRows, ray, n0, targetSurfaceIndex) {
    return traceRayHitPoint(opticalSystemRows, ray, n0, targetSurfaceIndex, RENDER_TS_TRACE_OPTIONS);
}

function traceRayHitPointBatchForRenderTs(opticalSystemRows, rays, n0, targetSurfaceIndex) {
    return traceRayHitPointBatch(opticalSystemRows, rays, n0, targetSurfaceIndex, RENDER_TS_TRACE_OPTIONS);
}

function traceRayHitPointForRender(opticalSystemRows, ray, n0, targetSurfaceIndex, traceBackend: 'ts' | 'rust' = 'rust') {
    if (traceBackend === 'rust') {
        try {
            const rust = getRustRayTracingWasmSync();
            if (rust) {
                return traceRayHitPoint(opticalSystemRows, ray, n0, targetSurfaceIndex, RENDER_RUST_TRACE_OPTIONS);
            }
        } catch (_) {}
    }
    return traceRayHitPointForRenderTs(opticalSystemRows, ray, n0, targetSurfaceIndex);
}

function traceRayHitPointBatchForRender(opticalSystemRows, rays, n0, targetSurfaceIndex, traceBackend: 'ts' | 'rust' = 'rust') {
    if (traceBackend === 'rust') {
        try {
            const rust = getRustRayTracingWasmSync();
            if (rust) {
                return traceRayHitPointBatch(opticalSystemRows, rays, n0, targetSurfaceIndex, RENDER_RUST_TRACE_OPTIONS);
            }
        } catch (_) {}
    }
    return traceRayHitPointBatchForRenderTs(opticalSystemRows, rays, n0, targetSurfaceIndex);
}

function traceImageHeightInfiniteCandidateLocalWithRust(opticalSystemRows, imageSurfaceIndex, wavelengthUm, angleXDeg, angleYDeg) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.trace_image_height_infinite_candidate_with_rows;
        if (typeof rustFn !== 'function') return null;
        const result = rustFn(opticalSystemRows, imageSurfaceIndex, wavelengthUm, angleXDeg, angleYDeg);
        const status = Number(result?.[0]);
        const hitX = Number(result?.[1]);
        const hitY = Number(result?.[2]);
        const hitZ = Number(result?.[3]);
        if (status !== 1 || ![hitX, hitY, hitZ].every(Number.isFinite)) return null;
        return { x: hitX, y: hitY, z: hitZ };
    } catch (_) {
        return null;
    }
}

function traceImageHeightInfiniteCandidateExactLocalWithRust(opticalSystemRows, imageSurfaceIndex, wavelengthUm, angleXDeg, angleYDeg) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.trace_image_height_infinite_candidate_exact_with_rows;
        if (typeof rustFn !== 'function') return null;
        const result = rustFn(opticalSystemRows, imageSurfaceIndex, wavelengthUm, angleXDeg, angleYDeg);
        const status = Number(result?.[0]);
        const hitX = Number(result?.[1]);
        const hitY = Number(result?.[2]);
        const hitZ = Number(result?.[3]);
        if (status !== 1 || ![hitX, hitY, hitZ].every(Number.isFinite)) return null;
        return { x: hitX, y: hitY, z: hitZ };
    } catch (_) {
        return null;
    }
}

function traceImageHeightInfiniteChiefRayExactWithRust(opticalSystemRows, imageSurfaceIndex, wavelengthUm, angleXDeg, angleYDeg) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.trace_image_height_infinite_chief_ray_exact_with_rows;
        if (typeof rustFn !== 'function') return null;
        const result = rustFn(opticalSystemRows, imageSurfaceIndex, wavelengthUm, angleXDeg, angleYDeg);
        const status = Number(result?.[0]);
        if (status !== 1) return null;
        const ox = Number(result?.[1]);
        const oy = Number(result?.[2]);
        const oz = Number(result?.[3]);
        const dx = Number(result?.[4]);
        const dy = Number(result?.[5]);
        const dz = Number(result?.[6]);
        const hx = Number(result?.[7]);
        const hy = Number(result?.[8]);
        const hz = Number(result?.[9]);
        if (![ox, oy, oz, dx, dy, dz, hx, hy, hz].every(Number.isFinite)) return null;
        return {
            origin: { x: ox, y: oy, z: oz },
            dir: { x: dx, y: dy, z: dz },
            localHit: { x: hx, y: hy, z: hz },
        };
    } catch (_) {
        return null;
    }
}

function traceImageHeightFiniteCandidateLocalWithRust(opticalSystemRows, imageSurfaceIndex, wavelengthUm, objectX, objectY) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.trace_image_height_finite_candidate_with_rows;
        if (typeof rustFn !== 'function') return null;
        const result = rustFn(opticalSystemRows, imageSurfaceIndex, wavelengthUm, objectX, objectY);
        const status = Number(result?.[0]);
        const hitX = Number(result?.[1]);
        const hitY = Number(result?.[2]);
        const hitZ = Number(result?.[3]);
        if (status !== 1 || ![hitX, hitY, hitZ].every(Number.isFinite)) return null;
        return { x: hitX, y: hitY, z: hitZ };
    } catch (_) {
        return null;
    }
}

type Vec3 = { x: number; y: number; z: number };

type RayStartDataArray = Array<any> & {
    annularRingsUsed?: number;
    selectedRingOverride?: number;
    emissionBasis?: any;
    expectedChiefDir?: Vec3;
    nominalFieldDir?: Vec3;
    expectedChiefOrigin?: Vec3;
    chiefRayAnalysis?: any;
};

type RayGenerationOptions = {
    annularRingCount?: number;
    wavelengthUm?: number;
    wavelength?: number;
    pattern?: 'grid' | 'annular';
    conjugateType?: ConjugateType;
    forceInfiniteObject?: boolean;
    forceFiniteObject?: boolean;
    useChiefRayAnalysis?: boolean;
    aimThroughStop?: boolean;
    chiefRaySolveMode?: string;
    disableAngleObjectPositionOptimization?: boolean;
    allowStopBasedOriginSolve?: boolean;
    skipStopPointRefine?: boolean;
    targetSurfaceIndex?: number;
    debugChiefRay?: boolean;
    apertureLimitMm?: number;
    apertureLimit?: number;
    disableCrossExtent?: boolean;
    originSolveTraceBackend?: 'ts' | 'rust';
    strictChiefDirectionSolve?: boolean;
    pupilScale?: number;
    rectangleAsAngleWhenInfinite?: boolean;
    precomputedSurfaceOrigins?: any[];
    crossType?: 'vertical' | 'horizontal' | 'both';
    exactCrossBeamSampling?: boolean;
    displayAxisAlignedSampling?: boolean;
    skipImageHeightTsValidation?: boolean;
    imageHeightValidationTraceBackend?: 'ts' | 'rust';
    preserveChiefNormalEmissionPlane?: boolean;
    angleStopDiag?: boolean;
};

type ImageHeightSolveOptions = {
    skipTsValidation?: boolean;
    validationTraceBackend?: 'ts' | 'rust';
    disableSolveCache?: boolean;
    disableWarmStartCache?: boolean;
    precomputedParaxial?: any;
    precomputedSurfaceOrigins?: any[];
    precomputedImageSurfaceIndex?: number;
    precomputedStopInfo?: any;
    precomputedStopCenter3d?: any;
    precomputedParaxialOnlyModel?: boolean;
    precomputedSolveScopeKey?: string;
};

// Helper function to normalize hit points
function normalizeHitPoint(hit): Vec3 | null {
    if (!hit || Array.isArray(hit)) return null;
    const point = (hit.hitPoint && typeof hit.hitPoint === 'object') ? hit.hitPoint : hit;
    const x = Number(point.x);
    const y = Number(point.y);
    const z = Number(point.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
}

function normalizeObjectPositionTag(value: any): string {
    return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function resolveObjectPositionForRayPath(obj: any): 'point' | 'angle' | 'rectangle' | 'imageheight' | '' {
    const rawPos = normalizeObjectPositionTag(obj?.position ?? obj?.object ?? obj?.objectType ?? obj?.fieldType ?? obj?.type);
    const effectivePos = normalizeObjectPositionTag(obj?.__cooptEffectivePosition);

    // Explicit row position should win so stale internal fields do not override user intent.
    if (rawPos === 'point' || rawPos === 'angle' || rawPos === 'rectangle') return rawPos as 'point' | 'angle' | 'rectangle';
    if (rawPos === 'imageheight') {
        if (effectivePos === 'angle' || effectivePos === 'rectangle') return effectivePos as 'angle' | 'rectangle';
        return 'imageheight';
    }

    if (effectivePos === 'point' || effectivePos === 'angle' || effectivePos === 'rectangle' || effectivePos === 'imageheight') {
        return effectivePos as 'point' | 'angle' | 'rectangle' | 'imageheight';
    }

    return '';
}

// Global variables for ray pattern and color mode
let rayEmissionPattern = 'annular'; // 'grid' or 'annular'
let rayColorMode = 'object'; // 'object' or 'segment'
const chiefRayOriginSolveCache = new Map<string, any>();
const rayStartGenerationCache = new Map<string, RayStartDataArray>();
const RAY_START_GENERATION_CACHE_LIMIT = 128;
const imageHeightEffectiveObjectCache = new Map<string, any>();
const IMAGE_HEIGHT_EFFECTIVE_OBJECT_CACHE_LIMIT = 64;
const imageHeightPairSolveCache = new Map<string, any>();
const IMAGE_HEIGHT_PAIR_SOLVE_CACHE_LIMIT = 128;
const imageHeightWarmStartCache = new Map<string, any[]>();
const IMAGE_HEIGHT_WARM_START_BUCKET_LIMIT = 12;
const IMAGE_HEIGHT_WARM_START_SCOPE_LIMIT = 24;

export function clearRayRendererCaches(): void {
    try { chiefRayOriginSolveCache.clear(); } catch (_) {}
    try { rayStartGenerationCache.clear(); } catch (_) {}
    try { imageHeightEffectiveObjectCache.clear(); } catch (_) {}
    try { imageHeightPairSolveCache.clear(); } catch (_) {}
    try { imageHeightWarmStartCache.clear(); } catch (_) {}
}

export function buildOpticalRowsSignature(opticalSystemRows) {
    if (!Array.isArray(opticalSystemRows)) return 'no-rows';
    return opticalSystemRows
        .map((row, index) => `${index}:${stableSerializeForCache(row ?? null)}`)
        .join('|');
}

function buildChiefRayOriginCacheKey(opticalSystemRows, angleX, angleY, stopSurfaceCenter3d, stopSurfaceIndex, targetSurfaceIndex, wavelength) {
    if (!Array.isArray(opticalSystemRows)) return null;
    if (!stopSurfaceCenter3d || !Number.isInteger(stopSurfaceIndex)) return null;
    const sig = buildOpticalRowsSignature(opticalSystemRows);
    return [
        sig,
        Number(angleX).toFixed(10),
        Number(angleY).toFixed(10),
        Number(stopSurfaceCenter3d.x).toFixed(10),
        Number(stopSurfaceCenter3d.y).toFixed(10),
        Number(stopSurfaceCenter3d.z).toFixed(10),
        Number(stopSurfaceIndex),
        Number(targetSurfaceIndex),
        Number(wavelength).toFixed(10)
    ].join('#');
}

function stableSerializeForCache(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const valueType = typeof value;
    if (valueType === 'number') {
        return Number.isFinite(value) ? `num:${value}` : `num:${String(value)}`;
    }
    if (valueType === 'string') return `str:${value}`;
    if (valueType === 'boolean') return value ? 'bool:1' : 'bool:0';
    if (valueType !== 'object') return `${valueType}:${String(value)}`;
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableSerializeForCache(entry)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${key}:${stableSerializeForCache(value[key])}`).join(',')}}`;
}

function buildRayStartGenerationCacheKey(obj, opticalSystemRows, rayCount, apertureLimit, options, effectivePattern, annularRingCount, wavelengthUm) {
    const optionsSignature = {
        conjugateType: options?.conjugateType,
        useChiefRayAnalysis: options?.useChiefRayAnalysis,
        aimThroughStop: options?.aimThroughStop,
        chiefRaySolveMode: options?.chiefRaySolveMode,
        disableAngleObjectPositionOptimization: options?.disableAngleObjectPositionOptimization,
        allowStopBasedOriginSolve: options?.allowStopBasedOriginSolve,
        skipStopPointRefine: options?.skipStopPointRefine,
        targetSurfaceIndex: options?.targetSurfaceIndex,
        debugChiefRay: options?.debugChiefRay,
        disableCrossExtent: options?.disableCrossExtent,
        originSolveTraceBackend: options?.originSolveTraceBackend,
        strictChiefDirectionSolve: options?.strictChiefDirectionSolve,
        pupilScale: options?.pupilScale,
        rectangleAsAngleWhenInfinite: options?.rectangleAsAngleWhenInfinite,
        crossType: options?.crossType,
        exactCrossBeamSampling: options?.exactCrossBeamSampling,
        displayAxisAlignedSampling: options?.displayAxisAlignedSampling,
        skipImageHeightTsValidation: options?.skipImageHeightTsValidation,
        imageHeightValidationTraceBackend: options?.imageHeightValidationTraceBackend,
        preserveChiefNormalEmissionPlane: options?.preserveChiefNormalEmissionPlane,
    };

    return [
        buildOpticalRowsSignature(opticalSystemRows),
        stableSerializeForCache(obj),
        Number(rayCount) || 0,
        Number.isFinite(Number(apertureLimit)) ? Number(apertureLimit) : 'none',
        String(effectivePattern || ''),
        annularRingCount ?? 'none',
        Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : 0.5876,
        stableSerializeForCache(optionsSignature),
    ].join('||');
}

function buildImageHeightSolveScopeKey(opticalSystemRows, wavelengthUm, conjugateType, validationMode) {
    return [
        buildOpticalRowsSignature(opticalSystemRows),
        Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : 0.5876,
        String(conjugateType || ''),
        String(validationMode || ''),
    ].join('||');
}

function buildImageHeightPairSolveCacheKey(scopeKey, targetX, targetY) {
    return [
        scopeKey,
        Number(targetX || 0).toFixed(9),
        Number(targetY || 0).toFixed(9),
    ].join('||');
}

function getCachedImageHeightPairSolve(scopeKey, targetX, targetY) {
    if (!scopeKey) return null;
    const key = buildImageHeightPairSolveCacheKey(scopeKey, targetX, targetY);
    return imageHeightPairSolveCache.get(key) || null;
}

function setCachedImageHeightPairSolve(scopeKey, targetX, targetY, value) {
    if (!scopeKey || !value || typeof value !== 'object') return value;
    const key = buildImageHeightPairSolveCacheKey(scopeKey, targetX, targetY);
    imageHeightPairSolveCache.set(key, value);
    if (imageHeightPairSolveCache.size > IMAGE_HEIGHT_PAIR_SOLVE_CACHE_LIMIT) {
        const firstKey = imageHeightPairSolveCache.keys().next().value;
        if (firstKey !== undefined) imageHeightPairSolveCache.delete(firstKey);
    }
    return value;
}

function getImageHeightWarmStart(scopeKey, targetX, targetY, fallbackX, fallbackY, explicitSolved = null) {
    const explicitX = Number(explicitSolved?.x);
    const explicitY = Number(explicitSolved?.y);
    if (Number.isFinite(explicitX) && Number.isFinite(explicitY)) {
        return { x: explicitX, y: explicitY, source: 'object-solved' };
    }

    const bucket = scopeKey ? imageHeightWarmStartCache.get(scopeKey) : null;
    if (Array.isArray(bucket) && bucket.length > 0) {
        const nextTargetX = Number(targetX) || 0;
        const nextTargetY = Number(targetY) || 0;
        let bestEntry = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const entry of bucket) {
            const entryTargetX = Number(entry?.targetX);
            const entryTargetY = Number(entry?.targetY);
            const entrySolvedX = Number(entry?.solvedX);
            const entrySolvedY = Number(entry?.solvedY);
            if (![entryTargetX, entryTargetY, entrySolvedX, entrySolvedY].every(Number.isFinite)) continue;
            const score = Math.hypot(entryTargetX - nextTargetX, entryTargetY - nextTargetY);
            if (score < bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        }
        if (bestEntry) {
            return {
                x: Number(bestEntry.solvedX),
                y: Number(bestEntry.solvedY),
                source: 'continuation-cache',
            };
        }
    }

    return {
        x: Number.isFinite(Number(fallbackX)) ? Number(fallbackX) : 0,
        y: Number.isFinite(Number(fallbackY)) ? Number(fallbackY) : 0,
        source: 'paraxial',
    };
}

function storeImageHeightWarmStart(scopeKey, targetX, targetY, solvedX, solvedY, hit = null) {
    if (!scopeKey) return;
    if (![targetX, targetY, solvedX, solvedY].every((value) => Number.isFinite(Number(value)))) return;
    const nextEntry = {
        targetX: Number(targetX),
        targetY: Number(targetY),
        solvedX: Number(solvedX),
        solvedY: Number(solvedY),
        hit: hit && Number.isFinite(Number(hit?.x)) && Number.isFinite(Number(hit?.y))
            ? { x: Number(hit.x), y: Number(hit.y), z: Number.isFinite(Number(hit?.z)) ? Number(hit.z) : 0 }
            : null,
    };
    const previous = Array.isArray(imageHeightWarmStartCache.get(scopeKey))
        ? imageHeightWarmStartCache.get(scopeKey)
        : [];
    const filtered = previous.filter((entry) => {
        const sameTarget = Math.abs(Number(entry?.targetX) - nextEntry.targetX) < 1e-9
            && Math.abs(Number(entry?.targetY) - nextEntry.targetY) < 1e-9;
        return !sameTarget;
    });
    filtered.push(nextEntry);
    while (filtered.length > IMAGE_HEIGHT_WARM_START_BUCKET_LIMIT) filtered.shift();
    imageHeightWarmStartCache.set(scopeKey, filtered);
    while (imageHeightWarmStartCache.size > IMAGE_HEIGHT_WARM_START_SCOPE_LIMIT) {
        const firstKey = imageHeightWarmStartCache.keys().next().value;
        if (firstKey !== undefined) imageHeightWarmStartCache.delete(firstKey);
        else break;
    }
}

function normalizeAnnularRingCount(value) {
    if (value === undefined || value === null) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.max(1, Math.min(Math.floor(numeric), 32));
}

function resolveInfiniteObjectZ(opticalSystemRows, renderDist, stopCenter = null) {
    const rd = Number(renderDist);
    if (Number.isFinite(rd) && rd > 0) return -Math.abs(rd);
    let systemLength = 0;
    if (Array.isArray(opticalSystemRows)) {
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const tRaw = opticalSystemRows[i]?.thickness;
            const t = (typeof tRaw === 'number') ? tRaw : parseFloat(String(tRaw ?? ''));
            if (Number.isFinite(t) && Math.abs(t) < 1e6) {
                systemLength += Math.abs(t);
            }
        }
    }
    const stopZ = Number.isFinite(Number(stopCenter?.z)) ? Math.abs(Number(stopCenter.z)) : 0;
    const fallbackDist = Math.max(1000, systemLength * 5, stopZ + 1000);
    return -fallbackDist;
}

function normalizeVector3(vec, fallback = { x: 0, y: 0, z: 1 }) {
    if (!vec || !Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)) {
        return { ...fallback };
    }
    const length = Math.hypot(vec.x, vec.y, vec.z);
    if (length < 1e-12) {
        return { ...fallback };
    }
    return { x: vec.x / length, y: vec.y / length, z: vec.z / length };
}

function crossProduct(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
    };
}

function projectVectorOntoPlane(vec, planeNormal, fallback = { x: 1, y: 0, z: 0 }) {
    const normal = normalizeVector3(planeNormal, null);
    if (!normal) return normalizeVector3(vec, fallback);
    const dot = Number(vec?.x) * normal.x + Number(vec?.y) * normal.y + Number(vec?.z) * normal.z;
    const projected = {
        x: Number(vec?.x) - dot * normal.x,
        y: Number(vec?.y) - dot * normal.y,
        z: Number(vec?.z) - dot * normal.z,
    };
    return normalizeVector3(projected, fallback);
}

function buildPerpendicularBasis(direction) {
    const dir = normalizeVector3(direction);
    let reference = Math.abs(dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let uAxis = crossProduct(reference, dir);
    if (Math.hypot(uAxis.x, uAxis.y, uAxis.z) < 1e-12) {
        reference = { x: 1, y: 0, z: 0 };
        uAxis = crossProduct(reference, dir);
    }
    const u = normalizeVector3(uAxis, { x: 1, y: 0, z: 0 });
    const v = normalizeVector3(crossProduct(dir, u), { x: 0, y: 1, z: 0 });
    return { dir, u, v };
}

function solveRayDirectionToStopPointFast(
    centerPoint,
    stopTarget3d,
    stopSurfaceIndex,
    opticalSystemRows,
    wavelengthUm,
    traceBackend: 'ts' | 'rust' = 'rust',
    solveOptions: { toleranceMm?: number; maxIter?: number; eps?: number; maxNewtonStep?: number; maxSlope?: number } = {}
) {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) {
        return null;
    }
    if (!centerPoint || !stopTarget3d) {
        return null;
    }

    const dx0 = Number(stopTarget3d.x) - Number(centerPoint.x);
    const dy0 = Number(stopTarget3d.y) - Number(centerPoint.y);
    const dz0 = Number(stopTarget3d.z) - Number(centerPoint.z);
    if (!Number.isFinite(dx0) || !Number.isFinite(dy0) || !Number.isFinite(dz0)) {
        return null;
    }
    if (Math.abs(dz0) < 1e-9) {
        return null;
    }

    const buildDirFromSlopes = (u, v) => {
        const zSign = dz0 >= 0 ? 1 : -1;
        const dir = normalizeVector3({ x: u, y: v, z: zSign }, { x: 0, y: 0, z: zSign });
        return dir;
    };

    // Initial guess: straight line to the stop center.
    const initial = normalizeVector3({ x: dx0, y: dy0, z: dz0 }, { x: 0, y: 0, z: 1 });
    let u = (Math.abs(initial.z) > 1e-9) ? (initial.x / initial.z) : 0;
    let v = (Math.abs(initial.z) > 1e-9) ? (initial.y / initial.z) : 0;

    const slopeGuess = Math.max(
        Math.abs(dx0 / dz0),
        Math.abs(dy0 / dz0),
        0
    );
    const defaultMaxSlope = Math.max(3.0, Math.min(10.0, slopeGuess * 4 + 1.5));
    const maxSlope = Number.isFinite(Number(solveOptions?.maxSlope))
        ? Math.max(0.1, Number(solveOptions.maxSlope))
        : defaultMaxSlope;
    const maxIter = Number.isFinite(Number(solveOptions?.maxIter))
        ? Math.max(1, Math.floor(Number(solveOptions.maxIter)))
        : 14;
    const tolMm = Number.isFinite(Number(solveOptions?.toleranceMm))
        ? Math.max(1e-8, Number(solveOptions.toleranceMm))
        : 1e-3;
    const eps = Number.isFinite(Number(solveOptions?.eps))
        ? Math.max(1e-8, Number(solveOptions.eps))
        : 1e-4;
    const maxNewtonStep = Number.isFinite(Number(solveOptions?.maxNewtonStep))
        ? Math.max(1e-4, Number(solveOptions.maxNewtonStep))
        : Math.max(0.5, Math.min(2.0, 0.25 * maxSlope));
    let bestDir = buildDirFromSlopes(u, v);
    let bestErr = Infinity;
    const finalizeResult = (candidateDir) => {
        if (!candidateDir) return null;
        return candidateDir;
    };

    for (let iter = 0; iter < maxIter; iter++) {
        u = Math.max(-maxSlope, Math.min(maxSlope, u));
        v = Math.max(-maxSlope, Math.min(maxSlope, v));

        const dir = buildDirFromSlopes(u, v);
        const raysForSample = [
            { wavelength: wavelengthUm, pos: { ...centerPoint }, dir },
            { wavelength: wavelengthUm, pos: { ...centerPoint }, dir: buildDirFromSlopes(u + eps, v) },
            { wavelength: wavelengthUm, pos: { ...centerPoint }, dir: buildDirFromSlopes(u, v + eps) }
        ];
        const sampled = traceRayHitPointBatchForRender(opticalSystemRows, raysForSample, 1.0, stopIdx, traceBackend);
        const hit = normalizeHitPoint(Array.isArray(sampled) ? sampled[0] : null);
        if (!hit) {
            u *= 0.8;
            v *= 0.8;
            continue;
        }

        const ex = hit.x - Number(stopTarget3d.x);
        const ey = hit.y - Number(stopTarget3d.y);
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = Math.hypot(ex, ey);
        if (err < bestErr) {
            bestErr = err;
            bestDir = dir;
        }
        if (err < tolMm) {
            return finalizeResult(dir);
        }

        // Finite-difference Jacobian.
        const hitU = normalizeHitPoint(Array.isArray(sampled) ? sampled[1] : null);
        const hitV = normalizeHitPoint(Array.isArray(sampled) ? sampled[2] : null);
        if (!hitU || !hitV) {
            u -= 0.03 * ex;
            v -= 0.03 * ey;
            continue;
        }

        const j11 = (hitU.x - hit.x) / eps;
        const j21 = (hitU.y - hit.y) / eps;
        const j12 = (hitV.x - hit.x) / eps;
        const j22 = (hitV.y - hit.y) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) {
            u -= 0.03 * ex;
            v -= 0.03 * ey;
            continue;
        }

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
            // Fallback: small proportional step.
            u -= 0.05 * ex;
            v -= 0.05 * ey;
            continue;
        }

        // Newton step: [du dv]^T = -J^{-1} * e
        let du = (-j22 * ex + j12 * ey) / det;
        let dv = (j21 * ex - j11 * ey) / det;

        // Clamp step to avoid wild jumps.
        const stepNorm = Math.hypot(du, dv);
        if (stepNorm > maxNewtonStep) {
            const scale = maxNewtonStep / stepNorm;
            du *= scale;
            dv *= scale;
        }
        u += du;
        v += dv;
    }

    // Not converged; use best-effort direction from the selected backend.
    return finalizeResult(bestDir);
}

function solveChiefRayDirectionToStopCenterFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend: 'ts' | 'rust' = 'rust') {
    return solveRayDirectionToStopPointFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend);
}

export function solveRayOriginToStopPointFast(initialOrigin, dirVector, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend: 'ts' | 'rust' = 'rust') {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) {
        return null;
    }
    if (!initialOrigin || !dirVector || !stopTarget3d) {
        return null;
    }

    const baseDir = normalizeVector3(dirVector, { x: 0, y: 0, z: 1 });
    if (!Number.isFinite(baseDir.x) || !Number.isFinite(baseDir.y) || !Number.isFinite(baseDir.z)) {
        return null;
    }

    let origin = { x: Number(initialOrigin.x), y: Number(initialOrigin.y), z: Number(initialOrigin.z) };
    if (![origin.x, origin.y, origin.z].every(Number.isFinite)) {
        return null;
    }

    const eps = 1e-3;
    const tolMm = 1e-3;
    const maxIter = 20;
    const maxStep = 10.0;
    const targetX = Number(stopTarget3d.x);
    const targetY = Number(stopTarget3d.y);
    const targetZ = Number(stopTarget3d.z);
    if (![targetX, targetY].every(Number.isFinite)) {
        return null;
    }

    if ([targetX, targetY, targetZ].every(Number.isFinite) && Math.abs(baseDir.z) > 1e-12) {
        const dz = targetZ - origin.z;
        const directOrigin = {
            x: targetX - baseDir.x / baseDir.z * dz,
            y: targetY - baseDir.y / baseDir.z * dz,
            z: origin.z
        };
        if ([directOrigin.x, directOrigin.y, directOrigin.z].every(Number.isFinite)) {
            origin = directOrigin;
        }
    }

    let bestOrigin = { ...origin };
    let bestErr = Infinity;

    const evaluateOrigin = (o) => {
        const hit = normalizeHitPoint(traceRayHitPointForRender(
            opticalSystemRows,
            { wavelength: wavelengthUm, pos: { ...o }, dir: { ...baseDir } },
            1.0,
            stopIdx,
            traceBackend
        ));
        if (!hit) return { hit: null, err: Number.POSITIVE_INFINITY, ex: Number.POSITIVE_INFINITY, ey: Number.POSITIVE_INFINITY };
        const ex = hit.x - targetX;
        const ey = hit.y - targetY;
        const err = Math.hypot(ex, ey);
        return { hit, err, ex, ey };
    };

    const acceptImprovingStep = (baseOrigin, dx, dy, currentErr) => {
        if (![dx, dy, currentErr].every(Number.isFinite)) return null;
        const scales = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625];
        let bestCandidate: any = null;
        let bestCandidateErr = currentErr;
        for (const scale of scales) {
            const candidate = {
                x: baseOrigin.x + dx * scale,
                y: baseOrigin.y + dy * scale,
                z: baseOrigin.z
            };
            if (![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) continue;
            const evaluated = evaluateOrigin(candidate);
            if (evaluated.err + 1e-9 < bestCandidateErr) {
                bestCandidateErr = evaluated.err;
                bestCandidate = candidate;
                if (evaluated.err < tolMm) break;
            }
        }
        return bestCandidate;
    };

    const hitAtBatch = (o) => {
        const rays = [
            { wavelength: wavelengthUm, pos: { ...o }, dir: { ...baseDir } },
            { wavelength: wavelengthUm, pos: { x: o.x + eps, y: o.y, z: o.z }, dir: { ...baseDir } },
            { wavelength: wavelengthUm, pos: { x: o.x, y: o.y + eps, z: o.z }, dir: { ...baseDir } }
        ];
        return traceRayHitPointBatchForRender(opticalSystemRows, rays, 1.0, stopIdx, traceBackend);
    };

    for (let iter = 0; iter < maxIter; iter++) {
        const sampled = hitAtBatch(origin);
        let hit = normalizeHitPoint(Array.isArray(sampled) ? sampled[0] : null);
        let scalarEval: any = null;
        if (!hit) {
            scalarEval = evaluateOrigin(origin);
            hit = scalarEval.hit;
        }
        if (!hit) {
            origin = {
                x: 0.5 * (origin.x + bestOrigin.x),
                y: 0.5 * (origin.y + bestOrigin.y),
                z: origin.z
            };
            continue;
        }
        const ex = scalarEval ? scalarEval.ex : hit.x - targetX;
        const ey = scalarEval ? scalarEval.ey : hit.y - targetY;
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = scalarEval ? scalarEval.err : Math.hypot(ex, ey);
        if (err < bestErr) {
            bestErr = err;
            bestOrigin = { ...origin };
        }
        if (err < tolMm) {
            return origin;
        }

        const hitX = normalizeHitPoint(Array.isArray(sampled) ? sampled[1] : null);
        const hitY = normalizeHitPoint(Array.isArray(sampled) ? sampled[2] : null);
        if (!hitX || !hitY) {
            const gain = 0.3;
            let dx = -gain * ex;
            let dy = -gain * ey;
            const stepNorm = Math.hypot(dx, dy);
            if (stepNorm > maxStep) {
                const s = maxStep / stepNorm;
                dx *= s;
                dy *= s;
            }
            const improved = acceptImprovingStep(origin, dx, dy, err);
            origin = improved || { x: origin.x + dx, y: origin.y + dy, z: origin.z };
            continue;
        }

        const j11 = (hitX.x - hit.x) / eps;
        const j21 = (hitX.y - hit.y) / eps;
        const j12 = (hitY.x - hit.x) / eps;
        const j22 = (hitY.y - hit.y) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) {
            const gain = 0.2;
            const improved = acceptImprovingStep(origin, -gain * ex, -gain * ey, err);
            origin = improved || { x: origin.x - gain * ex, y: origin.y - gain * ey, z: origin.z };
            continue;
        }

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
            const gain = 0.2;
            const improved = acceptImprovingStep(origin, -gain * ex, -gain * ey, err);
            origin = improved || { x: origin.x - gain * ex, y: origin.y - gain * ey, z: origin.z };
            continue;
        }

        // Newton step: [dx dy]^T = -J^{-1} * e
        let dx = (-j22 * ex + j12 * ey) / det;
        let dy = (j21 * ex - j11 * ey) / det;

        const stepNorm = Math.hypot(dx, dy);
        if (stepNorm > maxStep) {
            const s = maxStep / stepNorm;
            dx *= s;
            dy *= s;
        }

        const improved = acceptImprovingStep(origin, dx, dy, err);
        if (improved) {
            origin = improved;
        } else {
            const gain = 0.2;
            const fallback = acceptImprovingStep(origin, -gain * ex, -gain * ey, err);
            if (!fallback) break;
            origin = fallback;
        }
    }

    const result = bestErr < Infinity ? bestOrigin : origin;
    return result;
}

function solveRayOriginsToStopPointsFastBatch(
    initialOrigins,
    dirVectors,
    stopTargets,
    stopSurfaceIndex,
    opticalSystemRows,
    wavelengthUm,
    traceBackend: 'ts' | 'rust' = 'rust'
) {
    const count = Math.min(
        Array.isArray(initialOrigins) ? initialOrigins.length : 0,
        Array.isArray(dirVectors) ? dirVectors.length : 0,
        Array.isArray(stopTargets) ? stopTargets.length : 0
    );
    if (count <= 0) return [];

    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) {
        return initialOrigins.slice(0, count);
    }

    const eps = 1e-3;
    const tolMm = 1e-3;
    const maxIter = 20;
    const maxStep = 10.0;

    const origins = initialOrigins.slice(0, count).map((p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0, z: Number(p?.z) || 0 }));
    const dirs = dirVectors.slice(0, count).map((d) => normalizeVector3(d, { x: 0, y: 0, z: 1 }));
    const targets = stopTargets.slice(0, count).map((t) => ({ x: Number(t?.x) || 0, y: Number(t?.y) || 0, z: Number(t?.z) || 0 }));
    const bestOrigins = origins.map((p) => ({ ...p }));
    const bestErrs = new Array(count).fill(Number.POSITIVE_INFINITY);
    const solved = new Array(count).fill(false);
    let noProgressIters = 0;

    if (traceBackend === 'rust') {
        try {
            const solvedByRust = solveRayOriginsToStopPointsWithRustMeta(
                opticalSystemRows,
                origins,
                dirs,
                targets,
                stopIdx,
                wavelengthUm,
                {
                    maxIter,
                    tolMm,
                    eps,
                    maxStep: maxStep
                }
            );
            if (Array.isArray(solvedByRust) && solvedByRust.length === count) {
                let converged = 0;
                const mapped = solvedByRust.map((p, i) => {
                    const status = Number((p as any)?.__status);
                    if (status === 1) converged += 1;
                    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
                        return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
                    }
                    return { ...origins[i] };
                });
                if (converged === count) {
                    return mapped;
                }
            }
        } catch (_) {}
    }

    for (let iter = 0; iter < maxIter; iter++) {
        const rays = [];
        const indexMap = [];

        for (let i = 0; i < count; i++) {
            if (solved[i]) continue;
            const o = origins[i];
            const d = dirs[i];
            rays.push({ wavelength: wavelengthUm, pos: { x: o.x, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } });
            indexMap.push(i);
            rays.push({ wavelength: wavelengthUm, pos: { x: o.x + eps, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } });
            indexMap.push(i);
            rays.push({ wavelength: wavelengthUm, pos: { x: o.x, y: o.y + eps, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } });
            indexMap.push(i);
        }

        if (rays.length === 0) break;

        const hits = traceRayHitPointBatchForRender(opticalSystemRows, rays, 1.0, stopIdx, traceBackend);
        if (!Array.isArray(hits) || hits.length !== rays.length) {
            break;
        }

        let newlySolved = 0;
        let improvedBestErrs = 0;
        for (let k = 0; k < hits.length; k += 3) {
            const i = indexMap[k];
            if (!Number.isInteger(i) || i < 0 || i >= count || solved[i]) continue;

            const hit = normalizeHitPoint(hits[k]);
            const hitX = normalizeHitPoint(hits[k + 1]);
            const hitY = normalizeHitPoint(hits[k + 2]);
            const target = targets[i];
            const origin = origins[i];

            if (hit) {
                const ex = hit.x - target.x;
                const ey = hit.y - target.y;
                const err = Math.hypot(ex, ey);
                if (err < bestErrs[i]) {
                    if (bestErrs[i] - err > 1e-9) {
                        improvedBestErrs++;
                    }
                    bestErrs[i] = err;
                    bestOrigins[i] = { ...origin };
                }
                if (err < tolMm) {
                    solved[i] = true;
                    newlySolved++;
                    continue;
                }

                if (!hitX || !hitY) {
                    const gain = 0.3;
                    let dx = -gain * ex;
                    let dy = -gain * ey;
                    const stepNorm = Math.hypot(dx, dy);
                    if (stepNorm > maxStep) {
                        const s = maxStep / stepNorm;
                        dx *= s;
                        dy *= s;
                    }
                    origins[i] = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
                    continue;
                }

                const j11 = (hitX.x - hit.x) / eps;
                const j21 = (hitX.y - hit.y) / eps;
                const j12 = (hitY.x - hit.x) / eps;
                const j22 = (hitY.y - hit.y) / eps;

                if (![j11, j12, j21, j22].every(Number.isFinite)) {
                    origins[i] = { x: origin.x - 0.2 * ex, y: origin.y - 0.2 * ey, z: origin.z };
                    continue;
                }

                const det = j11 * j22 - j12 * j21;
                if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
                    origins[i] = { x: origin.x - 0.2 * ex, y: origin.y - 0.2 * ey, z: origin.z };
                    continue;
                }

                let dx = (-j22 * ex + j12 * ey) / det;
                let dy = (j21 * ex - j11 * ey) / det;
                const stepNorm = Math.hypot(dx, dy);
                if (stepNorm > maxStep) {
                    const s = maxStep / stepNorm;
                    dx *= s;
                    dy *= s;
                }

                origins[i] = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
            } else {
                origins[i] = {
                    x: 0.5 * (origin.x + bestOrigins[i].x),
                    y: 0.5 * (origin.y + bestOrigins[i].y),
                    z: origin.z
                };
            }
        }

        if (newlySolved === 0 && improvedBestErrs === 0) {
            noProgressIters += 1;
        } else {
            noProgressIters = 0;
        }

        if (noProgressIters >= 3 && iter >= 4) {
            break;
        }

        if (newlySolved === 0 && solved.every(Boolean)) break;
    }

    return origins.map((o, i) => (Number.isFinite(bestErrs[i]) ? bestOrigins[i] : o));
}

function selectSymmetricSubset(points, needed) {
    if (needed <= 0) return [];
    const groups = new Map();
    points.forEach(point => {
        const absU = Math.abs(point.offsetU);
        const absV = Math.abs(point.offsetV);
        const key = `${absU.toFixed(12)}_${absV.toFixed(12)}`;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(point);
    });

    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        const aKey = `${Math.abs(a[0].offsetU)}_${Math.abs(a[0].offsetV)}`;
        const bKey = `${Math.abs(b[0].offsetU)}_${Math.abs(b[0].offsetV)}`;
        return aKey.localeCompare(bKey);
    });

    const selected = [];
    for (const group of sortedGroups) {
        if (group.length <= needed) {
            selected.push(...group);
            needed -= group.length;
        }
        if (needed <= 0) break;
    }
    return selected;
}

function ensureCenterOffsetIncluded(offsets, rayCount) {
    const limit = Math.max(0, Math.floor(Number(rayCount) || 0));
    if (limit <= 0) return [];
    const list = Array.isArray(offsets) ? offsets.slice() : [];
    const centerIndex = list.findIndex((point) => {
        return Math.abs(Number(point?.offsetU) || 0) <= 1e-12
            && Math.abs(Number(point?.offsetV) || 0) <= 1e-12;
    });
    if (centerIndex >= 0) {
        const center = list.splice(centerIndex, 1)[0];
        return [center, ...list].slice(0, limit);
    }
    const withCenter = [{ offsetU: 0, offsetV: 0 }, ...list];
    return withCenter.slice(0, limit);
}

function generateAnnularOffsets(rayCount, maxRadius, ringCount) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.generate_annular_offsets_flat;
        if (typeof rustFn === 'function') {
            const flat = rustFn(rayCount, maxRadius, ringCount);
            if (flat && typeof (flat as any).length === 'number') {
                const offsets = [];
                for (let i = 0; i + 1 < (flat as any).length; i += 2) {
                    offsets.push({ offsetU: Number((flat as any)[i]) || 0, offsetV: Number((flat as any)[i + 1]) || 0 });
                }
                if (offsets.length > 0) {
                    return ensureCenterOffsetIncluded(offsets, rayCount);
                }
            }
        }
    } catch (_) {}

    const offsets = [];
    if (rayCount <= 0) {
        return offsets;
    }

    const safeRingCount = Math.max(1, Math.floor(ringCount));
    const rings = Math.min(safeRingCount, rayCount);

    const centerRays = Math.min(rayCount, 1);
    const remainingRays = rayCount - centerRays;

    if (centerRays === 1) {
        offsets.push({ offsetU: 0, offsetV: 0 });
    }

    if (remainingRays <= 0) {
        return offsets;
    }

    const ringRadii = [];
    const step = rings > 0 ? maxRadius / rings : maxRadius;
    for (let r = 1; r <= rings; r++) {
        ringRadii.push(step * r);
    }

    let raysLeft = remainingRays;
    for (let idx = 0; idx < ringRadii.length && raysLeft > 0; idx++) {
        const radius = ringRadii[idx];
        const ringsRemaining = ringRadii.length - idx;
        const raysForThisRing = Math.max(4, Math.floor(raysLeft / ringsRemaining));
        const angles = raysForThisRing;
        const angleStep = (2 * Math.PI) / angles;
        const startAngle = (idx % 2 === 0) ? 0 : angleStep / 2;

        for (let i = 0; i < angles && raysLeft > 0; i++) {
            const angle = startAngle + i * angleStep;
            const offsetU = radius * Math.cos(angle);
            const offsetV = radius * Math.sin(angle);
            offsets.push({ offsetU, offsetV });
            raysLeft--;
        }
    }

    return offsets;
}

function generateCenteredGridOffsets(rayCount, halfExtent) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.generate_centered_grid_offsets_flat;
        if (typeof rustFn === 'function') {
            const flat = rustFn(rayCount, halfExtent);
            if (flat && typeof (flat as any).length === 'number') {
                const offsets = [];
                for (let i = 0; i + 1 < (flat as any).length; i += 2) {
                    offsets.push({ offsetU: Number((flat as any)[i]) || 0, offsetV: Number((flat as any)[i + 1]) || 0 });
                }
                if (offsets.length >= rayCount) {
                    return ensureCenterOffsetIncluded(offsets, rayCount);
                }
            }
        }
    } catch (_) {}

    if (rayCount <= 0) return [];
    let gridSize = Math.max(1, Math.ceil(Math.sqrt(rayCount)));
    if (gridSize % 2 === 0) gridSize += 1;
    const spacing = gridSize > 1 ? (2 * halfExtent) / (gridSize - 1) : 0;
    const centerIndex = (gridSize - 1) / 2;
    const layers = new Map();

    for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
            const offsetU = gridSize > 1 ? (i - centerIndex) * spacing : 0;
            const offsetV = gridSize > 1 ? (j - centerIndex) * spacing : 0;
            const layer = Math.max(Math.abs(i - centerIndex), Math.abs(j - centerIndex));
            const point = { offsetU, offsetV, layer };
            if (!layers.has(layer)) {
                layers.set(layer, []);
            }
            layers.get(layer).push(point);
        }
    }

    const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);
    const selected = [];
    let remaining = rayCount;

    for (const layer of sortedLayers) {
        const layerPoints = layers.get(layer) || [];
        layerPoints.sort((a, b) => {
            const absUa = Math.abs(a.offsetU);
            const absUb = Math.abs(b.offsetU);
            if (absUa !== absUb) return absUa - absUb;
            const absVa = Math.abs(a.offsetV);
            const absVb = Math.abs(b.offsetV);
            if (absVa !== absVb) return absVa - absVb;
            if (a.offsetU !== b.offsetU) return a.offsetU - b.offsetU;
            return a.offsetV - b.offsetV;
        });

        if (remaining >= layerPoints.length) {
            selected.push(...layerPoints);
            remaining -= layerPoints.length;
        } else {
            const subset = selectSymmetricSubset(layerPoints, remaining);
            selected.push(...subset);
            remaining -= subset.length;
            break;
        }
    }

    if (selected.length < rayCount) {
        console.warn(`⚠️ [RayRenderer] Grid pattern placed ${selected.length}/${rayCount} rays to maintain symmetry. Consider adjusting ray count for full square coverage.`);
    }

    return selected.slice(0, rayCount);
}

function generateUniformCrossOffsets(rayCount, halfExtent, crossType: 'vertical' | 'horizontal' | 'both') {
    const useVertical = crossType === 'both' || crossType === 'vertical';
    const useHorizontal = crossType === 'both' || crossType === 'horizontal';
    const minimumRayCount = 1 + (useVertical ? 2 : 0) + (useHorizontal ? 2 : 0);
    const requestedRayCount = Math.max(minimumRayCount, Math.floor(Number(rayCount) || 0));
    const symmetricRayCount = requestedRayCount % 2 === 0 ? requestedRayCount + 1 : requestedRayCount;
    const pairCount = (symmetricRayCount - 1) / 2;
    let verticalPairCount = useVertical ? pairCount : 0;
    let horizontalPairCount = useHorizontal ? pairCount : 0;

    if (useVertical && useHorizontal) {
        verticalPairCount = Math.max(1, Math.floor(pairCount / 2));
        horizontalPairCount = Math.max(1, pairCount - verticalPairCount);
    }

    const offsets: Array<{ offsetU: number; offsetV: number }> = [{ offsetU: 0, offsetV: 0 }];
    const appendPairs = (count, axis: 'vertical' | 'horizontal') => {
        for (let index = 1; index <= count; index++) {
            const offset = halfExtent * index / count;
            if (axis === 'vertical') {
                offsets.push({ offsetU: 0, offsetV: -offset }, { offsetU: 0, offsetV: offset });
            } else {
                offsets.push({ offsetU: -offset, offsetV: 0 }, { offsetU: offset, offsetV: 0 });
            }
        }
    };

    if (useVertical) appendPairs(verticalPairCount, 'vertical');
    if (useHorizontal) appendPairs(horizontalPairCount, 'horizontal');
    return offsets;
}

function generateParallelStartPointsViaRust(origin, uAxis, vAxis, offsets) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.generate_parallel_start_points_flat;
        if (typeof rustFn !== 'function') return null;
        if (!Array.isArray(offsets) || offsets.length === 0) return [];

        const flatOffsets = new Float64Array(offsets.length * 2);
        for (let i = 0; i < offsets.length; i++) {
            flatOffsets[i * 2] = Number(offsets[i]?.offsetU) || 0;
            flatOffsets[i * 2 + 1] = Number(offsets[i]?.offsetV) || 0;
        }

        const flat = rustFn(
            new Float64Array([Number(origin?.x) || 0, Number(origin?.y) || 0, Number(origin?.z) || 0]),
            new Float64Array([Number(uAxis?.x) || 0, Number(uAxis?.y) || 0, Number(uAxis?.z) || 0]),
            new Float64Array([Number(vAxis?.x) || 0, Number(vAxis?.y) || 0, Number(vAxis?.z) || 0]),
            flatOffsets,
            offsets.length
        );

        if (!flat || typeof (flat as any).length !== 'number') return null;
        const out = [];
        for (let i = 0; i + 4 < (flat as any).length; i += 5) {
            out.push({
                startP: {
                    x: Number((flat as any)[i]) || 0,
                    y: Number((flat as any)[i + 1]) || 0,
                    z: Number((flat as any)[i + 2]) || 0
                },
                offsetU: Number((flat as any)[i + 3]) || 0,
                offsetV: Number((flat as any)[i + 4]) || 0
            });
        }
        return out;
    } catch (_) {
        return null;
    }
}

function parseAngleInput(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return 0;
        const normalized = trimmed.replace(',', '.');
        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function parseNumericValue(value, fallback = 0) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'string') {
        const normalized = value.replace(',', '.');
        const match = normalized.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
        if (match) {
            const parsed = parseFloat(match[0]);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    return fallback;
}

function buildDirectionFromFieldAngles(angleXDeg, angleYDeg) {
    const radX = (Number(angleXDeg) || 0) * Math.PI / 180;
    const radY = (Number(angleYDeg) || 0) * Math.PI / 180;
    const cosX = Math.cos(radX);
    const cosY = Math.cos(radY);
    const sinX = Math.sin(radX);
    const sinY = Math.sin(radY);
    const dir = {
        x: sinX * cosY,
        y: sinY * cosX,
        z: cosX * cosY
    };
    return normalizeVector3(dir, { x: 0, y: 0, z: 1 });
}

function findImageSurfaceIndex(opticalSystemRows) {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return 0;
    let imageIndex = -1;
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i] || {};
        const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
        if (objectType === 'image') imageIndex = i;
    }
    return imageIndex >= 0 ? imageIndex : Math.max(0, opticalSystemRows.length - 1);
}

function getRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const isCoordTransRow = (row) => {
        const stRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
        const st = stRaw.trim();
        return st === 'coord trans' || st === 'coordinate break' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
    };
    const isObjectRow = (row) => {
        const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
        return t === 'object';
    };
    const isGapRow = (row) => {
        const fields = [
            row?.blockType, row?._blockType, row?.block_type, row?.blockTypeName,
            row?.['object type'], row?.object, row?.Object,
            row?.type, row?.Type,
            row?.comment, row?.Comment,
        ];
        return fields.some((value) => {
            const key = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            return key === 'gap' || key === 'airgap' || key.includes('airgap');
        });
    };
    const isThinLensBackRow = (row) => {
        const blockType = String(row?._blockType ?? row?.blockType ?? row?.block_type ?? row?.blockTypeName ?? '').trim().toLowerCase();
        if (blockType !== 'thinlens' && blockType !== 'paraxial') return false;
        return String(row?._surfaceRole ?? row?.surfaceRole ?? '').trim().toLowerCase() === 'back';
    };

    const sIdx = Math.max(0, Math.min(Number(surfaceIndex), opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (isCoordTransRow(row)) continue;
        if (isObjectRow(row)) continue;
        if (isGapRow(row)) continue;
        if (isThinLensBackRow(row)) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(rayPath)) return null;
    const pIdx = getRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex);
    if (pIdx !== null && pIdx >= 0 && pIdx < rayPath.length) {
        const direct = rayPath[pIdx];
        if (direct && Number.isFinite(Number(direct.x)) && Number.isFinite(Number(direct.y)) && Number.isFinite(Number(direct.z))) {
            return direct;
        }
    }
    return null;
}

function transformPointToSurfaceLocal(point, surfaceInfo) {
    if (!point || !surfaceInfo?.origin || !surfaceInfo?.rotationMatrix) return point;
    const dx = Number(point.x) - Number(surfaceInfo.origin.x);
    const dy = Number(point.y) - Number(surfaceInfo.origin.y);
    const dz = Number(point.z) - Number(surfaceInfo.origin.z);
    const matrix = surfaceInfo.rotationMatrix;
    return {
        x: matrix[0][0] * dx + matrix[1][0] * dy + matrix[2][0] * dz,
        y: matrix[0][1] * dx + matrix[1][1] * dy + matrix[2][1] * dz,
        z: matrix[0][2] * dx + matrix[1][2] * dy + matrix[2][2] * dz,
    };
}

function resolveFiniteObjectSurfacePoint(opticalSystemRows, x, y) {
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const firstSurfaceOrigin = surfaceOrigins?.[0]?.origin ?? { x: 0, y: 0, z: 0 };
    const surf = opticalSystemRows?.[0] ?? {};
    let sag = 0;
    if (surf?.radius && surf.radius !== 'INF') {
        const r = Math.sqrt(x * x + y * y);
        const asphericParams = {
            radius: parseFloat(surf.radius),
            conic: Number(surf.conic) || 0,
            coef1: Number(surf.coef1) || 0,
            coef2: Number(surf.coef2) || 0,
            coef3: Number(surf.coef3) || 0,
            coef4: Number(surf.coef4) || 0,
            coef5: Number(surf.coef5) || 0,
            coef6: Number(surf.coef6) || 0,
            coef7: Number(surf.coef7) || 0,
            coef8: Number(surf.coef8) || 0,
            coef9: Number(surf.coef9) || 0,
            coef10: Number(surf.coef10) || 0,
        };
        sag = asphericSurfaceZ(r, asphericParams, getAsphericModeFromSurfType(surf.surfType)) || 0;
    }
    return {
        x,
        y,
        z: Number(firstSurfaceOrigin.z) + sag,
    };
}

function isParaxialOnlyImageHeightModel(opticalSystemRows) {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;

    let sawParaxialSurface = false;
    for (const row of opticalSystemRows) {
        const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image' || objectType === 'stop') continue;

        const blockType = String(row?._blockType ?? row?.blockType ?? row?.block_type ?? row?.blockTypeName ?? '').trim().toLowerCase();
        const surfaceRole = String(row?._surfaceRole ?? row?.surfaceRole ?? '').trim().toLowerCase();
        if (blockType === 'paraxial' || blockType === 'thinlens') {
            if (surfaceRole !== 'back') sawParaxialSurface = true;
            continue;
        }

        const fields = [
            row?.comment,
            row?.Comment,
            row?.type,
            row?.Type,
            row?.['object type'],
            row?.object,
            row?.Object,
        ];
        const isGapLike = fields.some((value) => {
            const key = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            return key === 'gap' || key === 'airgap' || key.includes('airgap');
        });
        if (isGapLike) continue;

        const thicknessRaw = row?.thickness;
        const thicknessText = String(thicknessRaw ?? '').trim();
        const radiusText = String(row?.radius ?? '').trim();
        const hasGeometry = thicknessText !== '' || radiusText !== '';
        if (hasGeometry) return false;
    }

    return sawParaxialSurface;
}

function traceChiefRayForAngleDetails(opticalSystemRows, angleXDeg, angleYDeg, imageSurfaceIndex, imageSurfaceInfo, wavelengthUm, precomputedContext: any = null, traceBackend: 'ts' | 'rust' = 'rust') {
    if (traceBackend === 'rust') {
        const exact = traceImageHeightInfiniteChiefRayExactWithRust(
            opticalSystemRows,
            imageSurfaceIndex,
            wavelengthUm,
            angleXDeg,
            angleYDeg,
        );
        if (exact) return exact;
    }

    const surfaceOrigins = Array.isArray(precomputedContext?.surfaceOrigins)
        ? precomputedContext.surfaceOrigins
        : calculateSurfaceOrigins(opticalSystemRows);
    const stopInfo = precomputedContext?.stopInfo || findStopSurface(opticalSystemRows, surfaceOrigins);
    const stopCenter3d = precomputedContext?.stopCenter3d || extractStopCenter3d(stopInfo);
    if (!stopInfo || !stopCenter3d || !Number.isInteger(stopInfo.index)) return null;

    const direction = buildDirectionFromFieldAngles(angleXDeg, angleYDeg);
    const origin = findInfiniteSystemChiefRayOrigin(
        { i: direction.x, j: direction.y, k: direction.z },
        stopCenter3d,
        stopInfo.index,
        opticalSystemRows,
        false,
        imageSurfaceIndex,
        wavelengthUm,
    );
    if (!origin) return null;

    const refinedDirection = solveRayDirectionToStopPointFast(
        origin,
        stopCenter3d,
        stopInfo.index,
        opticalSystemRows,
        wavelengthUm,
        traceBackend,
        {
            toleranceMm: 1e-4,
            maxIter: 20,
            eps: 1e-5,
            maxNewtonStep: 0.05,
        }
    );
    const traceDirection = refinedDirection || direction;
    let traceOrigin = origin;

    const refinedOriginFromDirection = findInfiniteSystemChiefRayOrigin(
        { i: traceDirection.x, j: traceDirection.y, k: traceDirection.z },
        stopCenter3d,
        stopInfo.index,
        opticalSystemRows,
        false,
        imageSurfaceIndex,
        wavelengthUm,
    );
    if (refinedOriginFromDirection) {
        traceOrigin = refinedOriginFromDirection;
    }

    const polishedOrigin = solveRayOriginToStopPointFast(
        traceOrigin,
        traceDirection,
        stopCenter3d,
        stopInfo.index,
        opticalSystemRows,
        wavelengthUm,
        traceBackend,
    );
    if (polishedOrigin && Number.isFinite(Number(polishedOrigin.x)) && Number.isFinite(Number(polishedOrigin.y)) && Number.isFinite(Number(polishedOrigin.z))) {
        traceOrigin = polishedOrigin;
    }

    const hit = traceRayHitPointForRender(
        opticalSystemRows,
        { pos: traceOrigin, dir: traceDirection, wavelength: wavelengthUm },
        1.0,
        imageSurfaceIndex,
        traceBackend
    );
    if (!hit || !Number.isFinite(Number(hit.x)) || !Number.isFinite(Number(hit.y)) || !Number.isFinite(Number(hit.z))) {
        return null;
    }
    const localHit = transformPointToSurfaceLocal(hit, imageSurfaceInfo);

    return {
        localHit,
        origin: traceOrigin,
        dir: traceDirection,
    };
}

function traceChiefRayImagePointForAngle(opticalSystemRows, angleXDeg, angleYDeg, imageSurfaceIndex, imageSurfaceInfo, wavelengthUm, precomputedContext: any = null, traceBackend: 'ts' | 'rust' = 'rust') {
    if (traceBackend === 'rust') {
        const localHit = traceImageHeightInfiniteCandidateExactLocalWithRust(
            opticalSystemRows,
            imageSurfaceIndex,
            wavelengthUm,
            angleXDeg,
            angleYDeg,
        ) || traceImageHeightInfiniteCandidateLocalWithRust(
            opticalSystemRows,
            imageSurfaceIndex,
            wavelengthUm,
            angleXDeg,
            angleYDeg,
        );
        if (localHit) return localHit;
    }

    const details = traceChiefRayForAngleDetails(
        opticalSystemRows,
        angleXDeg,
        angleYDeg,
        imageSurfaceIndex,
        imageSurfaceInfo,
        wavelengthUm,
        precomputedContext,
        traceBackend,
    );
    return details?.localHit ?? null;
}

function traceChiefRayImagePointForFiniteObject(opticalSystemRows, objectX, objectY, imageSurfaceIndex, imageSurfaceInfo, wavelengthUm, precomputedContext: any = null, traceBackend: 'ts' | 'rust' = 'rust') {
    const details = traceChiefRayForFiniteObjectDetails(
        opticalSystemRows,
        objectX,
        objectY,
        imageSurfaceIndex,
        imageSurfaceInfo,
        wavelengthUm,
        precomputedContext,
        traceBackend,
    );
    return details?.localHit ?? null;
}

function traceChiefRayForFiniteObjectDetails(opticalSystemRows, objectX, objectY, imageSurfaceIndex, imageSurfaceInfo, wavelengthUm, precomputedContext: any = null, traceBackend: 'ts' | 'rust' = 'rust') {
    if (traceBackend === 'rust') {
        const localHit = traceImageHeightFiniteCandidateLocalWithRust(
            opticalSystemRows,
            imageSurfaceIndex,
            wavelengthUm,
            objectX,
            objectY,
        );
        if (localHit) {
            const surfacePoint = resolveFiniteObjectSurfacePoint(opticalSystemRows, objectX, objectY);
            const surfaceOrigins = Array.isArray(precomputedContext?.surfaceOrigins)
                ? precomputedContext.surfaceOrigins
                : calculateSurfaceOrigins(opticalSystemRows);
            const stopInfo = precomputedContext?.stopInfo || findStopSurface(opticalSystemRows, surfaceOrigins);
            const stopCenter3d = precomputedContext?.stopCenter3d || extractStopCenter3d(stopInfo);
            let traceDirection = null;
            if (stopInfo && stopCenter3d && Number.isInteger(stopInfo.index)) {
                const chiefDirection = findFiniteSystemChiefRayDirection(
                    surfacePoint,
                    stopCenter3d,
                    stopInfo.index,
                    opticalSystemRows,
                    false,
                    wavelengthUm,
                );
                if (chiefDirection) {
                    traceDirection = refineFiniteChiefDirectionToStopCenter(
                        surfacePoint,
                        {
                            x: chiefDirection.i,
                            y: chiefDirection.j,
                            z: chiefDirection.k,
                        },
                        stopCenter3d,
                        stopInfo.index,
                        opticalSystemRows,
                        wavelengthUm,
                        traceBackend,
                    );
                }
            }
            return {
                localHit,
                origin: surfacePoint,
                dir: traceDirection,
            };
        }
    }

    const surfaceOrigins = Array.isArray(precomputedContext?.surfaceOrigins)
        ? precomputedContext.surfaceOrigins
        : calculateSurfaceOrigins(opticalSystemRows);
    const stopInfo = precomputedContext?.stopInfo || findStopSurface(opticalSystemRows, surfaceOrigins);
    const stopCenter3d = precomputedContext?.stopCenter3d || extractStopCenter3d(stopInfo);
    if (!stopInfo || !stopCenter3d || !Number.isInteger(stopInfo.index)) return null;

    const objectPoint = resolveFiniteObjectSurfacePoint(opticalSystemRows, objectX, objectY);
    const chiefDirection = findFiniteSystemChiefRayDirection(
        objectPoint,
        stopCenter3d,
        stopInfo.index,
        opticalSystemRows,
        false,
        wavelengthUm,
    );
    if (!chiefDirection) return null;

    const traceDirection = refineFiniteChiefDirectionToStopCenter(
        objectPoint,
        {
            x: chiefDirection.i,
            y: chiefDirection.j,
            z: chiefDirection.k,
        },
        stopCenter3d,
        stopInfo.index,
        opticalSystemRows,
        wavelengthUm,
        traceBackend,
    );

    const hit = traceRayHitPointForRender(
        opticalSystemRows,
        {
            pos: objectPoint,
            dir: traceDirection,
            wavelength: wavelengthUm,
        },
        1.0,
        imageSurfaceIndex,
        traceBackend
    );
    if (!hit || !Number.isFinite(Number(hit.x)) || !Number.isFinite(Number(hit.y)) || !Number.isFinite(Number(hit.z))) {
        return null;
    }
    return {
        localHit: transformPointToSurfaceLocal(hit, imageSurfaceInfo),
        origin: objectPoint,
        dir: traceDirection,
    };
}

export function traceChiefRayLocalImagePointForObject(
    opticalSystemRows,
    obj,
    wavelengthUm,
    options: {
        traceBackend?: 'ts' | 'rust';
        conjugateType?: ConjugateType;
        skipImageHeightTsValidation?: boolean;
        imageHeightValidationTraceBackend?: 'ts' | 'rust';
    } = {}
) {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0 || !obj) return null;

    const traceBackend: 'ts' | 'rust' = options?.traceBackend === 'ts' ? 'ts' : 'rust';
    const conjugateType = options?.conjugateType || detectConjugateType(opticalSystemRows, options);
    const imageSurfaceIndex = findImageSurfaceIndex(opticalSystemRows);
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const imageSurfaceInfo = surfaceOrigins?.[imageSurfaceIndex] || null;
    const stopInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
    const stopCenter3d = extractStopCenter3d(stopInfo);
    const precomputedContext = {
        surfaceOrigins,
        stopInfo,
        stopCenter3d,
    };

    const posNorm = resolveObjectPositionForRayPath(obj);
    if (posNorm === 'imageheight') {
        const effectiveObj = convertImageHeightToEffectiveObject(
            obj,
            opticalSystemRows,
            wavelengthUm,
            conjugateType,
            {
                skipTsValidation: options?.skipImageHeightTsValidation === true,
                validationTraceBackend: options?.imageHeightValidationTraceBackend === 'rust' ? 'rust' : 'ts',
            }
        );
        if (!effectiveObj || effectiveObj === obj) return null;
        return traceChiefRayLocalImagePointForObject(opticalSystemRows, effectiveObj, wavelengthUm, {
            ...options,
            conjugateType,
        });
    }

    if (posNorm === 'angle') {
        const angleXDeg = Number(obj?.xHeightAngle ?? obj?.xAngle ?? obj?.x ?? 0);
        const angleYDeg = Number(obj?.yHeightAngle ?? obj?.yAngle ?? obj?.yFieldAngle ?? obj?.fieldAngle ?? obj?.y ?? 0);
        return traceChiefRayImagePointForAngle(
            opticalSystemRows,
            Number.isFinite(angleXDeg) ? angleXDeg : 0,
            Number.isFinite(angleYDeg) ? angleYDeg : 0,
            imageSurfaceIndex,
            imageSurfaceInfo,
            wavelengthUm,
            precomputedContext,
            traceBackend,
        );
    }

    if (posNorm === 'rectangle' || posNorm === 'point') {
        const objectX = Number(obj?.xHeight ?? obj?.x ?? obj?.['object x'] ?? 0);
        const objectY = Number(obj?.yHeight ?? obj?.y ?? obj?.['object y'] ?? 0);
        return traceChiefRayImagePointForFiniteObject(
            opticalSystemRows,
            Number.isFinite(objectX) ? objectX : 0,
            Number.isFinite(objectY) ? objectY : 0,
            imageSurfaceIndex,
            imageSurfaceInfo,
            wavelengthUm,
            precomputedContext,
            traceBackend,
        );
    }

    return null;
}

function refineFiniteChiefDirectionToStopCenter(centerPoint, fallbackDirection, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend: 'ts' | 'rust' = 'rust') {
    const refinedDirection = solveRayDirectionToStopPointFast(
        centerPoint,
        stopCenter3d,
        stopSurfaceIndex,
        opticalSystemRows,
        wavelengthUm,
        traceBackend,
        {
            toleranceMm: 1e-4,
            maxIter: 20,
            eps: 1e-5,
            maxNewtonStep: 0.05,
        }
    );
    return refinedDirection || fallbackDirection;
}

function logImageHeightDiagnostics(label, payload) {
    try {
        const host = (typeof window !== 'undefined') ? (window as any) : null;
        const record = {
            at: new Date().toISOString(),
            label,
            ...payload
        };
        if (host) {
            try { host.__COOPT_LAST_IMAGEHEIGHT_DIAG = record; } catch (_) {}
            try {
                const logs = Array.isArray(host.__COOPT_IMAGEHEIGHT_DIAG_LOGS)
                    ? host.__COOPT_IMAGEHEIGHT_DIAG_LOGS
                    : [];
                logs.push(record);
                if (logs.length > 50) logs.splice(0, logs.length - 50);
                host.__COOPT_IMAGEHEIGHT_DIAG_LOGS = logs;
            } catch (_) {}
        }
        const enabled = host?.__COOPT_ENABLE_IMAGEHEIGHT_DIAG === true;
        const requestedOnce = host?.__COOPT_REQUEST_IMAGEHEIGHT_DIAG_ONCE === true;
        if (!enabled && !requestedOnce) return;
        if (requestedOnce) host.__COOPT_REQUEST_IMAGEHEIGHT_DIAG_ONCE = false;
        console.warn(`[ImageHeightDiag] ${label}`, record);
    } catch (_) {}
}

function solveImageHeightComponentWithRust(
    opticalSystemRows,
    imageSurfaceIndex,
    wavelengthUm,
    conjugateType: ConjugateType,
    componentIndex: 0 | 1,
    targetValue,
    initialGuess,
    fixedValue,
    options: { initialStep?: number; maxStep?: number } = {}
): { candidate: number; hit: { x: number; y: number; z: number } | null } | null {
    try {
        if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return null;
        if (!Number.isInteger(imageSurfaceIndex) || imageSurfaceIndex < 0) return null;
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.solve_image_height_component_with_rows;
        if (typeof rustFn !== 'function') return null;

        const initialStep = Number(options?.initialStep);
        const maxStep = Number(options?.maxStep);
        const raw = rustFn(
            opticalSystemRows,
            imageSurfaceIndex,
            Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : 0.5876,
            conjugateType === 'infinite' ? 0 : 1,
            componentIndex,
            Number(targetValue) || 0,
            Number(initialGuess) || 0,
            Number(fixedValue) || 0,
            Number.isFinite(initialStep) ? initialStep : NaN,
            Number.isFinite(maxStep) ? maxStep : NaN,
        );
        if (!raw || typeof raw.length !== 'number' || raw.length < 5) return null;
        const status = Number(raw[0]);
        const candidate = Number(raw[1]);
        if (status !== 1 || !Number.isFinite(candidate)) return null;

        const hitX = Number(raw[2]);
        const hitY = Number(raw[3]);
        const hitZ = Number(raw[4]);
        return {
            candidate,
            hit: (Number.isFinite(hitX) && Number.isFinite(hitY) && Number.isFinite(hitZ))
                ? { x: hitX, y: hitY, z: hitZ }
                : null,
        };
    } catch (_) {
        return null;
    }
}

function solveImageHeightPairWithRust(
    opticalSystemRows,
    imageSurfaceIndex,
    wavelengthUm,
    conjugateType: ConjugateType,
    targetX,
    targetY,
    initialX,
    initialY,
): { x: number; y: number; hit: { x: number; y: number; z: number } | null } | null {
    try {
        if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return null;
        if (!Number.isInteger(imageSurfaceIndex) || imageSurfaceIndex < 0) return null;
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.solve_image_height_pair_with_rows;
        if (typeof rustFn !== 'function') return null;

        const raw = rustFn(
            opticalSystemRows,
            imageSurfaceIndex,
            Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : 0.5876,
            conjugateType === 'infinite' ? 0 : 1,
            Number(targetX) || 0,
            Number(targetY) || 0,
            Number(initialX) || 0,
            Number(initialY) || 0,
        );
        if (!raw || typeof raw.length !== 'number' || raw.length < 6) return null;
        const status = Number(raw[0]);
        const solvedX = Number(raw[1]);
        const solvedY = Number(raw[2]);
        if (status !== 1 || !Number.isFinite(solvedX) || !Number.isFinite(solvedY)) return null;

        const hitX = Number(raw[3]);
        const hitY = Number(raw[4]);
        const hitZ = Number(raw[5]);
        return {
            x: solvedX,
            y: solvedY,
            hit: (Number.isFinite(hitX) && Number.isFinite(hitY) && Number.isFinite(hitZ))
                ? { x: hitX, y: hitY, z: hitZ }
                : null,
        };
    } catch (_) {
        return null;
    }
}

function solveImageHeightPairExactWithRust(
    opticalSystemRows,
    imageSurfaceIndex,
    wavelengthUm,
    conjugateType: ConjugateType,
    targetX,
    targetY,
    initialX,
    initialY,
): { x: number; y: number; hit: { x: number; y: number; z: number } | null } | null {
    try {
        if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return null;
        if (!Number.isInteger(imageSurfaceIndex) || imageSurfaceIndex < 0) return null;
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.solve_image_height_pair_exact_with_rows;
        if (typeof rustFn !== 'function') return null;

        const raw = rustFn(
            opticalSystemRows,
            imageSurfaceIndex,
            Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : 0.5876,
            conjugateType === 'infinite' ? 0 : 1,
            Number(targetX) || 0,
            Number(targetY) || 0,
            Number(initialX) || 0,
            Number(initialY) || 0,
        );
        if (!raw || typeof raw.length !== 'number' || raw.length < 6) return null;
        const status = Number(raw[0]);
        const solvedX = Number(raw[1]);
        const solvedY = Number(raw[2]);
        if (status !== 1 || !Number.isFinite(solvedX) || !Number.isFinite(solvedY)) return null;

        const hitX = Number(raw[3]);
        const hitY = Number(raw[4]);
        const hitZ = Number(raw[5]);
        return {
            x: solvedX,
            y: solvedY,
            hit: (Number.isFinite(hitX) && Number.isFinite(hitY) && Number.isFinite(hitZ))
                ? { x: hitX, y: hitY, z: hitZ }
                : null,
        };
    } catch (_) {
        return null;
    }
}

function acceptRustImageHeightCandidate(
    rustResult,
    componentIndex: 0 | 1,
    targetValue: number,
    tolerance = 1e-6,
): number | null {
    const candidate = Number(rustResult?.candidate);
    if (!Number.isFinite(candidate)) return null;
    const hit = rustResult?.hit;
    const hitComponent = componentIndex === 0 ? Number(hit?.x) : Number(hit?.y);
    if (!Number.isFinite(hitComponent)) return null;
    if (Math.abs(hitComponent - Number(targetValue || 0)) > tolerance) return null;
    return candidate;
}

function acceptRustImageHeightCandidateWithValidation(
    rustResult,
    componentIndex: 0 | 1,
    targetValue: number,
    evaluateCandidate,
    tolerance = 1e-6,
): number | null {
    const accepted = acceptRustImageHeightCandidate(rustResult, componentIndex, targetValue, tolerance);
    if (accepted === null) return null;
    if (typeof evaluateCandidate !== 'function') return accepted;

    const validatedHitComponent = Number(evaluateCandidate(accepted));
    if (!Number.isFinite(validatedHitComponent)) return null;
    if (Math.abs(validatedHitComponent - Number(targetValue || 0)) > tolerance) return null;
    return accepted;
}

function acceptRustImageHeightPair(
    rustResult,
    targetX: number,
    targetY: number,
    tolerance = 1e-6,
): { x: number; y: number; hit: { x: number; y: number; z: number } | null } | null {
    const solvedX = Number(rustResult?.x);
    const solvedY = Number(rustResult?.y);
    if (!Number.isFinite(solvedX) || !Number.isFinite(solvedY)) return null;
    const hitX = Number(rustResult?.hit?.x);
    const hitY = Number(rustResult?.hit?.y);
    const hitZ = Number(rustResult?.hit?.z);
    if (![hitX, hitY].every(Number.isFinite)) return null;
    if (Math.abs(hitX - Number(targetX || 0)) > tolerance) return null;
    if (Math.abs(hitY - Number(targetY || 0)) > tolerance) return null;
    return {
        x: solvedX,
        y: solvedY,
        hit: (Number.isFinite(hitZ) ? { x: hitX, y: hitY, z: hitZ } : null),
    };
}

function acceptRustImageHeightPairWithValidation(
    rustResult,
    targetX: number,
    targetY: number,
    evaluatePair,
    tolerance = 1e-6,
): { x: number; y: number; hit: { x: number; y: number; z: number } | null } | null {
    const accepted = acceptRustImageHeightPair(rustResult, targetX, targetY, tolerance);
    if (!accepted) return null;
    if (typeof evaluatePair !== 'function') return accepted;

    const validatedHit = evaluatePair(accepted.x, accepted.y);
    const validatedHitX = Number(validatedHit?.x);
    const validatedHitY = Number(validatedHit?.y);
    const validatedHitZ = Number(validatedHit?.z);
    if (![validatedHitX, validatedHitY].every(Number.isFinite)) return null;
    if (Math.abs(validatedHitX - Number(targetX || 0)) > tolerance) return null;
    if (Math.abs(validatedHitY - Number(targetY || 0)) > tolerance) return null;
    return {
        x: accepted.x,
        y: accepted.y,
        hit: Number.isFinite(validatedHitZ) ? { x: validatedHitX, y: validatedHitY, z: validatedHitZ } : accepted.hit,
    };
}

function isImageHeightPairNearParaxialBranch(
    solvedX: number,
    solvedY: number,
    paraxialX: number,
    paraxialY: number,
    targetX: number,
    targetY: number,
    mode: 'angle' | 'object'
): boolean {
    if (![solvedX, solvedY, paraxialX, paraxialY].every((value) => Number.isFinite(Number(value)))) return false;

    const significantTargetX = Math.abs(Number(targetX) || 0) > 1e-7;
    const significantTargetY = Math.abs(Number(targetY) || 0) > 1e-7;
    if (significantTargetX && Math.abs(paraxialX) > 1e-9 && Math.sign(solvedX) !== Math.sign(paraxialX)) return false;
    if (significantTargetY && Math.abs(paraxialY) > 1e-9 && Math.sign(solvedY) !== Math.sign(paraxialY)) return false;

    const solvedMagnitude = Math.hypot(solvedX, solvedY);
    const paraxialMagnitude = Math.hypot(paraxialX, paraxialY);
    const delta = Math.hypot(solvedX - paraxialX, solvedY - paraxialY);
    const hardLimit = mode === 'angle'
        ? Math.max(45, paraxialMagnitude * 3 + 12)
        : Math.max(100, paraxialMagnitude * 5 + 25);
    if (solvedMagnitude > hardLimit) return false;

    const branchLimit = mode === 'angle'
        ? Math.max(8, paraxialMagnitude * 1.5 + 3)
        : Math.max(10, paraxialMagnitude * 2 + 5);
    return delta <= branchLimit;
}

function isImageHeightComponentNearInitialBranch(candidate: number, initialGuess: number, mode: 'angle' | 'object'): boolean {
    if (!Number.isFinite(Number(candidate)) || !Number.isFinite(Number(initialGuess))) return false;
    const absInitial = Math.abs(Number(initialGuess));
    const delta = Math.abs(Number(candidate) - Number(initialGuess));
    const limit = mode === 'angle'
        ? Math.max(8, absInitial * 1.5 + 3)
        : Math.max(10, absInitial * 2 + 5);
    return delta <= limit;
}

function solveImageHeightComponent(targetValue, initialGuess, evaluateCandidate, options: { initialStep?: number; maxStep?: number } = {}) {
    const target = Number(targetValue) || 0;
    if (Math.abs(target) < 1e-12) return 0;

    const finiteInitial = Number.isFinite(initialGuess) ? initialGuess : 0;
    let bestCandidate = finiteInitial;
    let bestError = Infinity;

    const sampleCandidate = (candidate) => {
        const imageValue = evaluateCandidate(candidate);
        if (!Number.isFinite(imageValue)) return null;
        const error = imageValue - target;
        const absError = Math.abs(error);
        if (absError < bestError) {
            bestError = absError;
            bestCandidate = candidate;
        }
        return { candidate, error };
    };

    const center = sampleCandidate(finiteInitial) ?? sampleCandidate(0);
    if (center && Math.abs(center.error) < 1e-6) return center.candidate;

    const configuredInitialStep = Number(options?.initialStep);
    const configuredMaxStep = Number(options?.maxStep);
    const baseStep = (Number.isFinite(configuredInitialStep) && configuredInitialStep > 0)
        ? configuredInitialStep
        : Math.max(0.1, Math.abs(finiteInitial) * 0.05, Math.abs(target) * 0.02);
    const maxStep = (Number.isFinite(configuredMaxStep) && configuredMaxStep > baseStep)
        ? configuredMaxStep
        : Math.max(baseStep * 32, Math.abs(finiteInitial) * 2, Math.abs(target) * 0.5, 1);
    let bracketLow = null;
    let bracketHigh = null;
    let prevNeg = sampleCandidate(finiteInitial - baseStep);
    let prevPos = sampleCandidate(finiteInitial + baseStep);

    if (prevNeg && center && prevNeg.error * center.error <= 0) {
        bracketLow = prevNeg;
        bracketHigh = center;
    } else if (center && prevPos && center.error * prevPos.error <= 0) {
        bracketLow = center;
        bracketHigh = prevPos;
    }

    for (let stepIndex = 2; (!bracketLow || !bracketHigh) && stepIndex <= 32; stepIndex++) {
        const span = Math.min(maxStep, baseStep * stepIndex);
        const neg = sampleCandidate(finiteInitial - span);
        if (neg && prevNeg && neg.error * prevNeg.error <= 0) {
            bracketLow = neg;
            bracketHigh = prevNeg;
            break;
        }
        prevNeg = neg ?? prevNeg;

        const pos = sampleCandidate(finiteInitial + span);
        if (pos && prevPos && prevPos.error * pos.error <= 0) {
            bracketLow = prevPos;
            bracketHigh = pos;
            break;
        }
        prevPos = pos ?? prevPos;
    }

    if (!bracketLow || !bracketHigh) return bestCandidate;

    let low = bracketLow.candidate;
    let high = bracketHigh.candidate;
    let lowError = bracketLow.error;
    let highError = bracketHigh.error;

    if (low > high) {
        [low, high] = [high, low];
        [lowError, highError] = [highError, lowError];
    }

    for (let iter = 0; iter < 32; iter++) {
        const mid = 0.5 * (low + high);
        const sample = sampleCandidate(mid);
        if (!sample) break;
        if (Math.abs(sample.error) < 1e-6) return sample.candidate;
        if (lowError * sample.error <= 0) {
            high = sample.candidate;
            highError = sample.error;
        } else {
            low = sample.candidate;
            lowError = sample.error;
        }
    }

    return bestCandidate;
}

function refineImageHeightPairWithTs(
    initialX,
    initialY,
    targetX,
    targetY,
    evaluatePair,
    options: { tolerance?: number; maxIterations?: number; finiteDiffStep?: number; maxStep?: number } = {}
) {
    let x = Number(initialX) || 0;
    let y = Number(initialY) || 0;
    const tolerance = Number.isFinite(Number(options?.tolerance)) ? Math.max(1e-8, Number(options.tolerance)) : 1e-6;
    const maxIterations = Number.isFinite(Number(options?.maxIterations)) ? Math.max(1, Math.floor(Number(options.maxIterations))) : 8;
    const baseFiniteDiffStep = Number.isFinite(Number(options?.finiteDiffStep)) ? Math.max(1e-8, Number(options.finiteDiffStep)) : 1e-4;
    const maxStep = Number.isFinite(Number(options?.maxStep)) ? Math.max(1e-6, Number(options.maxStep)) : 0.25;

    const sample = (candidateX, candidateY) => {
        const hit = evaluatePair(candidateX, candidateY);
        const hitX = Number(hit?.x);
        const hitY = Number(hit?.y);
        if (!Number.isFinite(hitX) || !Number.isFinite(hitY)) return null;
        const errX = hitX - Number(targetX || 0);
        const errY = hitY - Number(targetY || 0);
        return {
            x: candidateX,
            y: candidateY,
            hitX,
            hitY,
            errX,
            errY,
            error: Math.hypot(errX, errY),
        };
    };

    let best = sample(x, y);
    if (!best) {
        return { x, y, hit: null };
    }

    for (let iter = 0; iter < maxIterations; iter++) {
        const center = sample(x, y);
        if (!center) break;
        if (center.error < best.error) best = center;
        if (center.error <= tolerance) {
            return { x: center.x, y: center.y, hit: { x: center.hitX, y: center.hitY } };
        }

        const stepX = Math.max(baseFiniteDiffStep, Math.abs(x) * 1e-3);
        const stepY = Math.max(baseFiniteDiffStep, Math.abs(y) * 1e-3);
        const sampleDx = sample(x + stepX, y);
        const sampleDy = sample(x, y + stepY);
        if (!sampleDx || !sampleDy) break;

        const j11 = (sampleDx.hitX - center.hitX) / stepX;
        const j21 = (sampleDx.hitY - center.hitY) / stepX;
        const j12 = (sampleDy.hitX - center.hitX) / stepY;
        const j22 = (sampleDy.hitY - center.hitY) / stepY;
        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) break;

        let deltaX = (-j22 * center.errX + j12 * center.errY) / det;
        let deltaY = (j21 * center.errX - j11 * center.errY) / det;
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) break;

        const deltaNorm = Math.hypot(deltaX, deltaY);
        if (deltaNorm > maxStep) {
            const scale = maxStep / deltaNorm;
            deltaX *= scale;
            deltaY *= scale;
        }

        let accepted = false;
        let alpha = 1;
        for (let lineSearch = 0; lineSearch < 8; lineSearch++) {
            const next = sample(x + alpha * deltaX, y + alpha * deltaY);
            if (next && next.error < center.error) {
                x = next.x;
                y = next.y;
                if (next.error < best.error) best = next;
                accepted = true;
                break;
            }
            alpha *= 0.5;
        }
        if (!accepted) break;
    }

    return {
        x: best.x,
        y: best.y,
        hit: { x: best.hitX, y: best.hitY },
    };
}

function applyRotationMatrixToVector(matrix, vec) {
    if (!matrix || !Array.isArray(matrix) || matrix.length < 3) return { ...vec };
    const x = Number(vec?.x) || 0;
    const y = Number(vec?.y) || 0;
    const z = Number(vec?.z) || 0;
    const m00 = Number(matrix?.[0]?.[0]);
    const m01 = Number(matrix?.[0]?.[1]);
    const m02 = Number(matrix?.[0]?.[2]);
    const m10 = Number(matrix?.[1]?.[0]);
    const m11 = Number(matrix?.[1]?.[1]);
    const m12 = Number(matrix?.[1]?.[2]);
    const m20 = Number(matrix?.[2]?.[0]);
    const m21 = Number(matrix?.[2]?.[1]);
    const m22 = Number(matrix?.[2]?.[2]);
    if (![m00, m01, m02, m10, m11, m12, m20, m21, m22].every(Number.isFinite)) return { ...vec };
    return {
        x: m00 * x + m01 * y + m02 * z,
        y: m10 * x + m11 * y + m12 * z,
        z: m20 * x + m21 * y + m22 * z
    };
}

function extractStopCenter3d(stopInfo) {
    if (!stopInfo || typeof stopInfo !== 'object') return null;
    const src = stopInfo.origin?.origin ?? stopInfo.origin ?? stopInfo.center ?? stopInfo.position;
    if (!src || typeof src !== 'object') return null;
    const x = Number(src.x);
    const y = Number(src.y);
    const z = Number(src.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
}

function resolveStopConfig(opticalSystemRows, surfaceOrigins, fallbackZ, fallbackRadius) {
    const safeFallbackRadius = (Number.isFinite(fallbackRadius) && fallbackRadius > 0)
        ? fallbackRadius
        : Math.max(Math.abs(fallbackRadius) || 1, 1);
    const config = {
        radius: safeFallbackRadius,
        z: Number.isFinite(fallbackZ) ? fallbackZ : 0,
        center: { x: 0, y: 0 },
        hasStop: false,
        index: undefined
    };
    try {
        const stopInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
        if (!stopInfo) {
            return config;
        }
        
        // Set the stop surface index
        const stopIndex = Number(stopInfo.index);
        if (Number.isFinite(stopIndex)) {
            config.index = stopIndex;
        }
        
        const candidateRadius = Number(stopInfo.radius);
        if (Number.isFinite(candidateRadius) && candidateRadius > 0) {
            config.radius = candidateRadius;
        }

        const originSource = stopInfo.origin?.origin ?? stopInfo.origin ?? stopInfo.center ?? stopInfo.position;
        if (originSource) {
            const ox = Number(originSource.x);
            const oy = Number(originSource.y);
            const oz = Number(originSource.z);
            if (Number.isFinite(ox)) config.center.x = ox;
            if (Number.isFinite(oy)) config.center.y = oy;
            if (Number.isFinite(oz)) config.z = oz;
        }
        config.hasStop = true;
    } catch (error) {
        console.warn('⚠️ Failed to resolve stop configuration:', error);
    }
    return config;
}

function resolveStopConfigCached(opticalSystemRows, surfaceOrigins, fallbackZ, fallbackRadius) {
    return resolveStopConfig(opticalSystemRows, surfaceOrigins, fallbackZ, fallbackRadius);
}

/**
 * Set ray emission pattern
 * @param {string} pattern - 'grid' or 'annular'
 */
export function setRayEmissionPattern(pattern) {
    rayEmissionPattern = pattern;
}

/**
 * Set ray color mode
 * @param {string} mode - 'object' or 'segment'
 */
export function setRayColorMode(mode) {
    rayColorMode = mode;
}

/**
 * Get current ray emission pattern
 * @returns {string} Current pattern
 */
export function getRayEmissionPattern() {
    return rayEmissionPattern;
}

/**
 * Get current ray color mode
 * @returns {string} Current mode
 */
export function getRayColorMode() {
    return rayColorMode;
}

/**
 * Optimize object position for Stop
 * @param {Object} objectData - Object data
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} Optimized position
 */
export function optimizeObjectPositionForStop(objectData, opticalSystemRows) {
    // Simple implementation - you can enhance this
    return {
        x: Number(objectData.xHeightAngle) || 0,
        y: Number(objectData.yHeightAngle) || 0
    };
}

/**
 * Optimize Angle object position so that chief ray passes through Stop center
 * @param {number} angleX - X angle in degrees
 * @param {number} angleY - Y angle in degrees
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} Optimized position
 */
export function optimizeAngleObjectPosition(angleX, angleY, opticalSystemRows, precomputedSurfaceOrigins = null) {
    const surfaceOrigins = (Array.isArray(precomputedSurfaceOrigins) && precomputedSurfaceOrigins.length > 0)
        ? precomputedSurfaceOrigins
        : calculateSurfaceOrigins(opticalSystemRows);
    const stopInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
    if (!stopInfo) {
        console.warn('⚠️ No Stop surface found for angle optimization');
        return { x: 0, y: 0 };
    }
    
    const firstSurfaceOrigin = surfaceOrigins[0] ? surfaceOrigins[0].origin : { x: 0, y: 0, z: 0 };
    
    // Object thickness INF の場合の特別処理
    const firstSurface = opticalSystemRows[0];
    const objectThicknessRaw = firstSurface.thickness;
    const thicknessStr = (objectThicknessRaw !== undefined && objectThicknessRaw !== null) ? String(objectThicknessRaw).trim().toUpperCase() : '';
    const objectThicknessVal = Number(objectThicknessRaw);

    if (objectThicknessRaw === Infinity ||
        thicknessStr === 'INF' ||
        thicknessStr === 'INFINITY' ||
        thicknessStr === '∞' ||
        (Number.isFinite(objectThicknessVal) && Math.abs(objectThicknessVal) > 1e6)) {

        // Infinite object: pick an emission origin so that a ray with the requested field
        // direction passes through the stop center (straight-line back-projection).
        // This is a fast, deterministic fallback that avoids the fragile 1mm heuristic.
        const stopOrigin = stopInfo.origin?.origin ?? stopInfo.origin ?? stopInfo.center ?? stopInfo.position;
        const stopX = Number(stopOrigin?.x ?? 0);
        const stopY = Number(stopOrigin?.y ?? 0);
        const stopZ = Number(stopOrigin?.z ?? stopInfo?.position?.z);

        // Use objectRenderDistance from Object row for INF objects (positive value converted to negative Z)
        const objectRow = opticalSystemRows && opticalSystemRows[0];
        const renderDist = (objectRow && typeof objectRow.objectRenderDistance === 'number') ? objectRow.objectRenderDistance : 0;
        const objectZ = -Math.abs(renderDist);
        const dir = buildDirectionFromFieldAngles(angleX, angleY);
        const safeK = Math.abs(dir.z) > 1e-12 ? dir.z : (dir.z >= 0 ? 1e-12 : -1e-12);
        if (!Number.isFinite(stopZ)) {
            return { x: 0, y: 0 };
        }
        const dz = stopZ - objectZ;
        const x0 = stopX - (dir.x / safeK) * dz;
        const y0 = stopY - (dir.y / safeK) * dz;
        if (!Number.isFinite(x0) || !Number.isFinite(y0) || Math.abs(x0) > 1e8 || Math.abs(y0) > 1e8) {
            return { x: 0, y: 0 };
        }
        return { x: x0, y: y0 };
    }
    
    // 通常の有限物体距離の場合
    const stopOriginZ = (() => {
        const o = stopInfo.origin?.origin ?? stopInfo.origin ?? stopInfo.center ?? stopInfo.position;
        const z = Number(o?.z);
        return Number.isFinite(z) ? z : null;
    })();
    const distanceToStop = (stopOriginZ !== null)
        ? (stopOriginZ - firstSurfaceOrigin.z)
        : (Number(stopInfo?.position?.z) - firstSurfaceOrigin.z);
    
    // 距離の妥当性チェック
    if (!isFinite(distanceToStop) || Math.abs(distanceToStop) > 1e6) {
        try {
            const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
            if (RAYTRACE_DEBUG) {
                console.warn('⚠️ Invalid distance to stop, using default positioning');
            }
        } catch (_) {}
        return { x: 0, y: 0 };
    }
    
    // Convert angles to radians
    const angleXRad = angleX * Math.PI / 180;
    const angleYRad = angleY * Math.PI / 180;
    
    // Calculate direction vector for chief ray
    const dirX = Math.sin(angleXRad);
    const dirY = Math.sin(angleYRad);
    const dirZ = Math.cos(angleXRad) * Math.cos(angleYRad);
    
    // dirZ が 0 に近い場合の処理
    if (Math.abs(dirZ) < 1e-10) {
        console.warn('⚠️ Ray direction nearly parallel to optical axis, using small offset');
        return { x: 0, y: 0 };
    }
    
    // Calculate optimal starting position so that ray reaches Stop center (0,0)
    const t = distanceToStop / dirZ;
    
    // t の妥当性チェック
    if (!isFinite(t) || Math.abs(t) > 1e6) {
        console.warn('⚠️ Invalid t parameter in angle optimization, using default');
        return { x: 0, y: 0 };
    }
    
    const optimizedX = -t * dirX;
    const optimizedY = -t * dirY;
    
    // 結果の妥当性チェック
    if (!isFinite(optimizedX) || !isFinite(optimizedY) || 
        Math.abs(optimizedX) > 1e6 || Math.abs(optimizedY) > 1e6) {
        console.warn('⚠️ Invalid optimized position, using default');
        return { x: 0, y: 0 };
    }
    
    return {
        x: optimizedX,
        y: optimizedY
    };
}

/**
 * Draw ray with segment colors
 * @param {Array} rayPath - Ray path data
 * @param {number} objectId - Object ID
 * @param {number} rayNumber - Ray number
 * @param {THREE.Scene} scene - Three.js scene
 */
export function drawRayWithSegmentColors(rayPath, objectId, rayNumber, scene) {
    // console.log(`🎨 Drawing ray ${rayNumber} for object ${objectId}, path length: ${rayPath ? rayPath.length : 0}`);
    
    if (!rayPath || rayPath.length < 2) {
        console.warn(`⚠️ Invalid ray path for ray ${rayNumber}`);
        return;
    }
    
    if (!scene) {
        console.error(`❌ Scene is not provided for ray drawing`);
        return;
    }
    
    // Debug: 光線パスの最初のポイントを確認
    const firstPoint = rayPath[0];

    // console.log(`🔍 Ray ${rayNumber} start point: (${firstPoint.x}, ${firstPoint.y}, ${firstPoint.z})`);
    // console.log(`🔍 Ray ${rayNumber} end point: (${lastPoint.x}, ${lastPoint.y}, ${lastPoint.z})`);
    
    // z=-25mm付近の確認
    const isStartNearZ25 = Math.abs(firstPoint.z + 25) < 1.0; // 1mm以内の誤差
    // console.log(`🔍 Ray ${rayNumber} starts near z=-25mm: ${isStartNearZ25} (z=${firstPoint.z})`);
    
    // 全パスポイントをログ出力（最初の3つと最後の3つ）
    // console.log(`🔍 Ray ${rayNumber} path details:`);
    const maxPoints = Math.min(3, rayPath.length);
    for (let i = 0; i < maxPoints; i++) {
        const p = rayPath[i];
        // console.log(`   Point ${i}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`);
    }
    if (rayPath.length > 6) {
        // console.log(`   ... (${rayPath.length - 6} points omitted) ...`);
    }
    const startFromEnd = Math.max(0, rayPath.length - 3);
    for (let i = startFromEnd; i < rayPath.length; i++) {
        const p = rayPath[i];
        // console.log(`   Point ${i}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`);
    }
    
    // Show all segments (no limitation)
    const segmentsToShow = rayPath.length - 1;
    // console.log(`🎨 Drawing ${segmentsToShow} segments for ray ${rayNumber}`);
    
    // Color palettes for different modes (避けるべき色: 白、薄い色)
    const segmentColors = [
        0xff0000, // Red
        0x0080ff, // Bright Blue
        0x00cc00, // Green  
        0xff8000, // Orange
        0x8000ff, // Purple
        0xff0080, // Pink
        0x00ff80, // Cyan Green
        0xffff00, // Yellow
        0x0000ff, // Blue
        0x800000, // Dark Red
        0x008000, // Dark Green
        0x000080, // Dark Blue
        0x800080, // Dark Purple
        0x808000, // Olive
        0x008080, // Teal
        0xff4000, // Red Orange
        0x4000ff, // Blue Purple
        0x00ff40, // Lime Green
        0xff0040, // Deep Pink
        0x4080ff  // Light Blue
    ];
    
    const objectColors = [
        0xff0000, // 赤 (Object0 - Draw Crossと同じ色)
        0x00cc00, // 緑 (Object1 - Draw Crossと同じ色)
        0xff8000, // オレンジ (Object2 - Draw Crossと同じ色)
        0x8000ff, // 紫 (Object3 - Draw Crossと同じ色)
        0xff0080, // ピンク (Object4 - Draw Crossと同じ色)
        0x00ff80, // 青緑 (Object5 - Draw Crossと同じ色)
        0xffff00, // 黄色 (Object6 - Draw Crossと同じ色)
        0xaa00ff, // マゼンタ (Object7 - Draw Crossと同じ色)
        0xffaa00, // 黄オレンジ (Object8 - Draw Crossと同じ色)
        0x00aaff  // 水色 (Object9 - Draw Crossと同じ色)
    ];
    
    // クロスビーム専用の色設定（普通の濃さ）
    const crossBeamColors = {
        'cross-horizontal': 0x0000ff,           // 青 (横方向)
        'cross-vertical': 0x0000ff,             // 青 (縦方向)
        'cross-horizontal-obj0': 0x0000ff,      // Object0 横方向 - 青
        'cross-vertical-obj0': 0x0000ff,        // Object0 縦方向 - 青
        // 主光線（chief）の色指定（Raynum依存差を避けるため cross-horizontal と同一に統一）
        'chief-obj0': 0x0000ff,
        'chief-obj1': 0x00cc00,
        'chief-obj2': 0xff8000,
        'chief-obj3': 0x8000ff,
        'chief-obj4': 0xff0080,
        'chief-obj5': 0x00ff80,
        'chief-obj6': 0xffff00,
        'chief-obj7': 0xaa00ff,
        'chief-obj8': 0xffaa00,
        'chief-obj9': 0x00aaff,
        'cross-horizontal-obj1': 0x00cc00,      // Object1 横方向 - 緑
        'cross-vertical-obj1': 0x00cc00,        // Object1 縦方向 - 緑
        'cross-horizontal-obj2': 0xff8000,      // Object2 横方向 - オレンジ
        'cross-vertical-obj2': 0xff8000,        // Object2 縦方向 - オレンジ
        'cross-horizontal-obj3': 0x8000ff,      // Object3 横方向 - 紫
        'cross-vertical-obj3': 0x8000ff,        // Object3 縦方向 - 紫
        'cross-horizontal-obj4': 0xff0080,      // Object4 横方向 - ピンク
        'cross-vertical-obj4': 0xff0080,        // Object4 縦方向 - ピンク
        'cross-horizontal-obj5': 0x00ff80,      // Object5 横方向 - 青緑
        'cross-vertical-obj5': 0x00ff80,        // Object5 縦方向 - 青緑
        'cross-horizontal-obj6': 0xffff00,      // Object6 横方向 - 黄
        'cross-vertical-obj6': 0xffff00,        // Object6 縦方向 - 黄
        'cross-horizontal-obj7': 0xaa00ff,      // Object7 横方向 - マゼンタ
        'cross-vertical-obj7': 0xaa00ff,        // Object7 縦方向 - マゼンタ
        'cross-horizontal-obj8': 0xffaa00,      // Object8 横方向 - 黄オレンジ
        'cross-vertical-obj8': 0xffaa00,        // Object8 縦方向 - 黄オレンジ
        'cross-horizontal-obj9': 0x00aaff,      // Object9 横方向 - 水色
        'cross-vertical-obj9': 0x00aaff         // Object9 縦方向 - 水色
    };
    
    const resolveCrossBeamColorKey = (rawObjectId) => {
        if (typeof rawObjectId !== 'string') return rawObjectId;
        const raySuffixIndex = rawObjectId.indexOf('-ray');
        if (raySuffixIndex > 0) {
            return rawObjectId.slice(0, raySuffixIndex);
        }
        return rawObjectId;
    };

    const colorObjectId = resolveCrossBeamColorKey(objectId);
    const genericCrossBeamMatch = typeof colorObjectId === 'string'
        ? colorObjectId.match(/^(chief|cross-horizontal|cross-vertical)-obj(\d+)$/)
        : null;

    const resolveLineColor = () => {
        let color;
        if (rayColorMode === 'segment') {
            return segmentColors[0];
        }
        if (crossBeamColors[colorObjectId]) {
            color = crossBeamColors[colorObjectId];
        } else if (genericCrossBeamMatch) {
            const paletteIndex = Number.parseInt(genericCrossBeamMatch[2], 10);
            if (Number.isFinite(paletteIndex)) {
                color = objectColors[Math.abs(paletteIndex) % objectColors.length];
            }
        } else if (typeof colorObjectId === 'string' && colorObjectId.startsWith('chief-obj')) {
            const objIndex = colorObjectId.replace('chief-obj', '');
            const fallbackId = `cross-horizontal-obj${objIndex}`;
            if (crossBeamColors[fallbackId]) {
                color = crossBeamColors[fallbackId];
            }
        }
        if (color === undefined) {
            let colorIndex;
            if (typeof objectId === 'string') {
                colorIndex = objectId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % objectColors.length;
            } else {
                colorIndex = (objectId || 0) % objectColors.length;
            }
            color = objectColors[colorIndex];
        }
        return color;
    };

    if (rayColorMode !== 'segment') {
        const validPoints = [];
        for (const point of rayPath) {
            if (!isFinite(point?.x) || !isFinite(point?.y) || !isFinite(point?.z)) {
                continue;
            }
            validPoints.push(new THREE.Vector3(point.x, point.y, point.z));
        }
        if (validPoints.length < 2) {
            return;
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
        const material = new THREE.LineBasicMaterial({
            color: resolveLineColor(),
            linewidth: 2,
            transparent: false,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false
        });
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 100000;
        line.frustumCulled = false;
        line.userData = {
            type: 'optical-ray',
            objectId: objectId,
            rayNumber: rayNumber,
            rayType: 'crossBeam',
            colorMode: rayColorMode,
            isRayLine: true
        };
        scene.add(line);
        return;
    }

    for (let i = 0; i < segmentsToShow; i++) {
        const startPoint = rayPath[i];
        const endPoint = rayPath[i + 1];
        
        // Debug: セグメントごとの詳細情報
        if (i < 3 || i >= segmentsToShow - 3) { // 最初の3つと最後の3つのセグメントのみログ出力
            // console.log(`🔍 Segment ${i}: (${startPoint.x.toFixed(3)}, ${startPoint.y.toFixed(3)}, ${startPoint.z.toFixed(3)}) → (${endPoint.x.toFixed(3)}, ${endPoint.y.toFixed(3)}, ${endPoint.z.toFixed(3)})`);
        }
        
        // NaN validation for ray points
        if (!isFinite(startPoint.x) || !isFinite(startPoint.y) || !isFinite(startPoint.z) ||
            !isFinite(endPoint.x) || !isFinite(endPoint.y) || !isFinite(endPoint.z)) {
            console.warn(`⚠️ Invalid ray segment ${i}: start(${startPoint.x}, ${startPoint.y}, ${startPoint.z}) end(${endPoint.x}, ${endPoint.y}, ${endPoint.z})`);
            continue;
        }
        
        // Create line geometry
        const points = [
            new THREE.Vector3(startPoint.x, startPoint.y, startPoint.z),
            new THREE.Vector3(endPoint.x, endPoint.y, endPoint.z)
        ];
        
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        
        // Choose color based on color mode
        const color = segmentColors[i % segmentColors.length];
        
        const material = new THREE.LineBasicMaterial({ 
            color: color,
            linewidth: 2,       // 線の太さを2に調整
            transparent: false, // 透明度を無効にして色を濃く表示
            opacity: 1.0,       // 完全不透明
            depthTest: false,
            depthWrite: false
        });
        
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 100000;
        line.frustumCulled = false;
        line.userData = { 
            type: 'optical-ray',  // Draw Cross光線を識別 
            objectId: objectId, 
            rayNumber: rayNumber,
            segment: i + 1,
            rayType: 'crossBeam',  // クロスビーム識別子追加
            colorMode: rayColorMode,
            isRayLine: true
        };
        
        scene.add(line);
        // console.log(`✅ Ray segment ${i + 1} added to scene for ray ${rayNumber}, object ${objectId}`);
    }
    
    // console.log(`✅ Ray ${rayNumber} drawing completed with ${segmentsToShow} segments`);
}

/**
 * Clear all rays from scene
 * @param {THREE.Scene} scene - Three.js scene
 */
export function clearAllRays(scene) {
    const raysToRemove = [];
    
    scene.traverse((child) => {
        if (child.userData && (child.userData.type === 'ray' || child.userData.type === 'optical-ray')) {
            raysToRemove.push(child);
        }
    });
    
    raysToRemove.forEach(ray => {
        scene.remove(ray);
        if (ray.geometry) ray.geometry.dispose();
        if (ray.material) ray.material.dispose();
    });
}

const RAY_RENDERER_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAY_RENDERER_DEBUG);
const rrLog = (...args) => { if (RAY_RENDERER_DEBUG) console.log(...args); };
const shouldEmitAngleStopDiag = () => {
    try {
        if (typeof globalThis === 'undefined') return false;
        const host: any = globalThis as any;
        const enabled = host?.__COOPT_ENABLE_ANGLE_STOP_DIAG === true || host?.__RAYTRACE_DEBUG === true;
        const requestedOnce = host?.__COOPT_REQUEST_ANGLE_STOP_DIAG_ONCE === true;
        if (requestedOnce) host.__COOPT_REQUEST_ANGLE_STOP_DIAG_ONCE = false;
        return enabled || requestedOnce;
    } catch (_) {
        return false;
    }
};
const emitAngleStopDiag = (label: string, payload: any, force = false) => {
    if (!force && !shouldEmitAngleStopDiag()) return;
    try {
        const host: any = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const record = {
            at: new Date().toISOString(),
            source: 'ray-renderer',
            label,
            ...payload
        };
        if (host) {
            try { host.__COOPT_LAST_ANGLE_STOP_DIAG = record; } catch (_) {}
            try {
                const logs = Array.isArray(host.__COOPT_ANGLE_STOP_DIAG_LOGS)
                    ? host.__COOPT_ANGLE_STOP_DIAG_LOGS
                    : [];
                logs.push(record);
                if (logs.length > 200) logs.shift();
                host.__COOPT_ANGLE_STOP_DIAG_LOGS = logs;
            } catch (_) {}
        }
        // Intentionally no console output.
    } catch (_) {}
};
const mirrorChiefRayDiagToOpener = (label, payload) => {
    try {
        if (typeof window === 'undefined') return;
        const openerRef = (window as any).opener;
        if (!openerRef || openerRef.closed) return;
        const mirrored = {
            at: new Date().toISOString(),
            source: 'ray-renderer',
            label,
            ...payload
        };
        try { openerRef.__LAST_CHIEF_RAY_DIAG = mirrored; } catch (_) {}
        try { openerRef.postMessage?.({ type: 'COOPT_CHIEF_RAY_DIAG', payload: mirrored }, '*'); } catch (_) {}
    } catch (_) {}
};

/**
 * Generate ray start points for object based on ray count
 * @param {Object} obj - Object data
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} rayCount - Number of rays to generate
 * @param {Object} apertureLimit - Aperture limit (optional)
 * @returns {Array} Array of ray start data
 */
/**
 * Convert an ImageHeight-mode object row to an equivalent Angle (infinite) or
 * Rectangle (finite) object row by computing paraxial EFL / magnification.
 * xHeightAngle and yHeightAngle are treated as target image heights in mm.
 */
export function convertImageHeightToEffectiveObject(
    obj,
    opticalSystemRows,
    wavelengthUm: number,
    conjugateType: ConjugateType,
    options: ImageHeightSolveOptions = {}
): any {
    const positionNorm = String(obj?.position ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const effectivePositionNorm = String(obj?.__cooptEffectivePosition ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const isRawImageHeightRow = positionNorm === 'imageheight' && !effectivePositionNorm;
    const targetX = (() => {
        const tableValue = Number(obj?.xHeightAngle);
        if (isRawImageHeightRow && Number.isFinite(tableValue)) return tableValue;
        const candidates = [
            obj?.__cooptImageHeightTarget?.x,
            obj?.xHeight,
            obj?.heightX,
            obj?.['object x'],
            obj?.x,
            tableValue,
        ];
        for (const candidate of candidates) {
            const value = Number(candidate);
            if (Number.isFinite(value)) return value;
        }
        return 0;
    })();
    const targetY = (() => {
        const tableValue = Number(obj?.yHeightAngle);
        if (isRawImageHeightRow && Number.isFinite(tableValue)) return tableValue;
        const candidates = [
            obj?.__cooptImageHeightTarget?.y,
            obj?.yHeight,
            obj?.heightY,
            obj?.['object y'],
            obj?.y,
            tableValue,
        ];
        for (const candidate of candidates) {
            const value = Number(candidate);
            if (Number.isFinite(value)) return value;
        }
        return 0;
    })();
    const paraxialOnlyModel = options?.precomputedParaxialOnlyModel === true
        ? true
        : options?.precomputedParaxialOnlyModel === false
            ? false
            : isParaxialOnlyImageHeightModel(opticalSystemRows);
    const skipTsValidation = options?.skipTsValidation === true;
    const validationTraceBackend: 'ts' | 'rust' = options?.validationTraceBackend === 'rust' ? 'rust' : 'ts';
    const disableSolveCache = options?.disableSolveCache === true;
    const disableWarmStartCache = options?.disableWarmStartCache === true;
    const validationMode = skipTsValidation ? 'rust-only' : `rust-${validationTraceBackend}-validated`;
    const solveScopeKey = String(options?.precomputedSolveScopeKey || buildImageHeightSolveScopeKey(opticalSystemRows, wavelengthUm, conjugateType, validationMode));
    const cacheKey = disableSolveCache ? null : [
        buildOpticalRowsSignature(opticalSystemRows),
        stableSerializeForCache(obj),
        Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : 0.5876,
        String(conjugateType || ''),
        validationMode
    ].join('||');
    if (cacheKey && imageHeightEffectiveObjectCache.has(cacheKey)) {
        return imageHeightEffectiveObjectCache.get(cacheKey);
    }

    const storeResult = (value) => {
        if (cacheKey && value && typeof value === 'object') {
            imageHeightEffectiveObjectCache.set(cacheKey, value);
            if (imageHeightEffectiveObjectCache.size > IMAGE_HEIGHT_EFFECTIVE_OBJECT_CACHE_LIMIT) {
                const firstKey = imageHeightEffectiveObjectCache.keys().next().value;
                if (firstKey !== undefined) imageHeightEffectiveObjectCache.delete(firstKey);
            }
        }
        return value;
    };

    try {
        const paraxial = options?.precomputedParaxial || calculateParaxialData(opticalSystemRows, wavelengthUm);
        if (!paraxial) throw new Error('paraxial null');

        const imageSurfaceIndex = Number.isInteger(options?.precomputedImageSurfaceIndex)
            ? Number(options.precomputedImageSurfaceIndex)
            : findImageSurfaceIndex(opticalSystemRows);
        const surfaceOrigins = Array.isArray(options?.precomputedSurfaceOrigins)
            ? options.precomputedSurfaceOrigins
            : calculateSurfaceOrigins(opticalSystemRows);
        const imageSurfaceInfo = surfaceOrigins?.[imageSurfaceIndex] || null;
        const stopInfo = options?.precomputedStopInfo || findStopSurface(opticalSystemRows, surfaceOrigins);
        const stopCenter3d = options?.precomputedStopCenter3d || extractStopCenter3d(stopInfo);
        const imageHeightSolveContext = {
            surfaceOrigins,
            stopInfo,
            stopCenter3d,
        };

        if (conjugateType === 'infinite') {
            const efl = Number(paraxial.focalLength);
            const hasFiniteEfl = Number.isFinite(efl) && Math.abs(efl) >= 1e-12;
            const paraxialAngleXDeg = hasFiniteEfl ? Math.atan2(targetX, efl) * (180 / Math.PI) : targetX;
            const paraxialAngleYDeg = hasFiniteEfl ? Math.atan2(targetY, efl) * (180 / Math.PI) : targetY;
            const warmStart = disableWarmStartCache
                ? {
                    x: paraxialAngleXDeg,
                    y: paraxialAngleYDeg,
                    source: 'paraxial',
                }
                : getImageHeightWarmStart(
                    solveScopeKey,
                    targetX,
                    targetY,
                    paraxialAngleXDeg,
                    paraxialAngleYDeg,
                    obj?.__cooptImageHeightSolve?.solved,
                );
            let solvedAngleXDeg = warmStart.x;
            let solvedAngleYDeg = warmStart.y;

            const cachedPairSolve = disableSolveCache ? null : getCachedImageHeightPairSolve(solveScopeKey, targetX, targetY);
            if (cachedPairSolve) {
                solvedAngleXDeg = Number.isFinite(Number(cachedPairSolve?.solved?.x)) ? Number(cachedPairSolve.solved.x) : solvedAngleXDeg;
                solvedAngleYDeg = Number.isFinite(Number(cachedPairSolve?.solved?.y)) ? Number(cachedPairSolve.solved.y) : solvedAngleYDeg;
                const cachedChiefRay = cachedPairSolve?.chiefRay;
                const cachedHit = cachedPairSolve?.hit;
                return storeResult({
                    ...obj,
                    position: obj?.position ?? 'ImageHeight',
                    __cooptEffectivePosition: 'Angle',
                    xHeightAngle: solvedAngleXDeg,
                    yHeightAngle: solvedAngleYDeg,
                    __cooptImageHeightTarget: { x: targetX, y: targetY },
                    __cooptImageHeightSolve: {
                        conjugateType,
                        mode: paraxialOnlyModel ? 'infinite-angle-paraxial' : 'infinite-angle',
                        validation: validationMode,
                        solver: String(cachedPairSolve?.solver || 'cache'),
                        warmStart: warmStart.source,
                        paraxial: { x: paraxialAngleXDeg, y: paraxialAngleYDeg },
                        solved: { x: solvedAngleXDeg, y: solvedAngleYDeg },
                        hit: cachedHit ? { x: Number(cachedHit.x), y: Number(cachedHit.y) } : null,
                        chiefRay: cachedChiefRay?.origin && cachedChiefRay?.dir ? {
                            origin: {
                                x: Number(cachedChiefRay.origin.x),
                                y: Number(cachedChiefRay.origin.y),
                                z: Number(cachedChiefRay.origin.z),
                            },
                            dir: {
                                x: Number(cachedChiefRay.dir.x),
                                y: Number(cachedChiefRay.dir.y),
                                z: Number(cachedChiefRay.dir.z),
                            },
                        } : null,
                        imageSurfaceIndex,
                        wavelengthUm,
                    },
                });
            }

            const rustPairResult = solveImageHeightPairExactWithRust(
                opticalSystemRows,
                imageSurfaceIndex,
                wavelengthUm,
                conjugateType,
                targetX,
                targetY,
                solvedAngleXDeg,
                solvedAngleYDeg,
            ) || solveImageHeightPairWithRust(
                opticalSystemRows,
                imageSurfaceIndex,
                wavelengthUm,
                conjugateType,
                targetX,
                targetY,
                solvedAngleXDeg,
                solvedAngleYDeg,
            );
            let acceptedRustPair = skipTsValidation
                ? acceptRustImageHeightPair(rustPairResult, targetX, targetY)
                : acceptRustImageHeightPairWithValidation(
                    rustPairResult,
                    targetX,
                    targetY,
                    (candidateX, candidateY) => traceChiefRayImagePointForAngle(
                        opticalSystemRows,
                        candidateX,
                        candidateY,
                        imageSurfaceIndex,
                        imageSurfaceInfo,
                        wavelengthUm,
                        imageHeightSolveContext,
                        validationTraceBackend,
                    )
                );
            if (acceptedRustPair && !isImageHeightPairNearParaxialBranch(
                Number(acceptedRustPair.x),
                Number(acceptedRustPair.y),
                paraxialAngleXDeg,
                paraxialAngleYDeg,
                targetX,
                targetY,
                'angle'
            )) {
                acceptedRustPair = null;
            }
            if (acceptedRustPair) {
                solvedAngleXDeg = acceptedRustPair.x;
                solvedAngleYDeg = acceptedRustPair.y;
                const solvedChief = traceChiefRayForAngleDetails(
                    opticalSystemRows,
                    solvedAngleXDeg,
                    solvedAngleYDeg,
                    imageSurfaceIndex,
                    imageSurfaceInfo,
                    wavelengthUm,
                    imageHeightSolveContext,
                    'rust',
                );
                const resolvedHit = solvedChief?.localHit ?? acceptedRustPair.hit;
                logImageHeightDiagnostics('solve-infinite', {
                    objectId: obj?.id ?? null,
                    conjugateType,
                    wavelengthUm,
                    warmStart: warmStart.source,
                    target: { x: targetX, y: targetY },
                    paraxial: { x: paraxialAngleXDeg, y: paraxialAngleYDeg },
                    solvedField: { x: solvedAngleXDeg, y: solvedAngleYDeg, mode: 'angle-deg' },
                    hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                    error: resolvedHit ? {
                        x: Number(resolvedHit.x) - targetX,
                        y: Number(resolvedHit.y) - targetY
                    } : null,
                    imageSurfaceIndex,
                    solver: 'rust-pair'
                });

                if (!disableSolveCache) {
                    setCachedImageHeightPairSolve(solveScopeKey, targetX, targetY, {
                        solver: 'rust-pair',
                        solved: { x: solvedAngleXDeg, y: solvedAngleYDeg },
                        hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y), z: Number(resolvedHit.z) || 0 } : null,
                        chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                            origin: {
                                x: Number(solvedChief.origin.x),
                                y: Number(solvedChief.origin.y),
                                z: Number(solvedChief.origin.z),
                            },
                            dir: {
                                x: Number(solvedChief.dir.x),
                                y: Number(solvedChief.dir.y),
                                z: Number(solvedChief.dir.z),
                            },
                        } : null,
                    });
                }
                if (!disableWarmStartCache) {
                    storeImageHeightWarmStart(solveScopeKey, targetX, targetY, solvedAngleXDeg, solvedAngleYDeg, resolvedHit);
                }

                return storeResult({
                    ...obj,
                    position: obj?.position ?? 'ImageHeight',
                    __cooptEffectivePosition: 'Angle',
                    xHeightAngle: solvedAngleXDeg,
                    yHeightAngle: solvedAngleYDeg,
                    __cooptImageHeightTarget: { x: targetX, y: targetY },
                    __cooptImageHeightSolve: {
                        conjugateType,
                        mode: paraxialOnlyModel ? 'infinite-angle-paraxial' : 'infinite-angle',
                        validation: validationMode,
                        solver: 'rust-pair',
                        warmStart: warmStart.source,
                        paraxial: { x: paraxialAngleXDeg, y: paraxialAngleYDeg },
                        solved: { x: solvedAngleXDeg, y: solvedAngleYDeg },
                        hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                        chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                            origin: {
                                x: Number(solvedChief.origin.x),
                                y: Number(solvedChief.origin.y),
                                z: Number(solvedChief.origin.z),
                            },
                            dir: {
                                x: Number(solvedChief.dir.x),
                                y: Number(solvedChief.dir.y),
                                z: Number(solvedChief.dir.z),
                            },
                        } : null,
                        imageSurfaceIndex,
                        wavelengthUm
                    },
                });
            }

            const evaluateAngleHitComponent = (
                candidateAngleX,
                candidateAngleY,
                componentIndex: 0 | 1,
                traceBackend: 'ts' | 'rust' = 'rust'
            ) => {
                const localHit = traceChiefRayImagePointForAngle(
                    opticalSystemRows,
                    candidateAngleX,
                    candidateAngleY,
                    imageSurfaceIndex,
                    imageSurfaceInfo,
                    wavelengthUm,
                    imageHeightSolveContext,
                    traceBackend,
                );
                return componentIndex === 0 ? Number(localHit?.x) : Number(localHit?.y);
            };

            const solveAngleX = (initialGuess, fixedAngleY = solvedAngleYDeg) => {
                const solverOptions = {
                    initialStep: Math.max(0.05, Math.abs(paraxialAngleXDeg) * 0.05, Math.abs(targetX) * 0.005),
                    maxStep: Math.max(2, Math.abs(paraxialAngleXDeg) * 0.5, Math.abs(targetX) * 0.05),
                };
                const evaluateCandidate = (candidate) => evaluateAngleHitComponent(candidate, fixedAngleY, 0, validationTraceBackend);
                const rustResult = solveImageHeightComponentWithRust(
                    opticalSystemRows,
                    imageSurfaceIndex,
                    wavelengthUm,
                    'infinite',
                    0,
                    targetX,
                    initialGuess,
                    fixedAngleY,
                    solverOptions,
                );
                const acceptedRustCandidate = skipTsValidation
                    ? acceptRustImageHeightCandidate(rustResult, 0, targetX)
                    : acceptRustImageHeightCandidateWithValidation(
                        rustResult,
                        0,
                        targetX,
                        (candidate) => evaluateAngleHitComponent(candidate, fixedAngleY, 0, validationTraceBackend)
                    );
                if (acceptedRustCandidate !== null && isImageHeightComponentNearInitialBranch(acceptedRustCandidate, initialGuess, 'angle')) return acceptedRustCandidate;
                return solveImageHeightComponent(targetX, initialGuess, evaluateCandidate, solverOptions);
            };

            const solveAngleY = (initialGuess, fixedAngleX = solvedAngleXDeg) => {
                const solverOptions = {
                    initialStep: Math.max(0.05, Math.abs(paraxialAngleYDeg) * 0.05, Math.abs(targetY) * 0.005),
                    maxStep: Math.max(2, Math.abs(paraxialAngleYDeg) * 0.5, Math.abs(targetY) * 0.05),
                };
                const evaluateCandidate = (candidate) => evaluateAngleHitComponent(fixedAngleX, candidate, 1, validationTraceBackend);
                const rustResult = solveImageHeightComponentWithRust(
                    opticalSystemRows,
                    imageSurfaceIndex,
                    wavelengthUm,
                    'infinite',
                    1,
                    targetY,
                    initialGuess,
                    fixedAngleX,
                    solverOptions,
                );
                const acceptedRustCandidate = skipTsValidation
                    ? acceptRustImageHeightCandidate(rustResult, 1, targetY)
                    : acceptRustImageHeightCandidateWithValidation(
                        rustResult,
                        1,
                        targetY,
                        (candidate) => evaluateAngleHitComponent(fixedAngleX, candidate, 1, validationTraceBackend)
                    );
                if (acceptedRustCandidate !== null && isImageHeightComponentNearInitialBranch(acceptedRustCandidate, initialGuess, 'angle')) return acceptedRustCandidate;
                return solveImageHeightComponent(targetY, initialGuess, evaluateCandidate, solverOptions);
            };

            for (let iter = 0; iter < 8; iter++) {
                const nextX = solveAngleX(solvedAngleXDeg, solvedAngleYDeg);
                const nextY = solveAngleY(solvedAngleYDeg, nextX);
                const localHit = traceChiefRayImagePointForAngle(
                    opticalSystemRows,
                    nextX,
                    nextY,
                    imageSurfaceIndex,
                    imageSurfaceInfo,
                    wavelengthUm,
                    imageHeightSolveContext,
                    'ts',
                    validationTraceBackend,
                );
                solvedAngleXDeg = nextX;
                solvedAngleYDeg = nextY;

                const errX = Math.abs((Number(localHit?.x) || 0) - targetX);
                const errY = Math.abs((Number(localHit?.y) || 0) - targetY);
                if ((errX < 1e-6 && errY < 1e-6) || (iter > 1 && errX < 1e-5 && errY < 1e-5)) {
                    break;
                }
            }

            {
                const refined = refineImageHeightPairWithTs(
                    solvedAngleXDeg,
                    solvedAngleYDeg,
                    targetX,
                    targetY,
                    (candidateX, candidateY) => traceChiefRayImagePointForAngle(
                        opticalSystemRows,
                        candidateX,
                        candidateY,
                        imageSurfaceIndex,
                        imageSurfaceInfo,
                        wavelengthUm,
                        imageHeightSolveContext,
                        'ts',
                        validationTraceBackend,
                    ),
                    {
                        tolerance: 1e-6,
                        maxIterations: 16,
                        finiteDiffStep: 5e-5,
                        maxStep: 0.1,
                    }
                );
                solvedAngleXDeg = refined.x;
                solvedAngleYDeg = refined.y;
            }

            const solvedChief = traceChiefRayForAngleDetails(
                opticalSystemRows,
                solvedAngleXDeg,
                solvedAngleYDeg,
                imageSurfaceIndex,
                imageSurfaceInfo,
                wavelengthUm,
                imageHeightSolveContext,
                'ts',
            );
            const solvedHit = solvedChief?.localHit ?? null;
            const resolvedHit = (solvedHit && Number.isFinite(Number(solvedHit.x)) && Number.isFinite(Number(solvedHit.y)))
                ? solvedHit
                : (paraxialOnlyModel ? { x: targetX, y: targetY, z: Number(imageSurfaceInfo?.origin?.z) || 0 } : null);
            logImageHeightDiagnostics('solve-infinite', {
                objectId: obj?.id ?? null,
                conjugateType,
                wavelengthUm,
                warmStart: warmStart.source,
                target: { x: targetX, y: targetY },
                paraxial: { x: paraxialAngleXDeg, y: paraxialAngleYDeg },
                solvedField: { x: solvedAngleXDeg, y: solvedAngleYDeg, mode: 'angle-deg' },
                hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                error: resolvedHit ? {
                    x: Number(resolvedHit.x) - targetX,
                    y: Number(resolvedHit.y) - targetY
                } : null,
                imageSurfaceIndex
            });

            if (!disableSolveCache) {
                setCachedImageHeightPairSolve(solveScopeKey, targetX, targetY, {
                    solver: 'ts-refine',
                    solved: { x: solvedAngleXDeg, y: solvedAngleYDeg },
                    hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y), z: Number(resolvedHit.z) || 0 } : null,
                    chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                        origin: {
                            x: Number(solvedChief.origin.x),
                            y: Number(solvedChief.origin.y),
                            z: Number(solvedChief.origin.z),
                        },
                        dir: {
                            x: Number(solvedChief.dir.x),
                            y: Number(solvedChief.dir.y),
                            z: Number(solvedChief.dir.z),
                        },
                    } : null,
                });
            }
            if (!disableWarmStartCache) {
                storeImageHeightWarmStart(solveScopeKey, targetX, targetY, solvedAngleXDeg, solvedAngleYDeg, resolvedHit);
            }

            return storeResult({
                ...obj,
                position: obj?.position ?? 'ImageHeight',
                __cooptEffectivePosition: 'Angle',
                xHeightAngle: solvedAngleXDeg,
                yHeightAngle: solvedAngleYDeg,
                __cooptImageHeightTarget: { x: targetX, y: targetY },
                __cooptImageHeightSolve: {
                    conjugateType,
                    mode: paraxialOnlyModel ? 'infinite-angle-paraxial' : 'infinite-angle',
                        validation: validationMode,
                        solver: 'ts-refine',
                        warmStart: warmStart.source,
                    paraxial: { x: paraxialAngleXDeg, y: paraxialAngleYDeg },
                    solved: { x: solvedAngleXDeg, y: solvedAngleYDeg },
                    hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                    chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                        origin: {
                            x: Number(solvedChief.origin.x),
                            y: Number(solvedChief.origin.y),
                            z: Number(solvedChief.origin.z),
                        },
                        dir: {
                            x: Number(solvedChief.dir.x),
                            y: Number(solvedChief.dir.y),
                            z: Number(solvedChief.dir.z),
                        },
                    } : null,
                    imageSurfaceIndex,
                    wavelengthUm
                },
            });
        } else {
            const imgDist = Number(paraxial.imageDistance);
            const objSurf = opticalSystemRows && opticalSystemRows[0];
            const objDist = objSurf ? Number(objSurf.thickness) : NaN;
            let mag: number;
            if (Number.isFinite(imgDist) && Number.isFinite(objDist) && Math.abs(objDist) > 1e-12) {
                mag = imgDist / objDist;
            } else {
                mag = 1;
            }
            const absMag = Math.abs(mag);
            const scale = absMag > 1e-12 ? 1 / absMag : 1;
            const paraxialObjectX = targetX * scale;
            const paraxialObjectY = targetY * scale;
            const warmStart = disableWarmStartCache
                ? {
                    x: paraxialObjectX,
                    y: paraxialObjectY,
                    source: 'paraxial',
                }
                : getImageHeightWarmStart(
                    solveScopeKey,
                    targetX,
                    targetY,
                    paraxialObjectX,
                    paraxialObjectY,
                    obj?.__cooptImageHeightSolve?.solved,
                );
            let solvedObjectX = warmStart.x;
            let solvedObjectY = warmStart.y;

            const cachedPairSolve = disableSolveCache ? null : getCachedImageHeightPairSolve(solveScopeKey, targetX, targetY);
            if (cachedPairSolve) {
                solvedObjectX = Number.isFinite(Number(cachedPairSolve?.solved?.x)) ? Number(cachedPairSolve.solved.x) : solvedObjectX;
                solvedObjectY = Number.isFinite(Number(cachedPairSolve?.solved?.y)) ? Number(cachedPairSolve.solved.y) : solvedObjectY;
                const cachedHit = cachedPairSolve?.hit;
                const cachedChiefRay = cachedPairSolve?.chiefRay;
                return storeResult({
                    ...obj,
                    position: obj?.position ?? 'ImageHeight',
                    __cooptEffectivePosition: 'Rectangle',
                    xHeightAngle: solvedObjectX,
                    yHeightAngle: solvedObjectY,
                    __cooptImageHeightTarget: { x: targetX, y: targetY },
                    __cooptImageHeightSolve: {
                        conjugateType,
                        mode: paraxialOnlyModel ? 'finite-rectangle-paraxial' : 'finite-rectangle',
                        validation: validationMode,
                        solver: String(cachedPairSolve?.solver || 'cache'),
                        warmStart: warmStart.source,
                        paraxial: { x: paraxialObjectX, y: paraxialObjectY },
                        solved: { x: solvedObjectX, y: solvedObjectY },
                        hit: cachedHit ? { x: Number(cachedHit.x), y: Number(cachedHit.y) } : null,
                        chiefRay: cachedChiefRay?.origin && cachedChiefRay?.dir ? {
                            origin: {
                                x: Number(cachedChiefRay.origin.x),
                                y: Number(cachedChiefRay.origin.y),
                                z: Number(cachedChiefRay.origin.z),
                            },
                            dir: {
                                x: Number(cachedChiefRay.dir.x),
                                y: Number(cachedChiefRay.dir.y),
                                z: Number(cachedChiefRay.dir.z),
                            },
                        } : null,
                        imageSurfaceIndex,
                        wavelengthUm
                    },
                });
            }

            const rustPairResult = solveImageHeightPairExactWithRust(
                opticalSystemRows,
                imageSurfaceIndex,
                wavelengthUm,
                conjugateType,
                targetX,
                targetY,
                solvedObjectX,
                solvedObjectY,
            ) || solveImageHeightPairWithRust(
                opticalSystemRows,
                imageSurfaceIndex,
                wavelengthUm,
                conjugateType,
                targetX,
                targetY,
                solvedObjectX,
                solvedObjectY,
            );
            let acceptedRustPair = skipTsValidation
                ? acceptRustImageHeightPair(rustPairResult, targetX, targetY)
                : acceptRustImageHeightPairWithValidation(
                    rustPairResult,
                    targetX,
                    targetY,
                    (candidateX, candidateY) => traceChiefRayImagePointForFiniteObject(
                        opticalSystemRows,
                        candidateX,
                        candidateY,
                        imageSurfaceIndex,
                        imageSurfaceInfo,
                        wavelengthUm,
                        imageHeightSolveContext,
                        validationTraceBackend,
                    )
                );
            if (acceptedRustPair && !isImageHeightPairNearParaxialBranch(
                Number(acceptedRustPair.x),
                Number(acceptedRustPair.y),
                paraxialObjectX,
                paraxialObjectY,
                targetX,
                targetY,
                'object'
            )) {
                acceptedRustPair = null;
            }
            if (acceptedRustPair) {
                solvedObjectX = acceptedRustPair.x;
                solvedObjectY = acceptedRustPair.y;
                const solvedChief = traceChiefRayForFiniteObjectDetails(
                    opticalSystemRows,
                    solvedObjectX,
                    solvedObjectY,
                    imageSurfaceIndex,
                    imageSurfaceInfo,
                    wavelengthUm,
                    imageHeightSolveContext,
                    'rust',
                );
                const resolvedHit = solvedChief?.localHit ?? acceptedRustPair.hit;
                logImageHeightDiagnostics('solve-finite', {
                    objectId: obj?.id ?? null,
                    conjugateType,
                    wavelengthUm,
                    warmStart: warmStart.source,
                    target: { x: targetX, y: targetY },
                    paraxial: { x: paraxialObjectX, y: paraxialObjectY },
                    solvedField: { x: solvedObjectX, y: solvedObjectY, mode: 'object-mm' },
                    hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                    error: resolvedHit ? {
                        x: Number(resolvedHit.x) - targetX,
                        y: Number(resolvedHit.y) - targetY
                    } : null,
                    imageSurfaceIndex,
                    solver: 'rust-pair'
                });

                if (!disableSolveCache) {
                    setCachedImageHeightPairSolve(solveScopeKey, targetX, targetY, {
                        solver: 'rust-pair',
                        solved: { x: solvedObjectX, y: solvedObjectY },
                        hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y), z: Number(resolvedHit.z) || 0 } : null,
                        chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                            origin: {
                                x: Number(solvedChief.origin.x),
                                y: Number(solvedChief.origin.y),
                                z: Number(solvedChief.origin.z),
                            },
                            dir: {
                                x: Number(solvedChief.dir.x),
                                y: Number(solvedChief.dir.y),
                                z: Number(solvedChief.dir.z),
                            },
                        } : null,
                    });
                }
                if (!disableWarmStartCache) {
                    storeImageHeightWarmStart(solveScopeKey, targetX, targetY, solvedObjectX, solvedObjectY, resolvedHit);
                }

                return storeResult({
                    ...obj,
                    position: obj?.position ?? 'ImageHeight',
                    __cooptEffectivePosition: 'Rectangle',
                    xHeightAngle: solvedObjectX,
                    yHeightAngle: solvedObjectY,
                    __cooptImageHeightTarget: { x: targetX, y: targetY },
                    __cooptImageHeightSolve: {
                        conjugateType,
                        mode: paraxialOnlyModel ? 'finite-rectangle-paraxial' : 'finite-rectangle',
                        validation: validationMode,
                        solver: 'rust-pair',
                        warmStart: warmStart.source,
                        paraxial: { x: paraxialObjectX, y: paraxialObjectY },
                        solved: { x: solvedObjectX, y: solvedObjectY },
                        hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                        chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                            origin: {
                                x: Number(solvedChief.origin.x),
                                y: Number(solvedChief.origin.y),
                                z: Number(solvedChief.origin.z),
                            },
                            dir: {
                                x: Number(solvedChief.dir.x),
                                y: Number(solvedChief.dir.y),
                                z: Number(solvedChief.dir.z),
                            },
                        } : null,
                        imageSurfaceIndex,
                        wavelengthUm
                    },
                });
            }

            const evaluateFiniteHitComponent = (
                candidateObjectX,
                candidateObjectY,
                componentIndex: 0 | 1,
                traceBackend: 'ts' | 'rust' = 'rust'
            ) => {
                const localHit = traceChiefRayImagePointForFiniteObject(
                    opticalSystemRows,
                    candidateObjectX,
                    candidateObjectY,
                    imageSurfaceIndex,
                    imageSurfaceInfo,
                    wavelengthUm,
                    imageHeightSolveContext,
                    traceBackend,
                );
                return componentIndex === 0 ? Number(localHit?.x) : Number(localHit?.y);
            };

            const solveObjectX = (initialGuess, fixedObjectY = solvedObjectY) => {
                const solverOptions = {
                    initialStep: Math.max(0.01, Math.abs(paraxialObjectX) * 0.05, Math.abs(targetX) * 0.01),
                    maxStep: Math.max(1, Math.abs(paraxialObjectX) * 0.5, Math.abs(targetX) * 0.25),
                };
                const evaluateCandidate = (candidate) => evaluateFiniteHitComponent(candidate, fixedObjectY, 0, validationTraceBackend);
                const rustResult = solveImageHeightComponentWithRust(
                    opticalSystemRows,
                    imageSurfaceIndex,
                    wavelengthUm,
                    'finite',
                    0,
                    targetX,
                    initialGuess,
                    fixedObjectY,
                    solverOptions,
                );
                const acceptedRustCandidate = skipTsValidation
                    ? acceptRustImageHeightCandidate(rustResult, 0, targetX)
                    : acceptRustImageHeightCandidateWithValidation(
                        rustResult,
                        0,
                        targetX,
                        (candidate) => evaluateFiniteHitComponent(candidate, fixedObjectY, 0, validationTraceBackend)
                    );
                if (acceptedRustCandidate !== null && isImageHeightComponentNearInitialBranch(acceptedRustCandidate, initialGuess, 'object')) return acceptedRustCandidate;
                return solveImageHeightComponent(targetX, initialGuess, evaluateCandidate, solverOptions);
            };

            const solveObjectY = (initialGuess, fixedObjectX = solvedObjectX) => {
                const solverOptions = {
                    initialStep: Math.max(0.01, Math.abs(paraxialObjectY) * 0.05, Math.abs(targetY) * 0.01),
                    maxStep: Math.max(1, Math.abs(paraxialObjectY) * 0.5, Math.abs(targetY) * 0.25),
                };
                const evaluateCandidate = (candidate) => evaluateFiniteHitComponent(fixedObjectX, candidate, 1, validationTraceBackend);
                const rustResult = solveImageHeightComponentWithRust(
                    opticalSystemRows,
                    imageSurfaceIndex,
                    wavelengthUm,
                    'finite',
                    1,
                    targetY,
                    initialGuess,
                    fixedObjectX,
                    solverOptions,
                );
                const acceptedRustCandidate = skipTsValidation
                    ? acceptRustImageHeightCandidate(rustResult, 1, targetY)
                    : acceptRustImageHeightCandidateWithValidation(
                        rustResult,
                        1,
                        targetY,
                        (candidate) => evaluateFiniteHitComponent(fixedObjectX, candidate, 1, validationTraceBackend)
                    );
                if (acceptedRustCandidate !== null && isImageHeightComponentNearInitialBranch(acceptedRustCandidate, initialGuess, 'object')) return acceptedRustCandidate;
                return solveImageHeightComponent(targetY, initialGuess, evaluateCandidate, solverOptions);
            };

            for (let iter = 0; iter < 8; iter++) {
                const nextX = solveObjectX(solvedObjectX, solvedObjectY);
                const nextY = solveObjectY(solvedObjectY, nextX);
                const localHit = traceChiefRayImagePointForFiniteObject(
                    opticalSystemRows,
                    nextX,
                    nextY,
                    imageSurfaceIndex,
                    imageSurfaceInfo,
                    wavelengthUm,
                    imageHeightSolveContext,
                    'rust',
                    validationTraceBackend,
                );
                solvedObjectX = nextX;
                solvedObjectY = nextY;

                const errX = Math.abs((Number(localHit?.x) || 0) - targetX);
                const errY = Math.abs((Number(localHit?.y) || 0) - targetY);
                if ((errX < 1e-6 && errY < 1e-6) || (iter > 1 && errX < 1e-5 && errY < 1e-5)) {
                    break;
                }
            }

            {
                const refined = refineImageHeightPairWithTs(
                    solvedObjectX,
                    solvedObjectY,
                    targetX,
                    targetY,
                    (candidateX, candidateY) => traceChiefRayImagePointForFiniteObject(
                        opticalSystemRows,
                        candidateX,
                        candidateY,
                        imageSurfaceIndex,
                        imageSurfaceInfo,
                        wavelengthUm,
                        imageHeightSolveContext,
                        'rust',
                        validationTraceBackend,
                    ),
                    {
                        tolerance: 1e-6,
                        maxIterations: 16,
                        finiteDiffStep: 5e-5,
                        maxStep: 0.25,
                    }
                );
                solvedObjectX = refined.x;
                solvedObjectY = refined.y;
            }

            const solvedChief = traceChiefRayForFiniteObjectDetails(
                opticalSystemRows,
                solvedObjectX,
                solvedObjectY,
                imageSurfaceIndex,
                imageSurfaceInfo,
                wavelengthUm,
                imageHeightSolveContext,
                'rust',
            );
            const resolvedHit = (solvedChief?.localHit && Number.isFinite(Number(solvedChief.localHit.x)) && Number.isFinite(Number(solvedChief.localHit.y)))
                ? solvedChief.localHit
                : (paraxialOnlyModel ? { x: targetX, y: targetY, z: Number(imageSurfaceInfo?.origin?.z) || 0 } : null);
            logImageHeightDiagnostics('solve-finite', {
                objectId: obj?.id ?? null,
                conjugateType,
                wavelengthUm,
                warmStart: warmStart.source,
                target: { x: targetX, y: targetY },
                paraxial: { x: paraxialObjectX, y: paraxialObjectY },
                solvedField: { x: solvedObjectX, y: solvedObjectY, mode: 'object-mm' },
                hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                error: resolvedHit ? {
                    x: Number(resolvedHit.x) - targetX,
                    y: Number(resolvedHit.y) - targetY
                } : null,
                imageSurfaceIndex
            });

            if (!disableSolveCache) {
                setCachedImageHeightPairSolve(solveScopeKey, targetX, targetY, {
                    solver: 'ts-refine',
                    solved: { x: solvedObjectX, y: solvedObjectY },
                    hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y), z: Number(resolvedHit.z) || 0 } : null,
                    chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                        origin: {
                            x: Number(solvedChief.origin.x),
                            y: Number(solvedChief.origin.y),
                            z: Number(solvedChief.origin.z),
                        },
                        dir: {
                            x: Number(solvedChief.dir.x),
                            y: Number(solvedChief.dir.y),
                            z: Number(solvedChief.dir.z),
                        },
                    } : null,
                });
            }
            if (!disableWarmStartCache) {
                storeImageHeightWarmStart(solveScopeKey, targetX, targetY, solvedObjectX, solvedObjectY, resolvedHit);
            }

            return storeResult({
                ...obj,
                position: obj?.position ?? 'ImageHeight',
                __cooptEffectivePosition: 'Rectangle',
                xHeightAngle: solvedObjectX,
                yHeightAngle: solvedObjectY,
                __cooptImageHeightTarget: { x: targetX, y: targetY },
                __cooptImageHeightSolve: {
                    conjugateType,
                    mode: paraxialOnlyModel ? 'finite-rectangle-paraxial' : 'finite-rectangle',
                        validation: validationMode,
                        solver: 'ts-refine',
                        warmStart: warmStart.source,
                    paraxial: { x: paraxialObjectX, y: paraxialObjectY },
                    solved: { x: solvedObjectX, y: solvedObjectY },
                    hit: resolvedHit ? { x: Number(resolvedHit.x), y: Number(resolvedHit.y) } : null,
                    chiefRay: solvedChief?.origin && solvedChief?.dir ? {
                        origin: {
                            x: Number(solvedChief.origin.x),
                            y: Number(solvedChief.origin.y),
                            z: Number(solvedChief.origin.z),
                        },
                        dir: {
                            x: Number(solvedChief.dir.x),
                            y: Number(solvedChief.dir.y),
                            z: Number(solvedChief.dir.z),
                        },
                    } : null,
                    imageSurfaceIndex,
                    wavelengthUm
                },
            });
        }
    } catch (_) {
        if (paraxialOnlyModel) {
            try {
                const paraxial = calculateParaxialData(opticalSystemRows, wavelengthUm);
                if (paraxial) {
                    if (conjugateType === 'infinite') {
                        const efl = Number(paraxial.focalLength);
                        if (Number.isFinite(efl) && Math.abs(efl) > 1e-12) {
                            return storeResult({
                                ...obj,
                                position: obj?.position ?? 'ImageHeight',
                                __cooptEffectivePosition: 'Angle',
                                xHeightAngle: Math.atan2(targetX, efl) * (180 / Math.PI),
                                yHeightAngle: Math.atan2(targetY, efl) * (180 / Math.PI),
                                __cooptImageHeightTarget: { x: targetX, y: targetY },
                                __cooptImageHeightSolve: {
                                    conjugateType,
                                    mode: 'infinite-angle-paraxial-fallback',
                                    paraxial: {
                                        x: Math.atan2(targetX, efl) * (180 / Math.PI),
                                        y: Math.atan2(targetY, efl) * (180 / Math.PI),
                                    },
                                    solved: {
                                        x: Math.atan2(targetX, efl) * (180 / Math.PI),
                                        y: Math.atan2(targetY, efl) * (180 / Math.PI),
                                    },
                                    hit: { x: targetX, y: targetY },
                                    imageSurfaceIndex: findImageSurfaceIndex(opticalSystemRows),
                                    wavelengthUm,
                                },
                            });
                        }
                    } else {
                        const imgDist = Number(paraxial.imageDistance);
                        const objSurf = opticalSystemRows && opticalSystemRows[0];
                        const objDist = objSurf ? Number(objSurf.thickness) : NaN;
                        const mag = (Number.isFinite(imgDist) && Number.isFinite(objDist) && Math.abs(objDist) > 1e-12)
                            ? (imgDist / objDist)
                            : 1;
                        const absMag = Math.abs(mag);
                        const scale = absMag > 1e-12 ? 1 / absMag : 1;
                        return storeResult({
                            ...obj,
                            position: obj?.position ?? 'ImageHeight',
                            __cooptEffectivePosition: 'Rectangle',
                            xHeightAngle: targetX * scale,
                            yHeightAngle: targetY * scale,
                            __cooptImageHeightTarget: { x: targetX, y: targetY },
                            __cooptImageHeightSolve: {
                                conjugateType,
                                mode: 'finite-rectangle-paraxial-fallback',
                                paraxial: { x: targetX * scale, y: targetY * scale },
                                solved: { x: targetX * scale, y: targetY * scale },
                                hit: { x: targetX, y: targetY },
                                imageSurfaceIndex: findImageSurfaceIndex(opticalSystemRows),
                                wavelengthUm,
                            },
                        });
                    }
                }
            } catch (_) {}
        }
        // Fallback: treat as Angle with y = targetY degrees
        return storeResult({
            ...obj,
            position: obj?.position ?? 'ImageHeight',
            __cooptEffectivePosition: 'Angle',
            xHeightAngle: targetX,
            yHeightAngle: targetY,
            __cooptImageHeightTarget: { x: targetX, y: targetY },
        });
    }
}

export function generateRayStartPointsForObject(obj, opticalSystemRows, rayCount, apertureLimit = null, options: RayGenerationOptions = {}) {
    // console.log(`🎯 generateRayStartPointsForObject called for object type: ${obj.position}`);
    // console.log(`🔍 Current ray emission pattern: ${rayEmissionPattern}`);
    
    const annularRingCount = normalizeAnnularRingCount(options?.annularRingCount);
    const wavelengthUmRaw = options?.wavelengthUm ?? options?.wavelength;
    const wavelengthUm = (typeof wavelengthUmRaw === 'number' && Number.isFinite(wavelengthUmRaw) && wavelengthUmRaw > 0)
        ? wavelengthUmRaw
        : 0.5876;
    
    // Detect conjugate type once and pass to all generation functions
    const conjugateType = detectConjugateType(opticalSystemRows, options);
    
    // options.pattern が指定されていればそれを優先（Requirements計算等でUI状態に依存しないため）
    const effectivePattern = (options && typeof options.pattern === 'string' && (options.pattern === 'grid' || options.pattern === 'annular'))
        ? options.pattern
        : rayEmissionPattern;
    const cacheKey = buildRayStartGenerationCacheKey(
        obj,
        opticalSystemRows,
        rayCount,
        apertureLimit,
        options,
        effectivePattern,
        annularRingCount,
        wavelengthUm
    );
    if (cacheKey && rayStartGenerationCache.has(cacheKey)) {
        const cached = rayStartGenerationCache.get(cacheKey);
        if (cached) return cached;
    }

    const posNorm = resolveObjectPositionForRayPath(obj);

    // Pass conjugateType to all generation functions
    const enhancedOptions = { ...options, conjugateType };

    let generatedRayStarts: RayStartDataArray = [];

    if (posNorm === "point") {
        generatedRayStarts = generateRaysForPointObject(obj, opticalSystemRows, rayCount, apertureLimit, effectivePattern, annularRingCount, wavelengthUm, enhancedOptions);
    } else if (posNorm === "angle") {
        generatedRayStarts = generateRaysForAngleObject(obj, opticalSystemRows, rayCount, effectivePattern, annularRingCount, { ...enhancedOptions, wavelengthUm, apertureLimitMm: apertureLimit });
    } else if (posNorm === "rectangle") {
        generatedRayStarts = generateRaysForRectangleObject(obj, opticalSystemRows, rayCount, effectivePattern, apertureLimit, annularRingCount, wavelengthUm, enhancedOptions);
    } else if (posNorm === "imageheight") {
        // Convert target image height → effective object field and delegate.
        // The solver inside convertImageHeightToEffectiveObject uses a stop-center
        // chief ray to determine the equivalent angle / object height. To keep the
        // rendered chief ray consistent with that solve (so the chief ray actually
        // hits the requested image height), force stop-center chief-ray aiming
        // when delegating to the Angle / Rectangle generators.
        const imageSurfaceIndex = findImageSurfaceIndex(opticalSystemRows);
        const effectiveObj = convertImageHeightToEffectiveObject(
            obj,
            opticalSystemRows,
            wavelengthUm,
            conjugateType,
            {
                skipTsValidation: options?.skipImageHeightTsValidation === true,
                validationTraceBackend: options?.imageHeightValidationTraceBackend === 'rust' ? 'rust' : 'ts',
            }
        );
        const imageHeightDelegationOptions = {
            ...enhancedOptions,
            aimThroughStop: true,
            useChiefRayAnalysis: true,
            allowStopBasedOriginSolve: true,
            originSolveTraceBackend: 'rust',
            strictChiefDirectionSolve: true,
            targetSurfaceIndex: Number.isInteger(imageSurfaceIndex) ? imageSurfaceIndex : enhancedOptions?.targetSurfaceIndex,
        };
        const shouldLogDelegatedImageHeightResult = !!((typeof globalThis !== 'undefined') && (globalThis as any).__COOPT_DEBUG_IMAGEHEIGHT_RENDER === true);
        const delegatedPositionNorm = String(effectiveObj?.__cooptEffectivePosition ?? effectiveObj?.position ?? '').trim().toLowerCase();
        const logDelegatedImageHeightResult = (rayStarts) => {
            if (!shouldLogDelegatedImageHeightResult) return;
            try {
                const target = effectiveObj?.__cooptImageHeightTarget ?? { x: Number(obj?.xHeightAngle) || 0, y: Number(obj?.yHeightAngle) || 0 };
                const imageSurfaceInfo = calculateSurfaceOrigins(opticalSystemRows)?.[imageSurfaceIndex] || null;
                const chiefOrigin = rayStarts?.expectedChiefOrigin ?? rayStarts?.[0]?.startP ?? null;
                const chiefDir = rayStarts?.expectedChiefDir ?? rayStarts?.[0]?.dir ?? null;
                let localHit = null;
                if (chiefOrigin && chiefDir && Number.isFinite(chiefOrigin.x) && Number.isFinite(chiefOrigin.y) && Number.isFinite(chiefOrigin.z)
                    && Number.isFinite(chiefDir.x) && Number.isFinite(chiefDir.y) && Number.isFinite(chiefDir.z)) {
                    const hit = traceRayHitPointForRender(
                        opticalSystemRows,
                        { pos: chiefOrigin, dir: chiefDir, wavelength: wavelengthUm },
                        1.0,
                        imageSurfaceIndex,
                        'rust'
                    );
                    localHit = hit ? transformPointToSurfaceLocal(hit, imageSurfaceInfo) : null;
                }
                logImageHeightDiagnostics('delegated-render', {
                    objectId: obj?.id ?? null,
                    sourcePosition: obj?.position ?? null,
                    delegatedPosition: delegatedPositionNorm || null,
                    target,
                    solve: effectiveObj?.__cooptImageHeightSolve ?? null,
                    chiefOrigin: chiefOrigin ? { x: Number(chiefOrigin.x), y: Number(chiefOrigin.y), z: Number(chiefOrigin.z) } : null,
                    chiefDir: chiefDir ? { x: Number(chiefDir.x), y: Number(chiefDir.y), z: Number(chiefDir.z) } : null,
                    renderHit: localHit ? { x: Number(localHit.x), y: Number(localHit.y) } : null,
                    renderError: localHit ? {
                        x: Number(localHit.x) - Number(target?.x || 0),
                        y: Number(localHit.y) - Number(target?.y || 0)
                    } : null,
                    imageSurfaceIndex,
                    rayCount: Array.isArray(rayStarts) ? rayStarts.length : null
                });
            } catch (error) {
                logImageHeightDiagnostics('delegated-render-log-failed', {
                    objectId: obj?.id ?? null,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        };
        if (delegatedPositionNorm === 'angle') {
            const rayStarts = generateRaysForAngleObject(effectiveObj, opticalSystemRows, rayCount, effectivePattern, annularRingCount, { ...imageHeightDelegationOptions, wavelengthUm, apertureLimitMm: apertureLimit });
            logDelegatedImageHeightResult(rayStarts);
            generatedRayStarts = rayStarts;
        } else {
            const rayStarts = generateRaysForRectangleObject(effectiveObj, opticalSystemRows, rayCount, effectivePattern, apertureLimit, annularRingCount, wavelengthUm, imageHeightDelegationOptions);
            logDelegatedImageHeightResult(rayStarts);
            generatedRayStarts = rayStarts;
        }
    } else {
        console.warn(`⚠️ Unknown object position type: ${obj.position}`);
        generatedRayStarts = [];
    }

    if (cacheKey && Array.isArray(generatedRayStarts)) {
        rayStartGenerationCache.set(cacheKey, generatedRayStarts);
        if (rayStartGenerationCache.size > RAY_START_GENERATION_CACHE_LIMIT) {
            const firstKey = rayStartGenerationCache.keys().next().value;
            if (firstKey !== undefined) rayStartGenerationCache.delete(firstKey);
        }
    }

    return generatedRayStarts;
}

// Helper functions for different object types would be implemented here
// This is a basic structure - the full implementation would include all the ray generation logic

/**
 * Generate rays for Point objects
 * @param {Object} obj - Object data
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} rayCount - Number of rays
 * @param {Object} apertureLimit - Aperture limit
 * @returns {Array} Ray start data
 */
function generateRaysForPointObject(obj, opticalSystemRows, rayCount, apertureLimit, pattern = 'annular', annularRingCount, wavelengthUm = 0.5876, options: RayGenerationOptions = {}) {
    const rayStartData: RayStartDataArray = [];
    rayStartData.annularRingsUsed = 0;
    rayStartData.selectedRingOverride = annularRingCount ?? 0;
    
    try {
        // Use unified conjugate type detection
        const conjugateType = options?.conjugateType || detectConjugateType(opticalSystemRows, options);
        const isInfiniteObject = (conjugateType === 'infinite');
        
        // Get surface origins for object position calculation
        const surfaceOrigins = (Array.isArray(options?.precomputedSurfaceOrigins) && options.precomputedSurfaceOrigins.length > 0)
            ? options.precomputedSurfaceOrigins
            : calculateSurfaceOrigins(opticalSystemRows);
        const stopSurfaceInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
        const stopSurfaceCenter3d = extractStopCenter3d(stopSurfaceInfo);
        const stopSurfaceIndex = Number.isInteger(stopSurfaceInfo?.index) ? stopSurfaceInfo.index : null;
        const firstSurfaceOrigin = surfaceOrigins[0] ? surfaceOrigins[0].origin : { x: 0, y: 0, z: 0 };
        const finiteObjectZ = Number.isFinite(firstSurfaceOrigin?.z) ? firstSurfaceOrigin.z : 0;
        const surf = opticalSystemRows[0];
        
        // Object position (Point objects use xHeightAngle and yHeightAngle for positioning)
        const objectX = Number(obj.xHeightAngle) || 0;
        const objectY = Number(obj.yHeightAngle) || 0;
        // Object Z coordinate: use actual surface origin for finite objects, use objectRenderDistance for infinite objects
        const objectRow = opticalSystemRows && opticalSystemRows[0];
        const renderDist = (objectRow && Number.isFinite(Number(objectRow.objectRenderDistance)))
            ? Number(objectRow.objectRenderDistance)
            : 0;
        let objectZ = isInfiniteObject ? resolveInfiniteObjectZ(opticalSystemRows, renderDist, stopSurfaceCenter3d) : finiteObjectZ;
        
        // Calculate Object surface sag at object position (finite objectのみ)
        let objectSag = 0;
        if (!isInfiniteObject && surf.radius && surf.radius !== "INF") {
            const r = Math.sqrt(objectX * objectX + objectY * objectY);
            const semidiaForQcon = Number(surf.semidia);
            const rawQconNrad = Number(surf.qconNrad ?? surf.qconNRadius ?? surf.nrad ?? surf.NRAD);
            const resolvedQconNrad = (Number.isFinite(rawQconNrad) && rawQconNrad > 0)
                ? rawQconNrad
                : ((Number.isFinite(semidiaForQcon) && semidiaForQcon > 0) ? semidiaForQcon : 0);
            const asphericParams = {
                radius: parseFloat(surf.radius),
                conic: Number(surf.conic) || 0,
                coef1: Number(surf.coef1) || 0,
                coef2: Number(surf.coef2) || 0,
                coef3: Number(surf.coef3) || 0,
                coef4: Number(surf.coef4) || 0,
                coef5: Number(surf.coef5) || 0,
                coef6: Number(surf.coef6) || 0,
                coef7: Number(surf.coef7) || 0,
                coef8: Number(surf.coef8) || 0,
                coef9: Number(surf.coef9) || 0,
                coef10: Number(surf.coef10) || 0,
                semidia: (Number.isFinite(semidiaForQcon) && semidiaForQcon > 0) ? semidiaForQcon : undefined,
                qconNrad: resolvedQconNrad,
                qconOffset: Number(surf.qconOffset ?? surf.qcon_offset) || 0,
                qconTermCount: Number(surf.qconTermCount) || 0
            };
            objectSag = asphericSurfaceZ(r, asphericParams, getAsphericModeFromSurfType(surf.surfType)) || 0;
            // console.log(`🔍 [RayRenderer] Object面sag計算: r=${r.toFixed(3)}, sag=${objectSag.toFixed(6)}`);
        }
        
        // Apply sag to object Z position
        const actualObjectZ = isInfiniteObject ? objectZ : objectZ + objectSag;
        
        const apertureRadius = Number(surf.semidia) || Number(surf.thickness) || 10;
        const thicknessNumeric = Number(surf.thickness);
        const entrancePupilZ = Number.isFinite(thicknessNumeric) ? objectZ + thicknessNumeric : objectZ + 1;
        const stopConfig = resolveStopConfigCached(opticalSystemRows, surfaceOrigins, entrancePupilZ, apertureRadius);
        const stopRadiusLimited = Math.min(stopConfig.radius, apertureRadius);
        const stopCenter = stopConfig.center || { x: 0, y: 0 };

        if (isInfiniteObject && (pattern === 'grid' || pattern === 'annular')) {
            let effectiveRadius = Number.isFinite(stopRadiusLimited) && stopRadiusLimited > 0
                ? Math.min(stopRadiusLimited, apertureRadius)
                : apertureRadius;

            const apLim = Number(apertureLimit);
            if (Number.isFinite(apLim) && apLim > 0) {
                effectiveRadius = Math.min(effectiveRadius, apLim);
            }

            const halfExtent = Math.max(1e-6, effectiveRadius);
            const offsets = pattern === 'annular'
                ? generateAnnularOffsets(rayCount, halfExtent, annularRingCount || 3)
                : generateCenteredGridOffsets(rayCount, halfExtent);
            const centerPoint = { x: objectX, y: objectY, z: actualObjectZ };
            const unitChief = { x: 0, y: 0, z: 1 };
            const startsFromRust = generateParallelStartPointsViaRust(
                centerPoint,
                { x: 1, y: 0, z: 0 },
                { x: 0, y: 1, z: 0 },
                offsets
            );

            if (Array.isArray(startsFromRust) && startsFromRust.length === offsets.length) {
                startsFromRust.forEach((entry, index) => {
                    rayStartData.push({
                        startP: entry.startP,
                        dir: unitChief,
                        description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`
                    });
                });
            } else {
                offsets.forEach((coord, index) => {
                    rayStartData.push({
                        startP: {
                            x: centerPoint.x + coord.offsetU,
                            y: centerPoint.y + coord.offsetV,
                            z: centerPoint.z
                        },
                        dir: unitChief,
                        description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`
                    });
                });
            }

            return rayStartData;
        }

        const stopPlaneCenter3d = (Number.isInteger(stopConfig?.index) && surfaceOrigins?.[stopConfig.index]?.origin)
            ? surfaceOrigins[stopConfig.index].origin
            : (Number.isFinite(stopConfig?.z)
                ? { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z }
                : null);
        const stopPlaneRotation = (Number.isInteger(stopConfig?.index) && surfaceOrigins?.[stopConfig.index]?.rotationMatrix)
            ? surfaceOrigins[stopConfig.index].rotationMatrix
            : null;
        const stopPlaneU = normalizeVector3(
            applyRotationMatrixToVector(stopPlaneRotation, { x: 1, y: 0, z: 0 }),
            { x: 1, y: 0, z: 0 }
        );
        const stopPlaneV = normalizeVector3(
            applyRotationMatrixToVector(stopPlaneRotation, { x: 0, y: 1, z: 0 }),
            { x: 0, y: 1, z: 0 }
        );
        const stopDeltaZ = (stopPlaneCenter3d?.z ?? stopConfig.z) - actualObjectZ;
        const canAimAtStop = !isInfiniteObject && Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;

        const useChiefRayAnalysis = !!(options && typeof options === 'object' && options.useChiefRayAnalysis);
        const aimThroughStop = !!(options && typeof options === 'object' && options.aimThroughStop);
        const chiefRaySolveMode = (options && typeof options === 'object' && typeof options.chiefRaySolveMode === 'string')
            ? options.chiefRaySolveMode
            : 'legacy';

        if (rayCount <= 1) {
            // Single-ray rendering should use the same chief-ray solve as the multi-ray path.
            let chiefVec = (!isInfiniteObject && canAimAtStop)
                ? { x: stopCenter.x - objectX, y: stopCenter.y - objectY, z: stopConfig.z - actualObjectZ }
                : { x: 0, y: 0, z: entrancePupilZ - actualObjectZ };

            if (!isInfiniteObject && canAimAtStop && useChiefRayAnalysis) {
                const centerPoint = { x: objectX, y: objectY, z: actualObjectZ };
                const stopCenter3d = stopPlaneCenter3d || { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                if (chiefRaySolveMode === 'fast') {
                    const solved = solveChiefRayDirectionToStopCenterFast(centerPoint, stopCenter3d, stopConfig.index, opticalSystemRows, wavelengthUm);
                    if (solved) {
                        chiefVec = solved;
                    }
                } else {
                    const chiefDirResult = findFiniteSystemChiefRayDirection(
                        centerPoint,
                        stopCenter3d,
                        stopConfig.index,
                        opticalSystemRows,
                        RAY_RENDERER_DEBUG,
                        wavelengthUm
                    );
                    if (chiefDirResult) {
                        chiefVec = {
                            x: chiefDirResult.i,
                            y: chiefDirResult.j,
                            z: chiefDirResult.k
                        };
                    }
                }
            }

            const length = Math.sqrt(chiefVec.x * chiefVec.x + chiefVec.y * chiefVec.y + chiefVec.z * chiefVec.z) || 1;
            const unitChief = { x: chiefVec.x / length, y: chiefVec.y / length, z: chiefVec.z / length };
            rayStartData.push({
                startP: { x: objectX, y: objectY, z: actualObjectZ },
                dir: unitChief,
                description: 'Chief point ray from object center',
                isChief: true,
                planeCoords: { u: 0, v: 0 }
            });
            rayStartData.expectedChiefOrigin = { x: objectX, y: objectY, z: actualObjectZ };
            rayStartData.expectedChiefDir = { ...unitChief };
        } else if (pattern === 'grid' || pattern === 'annular') {
            rrLog(`🔍 [RayRenderer] Pattern: ${pattern}, isInfiniteObject: ${isInfiniteObject}, canAimAtStop: ${canAimAtStop}`);
            rrLog(`🔍 [RayRenderer] Stop config:`, { stopCenter, stopZ: stopConfig.z, stopDeltaZ, stopIndex: stopConfig.index });
            
            const centerPoint = { x: objectX, y: objectY, z: actualObjectZ };
            let chiefDirection;
            if (isInfiniteObject) {
                chiefDirection = { x: 0, y: 0, z: 1 };
            } else if (canAimAtStop) {
                // Default to a cheap geometric chief direction; optionally refine via grid search.
                const stopCenter3d = stopPlaneCenter3d || { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                chiefDirection = {
                    x: stopCenter3d.x - objectX,
                    y: stopCenter3d.y - objectY,
                    z: stopCenter3d.z - actualObjectZ
                };

                if (useChiefRayAnalysis) {
                    if (chiefRaySolveMode === 'fast') {
                        const solved = solveChiefRayDirectionToStopCenterFast(centerPoint, stopCenter3d, stopConfig.index, opticalSystemRows, wavelengthUm);
                        if (solved) {
                            chiefDirection = solved;
                            rrLog(`✅ [RayRenderer] Chief ray direction (fast): (${chiefDirection.x.toFixed(6)}, ${chiefDirection.y.toFixed(6)}, ${chiefDirection.z.toFixed(6)})`);
                        } else {
                            rrLog(`⚠️ [RayRenderer] Fast chief ray solve failed, using geometric fallback`);
                        }
                    } else {
                        rrLog(`🔍 [RayRenderer] Calculating chief ray direction using grid search fallback...`);
                        const chiefDirResult = findFiniteSystemChiefRayDirection(
                            centerPoint,
                            stopCenter3d,
                            stopConfig.index,
                            opticalSystemRows,
                            RAY_RENDERER_DEBUG, // debugMode only when enabled
                            wavelengthUm // wavelength (μm)
                        );

                        if (chiefDirResult) {
                            chiefDirection = {
                                x: chiefDirResult.i,
                                y: chiefDirResult.j,
                                z: chiefDirResult.k
                            };
                            rrLog(`✅ [RayRenderer] Chief ray direction: (${chiefDirection.x.toFixed(6)}, ${chiefDirection.y.toFixed(6)}, ${chiefDirection.z.toFixed(6)})`);
                        } else {
                            rrLog(`⚠️ [RayRenderer] Chief ray direction finder failed, using geometric fallback`);
                        }
                    }
                }
            } else {
                console.log(`⚠️ [RayRenderer] Cannot aim at stop, using simple Z direction`);
                const deltaZ = entrancePupilZ - actualObjectZ;
                chiefDirection = { x: 0, y: 0, z: deltaZ };
            }

            let effectiveRadius = Number.isFinite(stopRadiusLimited) && stopRadiusLimited > 0
                ? Math.min(stopRadiusLimited, apertureRadius)
                : apertureRadius;

            // Optional external clamp (used by fast merit evaluation to avoid vignetting).
            const apLim = Number(apertureLimit);
            if (Number.isFinite(apLim) && apLim > 0) {
                effectiveRadius = Math.min(effectiveRadius, apLim);
            }
            const halfExtent = Math.max(1e-6, effectiveRadius);
            const offsets = pattern === 'annular'
                ? generateAnnularOffsets(rayCount, halfExtent, annularRingCount || 3)
                : generateCenteredGridOffsets(rayCount, halfExtent);

            // Finite object: keep start point fixed at the object and vary the direction
            // to hit different points on the stop/pupil.
            if (!isInfiniteObject && canAimAtStop) {
                offsets.forEach((coord, index) => {
                    const stopP = (stopPlaneCenter3d && stopPlaneU && stopPlaneV)
                        ? {
                            x: stopPlaneCenter3d.x + coord.offsetU * stopPlaneU.x + coord.offsetV * stopPlaneV.x,
                            y: stopPlaneCenter3d.y + coord.offsetU * stopPlaneU.y + coord.offsetV * stopPlaneV.y,
                            z: stopPlaneCenter3d.z + coord.offsetU * stopPlaneU.z + coord.offsetV * stopPlaneV.z
                        }
                        : {
                            x: stopCenter.x + coord.offsetU,
                            y: stopCenter.y + coord.offsetV,
                            z: stopConfig.z
                        };

                    let dir;
                    if (useChiefRayAnalysis && aimThroughStop && Number.isInteger(Number(stopConfig.index))) {
                        const solved = solveRayDirectionToStopPointFast(centerPoint, stopP, stopConfig.index, opticalSystemRows, wavelengthUm);
                        if (solved) {
                            dir = solved;
                        }
                    }

                    if (!dir) {
                        const dx = stopP.x - centerPoint.x;
                        const dy = stopP.y - centerPoint.y;
                        const dz = stopP.z - centerPoint.z;
                        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                        dir = { x: dx / L, y: dy / L, z: dz / L };
                    }

                    rayStartData.push({
                        startP: { ...centerPoint },
                        dir,
                        description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`,
                        isChief: Math.abs(Number(coord.offsetU) || 0) <= 1e-12 && Math.abs(Number(coord.offsetV) || 0) <= 1e-12,
                        planeCoords: { u: coord.offsetU, v: coord.offsetV }
                    });
                });
            } else {
                // Infinite object (or fallback): parallel rays from different pupil points.
                const { dir: unitChief, u, v } = buildPerpendicularBasis(chiefDirection);
                const startsFromRust = generateParallelStartPointsViaRust(centerPoint, u, v, offsets);
                if (Array.isArray(startsFromRust) && startsFromRust.length === offsets.length) {
                    startsFromRust.forEach((entry, index) => {
                        rayStartData.push({
                            startP: entry.startP,
                            dir: unitChief,
                            description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`,
                            isChief: Math.abs(Number(offsets[index]?.offsetU) || 0) <= 1e-12 && Math.abs(Number(offsets[index]?.offsetV) || 0) <= 1e-12,
                            planeCoords: { u: offsets[index]?.offsetU ?? 0, v: offsets[index]?.offsetV ?? 0 }
                        });
                    });
                } else {
                    offsets.forEach((coord, index) => {
                        const startP = {
                            x: centerPoint.x + coord.offsetU * u.x + coord.offsetV * v.x,
                            y: centerPoint.y + coord.offsetU * u.y + coord.offsetV * v.y,
                            z: centerPoint.z + coord.offsetU * u.z + coord.offsetV * v.z
                        };
                        rayStartData.push({
                            startP,
                            dir: unitChief,
                            description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`,
                            isChief: Math.abs(Number(coord.offsetU) || 0) <= 1e-12 && Math.abs(Number(coord.offsetV) || 0) <= 1e-12,
                            planeCoords: { u: coord.offsetU, v: coord.offsetV }
                        });
                    });
                }
            }
        } else {
            // Annular distribution (respects optional ring override)
            console.log(`🔍 [RayRenderer-Else] Pattern: ${pattern}, isInfiniteObject: ${isInfiniteObject}, canAimAtStop: ${canAimAtStop}`);
            
            const deltaZFallback = entrancePupilZ - actualObjectZ;
            
            // Build chief direction for infinite objects
            let chiefDirectionFallback;
            if (isInfiniteObject) {
                chiefDirectionFallback = { x: 0, y: 0, z: 1 };
            } else if (canAimAtStop) {
                // Use the robust chief ray direction finder from gen-ray-cross-finite.js
                console.log(`🔍 [RayRenderer-Annular] Calculating chief ray direction using grid search fallback...`);
                const stopCenter3d = { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                if (chiefRaySolveMode === 'fast') {
                    const solved = solveChiefRayDirectionToStopCenterFast(
                        { x: objectX, y: objectY, z: actualObjectZ },
                        stopCenter3d,
                        stopConfig.index,
                        opticalSystemRows,
                        wavelengthUm
                    );
                    if (solved) {
                        chiefDirectionFallback = solved;
                        console.log(`✅ [RayRenderer-Annular] Chief ray direction (fast): (${chiefDirectionFallback.x.toFixed(6)}, ${chiefDirectionFallback.y.toFixed(6)}, ${chiefDirectionFallback.z.toFixed(6)})`);
                    } else {
                        console.warn(`⚠️ [RayRenderer-Annular] Fast chief ray solve failed, using geometric fallback`);
                        chiefDirectionFallback = {
                            x: stopCenter.x - objectX,
                            y: stopCenter.y - objectY,
                            z: stopDeltaZ
                        };
                    }
                } else {
                    const chiefDirResult = findFiniteSystemChiefRayDirection(
                        { x: objectX, y: objectY, z: actualObjectZ },
                        stopCenter3d,
                        stopConfig.index,
                        opticalSystemRows,
                        true, // debugMode
                        wavelengthUm // wavelength (μm)
                    );
                    
                    if (chiefDirResult) {
                        chiefDirectionFallback = {
                            x: chiefDirResult.i,
                            y: chiefDirResult.j,
                            z: chiefDirResult.k
                        };
                        console.log(`✅ [RayRenderer-Annular] Chief ray direction: (${chiefDirectionFallback.x.toFixed(6)}, ${chiefDirectionFallback.y.toFixed(6)}, ${chiefDirectionFallback.z.toFixed(6)})`);
                    } else {
                        // Fallback to geometric calculation
                        console.warn(`⚠️ [RayRenderer-Annular] Chief ray direction finder failed, using geometric fallback`);
                        chiefDirectionFallback = {
                            x: stopCenter.x - objectX,
                            y: stopCenter.y - objectY,
                            z: stopDeltaZ
                        };
                    }
                }
            } else {
                console.log(`⚠️ [RayRenderer-Annular] Cannot aim at stop, using simple Z direction`);
                chiefDirectionFallback = { x: 0, y: 0, z: deltaZFallback };
            }
            
            const { dir: unitChiefFallback } = buildPerpendicularBasis(chiefDirectionFallback);
            
            const baseLength = Math.sqrt(deltaZFallback * deltaZFallback) || 1;
            rayStartData.push({
                startP: { x: objectX, y: objectY, z: actualObjectZ },
                dir: { x: 0, y: 0, z: deltaZFallback / baseLength },
                description: 'Chief point ray from object center'
            });
            let raysGenerated = 1;
            const remainingRays = Math.max(rayCount - 1, 0);
            
            if (remainingRays > 0) {
                let numRings;
                if (annularRingCount) {
                    // Use the explicit ring count parameter
                    numRings = Math.min(annularRingCount, remainingRays);
                } else {
                    // Auto-calculate based on remaining rays (fallback when no explicit count)
                    if (remainingRays <= 6) numRings = 1;
                    else if (remainingRays <= 15) numRings = 2;
                    else if (remainingRays <= 30) numRings = 3;
                    else if (remainingRays <= 50) numRings = 4;
                    else if (remainingRays <= 80) numRings = 5;
                    else if (remainingRays <= 120) numRings = 6;
                    else if (remainingRays <= 170) numRings = 7;
                    else numRings = 8;
                }

                const ringScale = numRings === 1 ? 1 : (numRings / (numRings + 1)); // keep rings slightly inside first semidia
                const maxStopRadius = Math.max(0, Math.min(stopRadiusLimited * ringScale, apertureRadius * ringScale));
                const fallbackRadius = apertureRadius * ringScale;
                const canUseStopTarget = canAimAtStop && maxStopRadius > 0;
                
                for (let ringIndex = 1; ringIndex <= numRings && raysGenerated < rayCount; ringIndex++) {
                    const ringsLeft = numRings - ringIndex + 1;
                    const raysAvailable = rayCount - raysGenerated;
                    let raysInThisRing = Math.max(3, Math.floor(raysAvailable / ringsLeft));
                    if (raysInThisRing > raysAvailable) raysInThisRing = raysAvailable;
                    if (ringIndex === numRings) raysInThisRing = raysAvailable;
                    const baseAngle = (ringIndex % 2 === 0 ? Math.PI / raysInThisRing : 0);
                    const ringLimitRadius = canUseStopTarget ? maxStopRadius : fallbackRadius;
                    const startRadius = (ringIndex / numRings) * ringLimitRadius;
                    const targetRadius = (ringIndex / numRings) * ringLimitRadius;
                    
                    for (let i = 0; i < raysInThisRing && raysGenerated < rayCount; i++) {
                        const angle = baseAngle + (2 * Math.PI * i) / raysInThisRing;
                        const startP = {
                            x: isInfiniteObject ? (objectX + startRadius * Math.cos(angle)) : objectX,
                            y: isInfiniteObject ? (objectY + startRadius * Math.sin(angle)) : objectY,
                            z: actualObjectZ
                        };
                        let dirVector;
                        if (isInfiniteObject) {
                            dirVector = unitChiefFallback;
                        } else if (canUseStopTarget) {
                            const stopCenter3d = stopPlaneCenter3d || { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                            const targetPoint = (stopCenter3d && stopPlaneU && stopPlaneV)
                                ? {
                                    x: stopCenter3d.x + (targetRadius * Math.cos(angle)) * stopPlaneU.x + (targetRadius * Math.sin(angle)) * stopPlaneV.x,
                                    y: stopCenter3d.y + (targetRadius * Math.cos(angle)) * stopPlaneU.y + (targetRadius * Math.sin(angle)) * stopPlaneV.y,
                                    z: stopCenter3d.z + (targetRadius * Math.cos(angle)) * stopPlaneU.z + (targetRadius * Math.sin(angle)) * stopPlaneV.z
                                }
                                : {
                                    x: stopCenter.x + targetRadius * Math.cos(angle),
                                    y: stopCenter.y + targetRadius * Math.sin(angle),
                                    z: stopConfig.z
                                };
                            const dx = targetPoint.x - objectX;
                            const dy = targetPoint.y - objectY;
                            const dz = targetPoint.z - actualObjectZ;
                            const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                            dirVector = { x: dx / length, y: dy / length, z: dz / length };
                        } else {
                            const pupilX = objectX + targetRadius * Math.cos(angle);
                            const pupilY = objectY + targetRadius * Math.sin(angle);
                            const deltaX = pupilX - objectX;
                            const deltaY = pupilY - objectY;
                            const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZFallback * deltaZFallback) || 1;
                            dirVector = {
                                x: deltaX / length,
                                y: deltaY / length,
                                z: deltaZFallback / length
                            };
                        }
                        
                        rayStartData.push({
                            startP,
                            dir: dirVector,
                            description: `Point ring ${ringIndex} ray (target radius ${targetRadius.toFixed(3)}mm)`
                        });
                        raysGenerated++;
                    }
                }
                rayStartData.annularRingsUsed = numRings;
            }
        }
        
        // console.log(`✅ Generated ${rayStartData.length} rays for Point object`);
        
    } catch (error) {
        console.error('❌ Error generating rays for Point object:', error);
    }
    
    return rayStartData;
}

/**
 * Generate rays for Angle objects
 * @param {Object} obj - Object data
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} rayCount - Number of rays
 * @param {string} pattern - Emission pattern
 * @returns {Array} Ray start data
 */
function generateRaysForAngleObject(obj, opticalSystemRows, rayCount, pattern, annularRingCount, options: RayGenerationOptions = {}) {
    // console.log(`🔍 generateRaysForAngleObject called for object:`, obj);
    // console.log(`📊 Parameters: rayCount=${rayCount}, pattern=${pattern}`);
    
    const rayStartData: RayStartDataArray = [];
    rayStartData.annularRingsUsed = 0;
    rayStartData.selectedRingOverride = annularRingCount ?? 0;
    
    try {
        const forceAngleStopDiag = options?.angleStopDiag === true;
        // Use unified conjugate type detection
        const conjugateType = options?.conjugateType || detectConjugateType(opticalSystemRows, options);
        const isInfiniteObject = (conjugateType === 'infinite');
        
        
        const angleX = parseAngleInput(
            obj.xAngle ?? obj.objectAngleX ?? obj.xHeightAngle ?? obj.x ?? obj.angleX
        );
        const angleY = parseAngleInput(
            obj.yAngle ?? obj.objectAngleY ?? obj.yHeightAngle ?? obj.y ?? obj.angle ?? obj.angleY
        );
        emitAngleStopDiag('angle-generator-enter', {
            objectId: obj?.id ?? null,
            pattern,
            rayCount,
            conjugateType,
            isInfiniteObject,
            angleDeg: { x: Number(angleX) || 0, y: Number(angleY) || 0 },
        }, forceAngleStopDiag);
        const chiefDir = buildDirectionFromFieldAngles(angleX, angleY);
        const maxFieldDeg = Math.max(Math.abs(angleX), Math.abs(angleY));
        const isHighField = maxFieldDeg >= 15;
        const logHighFieldChiefRayFailure = (reason, details = {}) => {
            if (!isHighField) return;
            try {
                // Keep this warning on a dedicated switch so AL diagnostics can be enabled
                // without flooding the console during optimization.
                if (!(typeof window !== 'undefined' && (window as any).__COOPT_HIGHFIELD_CHIEFRAY_DIAG === true)) return;
            } catch (_) {
                return;
            }
            console.warn('⚠️ [HighFieldChiefRay] Render chief-ray solve issue', {
                reason,
                angleX,
                angleY,
                maxFieldDeg,
                objectId: obj?.id ?? null,
                ...details
            });
        };

        // Spot diagram (physical-vignetting mode) may request disabling origin optimization
        // to preserve angle↔chief correlation.
        const disableAngleObjectPositionOptimization = options?.disableAngleObjectPositionOptimization === true;
        const surfaceOrigins = (Array.isArray(options?.precomputedSurfaceOrigins) && options.precomputedSurfaceOrigins.length > 0)
            ? options.precomputedSurfaceOrigins
            : calculateSurfaceOrigins(opticalSystemRows);
        const stopSurfaceInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
        const stopSurfaceCenter3d = extractStopCenter3d(stopSurfaceInfo);
        const stopSurfaceIndex = Number.isInteger(stopSurfaceInfo?.index) ? stopSurfaceInfo.index : null;

        // IMPORTANT:
        // - Default: do NOT aim through stop unless explicitly requested.
        //   (Many callers set useChiefRayAnalysis without setting aimThroughStop.)
        // - For Angle objects, aiming-through-stop should adjust direction (chief ray),
        //   not shift the emission origin by geometric back-projection.
        const aimThroughStop = options?.aimThroughStop === true;
        let useChiefRayAnalysis = options?.useChiefRayAnalysis !== false;
        // For Angle objects, field angle defines the ray DIRECTION. To make the chief ray pass
        // through the stop center, we should solve/adjust the emission ORIGIN (not override
        // the direction to point at the stop center).
        // Default to enabled unless explicitly disabled.
        let allowStopBasedOriginSolve = options?.allowStopBasedOriginSolve !== false;
        const requestedOriginSolveTraceBackend = options?.originSolveTraceBackend;
        const originSolveTraceBackend = (() => {
            if (requestedOriginSolveTraceBackend === 'rust') return 'rust';
            if (requestedOriginSolveTraceBackend === 'ts') return 'ts';
            try {
                const rust = getRustRayTracingWasmSync();
                return rust ? 'rust' : 'ts';
            } catch (_) {
                return 'ts';
            }
        })();
        
        // 軸上オブジェクトかどうかを判定
        const isOnAxis = (Math.abs(angleX) < 1e-10 && Math.abs(angleY) < 1e-10);
        const forceChiefAnalysisForHighField = isHighField && isInfiniteObject && !isOnAxis;
        if (forceChiefAnalysisForHighField) {
            useChiefRayAnalysis = true;
            allowStopBasedOriginSolve = true;
        }
        let shouldRunChiefOriginAnalysis = (aimThroughStop || forceChiefAnalysisForHighField) && useChiefRayAnalysis;
        
        // 位置最適化の実行
        let optimizedPosition;
        if (disableAngleObjectPositionOptimization) {
            optimizedPosition = { x: 0.0, y: 0.0 };
        } else if (isOnAxis) {
            // 軸上オブジェクトの場合は確実に厳密な(0,0)から出射
            optimizedPosition = { x: 0.0, y: 0.0 };
        } else {
            // For infinite Angle objects:
            // - Nominal mode keeps emission near the axis (small heuristic).
            // - aimThroughStop mode relies on chief-ray analysis to find a valid origin; do not
            //   pre-shift the origin with a geometric back-projection that can clip early apertures.
            if (isInfiniteObject) {
                const maxOffset = 1.0;
                if (aimThroughStop) {
                    optimizedPosition = { x: 0.0, y: 0.0 };
                } else {
                    optimizedPosition = {
                        x: Math.tan(angleX * Math.PI / 180) * maxOffset,
                        y: Math.tan(angleY * Math.PI / 180) * maxOffset
                    };
                }
            } else {
                // Object距離に関わらず最適化計算を試みる
                optimizedPosition = optimizeAngleObjectPosition(angleX, angleY, opticalSystemRows, surfaceOrigins);
            }
        }
        
        // 最適化位置の妥当性チェック
        if (!isFinite(optimizedPosition.x) || !isFinite(optimizedPosition.y) ||
            Math.abs(optimizedPosition.x) > 1e6 || Math.abs(optimizedPosition.y) > 1e6) {
            console.warn('⚠️ Invalid optimized position detected, using origin');
            optimizedPosition = { x: 0.0, y: 0.0 };
        }
        
        const dirX = chiefDir.x;
        const dirY = chiefDir.y;
        const dirZ = chiefDir.z;
        
        // Get surface origins for object position calculation
        const firstSurfaceOrigin = surfaceOrigins[0] ? surfaceOrigins[0].origin : { x: 0, y: 0, z: 0 };
        const finiteObjectZ = Number.isFinite(firstSurfaceOrigin?.z) ? firstSurfaceOrigin.z : 0;
        
        // Use actual object-plane origin for finite objects; use objectRenderDistance for infinite objects
        const objectRow = opticalSystemRows && opticalSystemRows[0];
        const renderDist = (objectRow && Number.isFinite(Number(objectRow.objectRenderDistance)))
            ? Number(objectRow.objectRenderDistance)
            : 0;
        let objectZ = isInfiniteObject ? resolveInfiniteObjectZ(opticalSystemRows, renderDist, stopSurfaceCenter3d) : finiteObjectZ;
        const imageHeightChiefRayOverride = isInfiniteObject
            ? obj?.__cooptImageHeightSolve?.chiefRay
            : null;
        const hasImageHeightChiefRayOverride = !!(
            imageHeightChiefRayOverride
            && Number.isFinite(Number(imageHeightChiefRayOverride?.origin?.x))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.origin?.y))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.origin?.z))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.dir?.x))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.dir?.y))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.dir?.z))
        );
        if (hasImageHeightChiefRayOverride) {
            shouldRunChiefOriginAnalysis = false;
        }
        
        const surf = opticalSystemRows[0];

        const computeCenterSag = (position) => {
            if (!position || !surf || !surf.radius || surf.radius === "INF") {
                return 0;
            }
            const r = Math.sqrt(position.x * position.x + position.y * position.y);
            const asphericParams = {
                radius: parseFloat(surf.radius),
                conic: Number(surf.conic) || 0,
                coef1: Number(surf.coef1) || 0,
                coef2: Number(surf.coef2) || 0,
                coef3: Number(surf.coef3) || 0,
                coef4: Number(surf.coef4) || 0,
                coef5: Number(surf.coef5) || 0,
                coef6: Number(surf.coef6) || 0,
                coef7: Number(surf.coef7) || 0,
                coef8: Number(surf.coef8) || 0
            };
            const sag = asphericSurfaceZ(r, asphericParams, getAsphericModeFromSurfType(surf.surfType)) || 0;
            return sag;
        };
        const targetSurfaceIndex = Number.isInteger(options?.targetSurfaceIndex)
            ? options.targetSurfaceIndex
            : opticalSystemRows.length - 1;
        let chiefRayOrigin = null;
        let chiefRayAnalysisMeta = null;

        if (hasImageHeightChiefRayOverride) {
            chiefRayOrigin = {
                x: Number(imageHeightChiefRayOverride.origin.x),
                y: Number(imageHeightChiefRayOverride.origin.y),
                z: Number(imageHeightChiefRayOverride.origin.z),
            };
            optimizedPosition = { x: chiefRayOrigin.x, y: chiefRayOrigin.y };
            objectZ = chiefRayOrigin.z;
            chiefRayAnalysisMeta = { source: 'imageheight-solve-chiefRay' };
        }

        if (allowStopBasedOriginSolve && shouldRunChiefOriginAnalysis && !isOnAxis && stopSurfaceCenter3d && Number.isInteger(stopSurfaceIndex)) {
            try {
                const directionForAnalysis = { i: chiefDir.x, j: chiefDir.y, k: chiefDir.z };
                const wavelengthForSolve = options?.wavelength ?? options?.wavelengthUm ?? 0.5876;
                const cacheKey = buildChiefRayOriginCacheKey(
                    opticalSystemRows,
                    angleX,
                    angleY,
                    stopSurfaceCenter3d,
                    stopSurfaceIndex,
                    targetSurfaceIndex,
                    wavelengthForSolve
                );
                let analysisResult = null;
                if (cacheKey && chiefRayOriginSolveCache.has(cacheKey)) {
                    const cached = chiefRayOriginSolveCache.get(cacheKey);
                    analysisResult = cached?.origin || null;
                    chiefRayAnalysisMeta = cached?.meta || null;
                } else {
                    analysisResult = findInfiniteSystemChiefRayOrigin(
                        directionForAnalysis,
                        stopSurfaceCenter3d,
                        stopSurfaceIndex,
                        opticalSystemRows,
                        !!options?.debugChiefRay,
                        targetSurfaceIndex,
                        wavelengthForSolve
                    );
                    if (cacheKey && analysisResult && Number.isFinite(analysisResult.x) && Number.isFinite(analysisResult.y)) {
                        let metaToCache = null;
                        if (typeof window !== 'undefined' && window.lastChiefRayResult) {
                            metaToCache = { ...window.lastChiefRayResult };
                        }
                        chiefRayOriginSolveCache.set(cacheKey, {
                            origin: {
                                x: analysisResult.x,
                                y: analysisResult.y,
                                z: analysisResult.z
                            },
                            meta: metaToCache
                        });
                        if (chiefRayOriginSolveCache.size > 256) {
                            const firstKey = chiefRayOriginSolveCache.keys().next().value;
                            if (firstKey !== undefined) chiefRayOriginSolveCache.delete(firstKey);
                        }
                    }
                }
                if (analysisResult && Number.isFinite(analysisResult.x) && Number.isFinite(analysisResult.y)) {
                    chiefRayOrigin = analysisResult;
                    optimizedPosition = { x: analysisResult.x, y: analysisResult.y };
                    if (Number.isFinite(analysisResult.z)) {
                        objectZ = analysisResult.z;
                    }
                    if (!chiefRayAnalysisMeta && typeof window !== 'undefined' && window.lastChiefRayResult) {
                        chiefRayAnalysisMeta = { ...window.lastChiefRayResult };
                    }
                } else {
                    logHighFieldChiefRayFailure('analysis-invalid-result', {
                        stopSurfaceIndex,
                        hasStopCenter: !!stopSurfaceCenter3d
                    });
                }
            } catch (error) {
                console.error(`❌ [AngleRayRenderer] Failed to find chief ray origin for Object ${obj?.id || 'unknown'}:`, error);
                console.error(`   Object details:`, {
                    id: obj?.id,
                    angleX: angleX,
                    angleY: angleY
                });
                console.warn('⚠️ [AngleRayRenderer] Chief ray analysis failed, using fallback position:', error);
                logHighFieldChiefRayFailure('analysis-exception', {
                    stopSurfaceIndex,
                    hasStopCenter: !!stopSurfaceCenter3d,
                    error: (error && typeof error === 'object' && 'message' in error)
                        ? error.message
                        : String(error)
                });
            }
        } else {
            if (forceChiefAnalysisForHighField) {
                logHighFieldChiefRayFailure('analysis-skipped', {
                    allowStopBasedOriginSolve,
                    aimThroughStop,
                    useChiefRayAnalysis,
                    shouldRunChiefOriginAnalysis,
                    hasStopCenter: !!stopSurfaceCenter3d,
                    stopSurfaceIndex,
                    isInfiniteObject
                });
            }
        }

        // NOTE: We intentionally do not apply geometric back-projection fallback here.
        // If chief-ray analysis fails, forcing a straight-line origin often pushes the ray
        // far off-axis and causes earlier physical-aperture clipping.

        let centerSag = computeCenterSag(optimizedPosition);

        // IMPORTANT: never fall back to thickness as an aperture proxy (can be INF and causes massive oversampling/vignetting).
        const apertureRadius = (Number.isFinite(Number(surf.semidia)) && Number(surf.semidia) > 0)
            ? Number(surf.semidia)
            : 10;
        const stopConfig = resolveStopConfig(opticalSystemRows, surfaceOrigins, objectZ + (Number(surf.thickness) || 10), apertureRadius);
        let stopRadiusLimited = (Number.isFinite(Number(stopConfig?.radius)) && Number(stopConfig.radius) > 0)
            ? Number(stopConfig.radius)
            : apertureRadius;
        if (!isInfiniteObject) {
            stopRadiusLimited = Math.min(stopRadiusLimited, apertureRadius);
        }
        const extApLim = Number(options?.apertureLimitMm ?? options?.apertureLimit);
        if (Number.isFinite(extApLim) && extApLim > 0) {
            stopRadiusLimited = Math.min(stopRadiusLimited, extApLim);
        }
        const stopCenter = stopConfig.center || { x: 0, y: 0 };
        let startZ = objectZ + centerSag;
        let stopDeltaZ = stopConfig.z - startZ;
        let canAimAtStop = Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;
        let usedTargetReachFallback = false;

        if (isInfiniteObject && aimThroughStop && isHighField && Number.isInteger(targetSurfaceIndex)) {
            const wavelengthForTrace = options?.wavelength ?? options?.wavelengthUm ?? 0.5876;
            const reachesTarget = (origin) => !!origin && !!traceRayHitPointForRender(
                    opticalSystemRows,
                    {
                        pos: origin,
                        dir: { x: chiefDir.x, y: chiefDir.y, z: chiefDir.z },
                        wavelength: wavelengthForTrace
                    },
                    1.0,
                    targetSurfaceIndex,
                    originSolveTraceBackend
                );

            if (!reachesTarget(chiefRayOrigin)) {
                const safeDirZ = Math.abs(chiefDir.z) > 1e-12 ? chiefDir.z : 1e-12;
                const dzToStop = stopSurfaceCenter3d.z - objectZ;
                const geometricOrigin = {
                    x: stopSurfaceCenter3d.x - (chiefDir.x / safeDirZ) * dzToStop,
                    y: stopSurfaceCenter3d.y - (chiefDir.y / safeDirZ) * dzToStop,
                    z: objectZ
                };
                const candidateStep = Math.max(stopRadiusLimited, 1e-6);
                const candidates = [];
                for (let offsetX = -4; offsetX <= 4; offsetX++) {
                    for (let offsetY = -4; offsetY <= 4; offsetY++) {
                        candidates.push({
                            x: geometricOrigin.x + offsetX * candidateStep,
                            y: geometricOrigin.y + offsetY * candidateStep,
                            z: geometricOrigin.z,
                            offsetDistance: Math.hypot(offsetX, offsetY)
                        });
                    }
                }
                const candidateRays = candidates.map((candidate) => ({
                    pos: { x: candidate.x, y: candidate.y, z: candidate.z },
                    dir: { x: chiefDir.x, y: chiefDir.y, z: chiefDir.z },
                    wavelength: wavelengthForTrace
                }));
                const targetHits = traceRayHitPointBatchForRender(
                    opticalSystemRows,
                    candidateRays,
                    1.0,
                    targetSurfaceIndex,
                    originSolveTraceBackend
                );
                const targetCandidate = candidates
                    .filter((_, index) => !!targetHits?.[index])
                    .sort((a, b) => a.offsetDistance - b.offsetDistance)[0];

                if (targetCandidate) {
                    chiefRayOrigin = {
                        x: targetCandidate.x,
                        y: targetCandidate.y,
                        z: targetCandidate.z
                    };
                    optimizedPosition = { x: targetCandidate.x, y: targetCandidate.y };
                    objectZ = targetCandidate.z;
                    centerSag = computeCenterSag(optimizedPosition);
                    startZ = objectZ + centerSag;
                    stopDeltaZ = stopConfig.z - startZ;
                    canAimAtStop = Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;
                    usedTargetReachFallback = true;
                }
            }
        }

        // Optional OPD-style origin refinement (disabled by default).
        if (allowStopBasedOriginSolve && options?.skipStopPointRefine !== true && aimThroughStop && !isOnAxis && stopSurfaceCenter3d && Number.isInteger(stopSurfaceIndex)
            && !hasImageHeightChiefRayOverride
            && !usedTargetReachFallback
            && chiefRayOrigin && Number.isFinite(chiefRayOrigin.x) && Number.isFinite(chiefRayOrigin.y) && Number.isFinite(chiefRayOrigin.z)) {
            const refined = solveRayOriginToStopPointFast(
                chiefRayOrigin,
                chiefDir,
                stopSurfaceCenter3d,
                stopSurfaceIndex,
                opticalSystemRows,
                options?.wavelength ?? options?.wavelengthUm ?? 0.5876,
                originSolveTraceBackend
            );
            if (refined && Number.isFinite(refined.x) && Number.isFinite(refined.y) && Number.isFinite(refined.z)) {
                chiefRayOrigin = refined;
                optimizedPosition = { x: refined.x, y: refined.y };
                objectZ = refined.z;
                centerSag = computeCenterSag(optimizedPosition);
                startZ = objectZ + centerSag;
                stopDeltaZ = stopConfig.z - startZ;
                canAimAtStop = Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;
            } else {
                logHighFieldChiefRayFailure('origin-refine-failed', {
                    stopSurfaceIndex,
                    stopDeltaZ
                });
            }
        }

        if (!chiefRayOrigin) {
            chiefRayOrigin = { x: optimizedPosition.x, y: optimizedPosition.y, z: startZ };
        }

        const emissionOrigin = {
            x: Number.isFinite(chiefRayOrigin?.x) ? chiefRayOrigin.x : optimizedPosition.x,
            y: Number.isFinite(chiefRayOrigin?.y) ? chiefRayOrigin.y : optimizedPosition.y,
            z: Number.isFinite(chiefRayOrigin?.z) ? chiefRayOrigin.z : startZ
        };
        const chiefDirOverride = hasImageHeightChiefRayOverride
            ? {
                x: Number(imageHeightChiefRayOverride.dir.x),
                y: Number(imageHeightChiefRayOverride.dir.y),
                z: Number(imageHeightChiefRayOverride.dir.z),
            }
            : null;

        // Keep direction defined by the field angle by default.
        // For ordinary Angle objects, aim-through-stop must solve the emission origin only;
        // overriding direction here collapses the requested field angle and makes Angle edits
        // appear ineffective. ImageHeight is the only mode that intentionally carries an
        // explicit chief-ray direction override from its solve result.
        let chiefDirUsed = chiefDirOverride || chiefDir;
        if (chiefDirOverride && aimThroughStop && chiefRayOrigin && stopSurfaceCenter3d && Number.isInteger(stopSurfaceIndex)) {
            const useStrictChiefDirectionSolve = options?.strictChiefDirectionSolve === true;
            const chiefDirectionTraceBackend = originSolveTraceBackend;
            const refinedChiefDir = solveRayDirectionToStopPointFast(
                chiefRayOrigin,
                stopSurfaceCenter3d,
                stopSurfaceIndex,
                opticalSystemRows,
                options?.wavelength ?? options?.wavelengthUm ?? 0.5876,
                chiefDirectionTraceBackend,
                useStrictChiefDirectionSolve
                    ? {
                        toleranceMm: 1e-4,
                        maxIter: 20,
                        eps: 1e-5,
                        maxNewtonStep: 0.05,
                    }
                    : undefined
            );
            if (refinedChiefDir && Number.isFinite(refinedChiefDir.x) && Number.isFinite(refinedChiefDir.y) && Number.isFinite(refinedChiefDir.z)) {
                chiefDirUsed = refinedChiefDir;
            } else if (isHighField) {
                logHighFieldChiefRayFailure('direction-refine-failed', {
                    stopSurfaceIndex,
                    hasChiefOrigin: !!chiefRayOrigin,
                    hasStopCenter: !!stopSurfaceCenter3d,
                });
            }
        }

        const basis = buildPerpendicularBasis(chiefDirUsed);
        const unitChief = basis.dir;
        const uAxis = basis.u;
        const vAxis = basis.v;

        const shouldSolveOriginsThroughStop =
            aimThroughStop
            && isInfiniteObject
            && Number.isInteger(stopConfig?.index);
        const stopPlaneCenter3d = (Number.isFinite(stopConfig?.center?.x) && Number.isFinite(stopConfig?.center?.y) && Number.isFinite(stopConfig?.z))
            ? { x: stopConfig.center.x, y: stopConfig.center.y, z: stopConfig.z }
            : null;
        const stopPlaneRotation = (Number.isInteger(stopConfig?.index) && surfaceOrigins?.[stopConfig.index]?.rotationMatrix)
            ? surfaceOrigins[stopConfig.index].rotationMatrix
            : null;
        const stopPlaneU = normalizeVector3(
            applyRotationMatrixToVector(stopPlaneRotation, { x: 1, y: 0, z: 0 }),
            { x: 1, y: 0, z: 0 }
        );
        const stopPlaneV = normalizeVector3(
            applyRotationMatrixToVector(stopPlaneRotation, { x: 0, y: 1, z: 0 }),
            { x: 0, y: 1, z: 0 }
        );
        const exactCrossType = options?.crossType === 'vertical' || options?.crossType === 'horizontal' || options?.crossType === 'both'
            ? options.crossType
            : 'both';
        const useDisplayAxisAlignedSampling = isInfiniteObject
            && options?.exactCrossBeamSampling === true
            && options?.displayAxisAlignedSampling === true
            && (exactCrossType === 'vertical' || exactCrossType === 'horizontal');
        let startOffsetUAxis = uAxis;
        let startOffsetVAxis = vAxis;
        let targetOffsetUAxis = stopPlaneU;
        let targetOffsetVAxis = stopPlaneV;

        // Infinite-angle with preserved chief-normal emission plane:
        // compensate projection shrink so requested pupil offsets map to stop-plane offsets 1:1.
        // Without this, stop-plane coordinates shrink by a fixed factor (|proj(stopAxis on chief plane)|).
        if (isInfiniteObject && options?.preserveChiefNormalEmissionPlane === true) {
            const buildCompensatedStartAxis = (stopAxis, fallbackAxis) => {
                const projectedUnit = projectVectorOntoPlane(stopAxis, unitChief, fallbackAxis);
                if (!projectedUnit) return fallbackAxis;
                return projectedUnit;
            };

            startOffsetUAxis = buildCompensatedStartAxis(stopPlaneU, uAxis);
            startOffsetVAxis = buildCompensatedStartAxis(stopPlaneV, vAxis);
        }

        if (useDisplayAxisAlignedSampling) {
            const stopPlaneNormal = normalizeVector3(crossProduct(stopPlaneU, stopPlaneV), unitChief);
            if (exactCrossType === 'horizontal') {
                const displayAxis = { x: 1, y: 0, z: 0 };
                startOffsetUAxis = projectVectorOntoPlane(displayAxis, unitChief, uAxis);
                targetOffsetUAxis = projectVectorOntoPlane(displayAxis, stopPlaneNormal, stopPlaneU);
            } else if (exactCrossType === 'vertical') {
                const displayAxis = { x: 0, y: 1, z: 0 };
                startOffsetVAxis = projectVectorOntoPlane(displayAxis, unitChief, vAxis);
                targetOffsetVAxis = projectVectorOntoPlane(displayAxis, stopPlaneNormal, stopPlaneV);
            }
        }

        rayStartData.emissionBasis = {
            origin: { ...emissionOrigin },
            u: uAxis,
            v: vAxis,
            stopRadius: stopRadiusLimited,
            stopIndex: (Number.isInteger(stopConfig?.index) ? Number(stopConfig.index) : null),
            stopZ: (Number.isFinite(Number(stopConfig?.z)) ? Number(stopConfig.z) : null),
            stopCenter: (stopConfig?.center && typeof stopConfig.center === 'object')
                ? { x: Number(stopConfig.center.x), y: Number(stopConfig.center.y) }
                : null,
            stopPlaneU: stopPlaneU ? { x: Number(stopPlaneU.x), y: Number(stopPlaneU.y), z: Number(stopPlaneU.z) } : null,
            stopPlaneV: stopPlaneV ? { x: Number(stopPlaneV.x), y: Number(stopPlaneV.y), z: Number(stopPlaneV.z) } : null
        };

        const pushRay = (offsetU, offsetV, dirVector, description) => {
            const startP = {
                x: emissionOrigin.x + offsetU * startOffsetUAxis.x + offsetV * startOffsetVAxis.x,
                y: emissionOrigin.y + offsetU * startOffsetUAxis.y + offsetV * startOffsetVAxis.y,
                z: emissionOrigin.z + offsetU * startOffsetUAxis.z + offsetV * startOffsetVAxis.z
            };
            rayStartData.push({
                startP,
                dir: dirVector,
                description,
                isChief: Math.abs(Number(offsetU) || 0) <= 1e-12 && Math.abs(Number(offsetV) || 0) <= 1e-12,
                planeCoords: { u: offsetU, v: offsetV }
            });
        };

        const anchorStartToChiefEmissionPlane = (point) => {
            if (!(isInfiniteObject && options?.preserveChiefNormalEmissionPlane === true)) return point;
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return point;
            const dx = point.x - emissionOrigin.x;
            const dy = point.y - emissionOrigin.y;
            const dz = point.z - emissionOrigin.z;
            const deltaAlongChief = dx * unitChief.x + dy * unitChief.y + dz * unitChief.z;
            return {
                x: point.x - deltaAlongChief * unitChief.x,
                y: point.y - deltaAlongChief * unitChief.y,
                z: point.z - deltaAlongChief * unitChief.z,
            };
        };

        const pushRayWithSolvedOriginIfNeeded = (offsetU, offsetV, dirVector, description) => {
            let startP = {
                x: emissionOrigin.x + offsetU * startOffsetUAxis.x + offsetV * startOffsetVAxis.x,
                y: emissionOrigin.y + offsetU * startOffsetUAxis.y + offsetV * startOffsetVAxis.y,
                z: emissionOrigin.z + offsetU * startOffsetUAxis.z + offsetV * startOffsetVAxis.z
            };

            if (shouldSolveOriginsThroughStop && stopPlaneCenter3d && Number.isInteger(stopConfig?.index)) {
                const targetPoint = {
                    x: stopPlaneCenter3d.x + offsetU * targetOffsetUAxis.x + offsetV * targetOffsetVAxis.x,
                    y: stopPlaneCenter3d.y + offsetU * targetOffsetUAxis.y + offsetV * targetOffsetVAxis.y,
                    z: stopPlaneCenter3d.z + offsetU * targetOffsetUAxis.z + offsetV * targetOffsetVAxis.z
                };
                const refined = solveRayOriginToStopPointFast(
                    startP,
                    dirVector,
                    targetPoint,
                    stopConfig.index,
                    opticalSystemRows,
                    options?.wavelength ?? options?.wavelengthUm ?? 0.5876,
                    originSolveTraceBackend
                );
                if (refined && Number.isFinite(refined.x) && Number.isFinite(refined.y) && Number.isFinite(refined.z)) {
                    startP = anchorStartToChiefEmissionPlane(refined);
                }
            }

            rayStartData.push({
                startP,
                dir: dirVector,
                description,
                isChief: Math.abs(Number(offsetU) || 0) <= 1e-12 && Math.abs(Number(offsetV) || 0) <= 1e-12,
                planeCoords: { u: offsetU, v: offsetV }
            });
        };

        try {
            const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
            if (RAYTRACE_DEBUG) {
                console.log(`🎯 Angle object光線生成: 角度=(${angleX}°, ${angleY}°), isOnAxis=${isOnAxis}, isInfinite=${isInfiniteObject}, 位置=(${optimizedPosition.x.toFixed(8)}, ${optimizedPosition.y.toFixed(8)})`);
            }
        } catch (_) {}

        if (rayCount === 1) {
            const chiefDescription = `Chief angle ray (${angleX}°, ${angleY}°) from ${isOnAxis ? 'exact on-axis (0,0)' : 'optimized'} position`;
            if (shouldSolveOriginsThroughStop) {
                pushRayWithSolvedOriginIfNeeded(0, 0, unitChief, chiefDescription);
            } else {
                pushRay(0, 0, unitChief, chiefDescription);
            }
        } else if (pattern === 'grid' || pattern === 'annular') {
            // 十字線の範囲を検出
            let crossExtentX = 0;
            let crossExtentY = 0;
            
            if (!(options && options.disableCrossExtent) && typeof window !== 'undefined' && Array.isArray(window.currentDrawCrossRays) && window.currentDrawCrossRays.length > 0) {
                const crossRays = window.currentDrawCrossRays;
                crossRays.forEach(ray => {
                    if (ray && ray.startPoint) {
                        const dx = Math.abs(ray.startPoint.x - (chiefRayOrigin?.x || 0));
                        const dy = Math.abs(ray.startPoint.y - (chiefRayOrigin?.y || 0));
                        crossExtentX = Math.max(crossExtentX, dx);
                        crossExtentY = Math.max(crossExtentY, dy);
                    }
                });
            }
            
            // 十字線の長辺を優先、なければStop半径を使用
            let effectiveRadius;
            if (crossExtentX > 0 || crossExtentY > 0) {
                effectiveRadius = Math.max(crossExtentX, crossExtentY);
                // Clamp to the physical stop radius when available; draw-cross rays may include other objects/configs.
                if (Number.isFinite(stopRadiusLimited) && stopRadiusLimited > 0) {
                    effectiveRadius = Math.min(effectiveRadius, stopRadiusLimited);
                }
                console.log(`🔍 [Cross-based extent] X=${crossExtentX.toFixed(6)}, Y=${crossExtentY.toFixed(6)}, effectiveRadius=${effectiveRadius.toFixed(6)}`);
            } else {
                effectiveRadius = Number.isFinite(stopRadiusLimited) && stopRadiusLimited > 0
                    ? (isInfiniteObject ? stopRadiusLimited : Math.min(stopRadiusLimited, apertureRadius))
                    : apertureRadius;
            }
            
            const pupilScale = (Number.isFinite(Number(options?.pupilScale)) && Number(options.pupilScale) > 0)
                ? Number(options.pupilScale)
                : 1;
            const insideScale = 1;
            const halfExtent = Math.max(1e-6, effectiveRadius * pupilScale * insideScale);
            // Apply exact cross sampling for both finite and infinite systems.
            // Limiting this to infinite systems made finite Angle rendering fall back to
            // annular/grid sampling, which uses inward ring scaling and appears as a
            // constant-factor shrink inside the pupil.
            const useExactCrossBeamSampling = options?.exactCrossBeamSampling === true;
            const crossType = exactCrossType;
            const stopSamplingRadius = (() => {
                let radius = Number.isFinite(Number(stopConfig?.radius)) && Number(stopConfig.radius) > 0
                    ? Number(stopConfig.radius)
                    : effectiveRadius;
                if (Number.isFinite(extApLim) && extApLim > 0) {
                    radius = Math.min(radius, extApLim);
                }
                return Math.max(1e-6, radius);
            })();
            const halfExtentForExactCross = Math.max(1e-6, stopSamplingRadius * pupilScale * insideScale);
            const offsets = useExactCrossBeamSampling
                ? generateUniformCrossOffsets(rayCount, halfExtentForExactCross, crossType)
                : (pattern === 'annular'
                    ? generateAnnularOffsets(rayCount, halfExtent, annularRingCount || 3)
                    : generateCenteredGridOffsets(rayCount, halfExtent));

            if (isInfiniteObject) {
                const dot = (a, b) => Number(a?.x || 0) * Number(b?.x || 0) + Number(a?.y || 0) * Number(b?.y || 0) + Number(a?.z || 0) * Number(b?.z || 0);
                const stopU = stopPlaneU || { x: 1, y: 0, z: 0 };
                const stopV = stopPlaneV || { x: 0, y: 1, z: 0 };
                const center = stopPlaneCenter3d || { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                const preview = offsets.slice(0, Math.min(8, offsets.length)).map((coord) => {
                    const targetPoint = {
                        x: center.x + coord.offsetU * targetOffsetUAxis.x + coord.offsetV * targetOffsetVAxis.x,
                        y: center.y + coord.offsetU * targetOffsetUAxis.y + coord.offsetV * targetOffsetVAxis.y,
                        z: center.z + coord.offsetU * targetOffsetUAxis.z + coord.offsetV * targetOffsetVAxis.z,
                    };
                    const dv = {
                        x: targetPoint.x - center.x,
                        y: targetPoint.y - center.y,
                        z: targetPoint.z - center.z,
                    };
                    const projU = dot(dv, stopU);
                    const projV = dot(dv, stopV);
                    const expectedR = Math.hypot(Number(coord.offsetU) || 0, Number(coord.offsetV) || 0);
                    const projectedR = Math.hypot(projU, projV);
                    return {
                        reqU: Number(coord.offsetU) || 0,
                        reqV: Number(coord.offsetV) || 0,
                        projU,
                        projV,
                        reqR: expectedR,
                        projR: projectedR,
                        ratio: expectedR > 1e-9 ? projectedR / expectedR : null,
                    };
                });
                const maxReqR = offsets.reduce((m, c) => Math.max(m, Math.hypot(Number(c?.offsetU) || 0, Number(c?.offsetV) || 0)), 0);
                const maxReqAbsU = offsets.reduce((m, c) => Math.max(m, Math.abs(Number(c?.offsetU) || 0)), 0);
                const maxReqAbsV = offsets.reduce((m, c) => Math.max(m, Math.abs(Number(c?.offsetV) || 0)), 0);
                emitAngleStopDiag('infinite-angle-sampling', {
                    objectId: obj?.id ?? null,
                    angleDeg: { x: Number(angleX) || 0, y: Number(angleY) || 0 },
                    pattern,
                    rayCount,
                    useExactCrossBeamSampling,
                    crossType,
                    radii: {
                        stopConfigRadius: Number(stopConfig?.radius) || null,
                        apertureRadius: Number(apertureRadius) || null,
                        stopRadiusLimited: Number(stopRadiusLimited) || null,
                        effectiveRadius: Number(effectiveRadius) || null,
                        stopSamplingRadius: Number(stopSamplingRadius) || null,
                        pupilScale: Number(pupilScale) || null,
                        halfExtent: Number(halfExtent) || null,
                        halfExtentForExactCross: Number(halfExtentForExactCross) || null,
                    },
                    basis: {
                        stopUNorm: Math.hypot(Number(stopU.x) || 0, Number(stopU.y) || 0, Number(stopU.z) || 0),
                        stopVNorm: Math.hypot(Number(stopV.x) || 0, Number(stopV.y) || 0, Number(stopV.z) || 0),
                        stopUdotV: dot(stopU, stopV),
                        targetUNorm: Math.hypot(Number(targetOffsetUAxis?.x) || 0, Number(targetOffsetUAxis?.y) || 0, Number(targetOffsetUAxis?.z) || 0),
                        targetVNorm: Math.hypot(Number(targetOffsetVAxis?.x) || 0, Number(targetOffsetVAxis?.y) || 0, Number(targetOffsetVAxis?.z) || 0),
                        targetUdotV: dot(targetOffsetUAxis || { x: 1, y: 0, z: 0 }, targetOffsetVAxis || { x: 0, y: 1, z: 0 }),
                    },
                    stats: {
                        offsetCount: offsets.length,
                        maxReqR,
                        maxReqAbsU,
                        maxReqAbsV,
                    },
                    preview,
                }, forceAngleStopDiag);
            }

            const canUseRustParallelStarts = !shouldSolveOriginsThroughStop && (isInfiniteObject || !canAimAtStop);
            const startsFromRust = canUseRustParallelStarts
                ? generateParallelStartPointsViaRust(emissionOrigin, uAxis, vAxis, offsets)
                : null;

            if (Array.isArray(startsFromRust) && startsFromRust.length === offsets.length && canUseRustParallelStarts) {
                startsFromRust.forEach((entry, index) => {
                    const dirVector = unitChief;
                    rayStartData.push({
                        startP: entry.startP,
                        dir: dirVector,
                        description: `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`,
                        planeCoords: { u: entry.offsetU, v: entry.offsetV }
                    });
                });
            } else {
            const solvedOriginsBatch = (() => {
                if (!(shouldSolveOriginsThroughStop && stopPlaneCenter3d && Number.isInteger(stopConfig?.index))) {
                    return null;
                }
                const initialOrigins = offsets.map((coord) => ({
                    x: emissionOrigin.x + coord.offsetU * startOffsetUAxis.x + coord.offsetV * startOffsetVAxis.x,
                    y: emissionOrigin.y + coord.offsetU * startOffsetUAxis.y + coord.offsetV * startOffsetVAxis.y,
                    z: emissionOrigin.z + coord.offsetU * startOffsetUAxis.z + coord.offsetV * startOffsetVAxis.z
                }));
                const dirVectors = offsets.map(() => ({ x: unitChief.x, y: unitChief.y, z: unitChief.z }));
                const targetPoints = offsets.map((coord) => ({
                    x: stopPlaneCenter3d.x + coord.offsetU * targetOffsetUAxis.x + coord.offsetV * targetOffsetVAxis.x,
                    y: stopPlaneCenter3d.y + coord.offsetU * targetOffsetUAxis.y + coord.offsetV * targetOffsetVAxis.y,
                    z: stopPlaneCenter3d.z + coord.offsetU * targetOffsetUAxis.z + coord.offsetV * targetOffsetVAxis.z
                }));
                return solveRayOriginsToStopPointsFastBatch(
                    initialOrigins,
                    dirVectors,
                    targetPoints,
                    stopConfig.index,
                    opticalSystemRows,
                    options?.wavelength ?? options?.wavelengthUm ?? 0.5876,
                    originSolveTraceBackend
                );
            })();

            const useExactStopTargetedInfiniteStarts =
                isInfiniteObject
                && options?.preserveChiefNormalEmissionPlane === true
                && !!stopPlaneCenter3d
                && !!targetOffsetUAxis
                && !!targetOffsetVAxis;
            offsets.forEach((coord, index) => {
                let dirVector = unitChief;
                const isCenterOffset = Math.abs(Number(coord.offsetU) || 0) <= 1e-12 && Math.abs(Number(coord.offsetV) || 0) <= 1e-12;
                
                // 無限遠物体でない場合のみ、Stop面への狙いを計算
                if (!isInfiniteObject && canAimAtStop) {
                    const targetOffsetU = coord.offsetU;
                    const targetOffsetV = coord.offsetV;
                    const stopPlaneCenter = stopPlaneCenter3d || { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                    const stopPlaneUAxis = stopPlaneU || { x: 1, y: 0, z: 0 };
                    const stopPlaneVAxis = stopPlaneV || { x: 0, y: 1, z: 0 };
                    const targetPoint = {
                        x: stopPlaneCenter.x + targetOffsetU * stopPlaneUAxis.x + targetOffsetV * stopPlaneVAxis.x,
                        y: stopPlaneCenter.y + targetOffsetU * stopPlaneUAxis.y + targetOffsetV * stopPlaneVAxis.y,
                        z: stopPlaneCenter.z + targetOffsetU * stopPlaneUAxis.z + targetOffsetV * stopPlaneVAxis.z
                    };
                    const startPoint = {
                        x: emissionOrigin.x + coord.offsetU * uAxis.x + coord.offsetV * vAxis.x,
                        y: emissionOrigin.y + coord.offsetU * uAxis.y + coord.offsetV * vAxis.y,
                        z: emissionOrigin.z + coord.offsetU * uAxis.z + coord.offsetV * vAxis.z
                    };
                    const deltaX = targetPoint.x - startPoint.x;
                    const deltaY = targetPoint.y - startPoint.y;
                    const deltaZ = targetPoint.z - startPoint.z;
                    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) || 1;
                    dirVector = {
                        x: deltaX / length,
                        y: deltaY / length,
                        z: deltaZ / length
                    };
                }
                if (shouldSolveOriginsThroughStop) {
                    if (isCenterOffset) {
                        rayStartData.push({
                            startP: { x: emissionOrigin.x, y: emissionOrigin.y, z: emissionOrigin.z },
                            dir: unitChief,
                            description: `${pattern === 'annular' ? 'Annular' : 'Grid'} chief angle ray`,
                            isChief: true,
                            planeCoords: { u: 0, v: 0 }
                        });
                        return;
                    }
                    const solved = Array.isArray(solvedOriginsBatch) ? solvedOriginsBatch[index] : null;
                    if (solved && Number.isFinite(solved.x) && Number.isFinite(solved.y) && Number.isFinite(solved.z)) {
                        const anchoredSolved = anchorStartToChiefEmissionPlane({ x: solved.x, y: solved.y, z: solved.z });
                        rayStartData.push({
                            startP: { x: anchoredSolved.x, y: anchoredSolved.y, z: anchoredSolved.z },
                            dir: unitChief,
                            description: `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`,
                            isChief: false,
                            planeCoords: { u: coord.offsetU, v: coord.offsetV }
                        });
                    } else {
                        pushRayWithSolvedOriginIfNeeded(coord.offsetU, coord.offsetV, unitChief, `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`);
                    }
                } else {
                    if (useExactStopTargetedInfiniteStarts) {
                        const targetPoint = {
                            x: stopPlaneCenter3d.x + coord.offsetU * targetOffsetUAxis.x + coord.offsetV * targetOffsetVAxis.x,
                            y: stopPlaneCenter3d.y + coord.offsetU * targetOffsetUAxis.y + coord.offsetV * targetOffsetVAxis.y,
                            z: stopPlaneCenter3d.z + coord.offsetU * targetOffsetUAxis.z + coord.offsetV * targetOffsetVAxis.z
                        };
                        const relX = targetPoint.x - emissionOrigin.x;
                        const relY = targetPoint.y - emissionOrigin.y;
                        const relZ = targetPoint.z - emissionOrigin.z;
                        const lambda = relX * unitChief.x + relY * unitChief.y + relZ * unitChief.z;
                        const startP = {
                            x: targetPoint.x - lambda * unitChief.x,
                            y: targetPoint.y - lambda * unitChief.y,
                            z: targetPoint.z - lambda * unitChief.z,
                        };
                        rayStartData.push({
                            startP,
                            dir: unitChief,
                            description: `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`,
                            isChief: isCenterOffset,
                            planeCoords: { u: coord.offsetU, v: coord.offsetV }
                        });
                    } else {
                        pushRay(coord.offsetU, coord.offsetV, dirVector, `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`);
                    }
                }
            });
            }
        } else {
            console.log(`🔍 [SPOT DIAGRAM] Using ANNULAR pattern, rayCount=${rayCount}`);
            // Annular pattern
            // Chief ray
            pushRay(0, 0, unitChief, `Chief angle ray from optimized position`);
            let raysGenerated = 1;
            const remainingRays = Math.max(rayCount - 1, 0);

            if (remainingRays > 0) {
                let numRings;
                if (annularRingCount) {
                    // Use the explicit ring count parameter
                    numRings = Math.min(annularRingCount, remainingRays);
                } else {
                    // Auto-calculate based on remaining rays (fallback when no explicit count)
                    if (remainingRays <= 6) numRings = 1;
                    else if (remainingRays <= 15) numRings = 2;
                    else if (remainingRays <= 30) numRings = 3;
                    else if (remainingRays <= 50) numRings = 4;
                    else if (remainingRays <= 80) numRings = 5;
                    else if (remainingRays <= 120) numRings = 6;
                    else if (remainingRays <= 170) numRings = 7;
                    else numRings = 8;
                }

                const ringScale = numRings === 1 ? 1 : (numRings / (numRings + 1)); // keep rings slightly inside first semidia
                const maxStopRadius = Math.max(0, Math.min(stopRadiusLimited * ringScale, apertureRadius * ringScale));
                const startRadiusLimit = Math.min(apertureRadius * ringScale, maxStopRadius > 0 ? maxStopRadius : apertureRadius * ringScale);
                const canUseStopTarget = canAimAtStop && maxStopRadius > 0;
                const baseAngleOffset = (Math.PI / numRings) * 0.5; // stagger rings for symmetry

                for (let ringIndex = 1; ringIndex <= numRings && raysGenerated < rayCount; ringIndex++) {
                    const ringsLeft = numRings - ringIndex + 1;
                    const raysAvailable = rayCount - raysGenerated;
                    let raysInThisRing = Math.max(3, Math.floor(raysAvailable / ringsLeft));
                    if (raysInThisRing > raysAvailable) raysInThisRing = raysAvailable;
                    if (ringIndex === numRings) raysInThisRing = raysAvailable;
                    const targetRadius = (ringIndex / numRings) * (canUseStopTarget ? maxStopRadius : apertureRadius * ringScale);
                    const startRadius = (ringIndex / numRings) * startRadiusLimit;
                    const baseAngle = (ringIndex % 2 === 0 ? Math.PI / raysInThisRing : 0) + baseAngleOffset * ringIndex;

                    for (let i = 0; i < raysInThisRing && raysGenerated < rayCount; i++) {
                        const angle = baseAngle + (2 * Math.PI * i) / raysInThisRing;
                        const offsetU = startRadius * Math.cos(angle);
                        const offsetV = startRadius * Math.sin(angle);

                        let dirVector = unitChief;
                        if (canUseStopTarget) {
                            const targetOffsetU = targetRadius * Math.cos(angle);
                            const targetOffsetV = targetRadius * Math.sin(angle);
                            const stopPlaneCenter = stopPlaneCenter3d || { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
                            const stopPlaneUAxis = stopPlaneU || { x: 1, y: 0, z: 0 };
                            const stopPlaneVAxis = stopPlaneV || { x: 0, y: 1, z: 0 };
                            const startPoint = {
                                x: emissionOrigin.x + offsetU * uAxis.x + offsetV * vAxis.x,
                                y: emissionOrigin.y + offsetU * uAxis.y + offsetV * vAxis.y,
                                z: emissionOrigin.z + offsetU * uAxis.z + offsetV * vAxis.z
                            };
                            const targetPoint = {
                                x: stopPlaneCenter.x + targetOffsetU * stopPlaneUAxis.x + targetOffsetV * stopPlaneVAxis.x,
                                y: stopPlaneCenter.y + targetOffsetU * stopPlaneUAxis.y + targetOffsetV * stopPlaneVAxis.y,
                                z: stopPlaneCenter.z + targetOffsetU * stopPlaneUAxis.z + targetOffsetV * stopPlaneVAxis.z
                            };
                            const deltaX = targetPoint.x - startPoint.x;
                            const deltaY = targetPoint.y - startPoint.y;
                            const deltaZ = targetPoint.z - startPoint.z;
                            const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) || 1;
                            dirVector = {
                                x: deltaX / length,
                                y: deltaY / length,
                                z: deltaZ / length
                            };
                        }

                        pushRay(offsetU, offsetV, dirVector, `Ring ${ringIndex} angle ray at U=${offsetU.toFixed(3)} V=${offsetV.toFixed(3)}`);
                        raysGenerated++;
                    }
                }
                rayStartData.annularRingsUsed = numRings;
            }
        }
        if (chiefDirUsed && Number.isFinite(chiefDirUsed.x) && Number.isFinite(chiefDirUsed.y) && Number.isFinite(chiefDirUsed.z)) {
            rayStartData.expectedChiefDir = { x: chiefDirUsed.x, y: chiefDirUsed.y, z: chiefDirUsed.z };
        }
        if (chiefDir && Number.isFinite(chiefDir.x) && Number.isFinite(chiefDir.y) && Number.isFinite(chiefDir.z)) {
            rayStartData.nominalFieldDir = { x: chiefDir.x, y: chiefDir.y, z: chiefDir.z };
        }
        rayStartData.expectedChiefOrigin = chiefRayOrigin ? { ...chiefRayOrigin } : { x: emissionOrigin.x, y: emissionOrigin.y, z: emissionOrigin.z };
        if (chiefRayAnalysisMeta) {
            rayStartData.chiefRayAnalysis = chiefRayAnalysisMeta;
        }

        // console.log(`✅ Generated ${rayStartData.length} rays for Angle object`);

    } catch (error) {
        console.error('❌ Error generating rays for Angle object:', error);
    }
    
    return rayStartData;
}

/**
 * Generate rays for Rectangle objects
 * @param {Object} obj - Object data
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} rayCount - Number of rays
 * @param {string} pattern - Emission pattern
 * @param {Object} apertureLimit - Aperture limit
 * @returns {Array} Ray start data
 */
function generateRaysForRectangleObject(obj, opticalSystemRows, rayCount, pattern, apertureLimit, annularRingCount, wavelengthUm = 0.5876, options: RayGenerationOptions = {}) {
    // console.log(`🔍 generateRaysForRectangleObject called for object:`, obj);
    // console.log(`📊 Parameters: rayCount=${rayCount}, pattern=${pattern}`);
    
    const rayStartData: RayStartDataArray = [];
    rayStartData.annularRingsUsed = 0;
    rayStartData.selectedRingOverride = annularRingCount ?? 0;
    
    try {
        // Use unified conjugate type detection
        const conjugateType = options?.conjugateType || detectConjugateType(opticalSystemRows, options);
        const isInfiniteObject = (conjugateType === 'infinite');
        
        console.log(`🔍 [RectangleObject] Conjugate type: ${conjugateType}`);
        
        // Get surface origins for object position calculation
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        const firstSurfaceOrigin = surfaceOrigins[0] ? surfaceOrigins[0].origin : { x: 0, y: 0, z: 0 };
        const surf = opticalSystemRows[0];
        
        // Object position (Rectangle objects use xHeightAngle and yHeightAngle for positioning)
        const centerX = parseNumericValue(obj.xHeight ?? obj.x ?? obj.xHeightAngle ?? obj.xAngle);
        const centerY = parseNumericValue(obj.yHeight ?? obj.y ?? obj.yHeightAngle ?? obj.yAngle);
        const finiteObjectZ = Number.isFinite(firstSurfaceOrigin?.z) ? firstSurfaceOrigin.z : 0;
        // Use true surface origin for finite objects; use objectRenderDistance for infinite objects
        const objectRow = opticalSystemRows && opticalSystemRows[0];
        const renderDist = (objectRow && Number.isFinite(Number(objectRow.objectRenderDistance)))
            ? Number(objectRow.objectRenderDistance)
            : 0;
        const objectZ = isInfiniteObject ? resolveInfiniteObjectZ(opticalSystemRows, renderDist) : finiteObjectZ;
        const imageHeightChiefRayOverride = !isInfiniteObject
            ? obj?.__cooptImageHeightSolve?.chiefRay
            : null;
        const hasImageHeightChiefRayOverride = !!(
            imageHeightChiefRayOverride
            && Number.isFinite(Number(imageHeightChiefRayOverride?.origin?.x))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.origin?.y))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.origin?.z))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.dir?.x))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.dir?.y))
            && Number.isFinite(Number(imageHeightChiefRayOverride?.dir?.z))
        );

        if (isInfiniteObject && options?.rectangleAsAngleWhenInfinite !== false) {
            const refDist = Math.max(1e-6, Math.abs(objectZ));
            const angleX = Math.atan2(centerX, refDist) * 180 / Math.PI;
            const angleY = Math.atan2(centerY, refDist) * 180 / Math.PI;
            console.log(`🔄 [RectangleObject] Converting to Angle object: centerX=${centerX}, centerY=${centerY} → angleX=${angleX}°, angleY=${angleY}°`);
            const angleObj = {
                ...obj,
                position: 'Angle',
                xAngle: angleX,
                yAngle: angleY,
                xHeightAngle: angleX,
                yHeightAngle: angleY
            };
            return generateRaysForAngleObject(angleObj, opticalSystemRows, rayCount, pattern, annularRingCount, {
                ...options,
                wavelengthUm,
                apertureLimitMm: apertureLimit,
                conjugateType: 'infinite'  // Pass conjugate type instead of force flag
            });
        }
        
        // Calculate Object surface sag at object position
        let objectSag = 0;
        if (!isInfiniteObject && surf.radius && surf.radius !== "INF") {
            const r = Math.sqrt(centerX * centerX + centerY * centerY);
            const asphericParams = {
                radius: parseFloat(surf.radius),
                conic: Number(surf.conic) || 0,
                coef1: Number(surf.coef1) || 0,
                coef2: Number(surf.coef2) || 0,
                coef3: Number(surf.coef3) || 0,
                coef4: Number(surf.coef4) || 0,
                coef5: Number(surf.coef5) || 0,
                coef6: Number(surf.coef6) || 0,
                coef7: Number(surf.coef7) || 0,
                coef8: Number(surf.coef8) || 0,
                coef9: Number(surf.coef9) || 0,
                coef10: Number(surf.coef10) || 0
            };
            objectSag = asphericSurfaceZ(r, asphericParams, getAsphericModeFromSurfType(surf.surfType)) || 0;
            rrLog(`🔍 [RayRenderer] Rectangle Object面sag計算: r=${r.toFixed(3)}, sag=${objectSag.toFixed(6)}`);
        }
        
        // Apply sag to object Z position for finite objects only
        const actualObjectZ = hasImageHeightChiefRayOverride
            ? Number(imageHeightChiefRayOverride.origin.z)
            : (isInfiniteObject ? objectZ : objectZ + objectSag);
        
        // console.log(`📍 Rectangle object position: (${centerX}, ${centerY}, ${objectZ})`);
        const apertureRadius = Number(surf.semidia) || Number(surf.thickness) || 10;
        const stopConfig = resolveStopConfig(opticalSystemRows, surfaceOrigins, actualObjectZ + (Number(surf.thickness) || 10), apertureRadius);
        const stopRadiusLimited = Math.min(stopConfig.radius, apertureRadius);
        const stopCenter = stopConfig.center || { x: 0, y: 0 };
        const stopZ = stopConfig.z;
        const stopDeltaZ = stopZ - actualObjectZ;
        const canAimAtStop = !isInfiniteObject && Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;
        const aimThroughStop = options?.aimThroughStop === true;
        const useChiefRayAnalysis = options?.useChiefRayAnalysis !== false;
        
        const pointEmission = true; // Rectangle objects now emit from their central point

        const resolveRectangleChiefDirection = () => {
            const fallbackDeltaZ = Number(surf.thickness) || 10.0;
            if (hasImageHeightChiefRayOverride) {
                return {
                    x: Number(imageHeightChiefRayOverride.dir.x),
                    y: Number(imageHeightChiefRayOverride.dir.y),
                    z: Number(imageHeightChiefRayOverride.dir.z),
                };
            }
            if (isInfiniteObject) {
                return { x: 0, y: 0, z: 1 };
            }
            if (canAimAtStop) {
                const centerPoint = { x: centerX, y: centerY, z: actualObjectZ };
                const stopCenter3d = { x: stopCenter.x, y: stopCenter.y, z: stopZ };
                const chiefDirResult = findFiniteSystemChiefRayDirection(
                    centerPoint,
                    stopCenter3d,
                    stopConfig.index,
                    opticalSystemRows,
                    true,
                    wavelengthUm
                );
                if (chiefDirResult) {
                    return refineFiniteChiefDirectionToStopCenter(
                        centerPoint,
                        {
                            x: chiefDirResult.i,
                            y: chiefDirResult.j,
                            z: chiefDirResult.k
                        },
                        stopCenter3d,
                        stopConfig.index,
                        opticalSystemRows,
                        wavelengthUm
                    );
                }
                return refineFiniteChiefDirectionToStopCenter(
                    centerPoint,
                    {
                        x: stopCenter.x - centerX,
                        y: chiefDirResult?.j ?? (stopCenter.y - centerY),
                        z: chiefDirResult?.k ?? stopDeltaZ
                    },
                    stopCenter3d,
                    stopConfig.index,
                    opticalSystemRows,
                    wavelengthUm
                );
            }
            return { x: 0, y: 0, z: fallbackDeltaZ };
        };

        if (rayCount === 1) {
            // Single-ray render should still use the chief ray so it passes the stop center.
            const startP = hasImageHeightChiefRayOverride
                ? {
                    x: Number(imageHeightChiefRayOverride.origin.x),
                    y: Number(imageHeightChiefRayOverride.origin.y),
                    z: Number(imageHeightChiefRayOverride.origin.z),
                }
                : { x: centerX, y: centerY, z: actualObjectZ };
            const chiefDirection = resolveRectangleChiefDirection();
            const chiefLength = Math.sqrt(
                chiefDirection.x * chiefDirection.x
                + chiefDirection.y * chiefDirection.y
                + chiefDirection.z * chiefDirection.z
            ) || 1;
            const unitChiefDir = {
                x: chiefDirection.x / chiefLength,
                y: chiefDirection.y / chiefLength,
                z: chiefDirection.z / chiefLength
            };
            
            rayStartData.push({
                startP: startP,
                dir: unitChiefDir,
                description: `Single Rectangle ray from center (${centerX}, ${centerY})`
            });
            rayStartData.expectedChiefOrigin = { ...startP };
            rayStartData.expectedChiefDir = { ...unitChiefDir };
        } else if (pattern === 'grid' || pattern === 'annular') {
            console.log(`🔍 [RayRenderer-Rectangle] Pattern: ${pattern}, canAimAtStop: ${canAimAtStop}, isInfiniteObject: ${isInfiniteObject}`);
            console.log(`🔍 [RayRenderer-Rectangle] Stop config:`, { stopCenter, stopZ, stopDeltaZ, stopIndex: stopConfig.index });
            
            const chiefDirection = resolveRectangleChiefDirection();
            
            const { dir: unitChief, u, v } = buildPerpendicularBasis(chiefDirection);
            rayStartData.expectedChiefOrigin = hasImageHeightChiefRayOverride
                ? {
                    x: Number(imageHeightChiefRayOverride.origin.x),
                    y: Number(imageHeightChiefRayOverride.origin.y),
                    z: Number(imageHeightChiefRayOverride.origin.z),
                }
                : { x: centerX, y: centerY, z: actualObjectZ };
            rayStartData.expectedChiefDir = { x: unitChief.x, y: unitChief.y, z: unitChief.z };
            const centerPoint = hasImageHeightChiefRayOverride
                ? {
                    x: Number(imageHeightChiefRayOverride.origin.x),
                    y: Number(imageHeightChiefRayOverride.origin.y),
                    z: Number(imageHeightChiefRayOverride.origin.z),
                }
                : { x: centerX, y: centerY, z: actualObjectZ };
            let effectiveRadius = Number.isFinite(stopRadiusLimited) && stopRadiusLimited > 0
                ? Math.min(stopRadiusLimited, apertureRadius)
                : apertureRadius;

            // Optional external clamp (used by fast merit evaluation to avoid vignetting).
            const apLim = Number(apertureLimit);
            if (Number.isFinite(apLim) && apLim > 0) {
                effectiveRadius = Math.min(effectiveRadius, apLim);
            }
            const pupilScale = (Number.isFinite(Number(options?.pupilScale)) && Number(options.pupilScale) > 0)
                ? Number(options.pupilScale)
                : 1;
            const halfExtent = Math.max(1e-6, effectiveRadius * pupilScale);
            const propagationDistance = Number(surf.thickness) || 10.0;
            const exactCrossType = options?.crossType === 'vertical' || options?.crossType === 'horizontal' || options?.crossType === 'both'
                ? options.crossType
                : 'both';
            const useExactCrossBeamSampling = options?.exactCrossBeamSampling === true;
            const stopSamplingRadius = (() => {
                const apLimNum = Number(apertureLimit);
                let radius = Number.isFinite(Number(stopConfig?.radius)) && Number(stopConfig.radius) > 0
                    ? Number(stopConfig.radius)
                    : effectiveRadius;
                if (Number.isFinite(apLimNum) && apLimNum > 0) {
                    radius = Math.min(radius, apLimNum);
                }
                return Math.max(1e-6, radius);
            })();
            const halfExtentForExactCross = Math.max(1e-6, stopSamplingRadius * pupilScale);
            const offsets = useExactCrossBeamSampling
                ? generateUniformCrossOffsets(rayCount, halfExtentForExactCross, exactCrossType)
                : (pattern === 'annular'
                    ? generateAnnularOffsets(rayCount, halfExtent, annularRingCount || 3)
                    : generateCenteredGridOffsets(rayCount, halfExtent));

            // Calculate chief ray intersection with stop surface (for canAimAtStop case)
            let chiefStopIntersection = { x: stopCenter.x, y: stopCenter.y, z: stopConfig.z };
            if (canAimAtStop && !isInfiniteObject) {
                // Find where chief ray intersects stop surface
                // Ray equation: P(t) = centerPoint + t * unitChief
                // At stop surface: P(t).z = stopConfig.z
                // Solve for t: actualObjectZ + t * unitChief.z = stopConfig.z
                const t = (stopConfig.z - actualObjectZ) / unitChief.z;
                if (t > 0 && Number.isFinite(t)) {
                    chiefStopIntersection = {
                        x: centerX + unitChief.x * t,
                        y: centerY + unitChief.y * t,
                        z: stopConfig.z
                    };
                }
            }

            offsets.forEach((coord, index) => {
                const startP = pointEmission
                    ? { ...centerPoint }
                    : {
                        x: centerPoint.x + coord.offsetU * u.x + coord.offsetV * v.x,
                        y: centerPoint.y + coord.offsetU * u.y + coord.offsetV * v.y,
                        z: centerPoint.z + coord.offsetU * u.z + coord.offsetV * v.z
                    };
                let dirVector = unitChief;
                if (canAimAtStop && !isInfiniteObject) {
                    // Aim at offset position around chief ray intersection on stop surface
                    const targetPoint = {
                        x: chiefStopIntersection.x + coord.offsetU * u.x + coord.offsetV * v.x,
                        y: chiefStopIntersection.y + coord.offsetU * u.y + coord.offsetV * v.y,
                        z: stopConfig.z
                    };
                    if (useChiefRayAnalysis && aimThroughStop && Number.isInteger(Number(stopConfig.index))) {
                        const solved = solveRayDirectionToStopPointFast(
                            startP,
                            targetPoint,
                            stopConfig.index,
                            opticalSystemRows,
                            wavelengthUm
                        );
                        if (solved) {
                            dirVector = solved;
                        }
                    }
                    if (dirVector === unitChief) {
                        const deltaX = targetPoint.x - startP.x;
                        const deltaY = targetPoint.y - startP.y;
                        const deltaZ = targetPoint.z - startP.z;
                        const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) || 1;
                        dirVector = {
                            x: deltaX / length,
                            y: deltaY / length,
                            z: deltaZ / length
                        };
                    }
                } else if (pointEmission) {
                    const targetPoint = {
                        x: centerPoint.x + coord.offsetU * u.x + coord.offsetV * v.x + unitChief.x * propagationDistance,
                        y: centerPoint.y + coord.offsetU * u.y + coord.offsetV * v.y + unitChief.y * propagationDistance,
                        z: centerPoint.z + coord.offsetU * u.z + coord.offsetV * v.z + unitChief.z * propagationDistance
                    };
                    const deltaX = targetPoint.x - startP.x;
                    const deltaY = targetPoint.y - startP.y;
                    const deltaZ = targetPoint.z - startP.z;
                    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) || 1;
                    dirVector = {
                        x: deltaX / length,
                        y: deltaY / length,
                        z: deltaZ / length
                    };
                }
                rayStartData.push({
                    startP,
                    dir: dirVector,
                    description: `${pattern === 'annular' ? 'Annular' : (useExactCrossBeamSampling ? 'Rectangle cross' : 'Rectangle grid')} ray ${index + 1}`,
                    planeCoords: { u: coord.offsetU, v: coord.offsetV }
                });
            });
        } else {
            console.log(`🔍 [RayRenderer-Rectangle-Else] Pattern: ${pattern}, canAimAtStop: ${canAimAtStop}, isInfiniteObject: ${isInfiniteObject}`);
            console.log(`🔍 [RayRenderer-Rectangle-Else] rayCount: ${rayCount}`);
            
            // Annular pattern for Rectangle objects
            // Calculate chief ray direction first
            const fallbackDeltaZ = Number(surf.thickness) || 10.0;
            const chiefDirection = resolveRectangleChiefDirection();
            
            // Normalize chief direction
            const chiefLength = Math.sqrt(chiefDirection.x * chiefDirection.x + chiefDirection.y * chiefDirection.y + chiefDirection.z * chiefDirection.z) || 1;
            const unitChiefDir = {
                x: chiefDirection.x / chiefLength,
                y: chiefDirection.y / chiefLength,
                z: chiefDirection.z / chiefLength
            };
            rayStartData.expectedChiefOrigin = hasImageHeightChiefRayOverride
                ? {
                    x: Number(imageHeightChiefRayOverride.origin.x),
                    y: Number(imageHeightChiefRayOverride.origin.y),
                    z: Number(imageHeightChiefRayOverride.origin.z),
                }
                : { x: centerX, y: centerY, z: actualObjectZ };
            rayStartData.expectedChiefDir = { x: unitChiefDir.x, y: unitChiefDir.y, z: unitChiefDir.z };
            
            // Add chief ray
            rayStartData.push({
                startP: hasImageHeightChiefRayOverride
                    ? {
                        x: Number(imageHeightChiefRayOverride.origin.x),
                        y: Number(imageHeightChiefRayOverride.origin.y),
                        z: Number(imageHeightChiefRayOverride.origin.z),
                    }
                    : { x: centerX, y: centerY, z: actualObjectZ },
                dir: unitChiefDir,
                description: `Chief Rectangle ray from center (${centerX}, ${centerY})`
            });
            let raysGenerated = 1;
            const remainingRays = Math.max(rayCount - 1, 0);

            if (remainingRays > 0) {
                // Calculate number of rings based on remaining rays or override from options
                let numRings;
                if (annularRingCount) {
                    // Use the explicit ring count parameter
                    numRings = Math.min(annularRingCount, remainingRays);
                } else {
                    // Auto-calculate based on remaining rays (fallback when no explicit count)
                    if (remainingRays <= 6) numRings = 1;
                    else if (remainingRays <= 15) numRings = 2;
                    else if (remainingRays <= 30) numRings = 3;
                    else if (remainingRays <= 50) numRings = 4;
                    else if (remainingRays <= 80) numRings = 5;
                    else if (remainingRays <= 120) numRings = 6;
                    else if (remainingRays <= 170) numRings = 7;
                    else numRings = 8;
                }

                // Maximum radius for annular pattern
                const ringScale = numRings === 1 ? 1 : (numRings / (numRings + 1)); // keep rings slightly inside first semidia
                const maxStopRadius = Math.max(0, Math.min(stopRadiusLimited * ringScale, apertureRadius * ringScale));
                const fallbackRadiusLimit = apertureRadius * ringScale;
                const canUseStopTarget = canAimAtStop && maxStopRadius > 0;
                const baseAngleOffset = (Math.PI / numRings) * 0.5;

                for (let ringIndex = 1; ringIndex <= numRings && raysGenerated < rayCount; ringIndex++) {
                    const ringsLeft = numRings - ringIndex + 1;
                    const raysAvailable = rayCount - raysGenerated;
                    let raysInThisRing = Math.max(3, Math.floor(raysAvailable / ringsLeft));
                    if (raysInThisRing > raysAvailable) raysInThisRing = raysAvailable;
                    if (ringIndex === numRings) raysInThisRing = raysAvailable;
                    const targetRadius = (ringIndex / numRings) * (canUseStopTarget ? maxStopRadius : fallbackRadiusLimit);
                    const baseAngle = (ringIndex % 2 === 0 ? Math.PI / raysInThisRing : 0) + baseAngleOffset * ringIndex;
                    
                    for (let i = 0; i < raysInThisRing && raysGenerated < rayCount; i++) {
                        const angle = baseAngle + (2 * Math.PI * i) / raysInThisRing;
                        let dirVector;
                        let targetX;
                        let targetY;
                        let deltaZDir;
                        
                        if (canUseStopTarget) {
                            targetX = stopCenter.x + targetRadius * Math.cos(angle);
                            targetY = stopCenter.y + targetRadius * Math.sin(angle);
                            deltaZDir = stopDeltaZ;
                        } else {
                            targetX = centerX + targetRadius * Math.cos(angle);
                            targetY = centerY + targetRadius * Math.sin(angle);
                            deltaZDir = fallbackDeltaZ;
                        }
                        
                        const deltaX = targetX - centerX;
                        const deltaY = targetY - centerY;
                        const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZDir * deltaZDir) || 1;
                        dirVector = {
                            x: deltaX / length,
                            y: deltaY / length,
                            z: deltaZDir / length
                        };

                        rayStartData.push({
                            startP: { x: centerX, y: centerY, z: actualObjectZ },
                            dir: dirVector,
                            description: `Rectangle ring ${ringIndex} ray at (${targetX.toFixed(2)}, ${targetY.toFixed(2)})`
                        });
                        raysGenerated++;
                    }
                }
                rayStartData.annularRingsUsed = numRings;
            }
        }
        
        // console.log(`✅ Generated ${rayStartData.length} rays for Rectangle object`);
        
    } catch (error) {
        console.error('❌ Error generating rays for Rectangle object:', error);
    }
    
    return rayStartData;
}

// Module loaded confirmation
if (typeof window !== 'undefined' && (window as any).opener) {
    const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && (globalThis as any).__RAYTRACE_DEBUG);
    if (RAYTRACE_DEBUG) {
        console.log('🔍 [ray-renderer.ts] Running in popup window - logs will mirror to parent');
    }
    try {
        if (RAYTRACE_DEBUG) {
            (window as any).opener.console?.log?.('✅ [ray-renderer.ts] Child popup loaded');
        }
    } catch (_) {}
}
