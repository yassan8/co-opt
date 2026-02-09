/**
 * Ray rendering utilities for optical system visualization
 */

import * as THREE from 'three';
import { traceRay, traceRayHitPoint, calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { findStopSurface } from './system-renderer.ts';
import { asphericSurfaceZ } from './surface.ts';
import { findInfiniteSystemChiefRayOrigin } from '../raytracing/generation/gen-ray-cross-infinite.ts';
import { findFiniteSystemChiefRayDirection } from '../raytracing/generation/gen-ray-cross-finite.ts';

// Global variables for ray pattern and color mode
let rayEmissionPattern = 'annular'; // 'grid' or 'annular'
let rayColorMode = 'object'; // 'object' or 'segment'

function normalizeAnnularRingCount(value) {
    if (value === undefined || value === null) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.max(1, Math.min(Math.floor(numeric), 32));
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

function solveRayDirectionToStopPointFast(centerPoint, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) return null;
    if (!centerPoint || !stopTarget3d) return null;

    const dx0 = Number(stopTarget3d.x) - Number(centerPoint.x);
    const dy0 = Number(stopTarget3d.y) - Number(centerPoint.y);
    const dz0 = Number(stopTarget3d.z) - Number(centerPoint.z);
    if (!Number.isFinite(dx0) || !Number.isFinite(dy0) || !Number.isFinite(dz0)) return null;
    if (Math.abs(dz0) < 1e-9) return null;

    const buildDirFromSlopes = (u, v) => {
        const zSign = dz0 >= 0 ? 1 : -1;
        const dir = normalizeVector3({ x: u, y: v, z: zSign }, { x: 0, y: 0, z: zSign });
        return dir;
    };

    // Initial guess: straight line to the stop center.
    const initial = normalizeVector3({ x: dx0, y: dy0, z: dz0 }, { x: 0, y: 0, z: 1 });
    let u = (Math.abs(initial.z) > 1e-9) ? (initial.x / initial.z) : 0;
    let v = (Math.abs(initial.z) > 1e-9) ? (initial.y / initial.z) : 0;

    const maxIter = 6;
    const tolMm = 1e-3;
    const eps = 1e-4;
    const maxSlope = 2.5;

    for (let iter = 0; iter < maxIter; iter++) {
        u = Math.max(-maxSlope, Math.min(maxSlope, u));
        v = Math.max(-maxSlope, Math.min(maxSlope, v));

        const dir = buildDirFromSlopes(u, v);
        const ray = { wavelength: wavelengthUm, pos: { ...centerPoint }, dir };
        const hit = traceRayHitPoint(opticalSystemRows, ray, 1.0, stopIdx);
        if (!hit) return null;

        const ex = Number(hit.x) - Number(stopTarget3d.x);
        const ey = Number(hit.y) - Number(stopTarget3d.y);
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = Math.hypot(ex, ey);
        if (err < tolMm) {
            return dir;
        }

        // Finite-difference Jacobian.
        const hitU = traceRayHitPoint(opticalSystemRows, { wavelength: wavelengthUm, pos: { ...centerPoint }, dir: buildDirFromSlopes(u + eps, v) }, 1.0, stopIdx);
        const hitV = traceRayHitPoint(opticalSystemRows, { wavelength: wavelengthUm, pos: { ...centerPoint }, dir: buildDirFromSlopes(u, v + eps) }, 1.0, stopIdx);
        if (!hitU || !hitV) return null;

        const j11 = (Number(hitU.x) - Number(hit.x)) / eps;
        const j21 = (Number(hitU.y) - Number(hit.y)) / eps;
        const j12 = (Number(hitV.x) - Number(hit.x)) / eps;
        const j22 = (Number(hitV.y) - Number(hit.y)) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) return null;

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
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
        if (stepNorm > 0.5) {
            const scale = 0.5 / stepNorm;
            du *= scale;
            dv *= scale;
        }
        u += du;
        v += dv;
    }

    // Not converged; use best-effort direction.
    return buildDirFromSlopes(u, v);
}

function solveChiefRayDirectionToStopCenterFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    return solveRayDirectionToStopPointFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm);
}

function solveRayOriginToStopPointFast(initialOrigin, dirVector, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) return null;
    if (!initialOrigin || !dirVector || !stopTarget3d) return null;

    const baseDir = normalizeVector3(dirVector, { x: 0, y: 0, z: 1 });
    if (!Number.isFinite(baseDir.x) || !Number.isFinite(baseDir.y) || !Number.isFinite(baseDir.z)) return null;

    let origin = { x: Number(initialOrigin.x), y: Number(initialOrigin.y), z: Number(initialOrigin.z) };
    if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return null;

    const eps = 1e-3;
    const tolMm = 1e-3;
    const maxIter = 10;
    const maxStep = 5.0;

    const hitAt = (o) => {
        const ray = { wavelength: wavelengthUm, pos: { ...o }, dir: { ...baseDir } };
        return traceRayHitPoint(opticalSystemRows, ray, 1.0, stopIdx);
    };

    for (let iter = 0; iter < maxIter; iter++) {
        const hit = hitAt(origin);
        if (!hit) return null;
        const ex = Number(hit.x) - Number(stopTarget3d.x);
        const ey = Number(hit.y) - Number(stopTarget3d.y);
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = Math.hypot(ex, ey);
        if (err < tolMm) {
            return origin;
        }

        const hitX = hitAt({ x: origin.x + eps, y: origin.y, z: origin.z });
        const hitY = hitAt({ x: origin.x, y: origin.y + eps, z: origin.z });
        if (!hitX || !hitY) return null;

        const j11 = (Number(hitX.x) - Number(hit.x)) / eps;
        const j21 = (Number(hitX.y) - Number(hit.y)) / eps;
        const j12 = (Number(hitY.x) - Number(hit.x)) / eps;
        const j22 = (Number(hitY.y) - Number(hit.y)) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) return null;

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;

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

    return origin;
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
    
