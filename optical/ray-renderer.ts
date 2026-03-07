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

function traceRayHitPointForRender(opticalSystemRows, ray, n0, targetSurfaceIndex, traceBackend: 'ts' | 'rust' = 'ts') {
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

function traceRayHitPointBatchForRender(opticalSystemRows, rays, n0, targetSurfaceIndex, traceBackend: 'ts' | 'rust' = 'ts') {
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
    targetSurfaceIndex?: number;
    debugChiefRay?: boolean;
    apertureLimitMm?: number;
    apertureLimit?: number;
    disableCrossExtent?: boolean;
    originSolveTraceBackend?: 'ts' | 'rust';
    pupilScale?: number;
    rectangleAsAngleWhenInfinite?: boolean;
    precomputedSurfaceOrigins?: any[];
};

// Helper function to normalize hit points
function normalizeHitPoint(hit): Vec3 | null {
    if (!hit || Array.isArray(hit)) return null;
    const x = Number(hit.x);
    const y = Number(hit.y);
    const z = Number(hit.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
}

// Global variables for ray pattern and color mode
let rayEmissionPattern = 'annular'; // 'grid' or 'annular'
let rayColorMode = 'object'; // 'object' or 'segment'
const chiefRayOriginSolveCache = new Map<string, any>();
const opticalRowsSignatureCache = new WeakMap<any[], string>();
const stopConfigCache = new WeakMap<any[], { surfaceOriginsRef: any[] | null; config: any }>();

function buildOpticalRowsSignature(opticalSystemRows) {
    if (!Array.isArray(opticalSystemRows)) return 'no-rows';
    const cached = opticalRowsSignatureCache.get(opticalSystemRows);
    if (cached) return cached;
    const parts = [];
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i] || {};
        parts.push([
            i,
            String(row.surfType ?? row['surf type'] ?? row.type ?? row.objectType ?? row['object type'] ?? ''),
            Number(row.radius ?? row.Radius ?? row.r),
            Number(row.thickness ?? row.Thickness ?? row.t),
            Number(row.conic ?? row.Conic ?? row.k),
            Number(row.semidia ?? row.semiDiameter ?? row['Semi Diameter'] ?? row.aperture)
        ].join(':'));
    }
    const sig = parts.join('|');
    opticalRowsSignatureCache.set(opticalSystemRows, sig);
    return sig;
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

function normalizeAnnularRingCount(value) {
    if (value === undefined || value === null) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.max(1, Math.min(Math.floor(numeric), 32));
}

function resolveInfiniteObjectZ(opticalSystemRows, renderDist) {
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
    const fallbackDist = Math.max(1000, systemLength * 5);
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

function solveRayDirectionToStopPointFast(centerPoint, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend: 'ts' | 'rust' = 'ts') {
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
    const maxSlope = Math.max(3.0, Math.min(10.0, slopeGuess * 4 + 1.5));
    const maxIter = 14;
    const tolMm = 1e-3;
    const eps = 1e-4;
    const maxNewtonStep = Math.max(0.5, Math.min(2.0, 0.25 * maxSlope));
    let bestDir = buildDirFromSlopes(u, v);
    let bestErr = Infinity;

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
            return dir;
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

    // Not converged; use best-effort direction.
    return bestDir;
}

function solveChiefRayDirectionToStopCenterFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend: 'ts' | 'rust' = 'ts') {
    return solveRayDirectionToStopPointFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend);
}

function evaluateOriginSolveResidualMm(origin, dirVector, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) return Number.POSITIVE_INFINITY;
    const o = {
        x: Number(origin?.x),
        y: Number(origin?.y),
        z: Number(origin?.z)
    };
    const d = normalizeVector3(dirVector, { x: 0, y: 0, z: 1 });
    const t = {
        x: Number(stopTarget3d?.x),
        y: Number(stopTarget3d?.y),
        z: Number(stopTarget3d?.z)
    };
    if (![o.x, o.y, o.z, d.x, d.y, d.z, t.x, t.y].every(Number.isFinite)) {
        return Number.POSITIVE_INFINITY;
    }
    const hit = normalizeHitPoint(
        traceRayHitPointForRenderTs(
            opticalSystemRows,
            { wavelength: wavelengthUm, pos: o, dir: d },
            1.0,
            stopIdx
        )
    );
    if (!hit) return Number.POSITIVE_INFINITY;
    return Math.hypot(hit.x - t.x, hit.y - t.y);
}

function solveRayOriginToStopPointFast(initialOrigin, dirVector, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm, traceBackend: 'ts' | 'rust' = 'ts') {
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
    let bestOrigin = { ...origin };
    let bestErr = Infinity;

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
        const hit = normalizeHitPoint(Array.isArray(sampled) ? sampled[0] : null);
        if (!hit) {
            origin = {
                x: 0.5 * (origin.x + bestOrigin.x),
                y: 0.5 * (origin.y + bestOrigin.y),
                z: origin.z
            };
            continue;
        }
        const ex = hit.x - Number(stopTarget3d.x);
        const ey = hit.y - Number(stopTarget3d.y);
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = Math.hypot(ex, ey);
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
            origin = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
            continue;
        }

        const j11 = (hitX.x - hit.x) / eps;
        const j21 = (hitX.y - hit.y) / eps;
        const j12 = (hitY.x - hit.x) / eps;
        const j22 = (hitY.y - hit.y) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) {
            const gain = 0.2;
            origin = {
                x: origin.x - gain * ex,
                y: origin.y - gain * ey,
                z: origin.z
            };
            continue;
        }

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
            const gain = 0.2;
            origin = {
                x: origin.x - gain * ex,
                y: origin.y - gain * ey,
                z: origin.z
            };
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

        origin = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
    }

    const result = bestErr < Infinity ? bestOrigin : origin;
    if (traceBackend === 'rust') {
        const tsResidual = evaluateOriginSolveResidualMm(
            result,
            baseDir,
            stopTarget3d,
            stopIdx,
            opticalSystemRows,
            wavelengthUm
        );
        if (!Number.isFinite(tsResidual) || tsResidual > Math.max(5e-3, tolMm * 3)) {
            return solveRayOriginToStopPointFast(
                initialOrigin,
                dirVector,
                stopTarget3d,
                stopSurfaceIndex,
                opticalSystemRows,
                wavelengthUm,
                'ts'
            );
        }
    }
    return result;
}

function solveRayOriginsToStopPointsFastBatch(
    initialOrigins,
    dirVectors,
    stopTargets,
    stopSurfaceIndex,
    opticalSystemRows,
    wavelengthUm,
    traceBackend: 'ts' | 'rust' = 'ts'
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
                    try {
                        const verifyRays = mapped.map((o, i) => ({
                            wavelength: wavelengthUm,
                            pos: { x: Number(o.x) || 0, y: Number(o.y) || 0, z: Number(o.z) || 0 },
                            dir: { x: Number(dirs[i].x) || 0, y: Number(dirs[i].y) || 0, z: Number(dirs[i].z) || 1 }
                        }));
                        const verifyHits = traceRayHitPointBatchForRenderTs(opticalSystemRows, verifyRays, 1.0, stopIdx);
                        if (Array.isArray(verifyHits) && verifyHits.length === count) {
                            let allOk = true;
                            for (let i = 0; i < count; i++) {
                                const hit = normalizeHitPoint(verifyHits[i]);
                                if (!hit) {
                                    allOk = false;
                                    break;
                                }
                                const target = targets[i];
                                const err = Math.hypot(hit.x - target.x, hit.y - target.y);
                                if (!Number.isFinite(err) || err > Math.max(5e-3, tolMm * 3)) {
                                    allOk = false;
                                    break;
                                }
                            }
                            if (allOk) {
                                return mapped;
                            }
                        }
                    } catch (_) {}
                }
                return solveRayOriginsToStopPointsFastBatch(
                    initialOrigins,
                    dirVectors,
                    stopTargets,
                    stopSurfaceIndex,
                    opticalSystemRows,
                    wavelengthUm,
                    'ts'
                );
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
                    return offsets.slice(0, Math.max(0, rayCount));
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
                    return offsets.slice(0, rayCount);
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
    try {
        if (Array.isArray(opticalSystemRows)) {
            const cached = stopConfigCache.get(opticalSystemRows);
            if (cached && cached.surfaceOriginsRef === surfaceOrigins && cached.config && cached.config.hasStop === true) {
                return {
                    ...cached.config,
                    center: cached.config.center ? { ...cached.config.center } : { x: 0, y: 0 }
                };
            }
        }
    } catch (_) {}

    const config = resolveStopConfig(opticalSystemRows, surfaceOrigins, fallbackZ, fallbackRadius);

    try {
        if (Array.isArray(opticalSystemRows) && config && config.hasStop === true) {
            stopConfigCache.set(opticalSystemRows, {
                surfaceOriginsRef: Array.isArray(surfaceOrigins) ? surfaceOrigins : null,
                config: {
                    ...config,
                    center: config.center ? { ...config.center } : { x: 0, y: 0 }
                }
            });
        }
    } catch (_) {}

    return config;
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
export function optimizeAngleObjectPosition(angleX, angleY, opticalSystemRows) {
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
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
    
    // Debug: 光線パスの最初のポイントと最後のポイントを確認
    const firstPoint = rayPath[0];
    const lastPoint = rayPath[rayPath.length - 1];
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
        let color;
        if (rayColorMode === 'segment') {
            // Color by segment: each segment gets a different color
            color = segmentColors[i % segmentColors.length];
            // console.log(`🎨 Segment color for ray ${rayNumber}, segment ${i}: 0x${color.toString(16)}`);
        } else {
            // Color by object: all segments of this object get the same color
            if (crossBeamColors[objectId]) {
                // クロスビーム専用の色を使用
                color = crossBeamColors[objectId];
                // console.log(`🎨 CrossBeam color for ${objectId}: 0x${color.toString(16)}`);
            } else if (typeof objectId === 'string' && objectId.startsWith('chief-obj')) {
                // 主光線は同一Objectのクロス光線色に合わせる
                const objIndex = objectId.replace('chief-obj', '');
                const fallbackId = `cross-horizontal-obj${objIndex}`;
                if (crossBeamColors[fallbackId]) {
                    color = crossBeamColors[fallbackId];
                }
            }
            if (color === undefined) {
                // 通常のオブジェクト色を使用
                let colorIndex;
                if (typeof objectId === 'string') {
                    colorIndex = objectId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % objectColors.length;
                } else {
                    colorIndex = (objectId || 0) % objectColors.length;
                }
                color = objectColors[colorIndex];
                // console.log(`🎨 Object color for objectId ${objectId} (index ${colorIndex}): 0x${color.toString(16)}`);
            }
        }
        
        const material = new THREE.LineBasicMaterial({ 
            color: color,
            linewidth: 2,       // 線の太さを2に調整
            transparent: false, // 透明度を無効にして色を濃く表示
            opacity: 1.0       // 完全不透明
        });
        
        const line = new THREE.Line(geometry, material);
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
export function generateRayStartPointsForObject(obj, opticalSystemRows, rayCount, apertureLimit = null, options: RayGenerationOptions = {}) {
    // console.log(`🎯 generateRayStartPointsForObject called for object type: ${obj.position}`);
    // console.log(`🔍 Current ray emission pattern: ${rayEmissionPattern}`);
    
    const rayStartData: RayStartDataArray = [];
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

    const posNorm = String(obj?.position ?? '').trim().toLowerCase();

    // Pass conjugateType to all generation functions
    const enhancedOptions = { ...options, conjugateType };

    if (posNorm === "point") {
        return generateRaysForPointObject(obj, opticalSystemRows, rayCount, apertureLimit, effectivePattern, annularRingCount, wavelengthUm, enhancedOptions);
    } else if (posNorm === "angle") {
        return generateRaysForAngleObject(obj, opticalSystemRows, rayCount, effectivePattern, annularRingCount, { ...enhancedOptions, wavelengthUm, apertureLimitMm: apertureLimit });
    } else if (posNorm === "rectangle") {
        return generateRaysForRectangleObject(obj, opticalSystemRows, rayCount, effectivePattern, apertureLimit, annularRingCount, wavelengthUm, enhancedOptions);
    } else {
        console.warn(`⚠️ Unknown object position type: ${obj.position}`);
        return [];
    }
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
        let objectZ = isInfiniteObject ? resolveInfiniteObjectZ(opticalSystemRows, renderDist) : finiteObjectZ;
        
        // Calculate Object surface sag at object position (finite objectのみ)
        let objectSag = 0;
        if (!isInfiniteObject && surf.radius && surf.radius !== "INF") {
            const r = Math.sqrt(objectX * objectX + objectY * objectY);
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
            objectSag = asphericSurfaceZ(r, asphericParams, surf.surfType === "Aspheric Odd" ? "odd" : "even") || 0;
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
            // Only the chief ray
            const chiefVec = (!isInfiniteObject && canAimAtStop)
                ? { x: stopCenter.x - objectX, y: stopCenter.y - objectY, z: stopConfig.z - actualObjectZ }
                : { x: 0, y: 0, z: entrancePupilZ - actualObjectZ };
            const length = Math.sqrt(chiefVec.x * chiefVec.x + chiefVec.y * chiefVec.y + chiefVec.z * chiefVec.z) || 1;
            rayStartData.push({
                startP: { x: objectX, y: objectY, z: actualObjectZ },
                dir: { x: chiefVec.x / length, y: chiefVec.y / length, z: chiefVec.z / length },
                description: 'Chief point ray from object center'
            });
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
                        description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`
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
                            description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`
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
                            description: `Point ${(pattern === 'annular') ? 'annular' : 'grid'} ray ${index + 1}`
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
        // Use unified conjugate type detection
        const conjugateType = options?.conjugateType || detectConjugateType(opticalSystemRows, options);
        const isInfiniteObject = (conjugateType === 'infinite');
        
        
        const angleX = parseAngleInput(
            obj.xAngle ?? obj.objectAngleX ?? obj.xHeightAngle ?? obj.x ?? obj.angleX
        );
        const angleY = parseAngleInput(
            obj.yAngle ?? obj.objectAngleY ?? obj.yHeightAngle ?? obj.y ?? obj.angle ?? obj.angleY
        );
        const chiefDir = buildDirectionFromFieldAngles(angleX, angleY);
        const maxFieldDeg = Math.max(Math.abs(angleX), Math.abs(angleY));
        const isHighField = maxFieldDeg >= 15;
        const logHighFieldChiefRayFailure = (reason, details = {}) => {
            if (!isHighField) return;
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
                const ua = String(navigator.userAgent || '');
                const isChromeDesktop = /\bChrome\//.test(ua)
                    && !/\bEdg\//.test(ua)
                    && !/\bOPR\//.test(ua)
                    && !/\bCriOS\//.test(ua);
                if (!isChromeDesktop) return 'ts';
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
        const shouldRunChiefOriginAnalysis = (aimThroughStop || forceChiefAnalysisForHighField) && useChiefRayAnalysis;
        
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
                optimizedPosition = optimizeAngleObjectPosition(angleX, angleY, opticalSystemRows);
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
        const surfaceOrigins = (Array.isArray(options?.precomputedSurfaceOrigins) && options.precomputedSurfaceOrigins.length > 0)
            ? options.precomputedSurfaceOrigins
            : calculateSurfaceOrigins(opticalSystemRows);
        const firstSurfaceOrigin = surfaceOrigins[0] ? surfaceOrigins[0].origin : { x: 0, y: 0, z: 0 };
        const finiteObjectZ = Number.isFinite(firstSurfaceOrigin?.z) ? firstSurfaceOrigin.z : 0;
        
        // Use actual object-plane origin for finite objects; use objectRenderDistance for infinite objects
        const objectRow = opticalSystemRows && opticalSystemRows[0];
        const renderDist = (objectRow && Number.isFinite(Number(objectRow.objectRenderDistance)))
            ? Number(objectRow.objectRenderDistance)
            : 0;
        let objectZ = isInfiniteObject ? resolveInfiniteObjectZ(opticalSystemRows, renderDist) : finiteObjectZ;
        
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
            const sag = asphericSurfaceZ(r, asphericParams, surf.surfType === "Aspheric Odd" ? "odd" : "even") || 0;
            if (Math.abs(sag) > 0) {
                console.log(`🔍 [AngleRayRenderer] Object面sag計算: r=${r.toFixed(3)}, sag=${sag.toFixed(6)}`);
            }
            return sag;
        };
        const stopSurfaceInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
        const stopSurfaceCenter3d = extractStopCenter3d(stopSurfaceInfo);
        const stopSurfaceIndex = Number.isInteger(stopSurfaceInfo?.index) ? stopSurfaceInfo.index : null;
        const targetSurfaceIndex = Number.isInteger(options?.targetSurfaceIndex)
            ? options.targetSurfaceIndex
            : opticalSystemRows.length - 1;
        let chiefRayOrigin = null;
        let chiefRayAnalysisMeta = null;

        if (allowStopBasedOriginSolve && shouldRunChiefOriginAnalysis && !isOnAxis && stopSurfaceCenter3d && Number.isInteger(stopSurfaceIndex)) {
            try {
                const directionForAnalysis = { i: chiefDir.x, j: chiefDir.y, k: chiefDir.z };
                const wavelengthForSolve = options?.wavelength ?? 0.5876;
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
        let stopRadiusLimited = Math.min(stopConfig.radius, apertureRadius);
        const extApLim = Number(options?.apertureLimitMm ?? options?.apertureLimit);
        if (Number.isFinite(extApLim) && extApLim > 0) {
            stopRadiusLimited = Math.min(stopRadiusLimited, extApLim);
        }
        const stopCenter = stopConfig.center || { x: 0, y: 0 };
        let startZ = objectZ + centerSag;
        let stopDeltaZ = stopConfig.z - startZ;
        let canAimAtStop = Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;

        // Optional OPD-style origin refinement (disabled by default).
        if (allowStopBasedOriginSolve && aimThroughStop && !isOnAxis && stopSurfaceCenter3d && Number.isInteger(stopSurfaceIndex)
            && chiefRayOrigin && Number.isFinite(chiefRayOrigin.x) && Number.isFinite(chiefRayOrigin.y) && Number.isFinite(chiefRayOrigin.z)) {
            const refined = solveRayOriginToStopPointFast(
                chiefRayOrigin,
                chiefDir,
                stopSurfaceCenter3d,
                stopSurfaceIndex,
                opticalSystemRows,
                options?.wavelength ?? 0.5876,
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

        const emissionOrigin = { x: optimizedPosition.x, y: optimizedPosition.y, z: startZ };

        // Keep direction defined by the field angle.
        // When aimThroughStop is requested, origin solving (above) is responsible for passing
        // the chief ray through the stop center.
        const chiefDirUsed = chiefDir;

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
                x: emissionOrigin.x + offsetU * uAxis.x + offsetV * vAxis.x,
                y: emissionOrigin.y + offsetU * uAxis.y + offsetV * vAxis.y,
                z: emissionOrigin.z + offsetU * uAxis.z + offsetV * vAxis.z
            };
            rayStartData.push({
                startP,
                dir: dirVector,
                description,
                planeCoords: { u: offsetU, v: offsetV }
            });
        };

        const pushRayWithSolvedOriginIfNeeded = (offsetU, offsetV, dirVector, description) => {
            let startP = {
                x: emissionOrigin.x + offsetU * uAxis.x + offsetV * vAxis.x,
                y: emissionOrigin.y + offsetU * uAxis.y + offsetV * vAxis.y,
                z: emissionOrigin.z + offsetU * uAxis.z + offsetV * vAxis.z
            };

            if (shouldSolveOriginsThroughStop && stopPlaneCenter3d && Number.isInteger(stopConfig?.index)) {
                const targetPoint = {
                    x: stopPlaneCenter3d.x + offsetU * stopPlaneU.x + offsetV * stopPlaneV.x,
                    y: stopPlaneCenter3d.y + offsetU * stopPlaneU.y + offsetV * stopPlaneV.y,
                    z: stopPlaneCenter3d.z + offsetU * stopPlaneU.z + offsetV * stopPlaneV.z
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
                    startP = refined;
                }
            }

            rayStartData.push({
                startP,
                dir: dirVector,
                description,
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
            pushRay(0, 0, unitChief, `Chief angle ray (${angleX}°, ${angleY}°) from ${isOnAxis ? 'exact on-axis (0,0)' : 'optimized'} position`);
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
                    ? Math.min(stopRadiusLimited, apertureRadius)
                    : apertureRadius;
            }
            
            const pupilScale = (Number.isFinite(Number(options?.pupilScale)) && Number(options.pupilScale) > 0)
                ? Number(options.pupilScale)
                : 1;
            const insideScale = (pattern === 'annular')
                ? (Number.isFinite(annularRingCount) && annularRingCount > 0 ? (annularRingCount / (annularRingCount + 1)) : 0.9)
                : 1;
            const halfExtent = Math.max(1e-6, effectiveRadius * pupilScale * insideScale);
            const offsets = pattern === 'annular'
                ? generateAnnularOffsets(rayCount, halfExtent, annularRingCount || 3)
                : generateCenteredGridOffsets(rayCount, halfExtent);

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
                    x: emissionOrigin.x + coord.offsetU * uAxis.x + coord.offsetV * vAxis.x,
                    y: emissionOrigin.y + coord.offsetU * uAxis.y + coord.offsetV * vAxis.y,
                    z: emissionOrigin.z + coord.offsetU * uAxis.z + coord.offsetV * vAxis.z
                }));
                const dirVectors = offsets.map(() => ({ x: unitChief.x, y: unitChief.y, z: unitChief.z }));
                const targetPoints = offsets.map((coord) => ({
                    x: stopPlaneCenter3d.x + coord.offsetU * stopPlaneU.x + coord.offsetV * stopPlaneV.x,
                    y: stopPlaneCenter3d.y + coord.offsetU * stopPlaneU.y + coord.offsetV * stopPlaneV.y,
                    z: stopPlaneCenter3d.z + coord.offsetU * stopPlaneU.z + coord.offsetV * stopPlaneV.z
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

            offsets.forEach((coord, index) => {
                let dirVector = unitChief;
                
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
                    const solved = Array.isArray(solvedOriginsBatch) ? solvedOriginsBatch[index] : null;
                    if (solved && Number.isFinite(solved.x) && Number.isFinite(solved.y) && Number.isFinite(solved.z)) {
                        rayStartData.push({
                            startP: { x: solved.x, y: solved.y, z: solved.z },
                            dir: unitChief,
                            description: `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`,
                            planeCoords: { u: coord.offsetU, v: coord.offsetV }
                        });
                    } else {
                        pushRayWithSolvedOriginIfNeeded(coord.offsetU, coord.offsetV, unitChief, `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`);
                    }
                } else {
                    pushRay(coord.offsetU, coord.offsetV, dirVector, `${pattern === 'annular' ? 'Annular' : 'Grid'} angle ray ${index + 1}`);
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
            objectSag = asphericSurfaceZ(r, asphericParams, surf.surfType === "Aspheric Odd" ? "odd" : "even") || 0;
            rrLog(`🔍 [RayRenderer] Rectangle Object面sag計算: r=${r.toFixed(3)}, sag=${objectSag.toFixed(6)}`);
        }
        
        // Apply sag to object Z position for finite objects only
        const actualObjectZ = isInfiniteObject ? objectZ : objectZ + objectSag;
        
        // console.log(`📍 Rectangle object position: (${centerX}, ${centerY}, ${objectZ})`);
        const apertureRadius = Number(surf.semidia) || Number(surf.thickness) || 10;
        const stopConfig = resolveStopConfig(opticalSystemRows, surfaceOrigins, actualObjectZ + (Number(surf.thickness) || 10), apertureRadius);
        const stopRadiusLimited = Math.min(stopConfig.radius, apertureRadius);
        const stopCenter = stopConfig.center || { x: 0, y: 0 };
        const stopZ = stopConfig.z;
        const stopDeltaZ = stopZ - actualObjectZ;
        const canAimAtStop = !isInfiniteObject && Number.isFinite(stopDeltaZ) && stopDeltaZ > 1e-6;
        
        const pointEmission = true; // Rectangle objects now emit from their central point

        if (rayCount === 1) {
            // Single ray from center
            const startP = { x: centerX, y: centerY, z: actualObjectZ };
            const targetX = centerX;
            const targetY = centerY;
            const deltaZ = Number(surf.thickness) || 10.0;
            const length = Math.sqrt(deltaZ * deltaZ);
            const dirX = 0;
            const dirY = 0;
            const dirZ = deltaZ / length;
            
            rayStartData.push({
                startP: startP,
                dir: { x: dirX, y: dirY, z: dirZ },
                description: `Single Rectangle ray from center (${centerX}, ${centerY})`
            });
        } else if (pattern === 'grid' || pattern === 'annular') {
            console.log(`🔍 [RayRenderer-Rectangle] Pattern: ${pattern}, canAimAtStop: ${canAimAtStop}, isInfiniteObject: ${isInfiniteObject}`);
            console.log(`🔍 [RayRenderer-Rectangle] Stop config:`, { stopCenter, stopZ, stopDeltaZ, stopIndex: stopConfig.index });
            
            let chiefDirection;
            if (isInfiniteObject) {
                chiefDirection = { x: 0, y: 0, z: 1 };
            } else if (canAimAtStop) {
                // Use the robust chief ray direction finder from gen-ray-cross-finite.js
                console.log(`🔍 [RayRenderer-Rectangle] Calculating chief ray direction using grid search fallback...`);
                const chiefDirResult = findFiniteSystemChiefRayDirection(
                    { x: centerX, y: centerY, z: actualObjectZ },
                    { x: stopCenter.x, y: stopCenter.y, z: stopZ },
                    stopConfig.index,
                    opticalSystemRows,
                    true, // debugMode
                    wavelengthUm // wavelength (μm)
                );
                
                if (chiefDirResult) {
                    chiefDirection = {
                        x: chiefDirResult.i,
                        y: chiefDirResult.j,
                        z: chiefDirResult.k
                    };
                    console.log(`✅ [RayRenderer-Rectangle] Chief ray direction from grid search: (${chiefDirection.x.toFixed(6)}, ${chiefDirection.y.toFixed(6)}, ${chiefDirection.z.toFixed(6)})`);
                } else {
                    // Fallback to geometric calculation
                    console.warn(`⚠️ [RayRenderer-Rectangle] Chief ray direction finder failed, using geometric fallback`);
                    chiefDirection = {
                        x: stopCenter.x - centerX,
                        y: stopCenter.y - centerY,
                        z: stopDeltaZ
                    };
                }
            } else {
                console.log(`⚠️ [RayRenderer-Rectangle] Cannot aim at stop, using simple Z direction`);
                chiefDirection = { x: 0, y: 0, z: Number(surf.thickness) || 10.0 };
            }
            
            const { dir: unitChief, u, v } = buildPerpendicularBasis(chiefDirection);
            const centerPoint = { x: centerX, y: centerY, z: actualObjectZ };
            let effectiveRadius = Number.isFinite(stopRadiusLimited) && stopRadiusLimited > 0
                ? Math.min(stopRadiusLimited, apertureRadius)
                : apertureRadius;

            // Optional external clamp (used by fast merit evaluation to avoid vignetting).
            const apLim = Number(apertureLimit);
            if (Number.isFinite(apLim) && apLim > 0) {
                effectiveRadius = Math.min(effectiveRadius, apLim);
            }
            const halfExtent = Math.max(1e-6, effectiveRadius);
            const propagationDistance = Number(surf.thickness) || 10.0;
            const offsets = pattern === 'annular'
                ? generateAnnularOffsets(rayCount, halfExtent, annularRingCount || 3)
                : generateCenteredGridOffsets(rayCount, halfExtent);

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
                    const deltaX = targetPoint.x - startP.x;
                    const deltaY = targetPoint.y - startP.y;
                    const deltaZ = targetPoint.z - startP.z;
                    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) || 1;
                    dirVector = {
                        x: deltaX / length,
                        y: deltaY / length,
                        z: deltaZ / length
                    };
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
                    description: `${pattern === 'annular' ? 'Annular' : 'Rectangle grid'} ray ${index + 1}`
                });
            });
        } else {
            console.log(`🔍 [RayRenderer-Rectangle-Else] Pattern: ${pattern}, canAimAtStop: ${canAimAtStop}, isInfiniteObject: ${isInfiniteObject}`);
            console.log(`🔍 [RayRenderer-Rectangle-Else] rayCount: ${rayCount}`);
            
            // Annular pattern for Rectangle objects
            // Calculate chief ray direction first
            const fallbackDeltaZ = Number(surf.thickness) || 10.0;
            let chiefDirection;
            
            if (isInfiniteObject) {
                chiefDirection = { x: 0, y: 0, z: 1 };
            } else if (canAimAtStop) {
                // Use the robust chief ray direction finder from gen-ray-cross-finite.js
                console.log(`🔍 [RayRenderer-Rectangle-Else] Calculating chief ray direction using grid search fallback...`);
                const chiefDirResult = findFiniteSystemChiefRayDirection(
                    { x: centerX, y: centerY, z: actualObjectZ },
                    { x: stopCenter.x, y: stopCenter.y, z: stopZ },
                    stopConfig.index,
                    opticalSystemRows,
                    true, // debugMode
                    wavelengthUm // wavelength (μm)
                );
                
                if (chiefDirResult) {
                    chiefDirection = {
                        x: chiefDirResult.i,
                        y: chiefDirResult.j,
                        z: chiefDirResult.k
                    };
                    console.log(`✅ [RayRenderer-Rectangle-Else] Chief ray direction from grid search: (${chiefDirection.x.toFixed(6)}, ${chiefDirection.y.toFixed(6)}, ${chiefDirection.z.toFixed(6)})`);
                } else {
                    // Fallback to geometric calculation
                    console.warn(`⚠️ [RayRenderer-Rectangle-Else] Chief ray direction finder failed, using geometric fallback`);
                    chiefDirection = {
                        x: stopCenter.x - centerX,
                        y: stopCenter.y - centerY,
                        z: stopDeltaZ
                    };
                }
            } else {
                console.log(`⚠️ [RayRenderer-Rectangle-Else] Cannot aim at stop, using simple Z direction`);
                chiefDirection = { x: 0, y: 0, z: fallbackDeltaZ };
            }
            
            // Normalize chief direction
            const chiefLength = Math.sqrt(chiefDirection.x * chiefDirection.x + chiefDirection.y * chiefDirection.y + chiefDirection.z * chiefDirection.z) || 1;
            const unitChiefDir = {
                x: chiefDirection.x / chiefLength,
                y: chiefDirection.y / chiefLength,
                z: chiefDirection.z / chiefLength
            };
            
            // Add chief ray
            rayStartData.push({
                startP: { x: centerX, y: centerY, z: actualObjectZ },
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
    console.log('🔍 [ray-renderer.ts] Running in popup window - logs will mirror to parent');
    try {
        (window as any).opener.console?.log?.('✅ [ray-renderer.ts] Child popup loaded');
    } catch (_) {}
}
