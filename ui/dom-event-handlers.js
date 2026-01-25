/**
 * DOM Event Handlers Module
 * ドキュメントのDOMContentLoadedイベントとその他のUIイベントハンドラーを管理
 */

import { getOpticalSystemRows, getObjectRows, getSourceRows, outputParaxialDataToDebug, displayCoordinateTransformMatrix } from '../utils/data-utils.js';
import { showSpotDiagram, showTransverseAberrationDiagram, showLongitudinalAberrationDiagram, showAstigmatismDiagram, createFieldSettingFromObject } from '../analysis/optical-analysis.js';
import { updateSurfaceNumberSelect } from './ui-updates.js';
import { generateSurfaceOptions } from '../evaluation/spot-diagram.js';
import { saveTableData as saveSourceTableData } from '../data/table-source.js';
import { saveTableData as saveObjectTableData } from '../data/table-object.js';
import { saveTableData as saveLensTableData } from '../data/table-optical-system.js';
import { tableSource } from '../data/table-source.js';
import { tableObject } from '../data/table-object.js';
import { tableOpticalSystem } from '../data/table-optical-system.js';
import { debugWASMSystem, quickWASMComparison } from '../debug/debug-utils.js';
import { BLOCK_SCHEMA_VERSION, DEFAULT_STOP_SEMI_DIAMETER, configurationHasBlocks, validateBlocksConfiguration, expandBlocksToOpticalSystemRows, deriveBlocksFromLegacyOpticalSystemRows } from '../data/block-schema.js';
import { calculateBackFocalLength, calculateImageDistance, calculateFocalLength, calculateParaxialData, findStopSurfaceIndex } from '../raytracing/core/ray-paraxial.js';
import { traceRay, traceRayHitPoint } from '../raytracing/core/ray-tracing.js';
import { findInfiniteSystemChiefRayOrigin, findApertureBoundaryRays } from '../raytracing/generation/gen-ray-cross-infinite.js';
import { generateZMXText, downloadZMX } from '../import-export/zemax-export.js';
import { parseZMXArrayBufferToOpticalSystemRows } from '../import-export/zemax-import.js';
import { buildShareUrlFromCompressedString, decodeAllDataFromCompressedString, encodeAllDataToCompressedString, getCompressedStringFromLocationHash, getCompressedStringFromLocation } from '../utils/url-share.js';
import { listDesignVariablesFromBlocks } from '../optimization/design-variables.js';

function __zmxPickPrimaryWavelengthMicrons(sourceRows) {
    try {
        const rows = Array.isArray(sourceRows) ? sourceRows : [];
        const primary = rows.find(r => String(r?.primary ?? '').trim());
        const wl = Number((primary || rows[0])?.wavelength);
        return (Number.isFinite(wl) && wl > 0) ? wl : 0.5876;
    } catch (_) {
        return 0.5876;
    }
}

function __zmxGetStopRadiusMmFromRows(rows, stopIndex, entrancePupilDiameterMm) {
    try {
        const r = Array.isArray(rows) ? rows[stopIndex] : null;
        const raw = r?.semidia ?? r?.Semidia ?? r?.['Semi Diameter'] ?? r?.aperture ?? r?.Aperture ?? NaN;
        const sd = Math.abs(parseFloat(raw));
        if (Number.isFinite(sd) && sd > 0) {
            const isApertureField = !!(r && (r.aperture !== undefined || r.Aperture !== undefined));
            const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
            if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) return stopRadiusMm;
        }
    } catch (_) {}

    const enpd = Number(entrancePupilDiameterMm);
    if (Number.isFinite(enpd) && enpd > 0) return Math.abs(enpd) * 0.5;

    return DEFAULT_STOP_SEMI_DIAMETER;
}

function __zmxIsInfiniteConjugateFromObjectRow(opticalSystemRows) {
    try {
        const t = opticalSystemRows?.[0]?.thickness;
        if (t === Infinity) return true;
        const s = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
        return (s === 'INF' || s === 'INFINITY');
    } catch (_) {
        return false;
    }
}

function __zmxNormalizeDir(x, y, z) {
    const nx = Number(x);
    const ny = Number(y);
    const nz = Number(z);
    const L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!Number.isFinite(L) || L <= 0) return { x: 0, y: 0, z: 1 };
    return { x: nx / L, y: ny / L, z: nz / L };
}

function __zmxTraceRayToSurfaceIndex(opticalSystemRows, ray0, surfaceIndex) {
    try {
        return traceRayHitPoint(opticalSystemRows, ray0, 1.0, surfaceIndex);
    } catch (_) {
        return null;
    }
}

function __zmxSolveCrossRayToStopCoordAxis(opticalSystemRows, stopIndex, targetCoordMm, wavelengthMicrons, axis /* 'x'|'y' */, options = null) {
    const isInfinite = __zmxIsInfiniteConjugateFromObjectRow(opticalSystemRows);
    const zStart = (options && typeof options === 'object' && Number.isFinite(options.zStart)) ? Number(options.zStart) : (isInfinite ? -25 : 0);
    const axisLower = String(axis || 'y').toLowerCase();
    const useX = axisLower === 'x';
    const target = Number(targetCoordMm);
    const dirOverride = (options && typeof options === 'object') ? options.direction : null;
    const baseOrigin = (options && typeof options === 'object' && options.baseOrigin && typeof options.baseOrigin === 'object') ? options.baseOrigin : null;

    const evalFunc = (u) => {
        const uNum = Number(u);
        if (!Number.isFinite(uNum)) return { ok: false, blocked: true, value: Infinity };

        let ray0;
        if (isInfinite) {
            const dir = (dirOverride && typeof dirOverride === 'object') ? dirOverride : { x: 0, y: 0, z: 1 };
            const bx = baseOrigin ? Number(baseOrigin.x) : 0;
            const by = baseOrigin ? Number(baseOrigin.y) : 0;
            const bz = baseOrigin ? Number(baseOrigin.z) : zStart;
            ray0 = {
                pos: { x: bx + (useX ? uNum : 0), y: by + (useX ? 0 : uNum), z: bz },
                dir: { x: Number(dir.x), y: Number(dir.y), z: Number(dir.z) },
                wavelength: wavelengthMicrons
            };
        } else {
            ray0 = {
                pos: { x: 0, y: 0, z: zStart },
                dir: useX ? __zmxNormalizeDir(uNum, 0, 1) : __zmxNormalizeDir(0, uNum, 1),
                wavelength: wavelengthMicrons
            };
        }

        const hit = __zmxTraceRayToSurfaceIndex(opticalSystemRows, ray0, stopIndex);
        if (!hit) return { ok: false, blocked: true, value: Infinity, ray0 };
        const vStop = Number(useX ? hit.x : hit.y);
        if (!Number.isFinite(vStop)) return { ok: false, blocked: true, value: Infinity, ray0 };
        return { ok: true, blocked: false, value: vStop - target, ray0 };
    };

    const f0 = evalFunc(0);
    if (!f0.ok && !f0.ray0) return null;

    if (f0.ok && Number.isFinite(f0.value) && Math.abs(f0.value) < 1e-7) return f0.ray0;

    let lo = 0;
    // Pick the initial search direction based on whether u needs to increase or decrease
    // to approach the target coordinate at the stop.
    const dirSign = (f0.ok && Number.isFinite(f0.value) && f0.value < 0) ? +1 : -1;
    let hi = (isInfinite ? Math.max(1e-6, Math.abs(target) || 1) : 0.05) * dirSign;
    let fhiObj = evalFunc(hi);
    let tries = 0;
    while (tries < 40) {
        if (fhiObj.ok) {
            if ((f0.ok && Number.isFinite(f0.value) && Number.isFinite(fhiObj.value)) && (f0.value === 0 || (f0.value > 0) !== (fhiObj.value > 0))) break;
        } else if (fhiObj.blocked) {
            break;
        }
        hi *= 2;
        fhiObj = evalFunc(hi);
        tries++;
    }
    if (!(fhiObj.ok && f0.ok && Number.isFinite(f0.value) && Number.isFinite(fhiObj.value) && (f0.value === 0 || (f0.value > 0) !== (fhiObj.value > 0)))) {
        return null;
    }

    let bestRay0 = (fhiObj && fhiObj.ray0) ? fhiObj.ray0 : (f0.ray0 || null);
    for (let it = 0; it < 50; it++) {
        const mid = (lo + hi) * 0.5;
        const fm = evalFunc(mid);
        if (fm.ray0) bestRay0 = fm.ray0;

        if (fm.ok) {
            if (Math.abs(fm.value) < 1e-7) {
                bestRay0 = fm.ray0;
                break;
            }
            if (fm.value >= 0) hi = mid;
            else lo = mid;
        } else {
            hi = mid;
        }
    }
    return bestRay0;
}

function __zmxIsCoordTransRow(row) {
    const st = String(row?.surfType ?? row?.['surf type'] ?? '').toLowerCase();
    return st === 'coord break' || st === 'coordinate break' || st === 'cb';
}

function __zmxIsObjectRow(row) {
    const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
    return t === 'object';
}

// traceRay() rayPath does not record intersections for Object/Coord Break rows.
// Convert table surfaceIndex -> rayPath point index.
function __zmxGetRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const sIdx = Math.max(0, Math.min(Number(surfaceIndex), opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (__zmxIsCoordTransRow(row)) continue;
        if (__zmxIsObjectRow(row)) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function __zmxGetRayPointAtSurfaceIndex(rayPath, opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(rayPath)) return null;
    const pIdx = __zmxGetRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex);
    if (pIdx === null) return null;
    if (pIdx >= 0 && pIdx < rayPath.length) return rayPath[pIdx];
    return null;
}

function __zmxDirectionFromObjectRowDeg(objectRow) {
    try {
        const angleX = Number(objectRow?.xHeightAngle ?? 0) * Math.PI / 180;
        const angleY = Number(objectRow?.yHeightAngle ?? 0) * Math.PI / 180;
        const cosX = Math.cos(angleX);
        const cosY = Math.cos(angleY);
        const sinX = Math.sin(angleX);
        const sinY = Math.sin(angleY);
        const dx = sinX * cosY;
        const dy = sinY * cosX;
        const dz = cosX * cosY;
        return __zmxNormalizeDir(dx, dy, dz);
    } catch (_) {
        return { x: 0, y: 0, z: 1 };
    }
}

function __zmxComputeSurfaceOriginsZLikeGenRayCross(opticalSystemRows) {
    const zs = [];
    let cumulativeZ = 0;
    const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
    for (let i = 0; i < rows.length; i++) {
        zs.push(Number(cumulativeZ) || 0);
        const thickness = rows[i]?.thickness;
        if (thickness !== undefined && thickness !== null && thickness !== 'INF' && thickness !== 'Infinity') {
            const numericThickness = parseFloat(thickness);
            if (!isNaN(numericThickness)) cumulativeZ += numericThickness;
        }
    }
    return zs;
}

function __zmxApplySemidiaOverridesFromMarginalRays(activeCfg, rowsToApply, sourceRows, entrancePupilDiameterMm, objectRows) {
    if (!activeCfg || typeof activeCfg !== 'object' || !Array.isArray(rowsToApply) || rowsToApply.length === 0) {
        return { ok: false, reason: 'invalid inputs' };
    }

    const stopIndex = findStopSurfaceIndex(rowsToApply);
    if (stopIndex < 0) return { ok: false, reason: 'stop not found' };

    const wl = __zmxPickPrimaryWavelengthMicrons(sourceRows);
    const stopRadiusMm = __zmxGetStopRadiusMmFromRows(rowsToApply, stopIndex, entrancePupilDiameterMm);
    const marginMm = 0;

    // Ignore tiny positive radii caused by floating-point noise (e.g. ~1e-15).
    // Use both an absolute and stop-relative floor to avoid polluting semidiaOverrides/blocks.aperture.
    const MIN_SEMIDIA_ABS_MM = 1e-6;
    const MIN_SEMIDIA_REL_TO_STOP = 1e-6;
    const minUsefulRmm = Math.max(MIN_SEMIDIA_ABS_MM, Math.abs(Number(stopRadiusMm) || 0) * MIN_SEMIDIA_REL_TO_STOP);

    const paths = [];

    const isInfinite = __zmxIsInfiniteConjugateFromObjectRow(rowsToApply);
    const fields = (Array.isArray(objectRows) && objectRows.length > 0) ? objectRows : [{ xHeightAngle: 0, yHeightAngle: 0 }];

    // Avoid a chicken/egg issue for high field angles:
    // - Chief/boundary ray search can fail if surfaces have too-small default semidia (e.g. 10mm)
    // - But we need those rays to *compute* a better semidia
    // So we temporarily relax physical apertures during tracing by setting large semidia.
    const BIG_SEMIDIA_MM = Math.max(200, Math.abs(Number(stopRadiusMm) || 0) * 20, 100);
    const originalSemidias = new Array(rowsToApply.length);
    try {
        for (let i = 0; i < rowsToApply.length; i++) {
            const r = rowsToApply[i];
            if (!r || typeof r !== 'object') continue;
            originalSemidias[i] = r.semidia;
            const t = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
            if (t === 'object' || t === 'image') continue;
            if (i === stopIndex || t === 'stop') {
                r.semidia = stopRadiusMm;
                continue;
            }
            if (__zmxIsCoordTransRow(r)) continue;
            r.semidia = BIG_SEMIDIA_MM;
        }
    } catch (_) {}

    if (isInfinite) {
        // Use the same robust chief/boundary search used by the ray visualizer (gen-ray-cross-infinite.js).
        const zs = __zmxComputeSurfaceOriginsZLikeGenRayCross(rowsToApply);
        const stopCenter = { x: 0, y: 0, z: Number(zs?.[stopIndex] ?? 0) };

        for (const f of fields) {
            const dirXYZ = __zmxDirectionFromObjectRowDeg(f);
            const dirIJK = { i: dirXYZ.x, j: dirXYZ.y, k: dirXYZ.z };

            const chiefOrigin = findInfiniteSystemChiefRayOrigin(
                dirIJK,
                stopCenter,
                stopIndex,
                rowsToApply,
                false,
                null,
                wl
            );

            if (!chiefOrigin) continue;

            const boundary = findApertureBoundaryRays(
                chiefOrigin,
                dirXYZ,
                rowsToApply,
                { radius: stopRadiusMm },
                { debugMode: false, wavelength: wl, targetSurfaceIndex: null }
            );

            for (const b of Array.isArray(boundary) ? boundary : []) {
                const origin = b?.origin;
                const dir = b?.rayDirection;
                if (!origin || !dir) continue;
                const ray0 = { pos: { x: Number(origin.x), y: Number(origin.y), z: Number(origin.z) }, dir: { x: Number(dir.x), y: Number(dir.y), z: Number(dir.z) }, wavelength: wl };
                const p = traceRay(rowsToApply, ray0, 1.0, null, null);
                if (Array.isArray(p)) paths.push(p);
            }
        }
    } else {
        // Finite conjugates: keep the legacy on-axis approximation (better than default 10).
        const ray0y = __zmxSolveCrossRayToStopCoordAxis(rowsToApply, stopIndex, stopRadiusMm, wl, 'y');
        const ray0x = __zmxSolveCrossRayToStopCoordAxis(rowsToApply, stopIndex, stopRadiusMm, wl, 'x');
        if (ray0y) {
            const p = traceRay(rowsToApply, ray0y, 1.0, null, null);
            if (Array.isArray(p)) paths.push(p);
        }
        if (ray0x) {
            const p = traceRay(rowsToApply, ray0x, 1.0, null, null);
            if (Array.isArray(p)) paths.push(p);
        }
    }

    // Restore original semidia before writing computed values back.
    try {
        for (let i = 0; i < rowsToApply.length; i++) {
            const r = rowsToApply[i];
            if (!r || typeof r !== 'object') continue;
            r.semidia = originalSemidias[i];
        }
    } catch (_) {}

    if (paths.length === 0) {
        try {
            if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
            activeCfg.metadata.lastSemidiaEstimate = { ok: false, reason: 'ray trace failed', isInfinite, stopRadiusMm, fields: Array.isArray(fields) ? fields.length : 0 };
        } catch (_) {}
        return { ok: false, reason: 'ray trace failed' };
    }

    // Compute max radius per surface index (rayPath indexing follows gen-ray-cross-* mapping).
    const maxR = new Array(rowsToApply.length).fill(0);
    for (const p of paths) {
        for (let si = 0; si < rowsToApply.length; si++) {
            const hit = __zmxGetRayPointAtSurfaceIndex(p, rowsToApply, si);
            if (!hit) continue;
            const x = Number(hit.x);
            const y = Number(hit.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const r = Math.sqrt(x * x + y * y);
            if (Number.isFinite(r) && r > maxR[si]) maxR[si] = r;
        }
    }

    // Index blocks by blockId for canonical aperture writes.
    const blockById = new Map();
    try {
        if (Array.isArray(activeCfg.blocks)) {
            for (const b of activeCfg.blocks) {
                const id = String(b?.blockId ?? '').trim();
                if (id) blockById.set(id, b);
            }
        }
    } catch (_) {}

    // Persist stop radius into Stop block when possible.
    try {
        if (Array.isArray(activeCfg.blocks)) {
            const stopBlock = activeCfg.blocks.find(b => b && String(b.blockType ?? '') === 'Stop');
            if (stopBlock) {
                if (!stopBlock.parameters || typeof stopBlock.parameters !== 'object') stopBlock.parameters = {};
                stopBlock.parameters.semiDiameter = stopRadiusMm;
            }
        }
    } catch (_) {}

    // Build semidiaOverrides (legacy support) and apply to current rowsToApply.
    // IMPORTANT: Render is blocks-first, so we also write back into the block.aperture fields.
    const overrides = (activeCfg.semidiaOverrides && typeof activeCfg.semidiaOverrides === 'object') ? { ...activeCfg.semidiaOverrides } : {};
    const provKey = (row, surfaceIndex) => {
        const bid = String(row?._blockId ?? '').trim();
        const role = String(row?._surfaceRole ?? '').trim();
        if (bid && role) return `p:${bid}|${role}`;
        return `i:${surfaceIndex}`;
    };

    const writeBlockAperture = (row, sd) => {
        try {
            const bid = String(row?._blockId ?? '').trim();
            const role = String(row?._surfaceRole ?? '').trim();
            if (!bid || !role) return;
            const blk = blockById.get(bid);
            if (!blk || typeof blk !== 'object') return;
            if (!blk.aperture || typeof blk.aperture !== 'object') blk.aperture = {};
            blk.aperture[role] = sd;
        } catch (_) {}
    };

    for (let si = 0; si < rowsToApply.length; si++) {
        const row = rowsToApply[si];
        if (!row || typeof row !== 'object') continue;
        const t = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
        if (t === 'object' || t === 'image') continue;
        if (si === stopIndex || t === 'stop') {
            row.semidia = stopRadiusMm;
            continue;
        }

        const r = Number(maxR[si]);
        if (!Number.isFinite(r) || r <= minUsefulRmm) continue;
        const sd = r + marginMm;
        const key = provKey(row, si);
        overrides[key] = sd;
        row.semidia = sd;
        writeBlockAperture(row, sd);
    }

    // If semidia was missing in the imported .zmx, derived semidia can differ surface-to-surface.
    // We normalize ONLY the parts that define a visually clean outer contour:
    // - Singlet (Lens/PositiveLens): normalize both surfaces to max.
    // - Doublet: normalize s2 only.
    // - Triplet: normalize s2 and s3 only.
    // Other surfaces are allowed to taper (diagonal connectors are acceptable) to avoid bulky outlines
    // that can overlap downstream lens groups.
    try {
        /** @type {Map<string, { roles: Map<string, number>, rows: Array<{si:number,row:any}>, block:any, blockType:string }>} */
        const byBlockId = new Map();
        for (let si = 0; si < rowsToApply.length; si++) {
            const row = rowsToApply[si];
            if (!row || typeof row !== 'object') continue;
            const t = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
            if (t === 'object' || t === 'image' || t === 'stop') continue;

            const bid = String(row?._blockId ?? '').trim();
            const role = String(row?._surfaceRole ?? '').trim();
            if (!bid || !role) continue;

            const blk = blockById.get(bid);
            const bt = String(blk?.blockType ?? row?._blockType ?? '').trim();
            if (!(bt === 'Lens' || bt === 'PositiveLens' || bt === 'Doublet' || bt === 'Triplet')) continue;

            const sd = Number(row.semidia);
            if (!Number.isFinite(sd) || sd <= 0) continue;

            let rec = byBlockId.get(bid);
            if (!rec) {
                rec = { roles: new Map(), rows: [], block: blk, blockType: bt };
                byBlockId.set(bid, rec);
            }
            rec.roles.set(role, sd);
            rec.rows.push({ si, row });
        }

        const normalizeRolesToMax = (rec, rolesToNormalize) => {
            const values = Array.from(rec.roles.values()).filter(v => Number.isFinite(v) && v > 0);
            if (values.length === 0) return;
            const maxSd = Math.max(...values);
            if (!Number.isFinite(maxSd) || maxSd <= 0) return;

            // Update canonical block aperture
            const blk = rec.block;
            if (blk && typeof blk === 'object') {
                if (!blk.aperture || typeof blk.aperture !== 'object') blk.aperture = {};
                for (const role of rolesToNormalize) {
                    if (rec.roles.has(role)) blk.aperture[role] = maxSd;
                }
            }

            // Update rows + semidiaOverrides keys for the normalized roles
            for (const { si, row } of rec.rows) {
                const role = String(row?._surfaceRole ?? '').trim();
                if (!rolesToNormalize.includes(role)) continue;
                try { row.semidia = maxSd; } catch (_) {}
                const key = provKey(row, si);
                overrides[key] = maxSd;
            }
        };

        for (const rec of byBlockId.values()) {
            const bt = String(rec.blockType ?? '').trim();
            if (bt === 'Lens' || bt === 'PositiveLens') {
                // Normalize all surfaces for singlets
                normalizeRolesToMax(rec, Array.from(rec.roles.keys()));
            } else if (bt === 'Doublet') {
                // User rule: outer contour anchor is s2
                normalizeRolesToMax(rec, ['s2']);
            } else if (bt === 'Triplet') {
                // User rule: outer contour anchors are s2, s3
                normalizeRolesToMax(rec, ['s2', 's3']);
            }
        }
    } catch (_) {}

    activeCfg.semidiaOverrides = overrides;
    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.lastSemidiaEstimate = { ok: true, isInfinite, stopRadiusMm, paths: paths.length, wavelengthMicrons: wl };
    } catch (_) {}
    return { ok: true, stopRadiusMm, wavelengthMicrons: wl };
}

function derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wavelengthMicrons, preferEntrancePupil) {
    let pupilDiameterMm = DEFAULT_STOP_SEMI_DIAMETER * 2;
    let focalLengthMm = 100.0;

    // Prefer paraxial pupils (EnPD/ExPD). Fallback to Stop.semidia.
    try {
        const paraxial = calculateParaxialData(opticalSystemRows, wavelengthMicrons);
        const enpd = Number(paraxial?.entrancePupilDiameter);
        const expd = Number(paraxial?.exitPupilDiameter);

        const preferred = preferEntrancePupil ? enpd : expd;
        const alternate = preferEntrancePupil ? expd : enpd;
        if (Number.isFinite(preferred) && preferred > 0) {
            pupilDiameterMm = Math.abs(preferred);
        } else if (Number.isFinite(alternate) && alternate > 0) {
            pupilDiameterMm = Math.abs(alternate);
        }

        const fl = Number(paraxial?.focalLength);
        if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) {
            focalLengthMm = Math.abs(fl);
        }
    } catch (_) {
        // ignore; fallback below
    }

    // Stop-based fallback for pupil diameter
    try {
        const stopIndex = findStopSurfaceIndex(opticalSystemRows);
        const stopRow = (stopIndex >= 0) ? opticalSystemRows?.[stopIndex] : null;
        const sd = Math.abs(parseFloat(stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.['Semi Diameter'] ?? stopRow?.aperture ?? stopRow?.Aperture ?? NaN));
        if (Number.isFinite(sd) && sd > 0) {
            const isApertureField = stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined);
            const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
            if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) {
                pupilDiameterMm = stopRadiusMm * 2;
            }
        }
    } catch (_) {
        // ignore
    }

    // Focal length fallback
    try {
        const fl = calculateFocalLength(opticalSystemRows, wavelengthMicrons);
        if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) {
            focalLengthMm = Math.abs(fl);
        }
    } catch (_) {
        // ignore
    }

    return { pupilDiameterMm, focalLengthMm };
}
import { getGlassDataWithSellmeier, findSimilarGlassesByNdVd, findSimilarGlassNames } from '../data/glass.js';
import { openGlassMapWindow } from '../data/glass-map.js';
import { normalizeDesign } from '../optimization/normalize-design.js';

function __blocks_setBlockGlassRegionConstraint(blockId, region) {
    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return { ok: false, reason: 'systemConfigurations not found.' };

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex(c => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };

    const b = activeCfg.blocks.find(x => x && String(x.blockId ?? '') === String(blockId));
    if (!b) return { ok: false, reason: `block not found: ${String(blockId)}` };

    const minNd = Number(region?.minNd);
    const maxNd = Number(region?.maxNd);
    const minVd = Number(region?.minVd);
    const maxVd = Number(region?.maxVd);
    if (![minNd, maxNd, minVd, maxVd].every(Number.isFinite)) {
        return { ok: false, reason: 'invalid region (must be finite numbers)' };
    }

    if (!b.constraints || typeof b.constraints !== 'object') b.constraints = {};
    b.constraints = {
        ...b.constraints,
        glassRegion: {
            minNd: Math.min(minNd, maxNd),
            maxNd: Math.max(minNd, maxNd),
            minVd: Math.min(minVd, maxVd),
            maxVd: Math.max(minVd, maxVd)
        }
    };

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) return { ok: false, reason: 'block validation failed.' };
    } catch (_) {}

    try {
        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
        } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        }
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true };
}

// Small shared helpers (used by load/apply flows)

/**
 * @param {{severity?:'fatal'|'warning', phase?:string, message?:string, blockId?:string, surfaceIndex?:number}|any} issue
 * @returns {string}
 */
function formatLoadIssue(issue) {
    if (!issue || typeof issue !== 'object') return String(issue);
    const sev = issue.severity ? String(issue.severity) : 'unknown';
    const phase = issue.phase ? String(issue.phase) : 'unknown';
    const bid = issue.blockId ? ` blockId=${String(issue.blockId)}` : '';
    const si = (issue.surfaceIndex !== undefined && issue.surfaceIndex !== null) ? ` surface=${String(issue.surfaceIndex)}` : '';
    const msg = issue.message ? String(issue.message) : '';
    return `[${sev}](${phase})${bid}${si} ${msg}`.trim();
}

function setLoadWarnUIFlag(enabled) {
    try { window.__cooptLoadHasWarnings = !!enabled; } catch (_) {}
}

function appendLoadWarnToFileNameUI() {
    try {
        const el = document.getElementById('loaded-filename');
        if (!el) return;
        const t = String(el.textContent ?? '');
        if (t.includes('⚠️')) return;
        el.textContent = `${t} ⚠️`;
    } catch (_) {}
}

/**
 * @param {Array<{severity:'fatal'|'warning', phase:'parse'|'normalize'|'validate'|'expand', message:string, blockId?:string, surfaceIndex?:number}>} issues
 * @param {{ filename?: string }} context
 * @returns {boolean} true if no fatal issues
 */
function showLoadErrors(issues, context = {}) {
    const list = Array.isArray(issues) ? issues : [];
    const fatals = list.filter(i => i && i.severity === 'fatal');
    const warnings = list.filter(i => i && i.severity === 'warning');

    if (warnings.length > 0) {
        for (const w of warnings) console.warn('⚠️ [Load]', formatLoadIssue(w));
        setLoadWarnUIFlag(true);
        appendLoadWarnToFileNameUI();
    }

    if (fatals.length === 0) return true;

    for (const f of fatals) console.error('❌ [Load]', formatLoadIssue(f));
    const filename = context.filename ? `\nFile: ${context.filename}` : '';
    const body = fatals.slice(0, 6).map(formatLoadIssue).join('\n');
    const more = fatals.length > 6 ? `\n...and ${fatals.length - 6} more` : '';
    alert(`Load failed.${filename}\n\n${body}${more}`);
    return false;
}

function __blocks_mergeLegacyIndexFieldsIntoExpandedRows(legacyRows, expandedRows) {
    if (!Array.isArray(legacyRows) || !Array.isArray(expandedRows)) return;

    // Object row is not represented in Blocks; preserve user/imported values over schema defaults.
    // Do this even when row counts differ.
    try {
        const findLegacyObjectRow = () => {
            if (legacyRows.length === 0) return null;
            const first = legacyRows[0];
            const t0 = String(first?.['object type'] ?? first?.object ?? '').trim().toLowerCase();
            if (t0 === 'object' || legacyRows[0]?.id === 0) return first;
            for (const r of legacyRows) {
                const t = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
                if (t === 'object') return r;
            }
            return null;
        };

        const legacyObject = findLegacyObjectRow();
        const expandedObject = expandedRows.length > 0 ? expandedRows[0] : null;
        if (legacyObject && expandedObject && typeof expandedObject === 'object') {
            const ltRaw = legacyObject.thickness;
            const lt = String(ltRaw ?? '').trim();
            if (lt !== '') expandedObject.thickness = ltRaw;

            const lsRaw = legacyObject.semidia;
            const ls = String(lsRaw ?? '').trim();
            if (ls !== '') expandedObject.semidia = lsRaw;
        }
    } catch (_) {}

    // Preserve per-surface semidia from legacy/imported rows.
    // Do this even when row counts differ (Blocks conversion may change surface count).
    try {
        const n = Math.min(legacyRows.length, expandedRows.length);
        for (let i = 0; i < n; i++) {
            const legacy = legacyRows[i];
            const row = expandedRows[i];
            if (!legacy || typeof legacy !== 'object' || !row || typeof row !== 'object') continue;

            const t = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
            if (t === 'stop' || t === 'image') continue;

            const lsRaw = legacy.semidia ?? legacy['Semi Diameter'] ?? legacy['semi diameter'] ?? legacy.semiDiameter ?? legacy.semiDia;
            const ls = String(lsRaw ?? '').trim();
            if (ls !== '') row.semidia = lsRaw;
        }
    } catch (_) {}

    // Index-only fields (rindex/abbe) can be merged only when surface indices align.
    if (legacyRows.length !== expandedRows.length) return;
    for (let i = 0; i < expandedRows.length; i++) {
        const legacy = legacyRows[i];
        const row = expandedRows[i];
        if (!legacy || typeof legacy !== 'object' || !row || typeof row !== 'object') continue;

        const lr = String(legacy.rindex ?? '').trim();
        const la = String(legacy.abbe ?? '').trim();
        const rr = String(row.rindex ?? '').trim();
        const ra = String(row.abbe ?? '').trim();
        if (rr === '' && lr !== '') row.rindex = legacy.rindex;
        if (ra === '' && la !== '') row.abbe = legacy.abbe;
    }
}

function __blocks_overlayExpandedProvenanceIntoLegacyRows(legacyRows, expandedRows) {
    if (!Array.isArray(legacyRows) || !Array.isArray(expandedRows)) return;
    if (legacyRows.length === 0 || expandedRows.length === 0) return;

    const copyProv = (src, dst) => {
        if (!src || typeof src !== 'object' || !dst || typeof dst !== 'object') return;
        if ('_blockId' in src) dst._blockId = src._blockId;
        if ('_blockType' in src) dst._blockType = src._blockType;
        if ('_surfaceRole' in src) dst._surfaceRole = src._surfaceRole;
    };

    // Fast path: aligned lengths.
    if (legacyRows.length === expandedRows.length) {
        for (let i = 0; i < legacyRows.length; i++) copyProv(expandedRows[i], legacyRows[i]);
        return;
    }

    const normInf = (v) => {
        const s = String(v ?? '').trim();
        if (s === '') return '';
        if (/^inf(inity)?$/i.test(s)) return 'INF';
        return s.toUpperCase();
    };
    const normMat = (v) => String(v ?? '').trim().toUpperCase();
    const normObjType = (r) => String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();

    const isStop = (r) => normObjType(r) === 'stop';
    const isObject = (r) => normObjType(r) === 'object';
    const isImage = (r) => normObjType(r) === 'image';

    const match = (expRow, legacyRow) => {
        if (!expRow || !legacyRow) return false;
        // Keep Object/Image aligned only by type.
        if (isObject(expRow) || isObject(legacyRow)) return isObject(expRow) && isObject(legacyRow);
        if (isImage(expRow) || isImage(legacyRow)) return isImage(expRow) && isImage(legacyRow);
        if (isStop(expRow) || isStop(legacyRow)) return isStop(expRow) && isStop(legacyRow);

        // Surface rows: match loosely by material class and radius.
        const em = normMat(expRow.material);
        const lm = normMat(legacyRow.material);
        const er = normInf(expRow.radius);
        const lr = normInf(legacyRow.radius);

        // Prefer matching by radius, then material (when available).
        if (er && lr && er !== lr) return false;
        if (em && lm && em !== lm) {
            // Allow legacy empty material to match.
            if (lm !== '') return false;
        }
        return true;
    };

    // Greedy subsequence match: walk expanded rows and assign provenance to the next matching legacy row.
    let j = 0;
    for (let i = 0; i < expandedRows.length; i++) {
        const er = expandedRows[i];
        for (; j < legacyRows.length; j++) {
            const lr = legacyRows[j];
            if (match(er, lr)) {
                copyProv(er, lr);
                j++;
                break;
            }
        }
        if (j >= legacyRows.length) break;
    }
}

function __blocks_mergeLegacySemidiaIntoExpandedRows(legacyRows, expandedRows) {
    if (!Array.isArray(legacyRows) || !Array.isArray(expandedRows)) return;
    const n = Math.min(legacyRows.length, expandedRows.length);
    for (let i = 0; i < n; i++) {
        const legacy = legacyRows[i];
        const row = expandedRows[i];
        if (!legacy || typeof legacy !== 'object' || !row || typeof row !== 'object') continue;
        const t = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
        if (t === 'stop') continue; // Stop semiDiameter should come from Blocks.
        if (t === 'image') continue;
        const lsRaw = legacy.semidia ?? legacy['Semi Diameter'] ?? legacy['semi diameter'] ?? legacy.semiDiameter ?? legacy.semiDia;
        const ls = String(lsRaw ?? '').trim();
        if (ls !== '') row.semidia = lsRaw;
    }
}

let _psfCalculatorSingletonPromise = null;
async function getPSFCalculatorSingleton() {
    if (!_psfCalculatorSingletonPromise) {
        _psfCalculatorSingletonPromise = (async () => {
            const { PSFCalculator } = await import('../evaluation/psf/psf-calculator.js');
            return new PSFCalculator();
        })();
    }
    return _psfCalculatorSingletonPromise;
}

function createCancelToken() {
    return {
        aborted: false,
        reason: null,
        _listeners: [],
        abort(reason = 'User requested stop') {
            if (this.aborted) return;
            this.aborted = true;
            this.reason = reason;
            const ls = Array.isArray(this._listeners) ? this._listeners.slice() : [];
            for (const fn of ls) {
                try { fn(reason); } catch (_) {}
            }
        },
        onAbort(fn) {
            if (typeof fn !== 'function') return;
            if (this.aborted) {
                try { fn(this.reason); } catch (_) {}
                return;
            }
            this._listeners.push(fn);
        }
    };
}

function throwIfCancelled(cancelToken) {
    if (cancelToken && cancelToken.aborted) {
        const err = new Error(String(cancelToken.reason || 'Cancelled'));
        err.code = 'CANCELLED';
        throw err;
    }
}

async function raceWithCancel(promise, cancelToken) {
    if (!cancelToken) return await promise;
    if (cancelToken.aborted) throwIfCancelled(cancelToken);
    let cancelReject = null;
    const cancelPromise = new Promise((_, reject) => {
        cancelReject = reject;
        cancelToken.onAbort((reason) => {
            const err = new Error(String(reason || 'Cancelled'));
            err.code = 'CANCELLED';
            reject(err);
        });
    });
    try {
        return await Promise.race([promise, cancelPromise]);
    } finally {
        // Best-effort detach: keep memory bounded
        try {
            if (cancelReject && Array.isArray(cancelToken._listeners)) {
                cancelToken._listeners = cancelToken._listeners.filter(fn => fn !== cancelReject);
            }
        } catch (_) {}
    }
}

/**
 * セーブボタンのイベントハンドラーを設定
 */
function setupSaveButton() {
    const saveBtn = document.getElementById('save-all-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', function() {
            if (document.activeElement) document.activeElement.blur();

            const allData = buildAllDataForExport();

            // 現在Loadされているファイル名を取得
            const loadedFileName = localStorage.getItem('loadedFileName');
            let defaultName = 'optical_system_data';
            
            // 拡張子を除いたファイル名をデフォルトにする
            if (loadedFileName) {
                defaultName = loadedFileName.replace(/\.json$/i, '');
            }

            let filename = prompt("保存するファイル名を入力してください（拡張子 .json は自動で付きます）\n\n※ダウンロードフォルダに既存ファイルがある場合はブラウザが自動的に連番を付けます", defaultName);
            if (!filename) return;
            if (!filename.endsWith('.json')) filename += '.json';

            const blob = new Blob([JSON.stringify(allData, null, 2)], {type: "application/json"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            
            // 保存したファイル名を記録
            localStorage.setItem('loadedFileName', filename);
            
            // ファイル名表示を更新
            const fileNameElement = document.getElementById('loaded-file-name');
            if (fileNameElement) {
                fileNameElement.textContent = filename;
                fileNameElement.style.color = '#1a4d8f';
            }
            
            console.log('✅ データが保存されました:', filename);
        });
    }
}

function getSanitizedConfigurationsForExport() {
    // Configurationsデータを取得
    const systemConfigurations = localStorage.getItem('systemConfigurations');
    const parsedConfig = systemConfigurations ? JSON.parse(systemConfigurations) : null;

    // Normalize configurations payload for export:
    // - Source is global (top-level), so omit per-config source.
    // - Merit/systemRequirements are exported at top-level, so omit duplicates inside the wrapper.
    const sanitizedConfig = parsedConfig ? JSON.parse(JSON.stringify(parsedConfig)) : null;
    if (sanitizedConfig) {
        try { delete sanitizedConfig.meritFunction; } catch (_) {}
        try { delete sanitizedConfig.systemRequirements; } catch (_) {}
        try {
            if (Array.isArray(sanitizedConfig.configurations)) {
                for (const cfg of sanitizedConfig.configurations) {
                    if (cfg && typeof cfg === 'object') {
                        try { delete cfg.source; } catch (_) {}
                    }
                }
            }
        } catch (_) {}
    }
    return sanitizedConfig;
}

function buildAllDataForExport() {
    // Reference Focal Length を取得
    const refFLInput = document.getElementById('reference-focal-length');
    const referenceFocalLength = refFLInput ? refFLInput.value : '';

    // Prefer expanded Blocks for opticalSystem when available to avoid stale surface tables.
    let opticalSystemData = window.tableOpticalSystem ? window.tableOpticalSystem.getData() : [];
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        const activeId = systemConfig?.activeConfigId;
        const activeCfg = Array.isArray(systemConfig?.configurations)
            ? (systemConfig.configurations.find(c => String(c?.id) === String(activeId)) || systemConfig.configurations[0])
            : null;
        if (activeCfg && configurationHasBlocks(activeCfg)) {
            const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
            if (expanded && Array.isArray(expanded.rows)) {
                opticalSystemData = expanded.rows;
            }
        }
    } catch (_) {}

    return {
        source: window.tableSource ? window.tableSource.getData() : [],
        object: window.tableObject ? window.tableObject.getData() : [],
        opticalSystem: opticalSystemData,
        meritFunction: window.meritFunctionEditor ? window.meritFunctionEditor.getData() : [],
        systemRequirements: window.systemRequirementsEditor ? window.systemRequirementsEditor.getData() : [],
        systemData: {
            referenceFocalLength: referenceFocalLength
        },
        // Configurationsデータ（meritFunctionはグローバル）
        configurations: getSanitizedConfigurationsForExport()
    };
}

function setupShareUrlButton() {
    const shareBtn = document.getElementById('share-url-btn');
    if (!shareBtn) return;

    const WARN_LEN = 2000;
    const MAX_LEN = 30000;

    shareBtn.addEventListener('click', async () => {
        if (document.activeElement) document.activeElement.blur();

        let compressed;
        try {
            const allData = buildAllDataForExport();
            compressed = encodeAllDataToCompressedString(allData);
        } catch (e) {
            console.warn('❌ [Share] Failed to encode:', e);
            alert(e?.message || 'Failed to generate share URL');
            return;
        }

        const base = `${location.origin}${location.pathname}`;
        let url;
        try {
            url = buildShareUrlFromCompressedString(compressed, base);
        } catch (e) {
            console.warn('❌ [Share] Failed to build URL:', e);
            alert(e?.message || 'Failed to generate share URL');
            return;
        }

        const len = url.length;
        if (len > MAX_LEN) {
            alert(`Share URL is too long (${len} chars). Please use Save instead.`);
            return;
        }
        if (len >= WARN_LEN) {
            const ok = confirm(`Share URL is long (${len} chars) and may not work in some apps.\n\nContinue?`);
            if (!ok) return;
        }

        try {
            await navigator.clipboard.writeText(url);
            alert('Share URL copied to clipboard.');
        } catch (e) {
            // Fallback: let user copy manually.
            prompt('Copy this URL:', url);
        }
    });
}

/**
 * Auto-calculate missing semidia values using chief ray tracing (similar to Zemax import behavior)
 * @param {Array} sourceRows - Source wavelength data
 * @param {Array} objectRows - Object field data
 */
async function autoCalculateMissingSemidia(sourceRows, objectRows) {
    console.log('🎯 [AutoSemidia] Starting auto-calculation of missing semidia values');
    
    // Get current optical system data from table
    const opticalSystemRows = (typeof window.getOpticalSystemRows === 'function')
        ? window.getOpticalSystemRows(window.tableOpticalSystem)
        : (window.tableOpticalSystem ? window.tableOpticalSystem.getData() : []);
    
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        console.log('⚠️ [AutoSemidia] No optical system data available');
        return;
    }

    console.log(`🔍 [AutoSemidia] Checking ${opticalSystemRows.length} surfaces for missing semidia`);

    // Find surfaces with missing or empty semidia
    const surfacesNeedingSemidia = [];
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i];
        if (!row) continue;
        
        const semidiaValue = String(row.semidia || '').trim();
        const isObject = row['object type'] === 'Object' || row.object === 'Object';
        const isImage = row['object type'] === 'Image' || row.object === 'Image';
        
        // Skip Object surface, but calculate for Image and other surfaces with missing semidia
        if (!isObject && semidiaValue === '') {
            surfacesNeedingSemidia.push(i);
            console.log(`  📍 Surface ${i} (${row['object type'] || row.object || 'Surface'}): semidia = "${semidiaValue}" (empty)`);
        }
    }

    if (surfacesNeedingSemidia.length === 0) {
        console.log('✅ [AutoSemidia] All surfaces have semidia values');
        return;
    }

    console.log(`🎯 [AutoSemidia] Found ${surfacesNeedingSemidia.length} surfaces with missing semidia:`, surfacesNeedingSemidia);

    // Get primary wavelength
    const primaryWavelength = (() => {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5876;
        const primary = sourceRows.find(s => s && (s.primary === 'Primary Wavelength' || s.primary));
        if (primary && Number.isFinite(Number(primary.wavelength))) return Number(primary.wavelength);
        if (sourceRows[0] && Number.isFinite(Number(sourceRows[0].wavelength))) return Number(sourceRows[0].wavelength);
        return 0.5876;
    })();

    console.log(`🌈 [AutoSemidia] Using wavelength: ${primaryWavelength} μm`);

    // Get object positions
    const allObjectPositions = Array.isArray(objectRows) && objectRows.length > 0
        ? objectRows.map(obj => ({
            x: parseFloat(obj.xHeightAngle) || 0,
            y: parseFloat(obj.yHeightAngle) || 0,
            z: 0
        }))
        : [{ x: 0, y: 0, z: 0 }];

    // Determine if system is infinite or finite
    const objectSurface = opticalSystemRows[0];
    const objectThickness = objectSurface?.thickness;
    const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;

    console.log(`🔍 [AutoSemidia] System type: ${isInfiniteSystem ? 'Infinite' : 'Finite'}`);

    // Trace chief rays once for all surfaces
    let crossBeamResult;
    try {
        if (isInfiniteSystem) {
            // For infinite system, use normalized thickness
            const tracingRows = opticalSystemRows.map((r, idx) => {
                if (idx !== 0) return r;
                const o = (r && typeof r === 'object') ? r : {};
                return { ...o, thickness: 0 };
            });
            const objectAngles = allObjectPositions.map(pos => ({ x: pos.x || 0, y: pos.y || 0 }));
            
            crossBeamResult = await window.generateInfiniteSystemCrossBeam(tracingRows, objectAngles, {
                rayCount: 1,  // Chief ray only
                debugMode: false,
                wavelength: primaryWavelength,
                crossType: 'both',
                angleUnit: 'deg',
                chiefZ: -20
            });
        } else {
            crossBeamResult = await window.generateCrossBeam(opticalSystemRows, allObjectPositions, {
                rayCount: 1,  // Chief ray only
                debugMode: false,
                wavelength: primaryWavelength,
                crossType: 'both'
            });
        }
    } catch (e) {
        console.warn('⚠️ [AutoSemidia] Failed to trace rays:', e);
        return;
    }

    // Extract rays from result
    let rays = [];
    if (crossBeamResult) {
        if (crossBeamResult.rays && crossBeamResult.rays.length > 0) {
            rays = crossBeamResult.rays;
        } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
            rays = crossBeamResult.allTracedRays;
        } else if (crossBeamResult.objectResults && crossBeamResult.objectResults.length > 0) {
            crossBeamResult.objectResults.forEach(obj => {
                const traced = Array.isArray(obj?.tracedRays) ? obj.tracedRays : [];
                for (const r of traced) {
                    if (r && r.rayPath) rays.push(r);
                }
            });
        }
    }

    if (rays.length === 0) {
        console.warn('⚠️ [AutoSemidia] No rays traced');
        return;
    }

    console.log(`🔍 [AutoSemidia] Traced ${rays.length} chief rays successfully`);

    // Helper functions for ray path indexing
    const __isCoordTransRow = (row) => {
        const st = String(row?.surfType ?? row?.['surf type'] ?? '').trim().toLowerCase();
        return st === 'coord trans' || st === 'coordinate break' || st === 'ct' || st === 'coordtrans';
    };
    const __isObjectRow = (row) => {
        const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
        return t === 'object';
    };
    const __rayPathPointIndexForSurfaceIndex = (rows, surfaceIndex0) => {
        if (!Array.isArray(rows)) return null;
        const sIdx = Number(surfaceIndex0);
        if (!Number.isInteger(sIdx) || sIdx < 0 || sIdx >= rows.length) return null;
        const row = rows[sIdx];
        if (__isObjectRow(row) || __isCoordTransRow(row)) return null;
        let count = 0;
        for (let i = 0; i <= sIdx; i++) {
            const r = rows[i];
            if (__isObjectRow(r) || __isCoordTransRow(r)) continue;
            count++;
        }
        return count > 0 ? count : null;
    };

    // Calculate semidia for each surface that needs it
    for (const surfaceIndex of surfacesNeedingSemidia) {
        try {
            const rayPathIndex = __rayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex);
            if (rayPathIndex === null) {
                console.warn(`⚠️ [AutoSemidia] Cannot determine ray path index for surface ${surfaceIndex}`);
                continue;
            }

            let maxHeight = 0;
            let validPointsFound = 0;

            rays.forEach((ray) => {
                if (ray.rayPath && Array.isArray(ray.rayPath) && ray.rayPath.length > rayPathIndex) {
                    const point = ray.rayPath[rayPathIndex];
                    if (point && isFinite(point.x) && isFinite(point.y)) {
                        validPointsFound++;
                        const height = Math.sqrt(point.x * point.x + point.y * point.y);
                        if (height > maxHeight) {
                            maxHeight = height;
                        }
                    }
                }
            });

            if (validPointsFound > 0 && maxHeight > 0) {
                const calculatedSemidia = maxHeight;
                
                console.log(`✅ [AutoSemidia] Surface ${surfaceIndex}: calculated semidia = ${calculatedSemidia.toFixed(3)} mm (from ${validPointsFound} chief rays)`);
                
                // Update the optical system row
                opticalSystemRows[surfaceIndex].semidia = calculatedSemidia;
                
                // Save to table immediately
                try {
                    if (window.tableOpticalSystem && typeof window.tableOpticalSystem.updateData === 'function') {
                        // Use updateData to update the specific row
                        window.tableOpticalSystem.updateData([{
                            id: opticalSystemRows[surfaceIndex].id,
                            semidia: calculatedSemidia
                        }]);
                        console.log(`  💾 Updated table row ${opticalSystemRows[surfaceIndex].id}`);
                    }
                } catch (e) {
                    console.warn(`⚠️ [AutoSemidia] Failed to update table for surface ${surfaceIndex}:`, e);
                }

                // Also update in configurations if blocks are present
                try {
                    if (typeof loadSystemConfigurations === 'function' && typeof saveSystemConfigurations === 'function') {
                        const systemConfig = loadSystemConfigurations();
                        const activeId = systemConfig?.activeConfigId;
                        const cfgIdx = Array.isArray(systemConfig?.configurations)
                            ? systemConfig.configurations.findIndex(c => c && c.id === activeId)
                            : -1;
                        const activeCfg = cfgIdx >= 0 ? systemConfig.configurations[cfgIdx] : null;
                        
                        if (activeCfg && Array.isArray(activeCfg.opticalSystem) && activeCfg.opticalSystem[surfaceIndex]) {
                            activeCfg.opticalSystem[surfaceIndex].semidia = calculatedSemidia;
                            
                            if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') {
                                activeCfg.metadata = {};
                            }
                            activeCfg.metadata.modified = new Date().toISOString();
                            
                            saveSystemConfigurations(systemConfig);
                        }
                    }
                } catch (e) {
                    console.warn(`⚠️ [AutoSemidia] Failed to persist to blocks for surface ${surfaceIndex}:`, e);
                }
            } else {
                console.warn(`⚠️ [AutoSemidia] Could not calculate semidia for surface ${surfaceIndex} (no valid ray intersections)`);
            }
        } catch (e) {
            console.warn(`⚠️ [AutoSemidia] Failed to calculate semidia for surface ${surfaceIndex}:`, e);
        }
    }

    // Save updated optical system data to localStorage
    try {
        if (typeof saveLensTableData === 'function') {
            saveLensTableData(opticalSystemRows);
            console.log('💾 [AutoSemidia] Updated optical system data saved to localStorage');
        }
    } catch (e) {
        console.warn('⚠️ [AutoSemidia] Failed to save updated optical system data:', e);
    }
    
    console.log('✅ [AutoSemidia] Auto-calculation completed');
}

async function __loadAllDataObjectIntoApp(allData, { filename }) {
    const displayName = filename || 'shared-link.json';

    // New load attempt: clear any previous warning marker; warnings will re-set it.
    setLoadWarnUIFlag(false);

    // Normalize phase: accept multiple input shapes but continue with a single canonical shape.
    try {
        const normalizedResult = normalizeDesign(allData);
        if (!showLoadErrors(normalizedResult.issues, { filename: displayName })) {
            return false;
        }
        allData = normalizedResult.normalized;
    } catch (err) {
        showLoadErrors([
            { severity: 'fatal', phase: 'normalize', message: `Unexpected normalize error: ${err?.message || String(err)}` }
        ], { filename: displayName });
        return false;
    }

    // Build candidate configuration object but do NOT save yet.
    /** @type {any} */
    let candidateConfig;
    if (allData && allData.configurations) {
        candidateConfig = allData.configurations;
    } else {
        showLoadErrors([
            { severity: 'fatal', phase: 'normalize', message: 'Normalization did not produce configurations wrapper.' }
        ], { filename: displayName });
        return false;
    }

    // Validate phase (block schema)
    /** @type {Array<any>} */
    const issues = [];

    const cfgList = Array.isArray(candidateConfig?.configurations) ? candidateConfig.configurations : [];

    const countBlocksByType = (blocks) => {
        const out = { Lens: 0, Doublet: 0, Triplet: 0, AirGap: 0, Stop: 0, ImageSurface: 0, Other: 0 };
        if (!Array.isArray(blocks)) return out;
        for (const b of blocks) {
            const t = String(b?.blockType ?? '');
            if (Object.prototype.hasOwnProperty.call(out, t)) out[t]++;
            else out.Other++;
        }
        return out;
    };

    const blocksLookSuspicious = (cfg) => {
        try {
            const blocks = cfg?.blocks;
            if (!Array.isArray(blocks) || blocks.length === 0) return false;
            const isNumericish = (v) => {
                if (typeof v === 'number') return Number.isFinite(v);
                const s = String(v ?? '').trim();
                if (!s) return false;
                return /^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(s);
            };
            for (const b of blocks) {
                const type = String(b?.blockType ?? '');
                if (type === 'Lens') {
                    const mat = b?.parameters?.material;
                    // A lens material should be a glass name, not a refractive index number.
                    if (isNumericish(mat)) return true;
                }
                if (type === 'Doublet' || type === 'Triplet') {
                    const m1 = b?.parameters?.material1;
                    const m2 = b?.parameters?.material2;
                    const m3 = b?.parameters?.material3;
                    if (isNumericish(m1) || isNumericish(m2) || isNumericish(m3)) return true;
                }
            }
            return false;
        } catch (_) {
            return false;
        }
    };

    // If blocks are missing, or embedded blocks look inconsistent, try to auto-derive Blocks.
    // This enables Apply-to-Design-Intent even for cemented lenses (Doublet/Triplet).
    for (const cfg of cfgList) {
        try {
            const legacyRows = Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : null;
            if (!legacyRows || legacyRows.length === 0) continue;

            const hasBlocks = configurationHasBlocks(cfg);
            const suspicious = hasBlocks && blocksLookSuspicious(cfg);
            const existingCounts = hasBlocks ? countBlocksByType(cfg.blocks) : null;

            // Always do a best-effort derive for comparison.
            const derived = deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
            const hasFatal = Array.isArray(derived?.issues) && derived.issues.some(i => i && i.severity === 'fatal');
            if (hasFatal) {
                if (!hasBlocks) {
                    // Do not fail the Load; keep legacy surface workflow.
                    const converted = (derived.issues || []).map(i => ({
                        ...i,
                        severity: 'warning',
                        message: `Blocks conversion skipped: ${i?.message || String(i)}`
                    }));
                    issues.push(...converted);
                    if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
                    cfg.metadata.importAnalyzeMode = true;
                }
                continue;
            }

            const derivedCounts = countBlocksByType(derived?.blocks);
            const wouldIncreaseDoublets = !!existingCounts && (derivedCounts.Doublet > existingCounts.Doublet);

            // Decide whether to set/replace blocks:
            // - if blocks missing: set
            // - if suspicious: replace
            // - if derived yields more Doublets: replace (user expectation: cemented groups preserved)
            if (!hasBlocks || suspicious || wouldIncreaseDoublets) {
                cfg.schemaVersion = cfg.schemaVersion || BLOCK_SCHEMA_VERSION;
                cfg.blocks = Array.isArray(derived?.blocks) ? derived.blocks : [];
                if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
                cfg.metadata.importAnalyzeMode = false;
                if (suspicious) cfg.metadata.importBlocksRepaired = true;
                if (wouldIncreaseDoublets) cfg.metadata.importBlocksRebuiltForCemented = true;

                if (hasBlocks && (suspicious || wouldIncreaseDoublets)) {
                    issues.push({
                        severity: 'warning',
                        phase: 'validate',
                        message: 'Blocks were rebuilt from opticalSystem to better preserve cemented groups (Doublet/Triplet) during Design Intent load.'
                    });
                }

                // Carry over non-fatal conversion warnings.
                if (Array.isArray(derived?.issues) && derived.issues.length > 0) {
                    issues.push(...derived.issues);
                }
            } else {
                // Keep existing blocks; still report non-fatal derive issues if any.
                if (Array.isArray(derived?.issues) && derived.issues.length > 0) {
                    const converted = (derived.issues || []).map(i => ({
                        ...i,
                        severity: 'warning',
                        message: `Blocks check (kept embedded blocks): ${i?.message || String(i)}`
                    }));
                    issues.push(...converted);
                }
            }
        } catch (e) {
            issues.push({ severity: 'warning', phase: 'validate', message: `Blocks conversion failed unexpectedly: ${e?.message || String(e)}` });
        }
    }

    for (const cfg of cfgList) {
        if (configurationHasBlocks(cfg)) {
            issues.push(...validateBlocksConfiguration(cfg));
        }
    }

    if (!showLoadErrors(issues, { filename: displayName })) {
        return false;
    }

    // Expand phase (only active config needs derived opticalSystem right now)
    try {
        const activeId = candidateConfig?.activeConfigId || 1;
        const activeCfg = cfgList.find(c => c.id === activeId) || cfgList[0];
        if (activeCfg && configurationHasBlocks(activeCfg)) {
            const legacyBeforeExpand = Array.isArray(activeCfg.opticalSystem) ? activeCfg.opticalSystem : null;
            // validate already ran above; avoid re-validating here to prevent duplicate warnings.
            const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
            issues.push(...expanded.issues);
            if (!showLoadErrors(expanded.issues, { filename: displayName })) {
                return false;
            }
            // IMPORTANT: keep legacy surface rows as-is (preserve per-surface fields like semidia),
            // and only overlay provenance so Apply-to-Design-Intent can reverse-map edits.
            if (Array.isArray(legacyBeforeExpand) && legacyBeforeExpand.length > 0) {
                try { __blocks_overlayExpandedProvenanceIntoLegacyRows(legacyBeforeExpand, expanded.rows); } catch (_) {}
                // Preserve object row thickness/semidia even if indices don't align.
                try { __blocks_mergeLegacyIndexFieldsIntoExpandedRows(legacyBeforeExpand, legacyBeforeExpand); } catch (_) {}
                // Normalize ids to current indices (Tabulator expects numeric ids).
                try {
                    for (let ii = 0; ii < legacyBeforeExpand.length; ii++) {
                        if (legacyBeforeExpand[ii] && typeof legacyBeforeExpand[ii] === 'object') legacyBeforeExpand[ii].id = ii;
                    }
                } catch (_) {}
                activeCfg.opticalSystem = legacyBeforeExpand;
            } else {
                activeCfg.opticalSystem = expanded.rows;
            }
        }
    } catch (err) {
        showLoadErrors([
            { severity: 'fatal', phase: 'expand', message: `Unexpected expand error: ${err?.message || String(err)}` }
        ], { filename: displayName });
        return false;
    }

    // Determine the effective payload to load into the tables.
    // Prefer top-level fields; fall back to active config in candidateConfig.
    let effectiveSource = allData.source;
    let effectiveObject = allData.object;
    let effectiveOpticalSystem = allData.opticalSystem;
    let effectiveMeritFunction = allData.meritFunction;
    let effectiveSystemRequirements = allData.systemRequirements;
    let effectiveSystemData = allData.systemData;

    // If blocks exist, the expanded active configuration is the source of truth.
    // Do NOT allow top-level legacy opticalSystem to override derived rows.
    try {
        const activeId = candidateConfig?.activeConfigId || 1;
        const activeCfg = cfgList.find(c => c.id === activeId) || cfgList[0];
        if (activeCfg && configurationHasBlocks(activeCfg) && Array.isArray(activeCfg.opticalSystem)) {
            effectiveOpticalSystem = activeCfg.opticalSystem;
        }
    } catch (_) {}

    if (!effectiveSource || !effectiveObject || !effectiveOpticalSystem || !effectiveSystemData) {
        try {
            const activeId = candidateConfig?.activeConfigId || 1;
            const activeCfg = cfgList.find(c => c.id === activeId) || cfgList[0];

            if (activeCfg) {
                if (!effectiveSource && activeCfg.source) effectiveSource = activeCfg.source;
                if (!effectiveObject && activeCfg.object) effectiveObject = activeCfg.object;
                if (!effectiveOpticalSystem && activeCfg.opticalSystem) effectiveOpticalSystem = activeCfg.opticalSystem;
                if (!effectiveSystemData && activeCfg.systemData) effectiveSystemData = activeCfg.systemData;
            }

            if (!effectiveMeritFunction && candidateConfig?.meritFunction) effectiveMeritFunction = candidateConfig.meritFunction;
            if (!effectiveSystemRequirements && candidateConfig?.systemRequirements) effectiveSystemRequirements = candidateConfig.systemRequirements;
        } catch (e) {
            console.warn('⚠️ [Load] Failed to derive table data from configurations:', e);
        }
    }

    // At this point, validation/expansion succeeded: write to localStorage.
    try {
        localStorage.setItem('systemConfigurations', JSON.stringify(candidateConfig));
        console.log('🔵 [Load] Configurations data saved');
    } catch (e) {
        showLoadErrors([
            { severity: 'fatal', phase: 'validate', message: `Failed to persist configurations: ${e?.message || String(e)}` }
        ], { filename: displayName });
        return false;
    }

    // System Data を復元（Reference Focal Length）
    if (effectiveSystemData) {
        const refFLInput = document.getElementById('reference-focal-length');
        if (refFLInput) {
            refFLInput.value = effectiveSystemData.referenceFocalLength || '';
        }
    }

    saveSourceTableData(effectiveSource || []);
    saveObjectTableData(effectiveObject || []);
    saveLensTableData(effectiveOpticalSystem || []);

    if (effectiveMeritFunction) {
        localStorage.setItem('meritFunctionData', JSON.stringify(effectiveMeritFunction));
    }

    if (effectiveSystemRequirements) {
        localStorage.setItem('systemRequirementsData', JSON.stringify(effectiveSystemRequirements));
    }

    // ファイル名を保存
    localStorage.setItem('loadedFileName', displayName);

    // Update file name UI immediately.
    try {
        const fileNameElement = document.getElementById('loaded-file-name');
        if (fileNameElement) {
            fileNameElement.textContent = displayName;
            fileNameElement.style.color = '#1a4d8f';
        }
    } catch (_) {}

    console.log('✅ [Load] Applying to UI (no reload)...');

    // Push new data into existing Tabulator instances.
    try { globalThis.__configurationAutoSaveDisabled = true; } catch (_) {}
    try {
        const tasks = [];
        if (window.tableSource && typeof window.tableSource.setData === 'function') {
            tasks.push(Promise.resolve(window.tableSource.setData(effectiveSource || [])));
        }
        if (window.tableObject && typeof window.tableObject.setData === 'function') {
            tasks.push(Promise.resolve(window.tableObject.setData(effectiveObject || [])));
        }
        if (window.tableOpticalSystem && typeof window.tableOpticalSystem.setData === 'function') {
            tasks.push(Promise.resolve(window.tableOpticalSystem.setData(effectiveOpticalSystem || [])));
        }

        if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.setData === 'function') {
            tasks.push(Promise.resolve(window.systemRequirementsEditor.setData(effectiveSystemRequirements || [])));
        }

        Promise.allSettled(tasks).finally(async () => {
            try { globalThis.__configurationAutoSaveDisabled = false; } catch (_) {}
            try { updateSurfaceNumberSelect(); } catch (_) {}
            try { if (typeof window.refreshConfigurationUI === 'function') window.refreshConfigurationUI(); } catch (_) {}
            try { if (typeof window.updatePSFObjectOptions === 'function') window.updatePSFObjectOptions(); } catch (_) {}
            // Wavefront Object dropdown is derived from tableObject; refresh explicitly.
            // (Tabulator setData does not always fire dataChanged.)
            try { if (typeof window.updateWavefrontObjectSelect === 'function') window.updateWavefrontObjectSelect(); } catch (_) {}
            try { refreshBlockInspector(); } catch (_) {}
            // Auto redraw 3D popup after Load (no manual Render click)
            try {
                const popup = window.popup3DWindow;
                if (popup && !popup.closed && typeof popup.postMessage === 'function') {
                    popup.postMessage({ action: 'request-redraw' }, '*');
                }
            } catch (_) {}
            
            // Auto-calculate missing semidia values after tables are updated
            try {
                await autoCalculateMissingSemidia(effectiveSource, effectiveObject);
            } catch (e) {
                console.warn('⚠️ [Load] Failed to auto-calculate semidia:', e);
            }
            
            console.log('✅ [Load] UI updated without reload');
        });
    } catch (e) {
        try { globalThis.__configurationAutoSaveDisabled = false; } catch (_) {}
        console.warn('⚠️ [Load] Failed to apply data to UI immediately:', e);
    }

    return true;
}

export async function loadFromCompressedDataHashIfPresent() {
    const compressed = getCompressedStringFromLocation();
    if (!compressed) return { ok: false, reason: 'no_hash' };

    const confirmed = confirm(
        'リンクから設計を読み込みます。現在の設計は上書きされます。続行しますか？\n\n' +
        'Load design from URL? Current design will be overwritten.'
    );
    if (!confirmed) return { ok: false, reason: 'cancelled' };

    let allData;
    try {
        allData = decodeAllDataFromCompressedString(compressed);
    } catch (e) {
        console.warn('❌ [URL Load] Decode failed:', e);
        alert(e?.message || 'Failed to load design from URL');
        return { ok: false, reason: 'decode_failed' };
    }

    const ok = await __loadAllDataObjectIntoApp(allData, { filename: 'shared-link.json' });
    if (ok) {
        try {
            history.replaceState(null, '', `${location.origin}${location.pathname}${location.search}`);
        } catch (_) {}
    }
    return { ok };
}

/**
 * Export Zemax (.zmx) for the current optical system.
 */
function setupExportZemaxButton() {
    const exportBtn = document.getElementById('export-zemax-btn');
    if (!exportBtn) return;

    exportBtn.addEventListener('click', () => {
        if (document.activeElement) document.activeElement.blur();

        // Default name based on last loaded filename.
        const loadedFileName = localStorage.getItem('loadedFileName');
        let defaultName = 'co-opt-export';
        if (loadedFileName) {
            defaultName = loadedFileName.replace(/\.(json|zmx)$/i, '');
        }

        let filename = prompt('Export Zemax file name (".zmx" will be added automatically)', defaultName);
        if (!filename) return;
        filename = String(filename).trim();
        if (!filename) return;

        try {
            const rows = getOpticalSystemRows(window.tableOpticalSystem || tableOpticalSystem);

            const includeSystemData = confirm('Include system settings (wavelength / field / pupil) in .zmx?\n\nFor maximum Zemax compatibility, choose Cancel (surfaces only).');

            let sourceRows = undefined;
            let objectRows = undefined;
            let entrancePupilDiameterMm = undefined;

            if (includeSystemData) {
                sourceRows = getSourceRows(window.tableSource || tableSource);
                objectRows = getObjectRows(window.tableObject || tableObject);

                // Best-effort: compute entrance pupil diameter from paraxial data using the primary wavelength.
                try {
                    const primary = Array.isArray(sourceRows) ? sourceRows.find(r => String(r?.primary ?? '').trim()) : null;
                    const primaryWavelengthMicrons = Number(primary?.wavelength);
                    const wl = (Number.isFinite(primaryWavelengthMicrons) && primaryWavelengthMicrons > 0) ? primaryWavelengthMicrons : 0.5875618;
                    const derived = derivePupilAndFocalLengthMmFromParaxial(rows, wl, true);
                    if (Number.isFinite(derived?.pupilDiameterMm) && derived.pupilDiameterMm > 0) {
                        entrancePupilDiameterMm = derived.pupilDiameterMm;
                    }
                } catch (_) {
                    // ignore
                }
            }
            const zmxText = generateZMXText(rows, {
                title: filename,
                units: 'MM',
                sourceRows,
                objectRows,
                entrancePupilDiameterMm
            });
            downloadZMX(zmxText, filename);
            console.log('✅ [ZemaxExport] Exported .zmx:', filename);
        } catch (e) {
            console.warn('❌ [ZemaxExport] Export failed:', e);
            alert(e?.message || 'Zemax export failed');
        }
    });
}

/**
 * Import Zemax (.zmx) into the Optical System table (minimal subset).
 * Note: This only updates the optical system surfaces (not source/object/requirements).
 */
function setupImportZemaxButton() {
    const importBtn = document.getElementById('import-zemax-btn');
    if (!importBtn) return;

    const persistToActiveConfiguration = (rows, sourceRows, objectRows, entrancePupilDiameterMm, filename) => {
        // Design Intent (Blocks) is driven by systemConfigurations. If we don't update it,
        // the UI can keep showing the previous Blocks even though the surface table updates.
        /** @type {any} */
        let systemConfig = null;
        try {
            if (typeof loadSystemConfigurationsFromTableConfig === 'function') {
                systemConfig = loadSystemConfigurationsFromTableConfig();
            } else if (typeof loadSystemConfigurations === 'function') {
                systemConfig = loadSystemConfigurations();
            }
        } catch (_) {
            systemConfig = null;
        }
        if (!systemConfig) {
            try { systemConfig = JSON.parse(localStorage.getItem('systemConfigurations')); } catch (_) {}
        }
        if (!systemConfig || !Array.isArray(systemConfig.configurations) || systemConfig.configurations.length === 0) {
            return { rowsToApply: rows, updated: false };
        }

        const activeId = systemConfig.activeConfigId;
        const idx = systemConfig.configurations.findIndex(c => c && String(c.id) === String(activeId));
        const activeIdx = (idx >= 0) ? idx : 0;
        const activeCfg = systemConfig.configurations[activeIdx];
        if (!activeCfg || typeof activeCfg !== 'object') {
            return { rowsToApply: rows, updated: false };
        }

        // Only overwrite source/object if present in the .zmx.
        // Source is global (shared across configurations), so persist to the shared key.
        if (Array.isArray(sourceRows) && sourceRows.length > 0) {
            try { localStorage.setItem('sourceTableData', JSON.stringify(sourceRows)); } catch (_) {}
        }
        if (Array.isArray(objectRows) && objectRows.length > 0) activeCfg.object = objectRows;

        // Detect whether imported data contains any semidia info.
        const importedHasAnySemidia = (() => {
            try {
                if (!Array.isArray(rows)) return false;
                const has = (v) => {
                    if (v === null || v === undefined) return false;
                    const s = String(v).trim();
                    return s !== '';
                };
                for (const r of rows) {
                    if (!r || typeof r !== 'object') continue;
                    const t = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
                    if (t === 'image') continue;
                    if (has(r.semidia ?? r.semiDiameter ?? r.semiDia ?? r['Semi Diameter'] ?? r['semi diameter'])) return true;
                }
                return false;
            } catch (_) {
                return false;
            }
        })();

        // Best-effort: derive Blocks from the imported legacy surface list.
        // If conversion fails, clear Blocks so Design Intent doesn't remain stale.
        let rowsToApply = rows;
        try {
            const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
            const fatals = Array.isArray(derived?.issues) ? derived.issues.filter(i => i && i.severity === 'fatal') : [];
            if (fatals.length === 0) {
                activeCfg.schemaVersion = activeCfg.schemaVersion || BLOCK_SCHEMA_VERSION;
                activeCfg.blocks = Array.isArray(derived?.blocks) ? derived.blocks : [];
                if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                activeCfg.metadata.importAnalyzeMode = false;

                // Ensure ObjectSurface exists and is first in Design Intent after Zemax import.
                if (Array.isArray(activeCfg.blocks)) {
                    try {
                        const hasObjectSurface = activeCfg.blocks.some(b => b && String(b.blockType ?? '').trim() === 'ObjectSurface');
                        if (!hasObjectSurface) {
                            // Check if Object surface (rows[0]) has finite or infinite thickness
                            const objThickness = rows?.[0]?.thickness;
                            const objThicknessStr = String(objThickness ?? '').trim().toUpperCase();
                            const isInfiniteObject = objThickness === 'INF' || 
                                                     objThickness === Infinity || 
                                                     objThicknessStr === 'INF' || 
                                                     objThicknessStr === 'INFINITY';
                            
                            const newId = __blocks_generateUniqueBlockId(activeCfg.blocks, 'ObjectSurface');
                            const objBlock = __blocks_makeDefaultBlock('ObjectSurface', newId);
                            if (objBlock && objBlock.metadata && typeof objBlock.metadata === 'object') {
                                objBlock.metadata.source = 'zemax-import';
                            }
                            
                            // Set objectDistanceMode based on imported thickness
                            if (isInfiniteObject) {
                                objBlock.parameters.objectDistanceMode = 'INF';
                                // objectDistance is not needed for INF mode
                                delete objBlock.parameters.objectDistance;
                            } else {
                                objBlock.parameters.objectDistanceMode = 'Finite';
                                const numThickness = Number(objThickness);
                                objBlock.parameters.objectDistance = Number.isFinite(numThickness) && numThickness > 0 ? numThickness : 100;
                            }
                            
                            activeCfg.blocks.unshift(objBlock);
                        }
                    } catch (_) {
                        // ignore
                    }
                }

                // If the imported file has no semidia/DIAM records, enable ImageSurface auto semidia (chief ray)
                // so the Image semidia can be derived later via `calculateImageSemiDiaFromChiefRays()`.
                if (!importedHasAnySemidia && Array.isArray(activeCfg.blocks)) {
                    try {
                        for (const b of activeCfg.blocks) {
                            if (!b || typeof b !== 'object') continue;
                            const bt = String(b?.blockType ?? b?.type ?? '').trim();
                            if (bt !== 'ImageSurface') continue;
                            if (!b.parameters || typeof b.parameters !== 'object') b.parameters = {};
                            b.parameters.optimizeSemiDia = 'A';
                        }
                    } catch (_) {
                        // ignore
                    }
                }

                try {
                    const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
                    if (expanded && Array.isArray(expanded.rows)) {
                        try { __blocks_mergeLegacyIndexFieldsIntoExpandedRows(rows, expanded.rows); } catch (_) {}
                        rowsToApply = expanded.rows;
                    }
                } catch (_) {
                    // If expansion fails, keep legacy rows.
                }

                // If the imported file had no semidia (e.g., no DIAM records), estimate numeric semidia
                // from marginal rays so rendering and clearance checks remain meaningful.
                if (!importedHasAnySemidia && Array.isArray(rowsToApply)) {
                    try {
                        __zmxApplySemidiaOverridesFromMarginalRays(activeCfg, rowsToApply, sourceRows, entrancePupilDiameterMm, objectRows);
                    } catch (e) {
                        console.warn('⚠️ [ZemaxImport] Failed to derive semidia from marginal rays:', e);
                    }
                }
            } else {
                activeCfg.blocks = [];
            }
        } catch (_) {
            try { activeCfg.blocks = []; } catch (_) {}
        }

        // Keep opticalSystem in sync for configs that still read it.
        activeCfg.opticalSystem = rowsToApply;

        // Treat Zemax import as a full design replacement: keep only one active configuration.
        // This prevents a previously-loaded systemConfigurations set from lingering.
        try {
            const base = String(filename ?? '').trim();
            if (base) activeCfg.name = base;
        } catch (_) {}

        try {
            if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
            // Mark as imported (best-effort; schema differs slightly between modules).
            activeCfg.metadata.designer = activeCfg.metadata.designer || { type: 'imported', name: 'zemax', confidence: null };
            if (activeCfg.metadata.designer && typeof activeCfg.metadata.designer === 'object') {
                activeCfg.metadata.designer.type = activeCfg.metadata.designer.type || 'imported';
                if (!activeCfg.metadata.designer.name) activeCfg.metadata.designer.name = 'zemax';
            }
        } catch (_) {}

        try {
            if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
            activeCfg.metadata.modified = new Date().toISOString();
        } catch (_) {}

        systemConfig.configurations = [activeCfg];
        systemConfig.activeConfigId = activeCfg.id;

        // Clear global/shared rows that likely belong to the previous design (best-effort).
        try { if (Array.isArray(systemConfig.meritFunction)) systemConfig.meritFunction = []; } catch (_) {}
        try { if (Array.isArray(systemConfig.systemRequirements)) systemConfig.systemRequirements = []; } catch (_) {}
        try {
            if (typeof saveSystemConfigurationsFromTableConfig === 'function') {
                saveSystemConfigurationsFromTableConfig(systemConfig);
            } else {
                localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
            }
        } catch (_) {
            try { localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig)); } catch (_) {}
        }

        return { rowsToApply, updated: true, importedHasAnySemidia };
    };

    importBtn.addEventListener('click', () => {
        if (document.activeElement) document.activeElement.blur();

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zmx,text/plain';
        input.style.display = 'none';
        document.body.appendChild(input);

        input.onchange = async (e) => {
            const file = e?.target?.files?.[0];
            if (!file) {
                try { document.body.removeChild(input); } catch (_) {}
                return;
            }

            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const buf = evt?.target?.result;
                    if (!buf) throw new Error('Failed to read .zmx file.');

                    const parsed = parseZMXArrayBufferToOpticalSystemRows(buf, { filename: file.name });
                    const rows = parsed?.rows || [];
                    const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
                    const sourceRows = Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [];
                    const objectRows = Array.isArray(parsed?.objectRows) ? parsed.objectRows : [];
                    const entrancePupilDiameterMm = parsed?.entrancePupilDiameterMm;

                    const { rowsToApply, importedHasAnySemidia } = persistToActiveConfiguration(rows, sourceRows, objectRows, entrancePupilDiameterMm, file.name);

                    if (!rows || rows.length === 0) throw new Error('Zemax import produced no surfaces.');

                    // Persist + apply
                    // Only overwrite Source/Object if present in the .zmx.
                    if (sourceRows.length > 0) saveSourceTableData(sourceRows);
                    if (objectRows.length > 0) saveObjectTableData(objectRows);
                    saveLensTableData(rowsToApply);
                    localStorage.setItem('loadedFileName', file.name);

                    // Update filename UI
                    try {
                        const fileNameElement = document.getElementById('loaded-file-name');
                        if (fileNameElement) {
                            fileNameElement.textContent = file.name;
                            fileNameElement.style.color = '#1a4d8f';
                        }
                    } catch (_) {}

                    try { globalThis.__configurationAutoSaveDisabled = true; } catch (_) {}
                    try {
                        const tasks = [];
                        if (sourceRows.length > 0 && window.tableSource && typeof window.tableSource.setData === 'function') {
                            tasks.push(Promise.resolve(window.tableSource.setData(sourceRows)));
                        }
                        if (objectRows.length > 0 && window.tableObject && typeof window.tableObject.setData === 'function') {
                            tasks.push(Promise.resolve(window.tableObject.setData(objectRows)));
                        }
                        if (window.tableOpticalSystem && typeof window.tableOpticalSystem.setData === 'function') {
                            tasks.push(Promise.resolve(window.tableOpticalSystem.setData(rowsToApply)));
                        } else {
                            // no-op
                        }

                        Promise.allSettled(tasks).finally(() => {
                            try { globalThis.__configurationAutoSaveDisabled = false; } catch (_) {}
                            try { updateSurfaceNumberSelect(); } catch (_) {}
                            try { if (typeof window.refreshConfigurationUI === 'function') window.refreshConfigurationUI(); } catch (_) {}
                            try { if (typeof window.updatePSFObjectOptions === 'function') window.updatePSFObjectOptions(); } catch (_) {}
                            // Wavefront Object dropdown is derived from tableObject; refresh explicitly.
                            try { if (typeof window.updateWavefrontObjectSelect === 'function') window.updateWavefrontObjectSelect(); } catch (_) {}
                            try { refreshBlockInspector(); } catch (_) {}

                            // If semidia was missing in the imported file, compute Image semidia from chief rays.
                            // Do it silently (no alert popups) to keep import UX smooth.
                            if (!importedHasAnySemidia && typeof window.calculateImageSemiDiaFromChiefRays === 'function') {
                                try {
                                    const prevAlert = globalThis.alert;
                                    try { globalThis.alert = () => {}; } catch (_) {}
                                    Promise.resolve()
                                        .then(() => window.calculateImageSemiDiaFromChiefRays())
                                        .catch(() => {})
                                        .finally(() => {
                                            try { globalThis.alert = prevAlert; } catch (_) {}
                                            // Ensure Design Intent reflects computed ImageSurface semidia without requiring a Render click.
                                            try { refreshBlockInspector(); } catch (_) {}
                                        });
                                } catch (_) {
                                    // ignore
                                }
                            }
                        });
                    } catch (err) {
                        try { globalThis.__configurationAutoSaveDisabled = false; } catch (_) {}
                        throw err;
                    }

                    if (issues.length > 0) {
                        console.warn('⚠️ [ZemaxImport] Issues:', issues);
                        const warnCount = issues.filter(i => i?.severity === 'warning').length;
                        if (warnCount > 0) {
                            alert(`Zemax import completed with ${warnCount} warning(s). See console for details.`);
                        }
                    }

                    console.log('✅ [ZemaxImport] Imported .zmx:', file.name);
                } catch (err) {
                    console.warn('❌ [ZemaxImport] Import failed:', err);
                    alert(err?.message || 'Zemax import failed');
                    try { globalThis.__configurationAutoSaveDisabled = false; } catch (_) {}
                } finally {
                    try { document.body.removeChild(input); } catch (_) {}
                }
            };
            reader.onerror = () => {
                console.error('❌ [ZemaxImport] FileReader error:', reader.error);
                alert(reader.error?.message || 'FileReader error while importing .zmx');
                try { document.body.removeChild(input); } catch (_) {}
            };

            reader.readAsArrayBuffer(file);
        };

        input.click();
    });
}

function setupSuggestOptimizeButtons() {

    function setupDesignIntentBlocksToolbar() {
        const addBtn = document.getElementById('design-intent-add-block-btn');
        const delBtn = document.getElementById('design-intent-delete-block-btn');
        const typeSel = document.getElementById('design-intent-add-block-type');

        if (addBtn) {
            addBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const type = String(typeSel?.value ?? 'Lens').trim();
                const after = __blockInspectorExpandedBlockId;
                const res = __blocks_addBlockToActiveConfig(type, after);
                if (!res || res.ok !== true) {
                    alert(`Failed to add block: ${res?.reason || 'unknown error'}`);
                    return;
                }
                __blockInspectorExpandedBlockId = String(res.blockId ?? '') || null;
                try { refreshBlockInspector(); } catch (_) {}
                try {
                    if (window.popup3DWindow && !window.popup3DWindow.closed) {
                        window.popup3DWindow.postMessage({ action: 'request-redraw' }, '*');
                    }
                } catch (_) {}
            });
        }

        if (delBtn) {
            delBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const bid = String(__blockInspectorExpandedBlockId ?? '').trim();
                if (!bid) {
                    alert('Select (expand) a block first to delete.');
                    return;
                }
                const ok = confirm(`Delete block ${bid}?`);
                if (!ok) return;
                const res = __blocks_deleteBlockFromActiveConfig(bid);
                if (!res || res.ok !== true) {
                    alert(`Failed to delete block: ${res?.reason || 'unknown error'}`);
                    return;
                }
                __blockInspectorExpandedBlockId = null;
                try { refreshBlockInspector(); } catch (_) {}
                try {
                    if (window.popup3DWindow && !window.popup3DWindow.closed) {
                        window.popup3DWindow.postMessage({ action: 'request-redraw' }, '*');
                    }
                } catch (_) {}
            });
        }
    }

    // IMPORTANT: this was previously defined but never invoked.
    // Without this call, the Design Intent (Blocks) Add/Delete buttons do nothing.
    setupDesignIntentBlocksToolbar();

    const suggestBtn = document.getElementById('suggest-design-intent-btn');
    if (suggestBtn) {
        suggestBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}

            const bid = String(__blockInspectorExpandedBlockId ?? '').trim();
            if (!bid) {
                alert('Select (expand) a block first.');
                return;
            }

            const container = document.getElementById('block-inspector');
            if (!container) return;

            // Trigger the inline glass helper by simulating Enter on the nd input.
            /** @type {HTMLInputElement|null} */
            let ndInput = null;
            try {
                const all = Array.from(container.querySelectorAll('input[data-glass-helper="nd"]'));
                const preferredKey = (() => {
                    try { return __blockInspectorPreferredMaterialKeyByBlockId.get(bid) || ''; } catch (_) { return ''; }
                })();

                ndInput = (
                    (preferredKey ? all.find(el => String(el?.dataset?.blockId ?? '') === bid && String(el?.dataset?.materialKey ?? '') === preferredKey) : null)
                    || all.find(el => String(el?.dataset?.blockId ?? '') === bid)
                    || all[0]
                    || null
                );
            } catch (_) {
                ndInput = null;
            }

            if (!ndInput) {
                alert('No material ref index/abbe inputs found for this block.');
                return;
            }

            try { ndInput.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
            try { ndInput.focus(); } catch (_) {}
            try {
                ndInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            } catch (_) {}
        });
    }

    const optimizeBtn = document.getElementById('optimize-design-intent-btn');
    if (optimizeBtn) {
        optimizeBtn.addEventListener('click', async () => {
            const prevDisabled = optimizeBtn.disabled;
            optimizeBtn.disabled = true;
            try {
                const opt = window.OptimizationMVP;
                if (!opt || typeof opt.run !== 'function') {
                    alert('OptimizationMVP が利用できません。');
                    return;
                }

                // Auto-detect scenarios: if 2+ scenarios exist, evaluate weighted sum.
                let multiScenario = false;
                let activeCfg = null;
                let variableCount = 0;
                let numericVarCount = 0;
                let categoricalVarCount = 0;
                try {
                    const systemConfig = (typeof loadSystemConfigurationsFromTableConfig === 'function')
                        ? loadSystemConfigurationsFromTableConfig()
                        : JSON.parse(localStorage.getItem('systemConfigurations'));
                    const activeId = systemConfig?.activeConfigId;
                    activeCfg = systemConfig?.configurations?.find(c => c && c.id === activeId)
                        || systemConfig?.configurations?.[0]
                        || null;
                    if (activeCfg && Array.isArray(activeCfg.scenarios) && activeCfg.scenarios.length >= 2) {
                        multiScenario = true;
                    }

                    const allVars = listDesignVariablesFromBlocks(activeCfg || {});
                    const numericVars = Array.isArray(allVars)
                        ? allVars.filter(v => typeof v?.value === 'number' && Number.isFinite(v.value))
                        : [];
                    variableCount = Array.isArray(allVars) ? allVars.length : 0;
                    numericVarCount = numericVars.length;
                    categoricalVarCount = Math.max(0, variableCount - numericVarCount);
                } catch (_) {}

                // Progress popup window
                let popup = null;
                const stopFlag = { stop: false };
                let popupWatchTimer = null;
                                let isRunning = false;
                try {
                    popup = window.open('', 'coopt-optimizer-progress', 'width=500,height=550,resizable=yes,scrollbars=no');
                    if (popup && popup.document) {
                        popup.document.title = 'Optimize Progress';
                        popup.document.body.style.fontFamily = 'system-ui, -apple-system, Segoe UI, sans-serif';
                        popup.document.body.style.margin = '12px';
                        popup.document.body.innerHTML = `
<div style="font-size:14px; font-weight:600; margin-bottom:8px;">Optimize Progress</div>
<div style="font-size:12px; color:#555; margin-bottom:10px;">Updates per candidate evaluation (±step)</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:6px;">
    <button id="opt-run" style="padding:6px 10px;" disabled>Run</button>
    <button id="opt-stop" style="padding:6px 10px;">Stop</button>
    <span id="opt-stop-state" style="margin-left:8px; font-size:12px; color:#555;"></span>
</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:10px;">
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        Max Iterations
        <input id="opt-max-iter" type="number" min="1" step="1" value="1000" style="width:100px; padding:4px 6px;" />
    </label>
</div>
<div style="display:flex; gap:10px; flex-direction:column;">
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Phase</span><span id="opt-phase" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Decision</span><span id="opt-decision" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Accept/Reject</span><span id="opt-decision-count" style="margin-left:8px;">0 / 0</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Iter</span><span id="opt-iter" style="margin-left:8px;">0</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Vars</span><span id="opt-vars" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Req</span><span id="opt-req" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Res</span><span id="opt-res" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Score</span><span id="opt-cur" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Violation</span><span id="opt-vio" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Soft</span><span id="opt-soft" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Best</span><span id="opt-best" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Rho</span><span id="opt-rho" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Issue</span><span id="opt-issue" style="margin-left:8px;">-</span></div>
</div>
<details style="margin-top:10px; margin-bottom:10px; font-size:12px; color:#555;">
    <summary style="font-weight:600; margin-bottom:6px; cursor:pointer;">Stability Tuning</summary>
    <div style="display:grid; grid-template-columns: 180px 140px 1fr; gap:6px 10px; align-items:center; margin-top:6px;">
        <div>stepFraction</div>
        <input id="opt-step-fraction" type="number" step="0.001" value="0.02" style="width:120px; padding:4px 6px;" />
        <div>CDの初期ステップ比率（小さくすると安定）</div>

        <div>minStep</div>
        <input id="opt-min-step" type="number" step="1e-7" value="1e-6" style="width:120px; padding:4px 6px;" />
        <div>CDの最小ステップ</div>

        <div>stepDecay</div>
        <input id="opt-step-decay" type="number" step="0.05" value="0.5" style="width:120px; padding:4px 6px;" />
        <div>CDの失敗時縮小率</div>

        <div>lmLambda0</div>
        <input id="opt-lm-lambda0" type="number" step="1e-4" value="1e-3" style="width:120px; padding:4px 6px;" />
        <div>LM初期ダンピング</div>

        <div>lmLambdaUp</div>
        <input id="opt-lm-lambdaup" type="number" step="1" value="10" style="width:120px; padding:4px 6px;" />
        <div>LM拒否時の増加係数</div>

        <div>lmLambdaDown</div>
        <input id="opt-lm-lambdadown" type="number" step="0.05" value="0.3" style="width:120px; padding:4px 6px;" />
        <div>LM受理時の減少係数</div>

        <div>trustRegion</div>
        <input id="opt-trust-region" type="checkbox" checked style="width:16px; height:16px;" />
        <div>信頼領域を有効化</div>

        <div>trustRegionDelta</div>
        <input id="opt-trust-region-delta" type="number" step="0.01" value="0.05" style="width:120px; padding:4px 6px;" />
        <div>信頼領域の基本半径</div>

        <div>trustRegionDeltaMax</div>
        <input id="opt-trust-region-delta-max" type="number" step="0.1" value="1.0" style="width:120px; padding:4px 6px;" />
        <div>信頼領域の最大半径</div>

        <div>backtracking</div>
        <input id="opt-backtracking" type="checkbox" checked style="width:16px; height:16px;" />
        <div>LMのバックトラック探索</div>

        <div>backtrackingMaxTries</div>
        <input id="opt-backtracking-max-tries" type="number" step="1" value="8" style="width:120px; padding:4px 6px;" />
        <div>バックトラック試行回数</div>

        <div>fdStepFraction</div>
        <input id="opt-fd-step-fraction" type="number" step="1e-5" value="1e-4" style="width:120px; padding:4px 6px;" />
        <div>数値微分の相対ステップ</div>

        <div>fdMinStep</div>
        <input id="opt-fd-min-step" type="number" step="1e-19" value="1e-18" style="width:120px; padding:4px 6px;" />
        <div>数値微分の最小ステップ</div>

        <div>fdScaledStep</div>
        <input id="opt-fd-scaled-step" type="number" step="1e-4" value="1e-3" style="width:120px; padding:4px 6px;" />
        <div>スケール付き微分ステップ</div>

        <div>staged</div>
        <input id="opt-staged" type="checkbox" checked style="width:16px; height:16px;" />
        <div>係数の段階的解放</div>

        <div>stageStallLimit</div>
        <input id="opt-stage-stall-limit" type="number" step="1" value="2" style="width:120px; padding:4px 6px;" />
        <div>段階の停滞許容回数</div>

        <div>restartOnRejectStreak</div>
        <input id="opt-restart-on-reject-streak" type="number" step="1" value="8" style="width:120px; padding:4px 6px;" />
        <div>連続拒否でリスタート</div>

        <div>restartMaxCount</div>
        <input id="opt-restart-max-count" type="number" step="1" value="2" style="width:120px; padding:4px 6px;" />
        <div>リスタートの最大回数</div>

        <div>restartJitterScaled</div>
        <input id="opt-restart-jitter-scaled" type="number" step="0.005" value="0.035" style="width:120px; padding:4px 6px;" />
        <div>リスタート時のジッタ量</div>

        <div>lmExploreWhenFlat</div>
        <input id="opt-lm-explore-when-flat" type="checkbox" style="width:16px; height:16px;" />
        <div>LMが平坦時に探索を許可</div>

        <div>lmExploreTries</div>
        <input id="opt-lm-explore-tries" type="number" step="1" value="3" style="width:120px; padding:4px 6px;" />
        <div>探索ステップ試行回数</div>
    </div>
</details>
`;

                        try {
                            const varsEl = popup.document.getElementById('opt-vars');
                            if (varsEl) {
                                const parts = [];
                                if (Number.isFinite(variableCount)) parts.push(String(variableCount));
                                if (Number.isFinite(numericVarCount) || Number.isFinite(categoricalVarCount)) {
                                    parts.push(`(num ${numericVarCount}, cat ${categoricalVarCount})`);
                                }
                                varsEl.textContent = parts.length ? parts.join(' ') : '-';
                            }
                        } catch (_) {}

                        try {
                            const stopBtn = popup.document.getElementById('opt-stop');
                            const runBtn = popup.document.getElementById('opt-run');
                            const stopState = popup.document.getElementById('opt-stop-state');
                            if (stopBtn) {
                                stopBtn.addEventListener('click', () => {
                                    stopFlag.stop = true;
                                    try {
                                        const opt = window.OptimizationMVP;
                                        if (opt && typeof opt.stop === 'function') opt.stop();
                                    } catch (_) {}
                                    try { stopBtn.disabled = true; } catch (_) {}
                                    try { if (runBtn) runBtn.disabled = true; } catch (_) {}
                                    if (stopState) stopState.textContent = 'Stopping...';
                                });
                            }

                            // Wire Run in the popup; the actual start function is attached below.
                            if (runBtn) {
                                runBtn.addEventListener('click', () => {
                                    try {
                                        const fn = window.__cooptStartOptimizationFromPopup;
                                        if (typeof fn === 'function') fn();
                                    } catch (_) {}
                                });
                            }
                        } catch (_) {}
                    }
                } catch (_) {
                    popup = null;
                }

                // Popup watchdog: only used to stop updating UI when the window is gone.
                // Do NOT auto-stop the optimizer just because the popup closed.
                if (popup) {
                    try {
                        if (typeof globalThis !== 'undefined') {
                            globalThis.__cooptOptimizerSchedulerWindow = popup;
                            globalThis.__cooptOptimizerIsRunning = false;
                        }
                    } catch (_) {}
                    
                    // Warn user if trying to close window during optimization
                    try {
                        popup.onbeforeunload = function(e) {
                            if (globalThis && globalThis.__cooptOptimizerIsRunning) {
                                const message = 'Optimization is still running. Closing this window may cause instability. Are you sure?';
                                e.returnValue = message;
                                return message;
                            }
                        };
                    } catch (_) {}
                    
                    try {
                        popupWatchTimer = window.setInterval(() => {
                            if (!popup || popup.closed) {
                                // Warn if window was closed during optimization
                                if (globalThis && globalThis.__cooptOptimizerIsRunning) {
                                    alert('⚠️ Warning: Optimize Progress window was closed while optimization was running.\nThis may cause instability. Use the Stop button before closing the window.');
                                    stopFlag.stop = true;
                                    try {
                                        const opt = window.OptimizationMVP;
                                        if (opt && typeof opt.stop === 'function') opt.stop();
                                    } catch (_) {}
                                }
                                
                                if (popupWatchTimer) {
                                    try { window.clearInterval(popupWatchTimer); } catch (_) {}
                                    popupWatchTimer = null;
                                }
                                try {
                                    if (typeof globalThis !== 'undefined' && globalThis.__cooptOptimizerSchedulerWindow === popup) {
                                        globalThis.__cooptOptimizerSchedulerWindow = null;
                                    }
                                } catch (_) {}
                            }
                        }, 250);
                    } catch (_) {
                        // ignore
                    }
                }

                const totalMeritEl = document.getElementById('total-merit-value');
                let lastIssueText = '-';
                let lastReqText = '-';
                let lastResText = '-';
                let lastRhoText = '-';
                let lastVioText = '-';
                let lastSoftText = '-';
                let lastDecisionText = '-';
                let acceptCount = 0;
                let rejectCount = 0;
                let __lastReqRefreshAt = 0;
                const __reqRefreshThrottleMs = 500;
                const updateProgressUI = (p) => {
                    // If popup was closed, just stop UI updates (optimizer can continue).

                    // If the optimizer has actually stopped, allow a new Optimize run immediately.
                    // (Cleanup/UI sync may still be finishing, but the heavy loop is done.)
                    const phaseStr = String(p?.phase ?? '');
                    if (phaseStr === 'stopped' || phaseStr === 'done' || phaseStr === 'error') {
                        try { optimizeBtn.disabled = false; } catch (_) {}
                        isRunning = false;
                    }

                    // Sticky accept/reject decision: Phase can change too quickly to notice.
                    if (phaseStr === 'accept') {
                        acceptCount++;
                        const a = (p && ('alpha' in p)) ? Number(p.alpha) : NaN;
                        const r = (p && ('rho' in p)) ? Number(p.rho) : NaN;
                        const aText = Number.isFinite(a) ? a.toFixed(6) : '-';
                        const rText = Number.isFinite(r) ? r.toFixed(6) : '-';
                        lastDecisionText = `ACCEPT (α=${aText}, ρ=${rText})`;
                    } else if (phaseStr === 'reject') {
                        rejectCount++;
                        lastDecisionText = 'REJECT';
                    }

                    const cur = Number(p?.current);
                    const best = Number(p?.best);
                    if (totalMeritEl && Number.isFinite(cur)) {
                        totalMeritEl.textContent = cur.toFixed(6);
                    }

                    // Optimizer evaluates operands directly, so the Requirements table can become stale.
                    // Refresh it at a low rate so UI reflects the same (fast-mode) state driving the score.
                    try {
                        const now = Date.now();
                        if ((now - __lastReqRefreshAt) >= __reqRefreshThrottleMs) {
                            if (phaseStr === 'start' || phaseStr === 'iter' || phaseStr === 'candidate' || phaseStr === 'accept' || phaseStr === 'reject') {
                                const sre = window.systemRequirementsEditor;
                                if (sre && typeof sre.scheduleEvaluateAndUpdate === 'function') {
                                    __lastReqRefreshAt = now;
                                    sre.scheduleEvaluateAndUpdate();
                                }
                            }
                        }
                    } catch (_) {}
                    if (p && ('materialIssue' in p)) {
                        lastIssueText = (p.materialIssue === undefined || p.materialIssue === null || p.materialIssue === '')
                            ? '-'
                            : String(p.materialIssue);
                    }

                    // Surface the worst residual/requirement contributor (debug from optimizer-mvp.js).
                    // This is the most useful explanation for a large Score.
                    try {
                        const dbg = (window.__cooptLastOptimizerResidualDebug && typeof window.__cooptLastOptimizerResidualDebug === 'object')
                            ? window.__cooptLastOptimizerResidualDebug
                            : null;
                        const worst = dbg && dbg.worst && typeof dbg.worst === 'object' ? dbg.worst : null;
                        const at = dbg ? Number(dbg.at) : NaN;
                        const fresh = Number.isFinite(at) ? (Date.now() - at) < 3000 : false;
                        const fmtNum = (x) => {
                            const n = Number(x);
                            return Number.isFinite(n) ? n.toFixed(6) : String(x ?? '-');
                        };
                        if (fresh && worst && worst.operand) {
                            const op = String(worst.operand);
                            const cfg = String(worst.configId ?? '');
                            const sid = (worst.scenarioId !== undefined && worst.scenarioId !== null && String(worst.scenarioId).trim())
                                ? String(worst.scenarioId)
                                : '';
                            const amt = fmtNum(worst.amount);
                            const curV = fmtNum(worst.current);
                            const rsn = String(worst.reason ?? '').trim();

                            const spotTag = (() => {
                                try {
                                    if (!op.startsWith('SPOT_SIZE')) return '';
                                    const sd = (dbg && dbg.spotDebug && typeof dbg.spotDebug === 'object') ? dbg.spotDebug : null;
                                    if (!sd) return '';
                                    const impl = String(sd.impl ?? '').trim();
                                    const r = String(sd.reason ?? '').trim();
                                    const hrRaw = sd.earlyAbortHitRate;
                                    const hr = (hrRaw === null || hrRaw === undefined || hrRaw === '') ? NaN : Number(hrRaw);
                                    const kind = String(sd.failPenaltyKind ?? '').trim();
                                    const lf = (sd.lastRayTraceFailure && typeof sd.lastRayTraceFailure === 'object') ? sd.lastRayTraceFailure : null;
                                    const ld = (lf && lf.details && typeof lf.details === 'object') ? lf.details : null;
                                    const surfNo = Number(sd.blockSurfaceNumber ?? ld?.surfaceNumber);
                                    const hitR = Number(sd.blockHitRadiusMm ?? ld?.hitRadiusMm);
                                    const limR = Number(sd.blockApertureLimitMm ?? ld?.apertureLimitMm);
                                    const surfIdx = Number(sd.targetSurfaceIndex);
                                    const wl = Number(sd.wavelength);
                                    const rays = Number(sd.rayCountRequested);
                                    const hits = Number(sd.hits);
                                    const parts = [];
                                    if (impl) parts.push(impl);
                                    if (r) parts.push(r);
                                    if (Number.isFinite(hr)) parts.push(`hitRate=${hr.toFixed(3)}`);
                                    if (kind) parts.push(kind);
                                    if (Number.isFinite(surfIdx) && surfIdx >= 0) parts.push(`Sidx=${Math.floor(surfIdx)}`);
                                    if (Number.isFinite(wl) && wl > 0) parts.push(`wl=${wl.toFixed(4)}um`);
                                    if (Number.isFinite(rays) && rays > 0) parts.push(`rays=${Math.floor(rays)}`);
                                    if (Number.isFinite(hits) && hits >= 0) parts.push(`hits=${Math.floor(hits)}`);
                                    if (kind === 'PHYSICAL_APERTURE_BLOCK') {
                                        if (Number.isFinite(surfNo) && surfNo > 0) parts.push(`S${Math.floor(surfNo)}`);
                                        if (Number.isFinite(hitR) && Number.isFinite(limR) && limR > 0) {
                                            parts.push(`r=${hitR.toFixed(3)}/${limR.toFixed(3)}mm`);
                                        }
                                    }
                                    return parts.length > 0 ? ` [spot:${parts.join(' ')}]` : '';
                                } catch (_) {
                                    return '';
                                }
                            })();

                            const tag = sid ? ` cfg=${cfg} scn=${sid}` : (cfg ? ` cfg=${cfg}` : '');
                            const reasonTag = rsn ? ` (${rsn})` : '';

                            // Keep it single-line and compact.
                            lastIssueText = `Worst: ${op}${tag} cur=${curV} amt=${amt}${reasonTag}${spotTag}`;
                        }
                    } catch (_) {}

                    if (p?.requirementCount !== undefined) {
                        lastReqText = String(p.requirementCount);
                    }
                    if (p?.residualCount !== undefined) {
                        lastResText = String(p.residualCount);
                    }

                    // LM gain ratio (rho): keep sticky so non-candidate phases don't clear it.
                    if (p && ('rho' in p)) {
                        const r = Number(p.rho);
                        lastRhoText = Number.isFinite(r) ? r.toFixed(6) : '-';
                    }

                    // Score breakdown: sticky so intermediate LM phases don't erase it.
                    if (p && ('violationScore' in p)) {
                        const v = Number(p.violationScore);
                        lastVioText = Number.isFinite(v) ? v.toFixed(6) : '-';
                    }
                    if (p && ('softPenalty' in p)) {
                        const s = Number(p.softPenalty);
                        lastSoftText = Number.isFinite(s) ? s.toFixed(6) : '-';
                    }

                    if (popup && !popup.closed) {
                        try {
                            const doc = popup.document;
                            const setText = (id, v) => {
                                const el = doc.getElementById(id);
                                if (el) el.textContent = v;
                            };
                            setText('opt-phase', String(p?.phase ?? '-'));
                            setText('opt-decision', lastDecisionText);
                            setText('opt-decision-count', `${acceptCount} / ${rejectCount}`);
                            setText('opt-iter', String(p?.iter ?? '-'));
                            setText('opt-req', lastReqText);
                            setText('opt-res', lastResText);
                            setText('opt-cur', Number.isFinite(cur) ? cur.toFixed(6) : String(p?.current ?? '-'));
                            setText('opt-vio', lastVioText);
                            setText('opt-soft', lastSoftText);
                            setText('opt-best', Number.isFinite(best) ? best.toFixed(6) : String(p?.best ?? '-'));
                            setText('opt-rho', lastRhoText);
                            setText('opt-issue', lastIssueText);

                            // Stop state rendering
                            if (String(p?.phase) === 'stopped') {
                                setText('opt-stop-state', 'Stopped');
                                try {
                                    const btn = doc.getElementById('opt-stop');
                                    if (btn) btn.disabled = true;
                                    const runBtn = doc.getElementById('opt-run');
                                    if (runBtn) runBtn.disabled = false;
                                } catch (_) {}
                            } else if (String(p?.phase) === 'done') {
                                setText('opt-stop-state', 'Done');
                                try {
                                    const btn = doc.getElementById('opt-stop');
                                    if (btn) btn.disabled = true;
                                    const runBtn = doc.getElementById('opt-run');
                                    if (runBtn) runBtn.disabled = false;
                                } catch (_) {}
                            } else if (String(p?.phase) === 'error') {
                                setText('opt-stop-state', 'Error');
                                try {
                                    const btn = doc.getElementById('opt-stop');
                                    if (btn) btn.disabled = true;
                                    const runBtn = doc.getElementById('opt-run');
                                    if (runBtn) runBtn.disabled = false;
                                } catch (_) {}
                            } else if (stopFlag.stop) {
                                setText('opt-stop-state', 'Stopping...');
                            }
                        } catch (_) {}
                    }
                };

                const startRun = async () => {
                    if (isRunning) return;
                    isRunning = true;
                    if (typeof globalThis !== 'undefined') {
                        globalThis.__cooptOptimizerIsRunning = true;
                    }

                    // Save state before optimization for undo
                    let beforeOptimizationState = null;
                    try {
                        const json = localStorage.getItem('systemConfigurations');
                        if (json) {
                            beforeOptimizationState = JSON.parse(json);
                        }
                    } catch (_) {}

                    stopFlag.stop = false;
                    acceptCount = 0;
                    rejectCount = 0;
                    lastIssueText = '-';
                    lastReqText = '-';
                    lastResText = '-';
                    lastRhoText = '-';
                    lastVioText = '-';
                    lastSoftText = '-';
                    lastDecisionText = '-';

                    try {
                        // Sync popup button states
                        if (popup && !popup.closed) {
                            const doc = popup.document;
                            const stopBtn = doc.getElementById('opt-stop');
                            const runBtn = doc.getElementById('opt-run');
                            const stopState = doc.getElementById('opt-stop-state');
                            if (stopBtn) stopBtn.disabled = false;
                            if (runBtn) runBtn.disabled = true;
                            if (stopState) stopState.textContent = 'Running...';
                        }
                    } catch (_) {}

                    try { optimizeBtn.disabled = true; } catch (_) {}

                    console.log('🛠️ [Optimize] Running OptimizationMVP...', { multiScenario });
                    const shouldStopNow = () => {
                        return !!stopFlag.stop;
                    };

                    const resolveMaxIterations = () => {
                        let n = 1000;
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-max-iter');
                                const v = el ? Number(el.value) : NaN;
                                if (Number.isFinite(v)) n = Math.trunc(v);
                            }
                        } catch (_) {}
                        if (!Number.isFinite(n) || n < 1) n = 1000;
                        return n;
                    };

                    const resolveOptParams = () => {
                        const readNum = (id, fallback) => {
                            let v = fallback;
                            try {
                                if (popup && !popup.closed) {
                                    const el = popup.document.getElementById(id);
                                    const n = el ? Number(el.value) : NaN;
                                    if (Number.isFinite(n)) v = n;
                                }
                            } catch (_) {}
                            return v;
                        };
                        const readBool = (id, fallback) => {
                            let v = fallback;
                            try {
                                if (popup && !popup.closed) {
                                    const el = popup.document.getElementById(id);
                                    if (el && typeof el.checked === 'boolean') v = !!el.checked;
                                }
                            } catch (_) {}
                            return v;
                        };

                        const trustRegionDelta = readNum('opt-trust-region-delta', 0.05);
                        const trustRegionDeltaMax = Math.max(trustRegionDelta, readNum('opt-trust-region-delta-max', 1.0));

                        return {
                            stepFraction: readNum('opt-step-fraction', 0.02),
                            minStep: readNum('opt-min-step', 1e-6),
                            stepDecay: readNum('opt-step-decay', 0.5),
                            lmLambda0: readNum('opt-lm-lambda0', 1e-3),
                            lmLambdaUp: readNum('opt-lm-lambdaup', 10),
                            lmLambdaDown: readNum('opt-lm-lambdadown', 0.3),
                            trustRegion: readBool('opt-trust-region', true),
                            trustRegionDelta,
                            trustRegionDeltaMax,
                            backtracking: readBool('opt-backtracking', true),
                            backtrackingMaxTries: Math.max(1, Math.floor(readNum('opt-backtracking-max-tries', 8))),
                            fdStepFraction: readNum('opt-fd-step-fraction', 1e-4),
                            fdMinStep: readNum('opt-fd-min-step', 1e-18),
                            fdScaledStep: readNum('opt-fd-scaled-step', 1e-3),
                            staged: readBool('opt-staged', true),
                            stageStallLimit: Math.max(1, Math.floor(readNum('opt-stage-stall-limit', 2))),
                            restartOnRejectStreak: Math.max(1, Math.floor(readNum('opt-restart-on-reject-streak', 8))),
                            restartMaxCount: Math.max(0, Math.floor(readNum('opt-restart-max-count', 2))),
                            restartJitterScaled: Math.max(0, readNum('opt-restart-jitter-scaled', 0.035)),
                            lmExploreWhenFlat: readBool('opt-lm-explore-when-flat', false),
                            lmExploreTries: Math.max(1, Math.floor(readNum('opt-lm-explore-tries', 3)))
                        };
                    };

                    const maxIterations = resolveMaxIterations();
                    const optParams = resolveOptParams();

                    let result = null;
                    try {
                        // Prevent undo recording during optimization
                        if (window.undoHistory) {
                            window.undoHistory.isExecuting = true;
                        }
                        
                        // Force-disable ray-tracing detailed debug logs during optimization.
                        // This prevents WASM intersection fast-path from being bypassed.
                        let __prevDisableRayTraceDebug;
                        let __prevOptimizerIsRunning;
                        try {
                            __prevDisableRayTraceDebug = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG : undefined;
                        } catch (_) { __prevDisableRayTraceDebug = undefined; }
                        try {
                            __prevOptimizerIsRunning = (typeof globalThis !== 'undefined') ? globalThis.__cooptOptimizerIsRunning : undefined;
                        } catch (_) { __prevOptimizerIsRunning = undefined; }
                        try {
                            if (typeof globalThis !== 'undefined') {
                                globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG = true;
                                globalThis.__cooptOptimizerIsRunning = true;
                            }
                        } catch (_) {}

                        result = await opt.run({
                            multiScenario,
                            // Run a bounded number of iterations by default so
                            // the optimizer does not depend on the popup staying open.
                            runUntilStopped: false,
                            maxIterations,
                            method: 'lm',
                            stageMaxCoef: [10], // unlock all asphere coef at once
                            ...optParams,
                            onProgress: updateProgressUI,
                            shouldStop: shouldStopNow
                        });
                        console.log('✅ [Optimize] Done', result);

                        // Restore flags after successful completion.
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (__prevDisableRayTraceDebug !== undefined) globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
                                else {
                                    try { delete globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
                                }
                                if (__prevOptimizerIsRunning !== undefined) globalThis.__cooptOptimizerIsRunning = __prevOptimizerIsRunning;
                                else {
                                    try { delete globalThis.__cooptOptimizerIsRunning; } catch (_) {}
                                }
                            }
                        } catch (_) {}
                        
                        // Re-enable undo recording after optimization
                        if (window.undoHistory) {
                            window.undoHistory.isExecuting = false;
                        }
                        
                        // Record optimization as a single undo operation
                        try {
                            if (beforeOptimizationState && window.undoHistory && result?.ok) {
                                const afterOptimizationState = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
                                if (JSON.stringify(beforeOptimizationState) !== JSON.stringify(afterOptimizationState)) {
                                    const command = {
                                        name: 'Optimization',
                                        execute: () => {
                                            localStorage.setItem('systemConfigurations', JSON.stringify(afterOptimizationState));
                                            window.location.reload();
                                        },
                                        undo: () => {
                                            localStorage.setItem('systemConfigurations', JSON.stringify(beforeOptimizationState));
                                            window.location.reload();
                                        },
                                        redo: function() { this.execute(); }
                                    };
                                    window.undoHistory.record(command);
                                    console.log('[Undo] Recorded: Optimization');
                                }
                            }
                        } catch (e) {
                            console.warn('[Undo] Failed to record optimization:', e);
                        }
                    } catch (e) {
                        console.warn('⚠️ [Optimize] Failed:', e);
                        result = { ok: false, reason: e?.message ?? String(e) };

                        // Restore flags on error too.
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (__prevDisableRayTraceDebug !== undefined) globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
                                else {
                                    try { delete globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
                                }
                                if (__prevOptimizerIsRunning !== undefined) globalThis.__cooptOptimizerIsRunning = __prevOptimizerIsRunning;
                                else {
                                    try { delete globalThis.__cooptOptimizerIsRunning; } catch (_) {}
                                }
                            }
                        } catch (_) {}
                        
                        // Re-enable undo recording even on error
                        if (window.undoHistory) {
                            window.undoHistory.isExecuting = false;
                        }
                    }

                    // Ensure UI is consistent after the run.
                    isRunning = false;
                    if (typeof globalThis !== 'undefined') {
                        globalThis.__cooptOptimizerIsRunning = false;
                    }
                    try { optimizeBtn.disabled = false; } catch (_) {}
                    try {
                        if (popup && !popup.closed) {
                            const doc = popup.document;
                            const stopBtn = doc.getElementById('opt-stop');
                            const runBtn = doc.getElementById('opt-run');
                            const stopState = doc.getElementById('opt-stop-state');
                            if (stopBtn) stopBtn.disabled = true;
                            if (runBtn) runBtn.disabled = false;
                            if (stopState && stopFlag.stop) stopState.textContent = 'Stopped';
                        }
                    } catch (_) {}

                    if (result && result.ok === false) {
                        const reason = String(result.reason || 'Optimize did not run.');
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-phase');
                                if (el) el.textContent = 'error';
                                const cur = popup.document.getElementById('opt-cur');
                                if (cur) cur.textContent = reason;
                            }
                        } catch (_) {}
                        alert(reason);
                    }
                };

                // Expose the starter in a predictable place for the popup.
                // (Popup event handler can't close over this function directly across reloads.)
                try {
                    window.__cooptStartOptimizationFromPopup = startRun;
                } catch (_) {}

                // Initial run
                await startRun();

            } catch (e) {
                console.warn('⚠️ [Optimize] Failed:', e);
                alert('Optimize の実行に失敗しました。console を確認してください。');
            } finally {
                try {
                    optimizeBtn.disabled = false;
                } catch (_) {}
            }
        });
    }
}

/**
 * ロードボタンのイベントハンドラーを設定
 */
function setupLoadButton() {
    const loadBtn = document.getElementById('load-all-btn');
    if (loadBtn) {
        loadBtn.addEventListener('click', function() {
            console.log('🔵 [Load] Load button clicked');
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            
            // DOMに一時的に追加（非表示）
            input.style.display = 'none';
            document.body.appendChild(input);
            console.log('🔵 [Load] Input element created and added to DOM');
            
            input.onchange = e => {
                const file = e.target.files[0];
                console.log('🔵 [Load] File selected:', file ? file.name : 'none');
                if (!file) {
                    // クリーンアップ
                    document.body.removeChild(input);
                    return;
                }
                const reader = new FileReader();
                reader.onload = async evt => {
                    console.log('🔵 [Load] File read complete, parsing JSON...');
                    let allData;
                    try {
                        allData = JSON.parse(evt.target.result);
                    } catch (err) {
                        showLoadErrors([
                            { severity: 'fatal', phase: 'parse', message: `JSON parse error: ${err?.message || String(err)}` }
                        ], { filename: file.name });
                        document.body.removeChild(input);
                        return;
                    }

                    console.log('🔵 [Load] JSON parsed successfully');
                    await __loadAllDataObjectIntoApp(allData, { filename: file.name });

                    // Clean up file input (we no longer reload).
                    document.body.removeChild(input);
                };
                reader.onerror = () => {
                    console.error('❌ [Load] FileReader error:', reader.error);
                    showLoadErrors([
                        { severity: 'fatal', phase: 'parse', message: `FileReader error: ${reader.error?.message || String(reader.error)}` }
                    ], { filename: file.name });
                    // クリーンアップ
                    document.body.removeChild(input);
                };
                console.log('🔵 [Load] Starting file read...');
                reader.readAsText(file);
            };
            
            console.log('🔵 [Load] Triggering file dialog...');
            input.click();
        });
    }
}

/**
 * ストレージクリアボタンのイベントハンドラーを設定
 */
function setupClearStorageButton() {
    const clearStorageBtn = document.getElementById('clear-storage-btn');
    if (clearStorageBtn) {
        clearStorageBtn.addEventListener('click', async function() {
            // NOTE: Browser-native confirm/alert localize button labels (e.g. キャンセル/閉じる).
            // For Clear Cache UX, use a minimal custom modal so buttons are always English.
            const __clearCacheModal = ({ message, buttons, defaultValue = null }) => {
                return new Promise((resolve) => {
                    const cleanup = (value) => {
                        try { document.removeEventListener('keydown', onKeyDown, true); } catch (_) {}
                        try { overlay.remove(); } catch (_) {}
                        resolve(value);
                    };

                    const overlay = document.createElement('div');
                    overlay.setAttribute('role', 'dialog');
                    overlay.setAttribute('aria-modal', 'true');
                    overlay.style.cssText = [
                        'position: fixed',
                        'inset: 0',
                        'background: rgba(0, 0, 0, 0.35)',
                        'display: flex',
                        'align-items: center',
                        'justify-content: center',
                        'z-index: 2147483647'
                    ].join(';');

                    const box = document.createElement('div');
                    box.style.cssText = [
                        'background: #fff',
                        'color: #111',
                        'max-width: min(560px, calc(100vw - 32px))',
                        'border-radius: 10px',
                        'padding: 16px 16px 12px 16px',
                        'box-shadow: 0 12px 32px rgba(0,0,0,0.25)'
                    ].join(';');

                    const body = document.createElement('div');
                    body.style.cssText = [
                        'white-space: pre-wrap',
                        'line-height: 1.4',
                        'font-size: 14px'
                    ].join(';');
                    body.textContent = String(message ?? '');

                    const footer = document.createElement('div');
                    footer.style.cssText = [
                        'display: flex',
                        'gap: 8px',
                        'justify-content: flex-end',
                        'margin-top: 12px'
                    ].join(';');

                    const makeBtn = (b) => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.textContent = String(b?.label ?? 'OK');
                        btn.style.cssText = [
                            'padding: 6px 14px',
                            'border-radius: 8px',
                            'border: 1px solid #ccc',
                            'background: #f7f7f7',
                            'cursor: pointer'
                        ].join(';');
                        if (b?.primary) {
                            btn.style.border = '1px solid #0b57d0';
                            btn.style.background = '#0b57d0';
                            btn.style.color = '#fff';
                        }
                        btn.addEventListener('click', () => cleanup(b?.value));
                        return btn;
                    };

                    const onKeyDown = (ev) => {
                        if (ev.key === 'Escape') {
                            ev.preventDefault();
                            ev.stopPropagation();
                            cleanup(defaultValue);
                        }
                    };
                    document.addEventListener('keydown', onKeyDown, true);

                    overlay.addEventListener('click', (ev) => {
                        if (ev.target === overlay) cleanup(defaultValue);
                    });

                    for (const b of (Array.isArray(buttons) ? buttons : [])) {
                        footer.appendChild(makeBtn(b));
                    }

                    box.appendChild(body);
                    box.appendChild(footer);
                    overlay.appendChild(box);
                    document.body.appendChild(overlay);

                    // Focus primary button if present, else first.
                    try {
                        const btns = footer.querySelectorAll('button');
                        const primary = footer.querySelector('button[style*="background: rgb(11, 87, 208)"]');
                        (primary || btns[btns.length - 1] || btns[0])?.focus?.();
                    } catch (_) {}
                });
            };

            const confirmed = await __clearCacheModal({
                message:
                    'ブラウザのキャッシュデータを削除してもよろしいですか? この操作は元に戻せません。\n\n' +
                    'Do you want to clear the browser cache data? This action cannot be undone.',
                buttons: [
                    { label: 'Cancel', value: false },
                    { label: 'OK', value: true, primary: true }
                ],
                defaultValue: false
            });
            if (confirmed) {
                try {
                    // IMPORTANT: Clear Cache ends with location.reload().
                    // The Configuration module installs a beforeunload autosave which would otherwise
                    // overwrite the freshly-written default configurations with the *current* table data.
                    // Disable autosave for the remainder of this flow to avoid cross-config corruption.
                    try { globalThis.__configurationAutoSaveDisabled = true; } catch (_) {}

                    localStorage.removeItem('sourceTableData');
                    localStorage.removeItem('objectTableData');
                    localStorage.removeItem('OpticalSystemTableData');
                    localStorage.removeItem('opticalSystemTableData');
                    localStorage.removeItem('meritFunctionData');
                    localStorage.removeItem('systemRequirementsData');
                    localStorage.removeItem('loadedFileName'); // ファイル名もクリア
                    localStorage.removeItem('loadedFileWarn'); // load warning flag もクリア
                    localStorage.removeItem('systemConfigurations'); // Configurationsもクリア
                    localStorage.removeItem('systemData'); // System Dataもクリア

                    // After clearing, immediately bootstrap a default design (same behavior as Load).
                    // This keeps Design Intent editable without requiring manual file selection.
                    try {
                        // NOTE: keep this as a string literal so the GitHub Pages docs builder can include it.
                        const res = await fetch('defaults/default-load.json', { cache: 'no-store' });
                        if (!res.ok) throw new Error(`Failed to fetch default JSON: ${res.status} ${res.statusText}`);
                        const text = await res.text();
                        const parsed = JSON.parse(text);

                        // Reuse the Load pipeline (normalize -> validate/derive blocks -> expand active -> persist).
                        // We only persist to storage here; the page will reload afterwards.
                        let allData = parsed;
                        setLoadWarnUIFlag(false);
                        const normalizedResult = normalizeDesign(allData);
                        // If normalization emits fatal issues, fall back to empty state.
                        const fatalNorm = (normalizedResult.issues || []).some(i => i && i.severity === 'fatal');
                        if (!fatalNorm) {
                            allData = normalizedResult.normalized;
                            const candidateConfig = allData?.configurations;
                            const cfgList = Array.isArray(candidateConfig?.configurations) ? candidateConfig.configurations : [];

                            const issues = [];
                            const countBlocksByType = (blocks) => {
                                const out = { Lens: 0, Doublet: 0, Triplet: 0, Gap: 0, AirGap: 0, Stop: 0, ImageSurface: 0, Other: 0 };
                                if (!Array.isArray(blocks)) return out;
                                for (const b of blocks) {
                                    const t = String(b?.blockType ?? '');
                                    if (Object.prototype.hasOwnProperty.call(out, t)) out[t]++;
                                    else out.Other++;
                                }
                                return out;
                            };
                            const blocksLookSuspicious = (cfg) => {
                                try {
                                    const blocks = cfg?.blocks;
                                    if (!Array.isArray(blocks) || blocks.length === 0) return false;
                                    const isNumericish = (v) => {
                                        if (typeof v === 'number') return Number.isFinite(v);
                                        const s = String(v ?? '').trim();
                                        if (!s) return false;
                                        return /^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(s);
                                    };
                                    for (const b of blocks) {
                                        const type = String(b?.blockType ?? '');
                                        if (type === 'Lens') {
                                            const mat = b?.parameters?.material;
                                            if (isNumericish(mat)) return true;
                                        }
                                        if (type === 'Doublet' || type === 'Triplet') {
                                            const m1 = b?.parameters?.material1;
                                            const m2 = b?.parameters?.material2;
                                            const m3 = b?.parameters?.material3;
                                            if (isNumericish(m1) || isNumericish(m2) || isNumericish(m3)) return true;
                                        }
                                    }
                                    return false;
                                } catch (_) {
                                    return false;
                                }
                            };

                            for (const cfg of cfgList) {
                                try {
                                    const legacyRows = Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : null;
                                    if (!legacyRows || legacyRows.length === 0) continue;

                                    const hasBlocks = configurationHasBlocks(cfg);
                                    const suspicious = hasBlocks && blocksLookSuspicious(cfg);
                                    const existingCounts = hasBlocks ? countBlocksByType(cfg.blocks) : null;

                                    const derived = deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
                                    const hasFatal = Array.isArray(derived?.issues) && derived.issues.some(i => i && i.severity === 'fatal');
                                    if (hasFatal) {
                                        if (!hasBlocks) {
                                            if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
                                            cfg.metadata.importAnalyzeMode = true;
                                        }
                                        continue;
                                    }

                                    const derivedCounts = countBlocksByType(derived?.blocks);
                                    const wouldIncreaseDoublets = !!existingCounts && (derivedCounts.Doublet > existingCounts.Doublet);
                                    if (!hasBlocks || suspicious || wouldIncreaseDoublets) {
                                        cfg.schemaVersion = cfg.schemaVersion || BLOCK_SCHEMA_VERSION;
                                        cfg.blocks = Array.isArray(derived?.blocks) ? derived.blocks : [];
                                        if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
                                        cfg.metadata.importAnalyzeMode = false;
                                    }
                                    if (Array.isArray(derived?.issues) && derived.issues.length > 0) {
                                        issues.push(...derived.issues);
                                    }
                                } catch (e) {
                                    issues.push({ severity: 'warning', phase: 'validate', message: `Blocks conversion failed unexpectedly: ${e?.message || String(e)}` });
                                }
                            }

                            for (const cfg of cfgList) {
                                if (configurationHasBlocks(cfg)) {
                                    issues.push(...validateBlocksConfiguration(cfg));
                                }
                            }

                            // Expand active config if it has blocks so OpticalSystemTableData is usable immediately.
                            try {
                                const activeId = candidateConfig?.activeConfigId || 1;
                                const activeCfg = cfgList.find(c => c.id === activeId) || cfgList[0];
                                if (activeCfg && configurationHasBlocks(activeCfg)) {
                                    const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
                                    issues.push(...expanded.issues);
                                    // Prefer keeping legacy opticalSystem rows if present; otherwise use expanded.
                                    if (!Array.isArray(activeCfg.opticalSystem) || activeCfg.opticalSystem.length === 0) {
                                        activeCfg.opticalSystem = expanded.rows;
                                    }
                                }
                            } catch (e) {
                                issues.push({ severity: 'warning', phase: 'expand', message: `Expand failed: ${e?.message || String(e)}` });
                            }

                            // Persist configurations wrapper.
                            localStorage.setItem('systemConfigurations', JSON.stringify(candidateConfig));

                            // Persist table data (match Load behavior as closely as possible).
                            const activeId = candidateConfig?.activeConfigId || 1;
                            const activeCfg = cfgList.find(c => c.id === activeId) || cfgList[0] || null;
                            // Prefer per-config tables for the active config. Some JSONs may also include
                            // top-level `source/object/opticalSystem`, which can belong to a different config.
                            // Source is global: prefer top-level; fall back to legacy per-config source only if needed.
                            const effectiveSource = Array.isArray(allData.source)
                                ? allData.source
                                : ((activeCfg && Array.isArray(activeCfg.source)) ? activeCfg.source : []);
                            const effectiveObject = (activeCfg && Array.isArray(activeCfg.object)) ? activeCfg.object : (allData.object ?? []);
                            const effectiveOpticalSystem = (activeCfg && configurationHasBlocks(activeCfg) && Array.isArray(activeCfg.opticalSystem))
                                ? activeCfg.opticalSystem
                                : ((activeCfg && Array.isArray(activeCfg.opticalSystem)) ? activeCfg.opticalSystem : (allData.opticalSystem ?? []));
                            const effectiveMeritFunction = allData.meritFunction ?? candidateConfig?.meritFunction ?? [];
                            const effectiveSystemRequirements = allData.systemRequirements ?? candidateConfig?.systemRequirements ?? [];
                            const effectiveSystemData = allData.systemData ?? activeCfg?.systemData ?? null;

                            saveSourceTableData(effectiveSource || []);
                            saveObjectTableData(effectiveObject || []);
                            saveLensTableData(effectiveOpticalSystem || []);
                            if (effectiveMeritFunction) localStorage.setItem('meritFunctionData', JSON.stringify(effectiveMeritFunction));
                            if (effectiveSystemRequirements) localStorage.setItem('systemRequirementsData', JSON.stringify(effectiveSystemRequirements));
                            if (effectiveSystemData) localStorage.setItem('systemData', JSON.stringify(effectiveSystemData));

                            // Keep consistent UX: show a loaded file name.
                            localStorage.setItem('loadedFileName', 'defaults/default-load.json');

                            // If there were warnings, set the warning UI flag.
                            const hasWarnings = (normalizedResult.issues || []).some(i => i && i.severity === 'warning') || (issues || []).some(i => i && i.severity === 'warning');
                            if (hasWarnings) {
                                try { localStorage.setItem('loadedFileWarn', '1'); } catch (_) {}
                                setLoadWarnUIFlag(true);
                            }
                        }
                    } catch (e) {
                        console.warn('⚠️ [ClearStorage] Failed to load default JSON after clear:', e);
                    }
                    
                    await __clearCacheModal({
                        message:
                            'ローカルキャッシュがクリアされました。デフォルト設計を読み込み、ページをリロードします。\n\n' +
                            'Local cache has been cleared. Loading the default design and reloading the page.',
                        buttons: [{ label: 'Close', value: true, primary: true }],
                        defaultValue: true
                    });
                    console.log('✅ ローカルキャッシュがクリアされました');
                    location.reload();
                } catch (error) {
                    console.error('❌ ローカルストレージクリアエラー:', error);
                    try { globalThis.__configurationAutoSaveDisabled = false; } catch (_) {}
                    alert('ローカルストレージのクリアに失敗しました。');
                }
            }
        });
    }
}

/**
 * 近軸計算ボタンのイベントハンドラーを設定
 */
function setupParaxialButton() {
    const paraxialBtn = document.getElementById('calculate-paraxial-btn');
    if (paraxialBtn) {

        paraxialBtn.addEventListener('click', function() {
            console.log('📐 近軸計算ボタンがクリックされました');
            try {
                if (typeof window.outputParaxialDataToDebug === 'function') {
                    // テーブルインスタンスを取得して渡す
                    const tableOpticalSystem = window.tableOpticalSystem;
                    window.outputParaxialDataToDebug(tableOpticalSystem);
                    console.log('✅ 近軸計算が完了しました');
                } else {
                    console.error('❌ outputParaxialDataToDebug関数が見つかりません');
                }
            } catch (error) {
                console.error('❌ 近軸計算ボタンエラー:', error);
            }
        });
    } else {
        console.error('❌ 近軸計算ボタンが見つかりません');
    }
}

/**
 * Seidel係数計算ボタンのイベントハンドラーを設定
 */
function setupSeidelButton() {
    const seidelBtn = document.getElementById('calculate-seidel-btn');
    if (seidelBtn) {

        seidelBtn.addEventListener('click', function() {
            console.log('🔬 Seidel係数計算ボタンがクリックされました');
            try {
                if (typeof window.outputSeidelCoefficientsToDebug === 'function') {
                    window.outputSeidelCoefficientsToDebug();
                    console.log('✅ Seidel係数計算が完了しました');
                } else {
                    console.error('❌ outputSeidelCoefficientsToDebug関数が見つかりません');
                }
            } catch (error) {
                console.error('❌ Seidel係数計算ボタンエラー:', error);
            }
        });
    } else {
        console.error('❌ Seidel係数計算ボタンが見つかりません');
    }
}

/**
 * Seidel係数計算（アフォーカル系）ボタンのイベントハンドラーを設定
 */
async function setupSeidelAfocalButton() {
    const seidelAfocalBtn = document.getElementById('calculate-seidel-afocal-btn');
    if (seidelAfocalBtn) {

        seidelAfocalBtn.addEventListener('click', async function() {
            console.log('🔬 Seidel係数計算（アフォーカル）ボタンがクリックされました');
            try {
                const { calculateAfocalSeidelCoefficientsIntegrated } = await import('../evaluation/aberrations/seidel-coefficients-afocal.js');
                const { formatSeidelCoefficients } = await import('../evaluation/aberrations/seidel-coefficients.js');
                
                const opticalSystemRows = window.getOpticalSystemRows ? window.getOpticalSystemRows() : [];
                const objectRows = window.getObjectTableRows ? window.getObjectTableRows() : [];
                const sourceRows = window.getSourceTableRows ? window.getSourceTableRows() : [];
                
                if (opticalSystemRows.length === 0) {
                    console.error('❌ Optical system data is empty');
                    alert('光学系データがありません。');
                    return;
                }
                
                const wavelength = sourceRows.length > 0 && sourceRows[0].wavelength 
                    ? parseFloat(sourceRows[0].wavelength) 
                    : 0.5876;
                
                let stopIndex = opticalSystemRows.findIndex(row => 
                    row['object type'] === 'Stop' || row.object === 'Stop'
                );
                
                if (stopIndex === -1) {
                    console.warn('⚠️ Stop surface not found, using surface 1');
                    stopIndex = 1;
                }
                
                const refFLInput = document.getElementById('reference-focal-length');
                let referenceFocalLength = undefined;

                if (refFLInput) {
                    const raw = refFLInput.value.trim();
                    if (raw !== '' && raw.toLowerCase() !== 'auto') {
                        const parsed = parseFloat(raw);
                        referenceFocalLength = isFinite(parsed) ? parsed : undefined;
                    }
                }
                
                const result = calculateAfocalSeidelCoefficientsIntegrated(
                    opticalSystemRows, 
                    wavelength, 
                    stopIndex,
                    objectRows,
                    referenceFocalLength
                );
                
                if (!result) {
                    console.error('❌ Afocal Seidel coefficients calculation failed');
                    alert('アフォーカル系収差係数の計算に失敗しました。');
                    return;
                }
                
                const systemDataTextarea = document.getElementById('system-data');
                if (systemDataTextarea) {
                    systemDataTextarea.value = formatSeidelCoefficients(result);
                    console.log('✅ アフォーカル系Seidel係数計算が完了しました');

                    if (typeof window.renderBlockContributionSummaryFromSeidel === 'function') {
                        try {
                            window.renderBlockContributionSummaryFromSeidel(result, opticalSystemRows);
                        } catch (e) {
                            console.warn('⚠️ Block contribution summary render failed (afocal):', e);
                        }
                    }
                } else {
                    console.error('❌ System Data textarea not found');
                }
            } catch (error) {
                console.error('❌ アフォーカル系Seidel係数計算ボタンエラー:', error);
                alert(`エラーが発生しました: ${error.message}`);
            }
        });
    } else {
        console.error('❌ Seidel係数計算（アフォーカル）ボタンが見つかりません');
    }
}

/**
 * 座標変換ボタンのイベントハンドラーを設定
 */
function setupCoordinateTransformButton() {
    const coordBtn = document.getElementById('coord-transform-btn');
    if (coordBtn) {

        coordBtn.addEventListener('click', function() {
            console.log('🔄 座標変換ボタンがクリックされました');
            try {
                if (typeof window.displayCoordinateTransformMatrix === 'function') {
                    window.displayCoordinateTransformMatrix();
                    console.log('✅ 座標変換表示が完了しました');
                } else {
                    console.error('❌ displayCoordinateTransformMatrix関数が見つかりません');
                }
            } catch (error) {
                console.error('❌ 座標変換ボタンエラー:', error);
            }
        });
    } else {
        console.error('❌ 座標変換ボタンが見つかりません');
    }
}

/**
 * スポットダイアグラムボタンのイベントハンドラーを設定
 */
function setupSpotDiagramButton() {
    const spotDiagramBtn = document.getElementById('show-spot-diagram-btn');
    if (spotDiagramBtn) {
        spotDiagramBtn.addEventListener('click', async function() {
            try {
                await showSpotDiagram();
            } catch (error) {
                console.error('❌ スポットダイアグラムエラー:', error);
                alert(`スポットダイアグラムエラー: ${error.message}`);
            }
        });
    }
}

/**
 * 縦収差図ボタンのイベントハンドラーを設定（Longitudinal Aberration）
 */
function setupLongitudinalAberrationButton() {
    const longitudinalAberrationBtn = document.getElementById('show-longitudinal-aberration-diagram-btn');
    if (longitudinalAberrationBtn) {
        longitudinalAberrationBtn.addEventListener('click', async function() {
            try {
                await showLongitudinalAberrationDiagram();
            } catch (error) {
                console.error('❌ 縦収差図エラー:', error);
                alert(`縦収差図エラー: ${error.message}`);
            }
        });
    }
}

/**
 * 横収差図ボタンのイベントハンドラーを設定
 */
function setupTransverseAberrationButton() {
    const transverseAberrationBtn = document.getElementById('show-transverse-aberration-diagram-btn');
    if (transverseAberrationBtn) {
        transverseAberrationBtn.addEventListener('click', async function() {
            try {
                await showTransverseAberrationDiagram();
            } catch (error) {
                console.error('❌ 横収差図エラー:', error);
                alert(`横収差図エラー: ${error.message}`);
            }
        });
    }
}

/**
 * 歪曲収差図ボタンのイベントハンドラーを設定
 */
function setupDistortionButton() {
    const distortionBtn = document.getElementById('show-distortion-diagram-btn');
    if (distortionBtn) {
        distortionBtn.addEventListener('click', async function() {
            try {
                console.log('📐 歪曲収差図の生成開始...');
                
                // generateDistortionPlots は main.js でグローバル公開済み
                if (typeof window.generateDistortionPlots !== 'function') {
                    throw new Error('generateDistortionPlots 関数が見つかりません');
                }
                
                const data = await window.generateDistortionPlots();
                if (!data) {
                    throw new Error('歪曲収差データの計算に失敗しました');
                }
                
                console.log('✅ 歪曲収差図の生成完了');
            } catch (error) {
                console.error('❌ 歪曲収差図エラー:', error);
                alert(`歪曲収差図エラー: ${error.message}`);
            }
        });
    }

    // Grid distortion button
    const gridBtn = document.getElementById('show-distortion-grid-btn');
    if (gridBtn) {
        gridBtn.addEventListener('click', async function() {
            try {
                console.log('📐 グリッド歪曲図の生成開始...');
                
                if (typeof window.generateGridDistortionPlot !== 'function') {
                    throw new Error('generateGridDistortionPlot 関数が見つかりません');
                }
                
                const gridSizeSelect = document.getElementById('grid-size-select');
                const gridSize = gridSizeSelect ? parseInt(gridSizeSelect.value) : 20;
                
                const data = await window.generateGridDistortionPlot({ gridSize });
                if (!data) {
                    throw new Error('グリッド歪曲データの計算に失敗しました');
                }
                
                console.log('✅ グリッド歪曲図の生成完了');
            } catch (error) {
                console.error('❌ グリッド歪曲図エラー:', error);
                alert(`グリッド歪曲図エラー: ${error.message}`);
            }
        });
    }
}

/**
 * 統合収差図ボタンのイベントハンドラーを設定
 */
function setupIntegratedAberrationButton() {
    const integratedBtn = document.getElementById('show-integrated-aberration-btn');
    if (integratedBtn) {
        integratedBtn.addEventListener('click', async function() {
            try {
                console.log('📊 統合収差図の生成開始...');
                
                // showIntegratedAberrationDiagram を呼び出す
                if (typeof window.showIntegratedAberrationDiagram !== 'function') {
                    throw new Error('showIntegratedAberrationDiagram 関数が見つかりません');
                }
                
                await window.showIntegratedAberrationDiagram();
                
                console.log('✅ 統合収差図の生成完了');
            } catch (error) {
                console.error('❌ 統合収差図エラー:', error);
                alert(`統合収差図エラー: ${error.message}`);
            }
        });
    }
}

/**
 * 非点収差図ボタンのイベントハンドラーを設定
 */
function setupAstigmatismButton() {
    const astigmatismBtn = document.getElementById('show-astigmatism-diagram-btn');
    if (astigmatismBtn) {
        astigmatismBtn.addEventListener('click', async function() {
            try {
                await showAstigmatismDiagram();
            } catch (error) {
                console.error('❌ 非点収差図エラー:', error);
                alert(`非点収差図エラー: ${error.message}`);
            }
        });
    }
}

/**
 * 波面収差図のObject選択オプションを更新
 */
function updateWavefrontObjectOptions() {
    const objectSelect = document.getElementById('wavefront-object-select');
    if (!objectSelect) return;
    
    try {
        // Objectテーブルからデータを取得
        const objectTable = window.tableObject || window.objectTabulator || window.objectTable;
        if (!objectTable) {
            console.warn('⚠️ Object テーブルが見つかりません');
            return;
        }
        
        const objectData = objectTable.getData();
        
        // 有効なObjectデータのみをフィルタリング
        const validObjectData = objectData.filter((obj, index) => {
            // 空行やundefinedを除外
            if (!obj || obj.id === undefined || obj.id === null) {
                console.log(`🚫 無効なObject[${index}]をスキップ:`, obj);
                return false;
            }
            return true;
        });
        
        // デバッグ: 実際のObjectデータを確認

        
        // ローカルストレージのデータが多すぎる場合の警告
        if (objectData.length > 6) {
            console.warn('⚠️ Objectデータが多すぎます。Clear Cacheボタンでリセットしてください。');
        }
        
        // 既存のオプションをクリア
        objectSelect.innerHTML = '';
        
        // Objectが存在しない場合
        if (!validObjectData || validObjectData.length === 0) {
            const option = document.createElement('option');
            option.value = '0';
            option.textContent = 'No Objects';
            option.disabled = true;
            objectSelect.appendChild(option);
            return;
        }
        
        // 各Objectのオプションを追加
        validObjectData.forEach((obj, index) => {
            console.log(`🔍 有効Object[${index}]:`, obj);
            
            const option = document.createElement('option');
            option.value = index.toString();
            
            // Object表示名を生成（座標情報含む）
            const xValue = (obj.x ?? obj.xHeightAngle ?? 0);
            const yValue = (obj.y ?? obj.yHeightAngle ?? 0);
            const objectName = `Object ${index + 1} (${xValue.toFixed(2)}, ${yValue.toFixed(2)})`;
            
            option.textContent = objectName;
            objectSelect.appendChild(option);
        });
        
        console.log(`📊 波面収差図Object選択更新: ${validObjectData.length}個の有効Object`);
        
    } catch (error) {
        console.error('❌ Object選択オプション更新エラー:', error);
        
        // エラー時のフォールバック
        objectSelect.innerHTML = '';
        const option = document.createElement('option');
        option.value = '0';
        option.textContent = 'Object 1';
        objectSelect.appendChild(option);
    }
}

// 外部（Configuration切替など）から呼べるように公開
if (typeof window !== 'undefined') {
    window.updateWavefrontObjectOptions = updateWavefrontObjectOptions;
}

/**
 * 波面収差図ボタンのイベントハンドラーを設定
 */
function setupWavefrontAberrationButton() {
    const wavefrontBtn = document.getElementById('show-wavefront-diagram-btn');
    const stopBtn = document.getElementById('stop-opd-btn');
    const progressEl = document.getElementById('opd-progress');
    
    let activeOpdCancelToken = null;
    
    if (wavefrontBtn) {
        wavefrontBtn.addEventListener('click', async function() {
            try {
                // UIから設定を取得
                const objectSelect = document.getElementById('wavefront-object-select');
                const plotTypeSelect = document.getElementById('wavefront-plot-type-select');
                const gridSizeSelect = document.getElementById('wavefront-grid-size-select');
                
                const selectedObjectIndex = objectSelect ? parseInt(objectSelect.value) : 0;
                const plotType = plotTypeSelect ? plotTypeSelect.value : 'surface';
                const dataType = 'opd'; // Optical Path Difference固定
                const gridSize = gridSizeSelect ? parseInt(gridSizeSelect.value) : 64;
                
                console.log(`🌊 光路差表示: Object${selectedObjectIndex + 1}, ${plotType}, ${dataType}, gridSize=${gridSize}`);
                
                // Create cancel token
                activeOpdCancelToken = createCancelToken();
                
                // Enable Stop button
                if (stopBtn) {
                    stopBtn.disabled = false;
                    stopBtn.textContent = 'Stop';
                }
                
                // Progress callback (supported by generateWavefrontMap)
                const onProgress = (evt) => {
                    try {
                        if (!progressEl) return;
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) {
                            progressEl.textContent = `${msg} (${Math.round(p)}%)`;
                        } else {
                            progressEl.textContent = msg;
                        }
                    } catch (_) {}
                };
                
                try {
                    await showWavefrontDiagram(plotType, dataType, gridSize, selectedObjectIndex, {
                        cancelToken: activeOpdCancelToken,
                        onProgress
                    });
                    if (progressEl) progressEl.textContent = 'OPD calculation completed';
                } catch (err) {
                    if (err?.message?.includes('Cancelled')) {
                        if (progressEl) progressEl.textContent = 'OPD calculation cancelled';
                        console.log('🛑 OPD calculation cancelled by user');
                    } else {
                        throw err;
                    }
                } finally {
                    // Disable Stop button
                    if (stopBtn) {
                        stopBtn.disabled = true;
                        stopBtn.textContent = 'Stop';
                    }
                    activeOpdCancelToken = null;
                }
            } catch (error) {
                console.error('❌ 波面収差図エラー:', error);
                if (progressEl) progressEl.textContent = '';
                alert(`波面収差図エラー: ${error.message}`);
            }
        });
    }
    
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            console.log('🛑 OPD Stop button clicked');
            if (activeOpdCancelToken && typeof activeOpdCancelToken.abort === 'function') {
                activeOpdCancelToken.abort('Stopped by user');
                if (stopBtn) {
                    stopBtn.disabled = true;
                    stopBtn.textContent = 'Stopping...';
                }
            }
        });
    }

    const zernikeBtn = document.getElementById('zernike-fit-btn');
    if (zernikeBtn) {
        zernikeBtn.addEventListener('click', function() {
            const map = window.__lastWavefrontMap;
            const fit = map?.zernike;
            if (!map || !fit) {
                alert('Zernike Fit: 先に「Show wavefront diagram」を実行してください。');
                return;
            }

            const cMic = fit.coefficientsMicrons || {};
            const cWav = fit.coefficientsWaves || {};
            const stats = fit.stats || {};

            const lines = [];
            lines.push('Zernike Fit (Noll index)');
            lines.push(`points: ${stats.points ?? 'n/a'}`);
            if (isFinite(stats.rmsResidual)) {
                lines.push(`rms residual: ${stats.rmsResidual.toFixed(6)} μm`);
            }
            lines.push('');
            lines.push('Removed (reference-sphere W): 1(piston),2(tilt x),3(tilt y),5(defocus)');
            lines.push('');

            const fmt = (v) => (isFinite(v) ? v.toFixed(6) : 'n/a');
            const wfmt = (v) => (isFinite(v) ? v.toFixed(6) : 'n/a');

            lines.push(`1 piston : ${fmt(cMic[1])} μm  (${wfmt(cWav[1])} waves)`);
            lines.push(`2 tilt x : ${fmt(cMic[2])} μm  (${wfmt(cWav[2])} waves)`);
            lines.push(`3 tilt y : ${fmt(cMic[3])} μm  (${wfmt(cWav[3])} waves)`);
            lines.push(`5 defocus: ${fmt(cMic[5])} μm  (${wfmt(cWav[5])} waves)`);

            if (map.statistics?.raw?.opdMicrons && (map.statistics?.display?.opdMicrons || map.statistics?.opdMicrons)) {
                const raw = map.statistics.raw.opdMicrons;
                const corr = map.statistics.display?.opdMicrons || map.statistics.opdMicrons;
                const corrLabel = map.statistics.display?.opdMicrons ? 'piston+tilt removed' : 'piston removed';
                lines.push('');
                lines.push(`OPD RMS: raw=${raw.rms.toFixed(6)} μm, corrected(${corrLabel})=${corr.rms.toFixed(6)} μm`);
                lines.push(`OPD P-V:  raw=${raw.peakToPeak.toFixed(6)} μm, corrected(${corrLabel})=${corr.peakToPeak.toFixed(6)} μm`);
            }

            alert(lines.join('\n'));
        });
    }

    // PSF計算ボタンのイベントハンドラー（新しいPSF計算システムを使用）
    const psfBtn = document.getElementById('show-psf-btn');
    if (psfBtn) {
        psfBtn.addEventListener('click', async function() {
            try {
                console.log('🔬 [PSF] Show PSF button clicked - using advanced PSF calculation system');
                
                // 新しいPSF計算システムを使用（オブジェクト選択を正しく反映）
                await handlePSFCalculation(false); // 通常モード
            } catch (error) {
                console.error('❌ PSF計算エラー:', error);
                alert(`PSF計算エラー: ${error.message}`);
            }
        });
    }

    const psfStopBtn = document.getElementById('stop-psf-btn');
    if (psfStopBtn) {
        psfStopBtn.addEventListener('click', function() {
            try {
                const t = window.__psfActiveCancelToken;
                if (t && typeof t.abort === 'function') {
                    t.abort('Stopped by user');
                }
            } catch (_) {}
        });
    }
}

/**
 * 面番号選択の更新（旧関数の互換性のため）
 */
function updateSurfaceNumberSelectLegacy() {
    // Debounce/throttle to avoid noisy repeated updates from table events.
    const now = Date.now();
    const lastAt = Number(window.__lastSurfaceSelectUpdateAt || 0);
    if (now - lastAt < 200) return;
    window.__lastSurfaceSelectUpdateAt = now;

    const surfaceSelect = document.getElementById('surface-number-select');
    
    if (!surfaceSelect) return;

    const prevValueRaw = (surfaceSelect.value !== undefined && surfaceSelect.value !== null)
        ? String(surfaceSelect.value)
        : '';
    const prevSelectedOption = (surfaceSelect.selectedIndex >= 0 && surfaceSelect.options)
        ? surfaceSelect.options[surfaceSelect.selectedIndex]
        : null;
    const prevRowIdRaw = prevSelectedOption && prevSelectedOption.dataset && prevSelectedOption.dataset.rowId
        ? String(prevSelectedOption.dataset.rowId)
        : '';
    
    // 既存のオプションをクリア
    surfaceSelect.innerHTML = '<option value="">面を選択...</option>';
    
    try {
        const resolveOpticalRowsForSpotConfig = () => {
            try {
                const cfgSel = document.getElementById('spot-diagram-config-select');
                const selected = cfgSel && cfgSel.value !== undefined && cfgSel.value !== null ? String(cfgSel.value).trim() : '';
                // Current (active) config: prefer live UI table rows so Surf ids match Requirements.
                if (!selected) {
                    try {
                        const live = (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function')
                            ? window.tableOpticalSystem.getData()
                            : (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.getData === 'function')
                                ? window.opticalSystemTabulator.getData()
                                : null;
                        if (Array.isArray(live) && live.length > 0) return live;
                    } catch (_) {}
                    return getOpticalSystemRows();
                }

                const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
                if (!raw) return getOpticalSystemRows();
                const sys = JSON.parse(raw);
                const cfg = Array.isArray(sys?.configurations)
                    ? sys.configurations.find(c => String(c?.id) === selected)
                    : null;

                // If this selected config is the active one, prefer live tables.
                const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId)
                    : '';
                if (activeId && selected === activeId) {
                    try {
                        const live = (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function')
                            ? window.tableOpticalSystem.getData()
                            : (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.getData === 'function')
                                ? window.opticalSystemTabulator.getData()
                                : null;
                        if (Array.isArray(live) && live.length > 0) return live;
                    } catch (_) {}
                    return getOpticalSystemRows();
                }

                // Prefer expanded blocks (with active scenario overrides) when available,
                // to keep Spot Diagram surface options consistent with evaluation.
                const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
                const cloneJson = (v) => {
                    try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
                };
                const parseOverrideKey = (variableId) => {
                    const s = String(variableId ?? '');
                    const dot = s.indexOf('.');
                    if (dot <= 0) return null;
                    const blockId = s.slice(0, dot);
                    const key = s.slice(dot + 1);
                    if (!blockId || !key) return null;
                    return { blockId, key };
                };
                const applyOverridesToBlocks = (blocks, overrides) => {
                    const cloned = cloneJson(blocks);
                    if (!Array.isArray(cloned)) return Array.isArray(blocks) ? blocks : [];
                    if (!isPlainObject(overrides)) return cloned;

                    const byId = new Map();
                    for (const b of cloned) {
                        const id = isPlainObject(b) ? String(b.blockId ?? '') : '';
                        if (id) byId.set(id, b);
                    }
                    for (const [varId, rawVal] of Object.entries(overrides)) {
                        const parsedKey = parseOverrideKey(varId);
                        if (!parsedKey) continue;
                        const blk = byId.get(String(parsedKey.blockId));
                        if (!blk || !isPlainObject(blk.parameters)) continue;
                        const n = Number(rawVal);
                        blk.parameters[parsedKey.key] = Number.isFinite(n) ? n : rawVal;
                    }
                    return cloned;
                };

                try {
                    if (cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0 && typeof expandBlocksToOpticalSystemRows === 'function') {
                        const blocksHaveObjectSurface = (() => {
                            try { return cfg.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectSurface'); } catch (_) { return false; }
                        })();
                        const scenarios = Array.isArray(cfg.scenarios) ? cfg.scenarios : null;
                        const scenarioId = cfg.activeScenarioId ? String(cfg.activeScenarioId) : '';
                        const scn = (scenarioId && scenarios)
                            ? scenarios.find(s => s && String(s.id) === String(scenarioId))
                            : null;
                        const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : null;
                        const blocksToExpand = overrides ? applyOverridesToBlocks(cfg.blocks, overrides) : cfg.blocks;
                        const exp = expandBlocksToOpticalSystemRows(blocksToExpand);
                        const expRows = exp && Array.isArray(exp.rows) ? exp.rows : null;
                        if (expRows && expRows.length > 0) {
                            if (!blocksHaveObjectSurface) {
                                const preferredThickness = cfg?.opticalSystem?.[0]?.thickness;
                                if (preferredThickness !== undefined && preferredThickness !== null && String(preferredThickness).trim() !== '') {
                                    expRows[0] = { ...expRows[0], thickness: preferredThickness };
                                }
                            }
                            return expRows;
                        }
                    }
                } catch (_) {}

                const rows = cfg && Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : null;
                return Array.isArray(rows) ? rows : getOpticalSystemRows();
            } catch (_) {
                return getOpticalSystemRows();
            }
        };

        const opticalSystemRows = resolveOpticalRowsForSpotConfig();
        if (opticalSystemRows && opticalSystemRows.length > 0) {
            const surfaceOptions = generateSurfaceOptions(opticalSystemRows);
            let imageSurfaceValue = null;
            let lastSurfaceValue = null;
            let desiredByRowId = '';
            let desiredByRowSig = '';

            const prevRowId = prevRowIdRaw || (prevValueRaw !== ''
                ? (surfaceOptions.find(o => String(o?.value) === String(prevValueRaw))?.rowId ? String(surfaceOptions.find(o => String(o?.value) === String(prevValueRaw)).rowId) : '')
                : '');

            const prevRowSig = (() => {
                try {
                    const prevOpt = prevSelectedOption;
                    const fromDataset = prevOpt && prevOpt.dataset && prevOpt.dataset.rowSig ? String(prevOpt.dataset.rowSig) : '';
                    if (fromDataset) return fromDataset;
                    if (prevValueRaw === '') return '';
                    const m = surfaceOptions.find(o => String(o?.value) === String(prevValueRaw));
                    return m && m.rowSig ? String(m.rowSig) : '';
                } catch (_) {
                    return '';
                }
            })();
            
            surfaceOptions.forEach(option => {
                // スポットダイアグラム用のセレクト
                const optionElement = document.createElement('option');
                optionElement.value = option.value;
                optionElement.textContent = option.label;
                if (option.rowId !== undefined && option.rowId !== null && String(option.rowId) !== '') {
                    optionElement.dataset.rowId = String(option.rowId);
                    if (prevRowId && String(option.rowId) === String(prevRowId)) {
                        desiredByRowId = String(option.value);
                    }
                }
                if (option.rowSig !== undefined && option.rowSig !== null && String(option.rowSig) !== '') {
                    optionElement.dataset.rowSig = String(option.rowSig);
                    if (!desiredByRowId && prevRowSig && String(option.rowSig) === String(prevRowSig)) {
                        desiredByRowSig = String(option.value);
                    }
                }
                if (Number.isInteger(option.rowIndex)) {
                    optionElement.dataset.rowIndex = String(option.rowIndex);
                }
                surfaceSelect.appendChild(optionElement);
                
                // Image面を探す
                if (option.label.includes('(Image)')) {
                    imageSurfaceValue = option.value;
                }
                
                // 最後の面を記録（Image面がない場合の代替）
                lastSurfaceValue = option.value;
            });
            
            // Image面が見つかった場合、それを初期選択値として設定
            const defaultValue = imageSurfaceValue !== null ? imageSurfaceValue : lastSurfaceValue;
            
            // Prefer restoring by stable rowId (survives insert/delete renumbering),
            // then rowSig, then fallback to previous numeric value if it still exists.
            const desired = (desiredByRowId !== '' ? desiredByRowId : '') || (desiredByRowSig !== '' ? desiredByRowSig : '') || (prevValueRaw !== '' ? prevValueRaw : '');
            if (desired !== '' && surfaceSelect.querySelector(`option[value="${CSS.escape(desired)}"]`)) {
                surfaceSelect.value = desired;
            } else if (defaultValue !== null) {
                surfaceSelect.value = defaultValue;
            }

            const sig = `${surfaceOptions.length}::${String(surfaceSelect.value ?? '')}`;
            if (window.__lastSurfaceSelectSignature !== sig) {
                window.__lastSurfaceSelectSignature = sig;
            }

            // Notify Spot Diagram popup (if open) to resync Surf options.
            try {
                const p = window.__spotDiagramPopup;
                if (p && !p.closed) {
                    if (typeof p.__cooptSpotPopupSyncAll === 'function') {
                        p.__cooptSpotPopupSyncAll();
                    } else if (typeof p.postMessage === 'function') {
                        p.postMessage({ action: 'coopt-spot-sync' }, '*');
                    }
                }
            } catch (_) {}
        }
    } catch (error) {
        console.error('❌ 面選択更新エラー:', error);
    }
}

function setupSpotDiagramConfigSelect() {
    const select = document.getElementById('spot-diagram-config-select');
    if (!select) return;

    const rebuildOptions = () => {
        try {
            const prev = (select.value !== undefined && select.value !== null) ? String(select.value) : '';
            let desired = prev;

            // Restore from lastSpotDiagramSettings if present.
            try {
                const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('lastSpotDiagramSettings') : null;
                if (raw) {
                    const s = JSON.parse(raw);
                    const v = (s && s.configId !== undefined && s.configId !== null) ? String(s.configId).trim() : '';
                    if (v) desired = v;
                }
            } catch (_) {}

            const rawCfg = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
            const sys = rawCfg ? JSON.parse(rawCfg) : null;
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
            const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null) ? String(sys.activeConfigId) : '';
            const activeName = configs.find(c => String(c?.id) === activeId)?.name;

            select.innerHTML = '';

            const optCurrent = document.createElement('option');
            optCurrent.value = '';
            optCurrent.textContent = activeName ? `Current (${activeName})` : 'Current';
            select.appendChild(optCurrent);

            for (const c of configs) {
                const id = (c && c.id !== undefined && c.id !== null) ? String(c.id) : '';
                if (!id) continue;
                const opt = document.createElement('option');
                opt.value = id;
                const name = String(c?.name ?? `Config ${id}`);
                opt.textContent = (id === activeId) ? `${name} ★` : name;
                select.appendChild(opt);
            }

            // Keep selection if it still exists.
            const hasDesired = desired && Array.from(select.options).some(o => String(o.value) === String(desired));
            select.value = hasDesired ? desired : '';
        } catch (e) {
            console.warn('⚠️ Spot Diagram config select rebuild failed:', e);
        }
    };

    if (!select.__cooptSpotCfgInit) {
        select.__cooptSpotCfgInit = true;
        select.addEventListener('change', () => {
            try {
                // Update surface list to match selected config.
                updateSurfaceNumberSelectLegacy();
            } catch (_) {}

            // Persist selection (best effort) so popup/requirements can mirror it.
            try {
                const current = (select.value !== undefined && select.value !== null) ? String(select.value).trim() : '';
                const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('lastSpotDiagramSettings') : null;
                const s = raw ? (JSON.parse(raw) || {}) : {};
                s.configId = current || null;
                s.updatedAt = Date.now();
                localStorage.setItem('lastSpotDiagramSettings', JSON.stringify(s));
            } catch (_) {}
        });
    }

    rebuildOptions();

    // Expose for other modules (e.g. configuration switch) to refresh options.
    try {
        if (typeof window !== 'undefined') {
            window.updateSpotDiagramConfigSelect = rebuildOptions;
        }
    } catch (_) {}
}

/**
 * PSF計算ボタンのイベントハンドラーを設定
 */
function setupPSFCalculationButton() {
    const calculatePsfBtn = document.getElementById('calculate-psf-btn');

    if (calculatePsfBtn) {
        calculatePsfBtn.addEventListener('click', async function() {
            await handlePSFCalculation(false); // 通常モード
        });
    }
}

/**
 * デバッグPSF計算ボタンのイベントハンドラーを設定
 */
function setupDebugPSFCalculationButton() {
    const debugPsfBtn = document.getElementById('debug-psf-btn');

    if (debugPsfBtn) {
        debugPsfBtn.addEventListener('click', async function() {
            await handlePSFCalculation(true); // デバッグモード
        });
    }
}

/**
 * PSF計算処理の共通関数
 * @param {boolean} debugMode - デバッグモードかどうか
 */
async function handlePSFCalculation(debugMode = false) {
    console.log(`🔬 [PSF] PSF計算ボタンがクリックされました (デバッグモード: ${debugMode})`);
    
    // 選択されたオブジェクトを取得
    const psfObjectSelect = document.getElementById('psf-object-select');
    console.log('🔍 [PSF] PSF object select:', {
        element: !!psfObjectSelect,
        value: psfObjectSelect?.value,
        options: psfObjectSelect?.options ? Array.from(psfObjectSelect.options).map(o => ({text: o.text, value: o.value})) : 'none'
    });
    
    if (!psfObjectSelect || !psfObjectSelect.value) {
        console.warn('⚠️ [PSF] PSF object not selected');
        alert('PSF計算のためのオブジェクトを選択してください');
        return;
    }
    
    const selectedObjectIndex = parseInt(psfObjectSelect.value);
    const objectRows = getObjectRows();
    if (!objectRows || selectedObjectIndex >= objectRows.length) {
        alert('選択されたオブジェクトが無効です');
        return;
    }
    
    const selectedObject = objectRows[selectedObjectIndex];
    
    // PSF UIからパラメータを取得
    const wavelengthSelect = document.getElementById('psf-wavelength-select'); // 現在存在しない
    const gridSizeSelect = document.getElementById('psf-grid-size-select'); // 現在存在しない
    const samplingSelect = document.getElementById('psf-sampling-select'); // PSF UIのサンプリングサイズ
    const zeroPadSelect = document.getElementById('psf-zeropad-select'); // PSF UIのゼロパディング設定
    const zernikeSamplingSelect = document.getElementById('psf-zernike-sampling-select'); // Zernikeフィット用サンプリングサイズ
    
    // デバッグモードの場合は設定を上書き
    let wavelength, psfSamplingSize, zernikeFitSamplingSize, zeroPadTo;
    if (debugMode) {
        wavelength = '0.5876'; // d線固定
        psfSamplingSize = 16; // 16×16グリッド固定（高速）
        zernikeFitSamplingSize = 16;
        // Debug mode should stay fast by default.
        zeroPadTo = psfSamplingSize;
        console.log('🔧 [DEBUG] デバッグモード: wavelength=0.5876μm, gridSize=16×16に固定');
    } else {
        // 光源データから波長を取得
        const sources = window.getSourceRows ? window.getSourceRows() : (window.sources || []);
        // Sourceテーブルの主波長を優先
        if (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function') {
            wavelength = Number(window.getPrimaryWavelength()) || 0.5876;
        } else {
            wavelength = (sources && sources.length > 0) ? (sources[0].wavelength || 0.5876) : 0.5876;
        }
        
        // PSF UIのサンプリング設定を使用（既定は64x64）
        psfSamplingSize = samplingSelect ? parseInt(samplingSelect.value) : 64;
        // Zernikeフィット用のサンプリング（未設定ならPSFと同じ）
        zernikeFitSamplingSize = zernikeSamplingSelect ? parseInt(zernikeSamplingSelect.value) : psfSamplingSize;

        // Zero padding control:
        // - auto: follow PSFCalculator default (>=512)
        // - none: disable padding (set to samplingSize)
        // - number: explicit FFT size (if > samplingSize and supported)
        const zpRaw = zeroPadSelect ? String(zeroPadSelect.value || 'auto') : 'auto';
        if (zpRaw === 'none') {
            zeroPadTo = psfSamplingSize;
        } else if (zpRaw === 'auto') {
            zeroPadTo = 0;
        } else {
            const zpN = parseInt(zpRaw);
            zeroPadTo = Number.isFinite(zpN) ? zpN : 0;
        }
        console.log(`📊 [NORMAL] 通常モード: wavelength=${wavelength}μm (source), psfSampling=${psfSamplingSize}×${psfSamplingSize}, fitGrid=${zernikeFitSamplingSize}×${zernikeFitSamplingSize}`);
    }
    
    console.log(`🔬 PSFパラメータ: wavelength=${wavelength}, psfSampling=${psfSamplingSize}, fitGrid=${zernikeFitSamplingSize}, debugMode=${debugMode}`);
    
    const getActiveConfigLabel = () => {
        try {
            if (typeof localStorage === 'undefined') return '';
            const raw = localStorage.getItem('systemConfigurations');
            if (!raw) return '';
            const sys = JSON.parse(raw);
            const activeId = sys?.activeConfigId;
            const cfg = Array.isArray(sys?.configurations)
                ? sys.configurations.find(c => String(c?.id) === String(activeId))
                : null;
            if (!cfg) return activeId !== undefined && activeId !== null ? `id=${activeId}` : '';
            return `id=${cfg.id} name=${cfg.name || ''}`.trim();
        } catch (_) {
            return '';
        }
    };

    const calcFNV1a32 = (str) => {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16);
    };

    const summarizeOpticalSystemRows = (rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return { checksum: '0' };
        const parts = [];
        for (const r of rows) {
            if (!r) continue;
            const obj = r['object type'] ?? r.object ?? r.Object ?? '';
            const radius = r.radius ?? r.Radius ?? '';
            const thickness = r.thickness ?? r.Thickness ?? '';
            const material = r.material ?? r.Material ?? '';
            const semidia = r.semidia ?? r.semidiameter ?? r.SemiDia ?? '';
            const id = r.id ?? '';
            parts.push(`${id}|${obj}|${radius}|${thickness}|${material}|${semidia}`);
        }
        return { checksum: calcFNV1a32(parts.join(';')) };
    };

    // 光学系データを取得
    const opticalSystemRows = getOpticalSystemRows();
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        alert('光学系データが見つかりません。まず光学系を設定してください。');
        return;
    }

    // Always emit a compact identity line so it's obvious which config/data PSF used.
    try {
        const summary = summarizeOpticalSystemRows(opticalSystemRows);
        console.log(`🧾 [PSF] activeConfig=${getActiveConfigLabel() || '(none)'} rows=${opticalSystemRows.length} checksum=${summary.checksum}`);
    } catch (_) {}
    
    // Install cancel token for this run (Stop button)
    const cancelToken = createCancelToken();
    window.__psfActiveCancelToken = cancelToken;
    try {
        const stopBtn = document.getElementById('stop-psf-btn');
        if (stopBtn) stopBtn.disabled = false;
    } catch (_) {}

    try {
        // 選択されたオブジェクトからフィールド設定を作成
        // NOTE: Objectテーブルの実データは設計によりキーが揺れるため、ここで頑健に解決する。
        // （過去の createFieldSettingFromObject は position/xHeightAngle 前提で、0,0 に潰れてPSFが不変になり得る）
        console.log('🔧 オブジェクトからフィールド設定を作成中:', selectedObject);

        const wl = (Number.isFinite(Number(wavelength)) && Number(wavelength) > 0) ? Number(wavelength) : 0.5876;
        const objectX = (selectedObject?.x ?? selectedObject?.xHeightAngle ?? selectedObject?.x_height_angle ?? 0);
        const objectY = (selectedObject?.y ?? selectedObject?.yHeightAngle ?? selectedObject?.y_height_angle ?? 0);
        const objectTypeRaw = String(selectedObject?.position ?? selectedObject?.object ?? selectedObject?.Object ?? selectedObject?.objectType ?? 'Point');
        const objectType = objectTypeRaw;
        const objectTypeLower = objectTypeRaw.toLowerCase();

        let fieldAngle = { x: 0, y: 0 };
        let xHeight = 0;
        let yHeight = 0;

        // IMPORTANT: 'rectangle' contains the substring 'angle'.
        // Use a word-boundary test so Rectangle is not treated as Angle.
        if (/\bangle\b/.test(objectTypeLower)) {
            // Angle (deg): interpret as field angle. Solver selection is handled by eva-wavefront.js.
            fieldAngle = { x: Number(objectX) || 0, y: Number(objectY) || 0 };
            xHeight = 0;
            yHeight = 0;
        } else {
            fieldAngle = { x: 0, y: 0 };
            xHeight = Number(objectX) || 0;
            yHeight = Number(objectY) || 0;
        }

        const fieldSetting = {
            objectIndex: selectedObjectIndex,
            type: objectType,
            fieldAngle,
            xHeight,
            yHeight,
            wavelength: wl
        };

        console.log('✅ フィールド設定が作成されました:', fieldSetting);
        
        // ローディングオーバーレイを表示
        showPSFLoadingOverlay(psfSamplingSize, wavelength, debugMode);
        
        const PSF_DEBUG = !!debugMode || !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);

        // PSFを計算
        if (PSF_DEBUG) console.log('🔬 PSF計算を開始...');
        
        let psfResult;
        
    // PSF計算タイムアウト設定（要求により無効化可能）
    const DISABLE_PSF_TIMEOUT = true; // タイムアウトを完全に無効化
    const PSF_TIMEOUT = debugMode ? 10000 : 60000; // 無効化時は未使用
        const psfCalculationPromise = (async () => {
            throwIfCancelled(cancelToken);
            // PSFCalculatorを使用した単色PSF計算
            const modeText = debugMode ? 'デバッグモード' : '通常モード';
            if (PSF_DEBUG) {
                console.log(`🔬 λ=${wavelength}μmの単色PSFを計算中... (${modeText})`);
                console.log('🔍 PSF計算パラメータ:', {
                    opticalSystemRows: opticalSystemRows?.length || 0,
                    fieldSetting: fieldSetting,
                    wavelength: wavelength,
                    psfSamplingSize: psfSamplingSize,
                    zernikeFitSamplingSize: zernikeFitSamplingSize,
                    debugMode: debugMode
                });
            }
            
            // 必要なモジュールを動的インポート
            // PSFCalculator はシングルトンで再利用（WASM初期化を使い回す）
            const { createOPDCalculator, WavefrontAberrationAnalyzer } = await import('../evaluation/wavefront/wavefront.js');

            // PSF入力のOPDは生の光線追跡データから直接補間して作る
            // - Zernike近似を経由しないため、サンプリングの非対称性に影響されない
            // - より正確なPSF計算が可能
            if (PSF_DEBUG) console.log('📊 [PSF] 生OPDデータから格子を生成中...');
            const opdCalculator = createOPDCalculator(opticalSystemRows, wl);
            const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);
            
            // NOTE: Infinite-field pupil sampling mode is controlled by the global Force setting
            // (Auto / Force stop / Force entrance) via eva-wavefront.js.
            
            const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, zernikeFitSamplingSize, 'circular', {
                recordRays: true,  // 光線データを記録
                progressEvery: 0,
                zernikeMaxNoll: 36,
                renderFromZernike: false,  // 生OPDデータを使用
                // Use raw OPD with geometric tilt, let PSF calculator remove it
                cancelToken
            });

            throwIfCancelled(cancelToken);

            if (wavefrontMap?.error) {
                const err = new Error(wavefrontMap.error?.message || 'Wavefront generation failed');
                err.code = 'WAVEFRONT_UNAVAILABLE';
                err.wavefrontError = wavefrontMap.error;
                throw err;
            }

            // PSF入力点は、ray path 依存の wavefrontMap.rayData ではなく、
            // 収差サンプリングの本体である pupilCoordinates/opds を優先する。
            // （rayData は ray.path が取れない点が落ちて疎になることがあり、補間が不安定化しやすい）
            const pupilCoords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
            const opdsMicrons = Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : [];
            const validPupilMask = Array.isArray(wavefrontMap?.validPupilMask) ? wavefrontMap.validPupilMask : null;
            const maskG = validPupilMask ? validPupilMask.length : 0;

            const buildRayDataFromWavefront = () => {
                const n = Math.min(pupilCoords.length, opdsMicrons.length);
                const rays = [];
                for (let k = 0; k < n; k++) {
                    const c = pupilCoords[k];
                    const pupilX = Number(c?.x);
                    const pupilY = Number(c?.y);
                    const opd = Number(opdsMicrons[k]);
                    if (!Number.isFinite(pupilX) || !Number.isFinite(pupilY) || !Number.isFinite(opd)) continue;

                    // Extra safety: if a validity mask exists and indices are present, respect it.
                    if (validPupilMask && Number.isInteger(c?.ix) && Number.isInteger(c?.iy)) {
                        const ix = c.ix;
                        const iy = c.iy;
                        if (ix >= 0 && iy >= 0 && ix < maskG && iy < maskG && !validPupilMask[iy][ix]) continue;
                    }

                    rays.push({
                        pupilX,
                        pupilY,
                        opd,
                        isVignetted: false
                    });
                }
                return rays;
            };

            let rayData = buildRayDataFromWavefront();
            let rayDataSource = 'pupilCoordinates/opds';
            if (!Array.isArray(rayData) || rayData.length === 0) {
                // Fallback: use recorded rayData when legacy maps are missing coordinate arrays.
                const rawRays = wavefrontMap?.rayData || [];
                rayData = Array.isArray(rawRays)
                    ? rawRays.map(ray => ({
                        pupilX: ray?.pupilX ?? ray?.x ?? 0,
                        pupilY: ray?.pupilY ?? ray?.y ?? 0,
                        opd: ray?.opd ?? 0,
                        isVignetted: !!ray?.isVignetted
                    }))
                    : [];
                rayDataSource = 'rayData(fallback)';
            }

            if (!Array.isArray(rayData) || rayData.length === 0) {
                throw new Error('光線データが取得できませんでした');
            }

            if (PSF_DEBUG) {
                const validMaskCount = (() => {
                    if (!validPupilMask || !Array.isArray(validPupilMask)) return null;
                    let cnt = 0;
                    for (const row of validPupilMask) for (const v of (row || [])) if (v) cnt++;
                    return cnt;
                })();
                console.log('📊 [PSF] PSF input sampling:', {
                    source: rayDataSource,
                    rayDataCount: rayData.length,
                    pupilCoordsCount: pupilCoords.length,
                    opdsCount: opdsMicrons.length,
                    validPupilMaskGrid: validPupilMask ? `${maskG}x${maskG}` : null,
                    validPupilMaskCount: validMaskCount
                });
            }

            const opdData = {
                wavelength: wl,
                rayData
            };

            // Prefer Zernike-fit piston+tilt removal for PSF input.
            // This keeps the residual wavefront (higher-order terms) while aligning the reference plane.
            // NOTE: Noll indexing here follows eva-wavefront.js (j=2 => sin, j=3 => cos).
            const removePistonTiltByZernikeFit = (() => {
                try {
                    const coeffs = wavefrontMap?.zernike?.coefficientsMicrons;
                    if (!coeffs || typeof coeffs !== 'object') return false;
                    const c1 = Number(coeffs?.[1] ?? 0);
                    const c2 = Number(coeffs?.[2] ?? 0);
                    const c3 = Number(coeffs?.[3] ?? 0);
                    if (![c1, c2, c3].some(Number.isFinite)) return false;

                    const eps = 1e-12;
                    for (const r of opdData.rayData) {
                        const x = Number(r?.pupilX);
                        const y = Number(r?.pupilY);
                        const opd = Number(r?.opd);
                        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(opd)) continue;
                        const rho = Math.hypot(x, y);
                        if (!(rho <= 1 + eps)) continue;
                        const theta = Math.atan2(y, x);

                        // Orthonormal Zernike (same normalization as eva-wavefront.js)
                        const Z1 = 1.0;
                        const Z2 = 2.0 * rho * Math.sin(theta); // Noll j=2 => m=-1
                        const Z3 = 2.0 * rho * Math.cos(theta); // Noll j=3 => m=+1
                        const plane = (Number.isFinite(c1) ? c1 * Z1 : 0) + (Number.isFinite(c2) ? c2 * Z2 : 0) + (Number.isFinite(c3) ? c3 * Z3 : 0);
                        r.opd = opd - plane;
                    }
                    return true;
                } catch {
                    return false;
                }
            })();
            
            // Debug: Log first few rays to check pupilX/pupilY orientation
            if (PSF_DEBUG && opdData.rayData.length > 0) {
                console.log('🔍 [PSF Debug] First 5 rays:', opdData.rayData.slice(0, 5).map(r => 
                    `(${r.pupilX.toFixed(3)}, ${r.pupilY.toFixed(3)}) opd=${r.opd.toFixed(3)}`
                ));
            }

            throwIfCancelled(cancelToken);
            
            // PSF計算器を初期化（WASM統合版）
            const psfCalculator = await getPSFCalculatorSingleton();

            throwIfCancelled(cancelToken);
            
            // パフォーマンス設定を取得
            const performanceSelect = document.getElementById('psf-performance-select');
            const performanceMode = performanceSelect ? performanceSelect.value : 'auto';
            
            // PSFを計算
            if (PSF_DEBUG) console.log(`🔬 [PSF] PSF計算中... (${psfSamplingSize}x${psfSamplingSize}, mode: ${performanceMode})`);
            // Use paraxial-derived pupil diameter & focal length for correct PSF pixel scaling.
            const preferEntrancePupilForPSF = /\bangle\b/.test(objectTypeLower);
            const derivedPSFScale = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wl, preferEntrancePupilForPSF);
            const pupilDiameterMm = Number(derivedPSFScale?.pupilDiameterMm);
            const focalLengthMm = Number(derivedPSFScale?.focalLengthMm);

            const result = await raceWithCancel(psfCalculator.calculatePSF(opdData, {
                samplingSize: psfSamplingSize,
                pupilDiameter: (Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0) ? pupilDiameterMm : 10.0,
                focalLength: (Number.isFinite(focalLengthMm) && focalLengthMm > 0) ? focalLengthMm : 100.0,
                zeroPadTo: (typeof zeroPadTo !== 'undefined') ? zeroPadTo : 0,
                forceImplementation: performanceMode === 'auto' ? null : performanceMode,
                // If piston+tilt were already removed via Zernike fit, avoid removing again in PSF.
                removeTilt: !removePistonTiltByZernikeFit
            }), cancelToken);
            
            // WASM使用状況をログ
            const wasmStatus = psfCalculator.getWasmStatus();
            if (PSF_DEBUG) {
                console.log('🔍 PSF計算完了、結果:', {
                    hasResult: !!result,
                    resultType: typeof result,
                    resultKeys: result ? Object.keys(result) : 'none',
                    wasmStatus: wasmStatus,
                    calculator: result?.metadata?.method || 'unknown',
                    executionTime: result?.metadata?.executionTime || 'unknown',
                    debugMode: debugMode
                });
            }
            
            return result;
        })();
        
        if (DISABLE_PSF_TIMEOUT) {
            // タイムアウトを無効化して計算完了まで待機
            psfResult = await raceWithCancel(psfCalculationPromise, cancelToken);
        } else {
            // タイムアウト処理
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`PSF計算がタイムアウトしました (${PSF_TIMEOUT/1000}秒)`));
                }, PSF_TIMEOUT);
            });

            try {
                psfResult = await Promise.race([raceWithCancel(psfCalculationPromise, cancelToken), timeoutPromise]);
            } catch (timeoutError) {
                console.error('❌ PSF計算タイムアウト:', timeoutError);

                // ローディングオーバーレイを非表示
                hidePSFLoadingOverlay();

                const psfContainer = document.getElementById('psf-container');
                if (psfContainer) {
                    psfContainer.innerHTML = `
                        <div style="padding: 20px; text-align: center; color: #d32f2f; border: 1px solid #d32f2f; border-radius: 5px; background-color: #ffebee;">
                            <h3>PSF計算タイムアウト</h3>
                            <p>PSF計算が${PSF_TIMEOUT/1000}秒以内に完了しませんでした。</p>
                            <p>以下を試してください：</p>
                            <ul style="text-align: left; margin: 10px 0;">
                                <li>グリッドサイズを小さくする（64×64など）</li>
                                <li>光学系の設定を確認する</li>
                                <li>ブラウザを再読み込みする</li>
                            </ul>
                        </div>
                    `;
                }
                return;
            }
        }
        
        if (!psfResult) {
            console.error('❌ PSF計算がnull結果を返しました');
            
            // ローディングオーバーレイを非表示
            hidePSFLoadingOverlay();
            
            const psfContainer = document.getElementById('psf-container');
            if (psfContainer) {
                psfContainer.innerHTML = `
                    <div style="padding: 20px; text-align: center; color: #d32f2f; border: 1px solid #d32f2f; border-radius: 5px; background-color: #ffebee;">
                        <h3>PSF計算エラー</h3>
                        <p>PSF計算に失敗しました。以下を確認してください:</p>
                        </ul>
                        <p>詳細なエラーはコンソールを確認してください。</p>
                    </div>
                `;
            }
            alert('PSF計算に失敗しました。光学系とオブジェクトの設定を確認してください。');
            return;
        }
        
            if (PSF_DEBUG) console.log('✅ PSF計算が正常に完了しました');
        
        // ローディングオーバーレイを非表示
        hidePSFLoadingOverlay();
        
        // PSF結果の構造を修正（PSFCalculatorの結果フォーマットに合わせる）
        if (psfResult && psfResult.psfData && !psfResult.psf) {
            psfResult.psf = psfResult.psfData;
        }
        
        console.log('📊 PSF結果の構造:', {
            hasResult: !!psfResult,
            keys: psfResult ? Object.keys(psfResult) : 'none',
            hasPSFData: psfResult ? !!psfResult.psfData : false,
            hasPSF: psfResult ? !!psfResult.psf : false,
            samplingSize: psfResult ? psfResult.samplingSize : 'none',
            psfType: psfResult?.psf ? (Array.isArray(psfResult.psf) ? 'array' : typeof psfResult.psf) : 'none',
            dimensions: psfResult?.psf && Array.isArray(psfResult.psf) ? `${psfResult.psf.length}x${psfResult.psf[0]?.length || 0}` : 'none',
            sampleValue: psfResult?.psf && Array.isArray(psfResult.psf) && psfResult.psf[0] ? psfResult.psf[0][0] : 'none',
            hasMetrics: psfResult ? !!psfResult.metrics : false,
            wavelength: psfResult ? psfResult.wavelength : 'none',
            debugMode: debugMode
        });        // PSF結果をグローバル変数に保存（チェックボックス機能用）
        window.lastPsfResult = psfResult;
        window.lastPsfResult.title = debugMode ? `Debug PSF - ${wavelength}nm (16×16)` : `PSF - ${wavelength}nm`;
        window.lastPsfObjectData = selectedObject;
        window.lastPsfWavelength = wavelength;
        window.lastPsfGridSize = psfSamplingSize;
        window.lastPsfDebugMode = debugMode;
        window.lastPsfError = null;

        // Persist token-light PSF summary for other windows / AI context
        try {
            const metrics = psfResult?.metrics || psfResult?.characteristics || null;
            const summary = {
                at: new Date().toISOString(),
                wavelength: psfResult?.wavelength ?? wavelength ?? null,
                gridSize: psfResult?.gridSize ?? psfSamplingSize ?? null,
                calculationTime: psfResult?.calculationTime ?? null,
                hasMetrics: !!metrics,
                metricKeys: metrics ? Object.keys(metrics).slice(0, 30) : [],
                // Lightweight PSF fingerprint (does not include full array)
                psfSummary: (psfResult && (psfResult.psfSummary || psfResult.summary)) ? (psfResult.psfSummary || psfResult.summary) : null,
                debugMode: !!debugMode,
            };
            localStorage.setItem('lastPsfMeta', JSON.stringify(summary));
            localStorage.removeItem('lastPsfError');
        } catch (_) {}
        
        // PSFプロット表示を呼び出し
        try {
            // チェックボックスの状態を取得
            const logScaleCheckbox = document.getElementById('psf-log-scale-checkbox') || 
                                    document.getElementById('psf-log-scale-cb');
            const logScaleEnabled = logScaleCheckbox?.checked || false;
            
            // eva-psf-plot.jsの表示関数を動的インポートして使用
            if (typeof window.displayPSFResult === 'function') {
                await window.displayPSFResult(psfResult, 'psf-container', {
                    plotType: '2D',
                    logScale: logScaleEnabled,
                    colorscale: 'BGR',
                    showMetrics: true
                });
            } else if (typeof window.displaySimplePSFResult === 'function') {
                window.displaySimplePSFResult(psfResult, 'psf-container');
            } else {
                // fallback: 従来の簡単表示
                const psfContainer = document.getElementById('psf-container');
                if (psfContainer) {
                    psfContainer.innerHTML = `
                        <div style="padding: 20px; text-align: center; color: #2e7d32; border: 1px solid #4caf50; border-radius: 5px; background-color: #e8f5e8;">
                            <h3>PSF計算完了</h3>
                            <p>オブジェクト${selectedObjectIndex + 1}のPSF計算が完了しました</p>
                            <p>波長: ${wavelength}μm</p>
                            <p>グリッドサイズ: ${psfSamplingSize}×${psfSamplingSize}</p>
                            <p>PSF配列サイズ: ${psfResult.psf ? psfResult.psf.length : 'unknown'}×${psfResult.psf && psfResult.psf[0] ? psfResult.psf[0].length : 'unknown'}</p>
                            <p>計算時間: ${psfResult.calculationTime || 'unknown'}ms</p>
                            <p style="color: #d32f2f;">⚠️ PSFプロット機能が読み込まれていません</p>
                        </div>
                    `;
                }
            }
        } catch (plotError) {
            console.error('❌ [PSF] プロット表示エラー:', plotError);
            
            // エラー時は従来の表示
            const psfContainer = document.getElementById('psf-container');
            if (psfContainer) {
                psfContainer.innerHTML = `
                    <div style="padding: 20px; text-align: center; color: #2e7d32; border: 1px solid #4caf50; border-radius: 5px; background-color: #e8f5e8;">
                        <h3>PSF計算完了</h3>
                        <p>オブジェクト${selectedObjectIndex + 1}のPSF計算が完了しました</p>
                        <p>波長: ${wavelength}μm</p>
                        <p>グリッドサイズ: ${psfSamplingSize}×${psfSamplingSize}</p>
                        <p>PSF配列サイズ: ${psfResult.psf ? psfResult.psf.length : 'unknown'}×${psfResult.psf && psfResult.psf[0] ? psfResult.psf[0].length : 'unknown'}</p>
                        <p>計算時間: ${psfResult.calculationTime || 'unknown'}ms</p>
                        <p style="color: #d32f2f;">プロット表示エラー: ${plotError.message}</p>
                    </div>
                `;
            }
        }
        
        console.log('✅ [PSF] PSF計算・表示完了');
    } catch (error) {
        if (error && (error.code === 'CANCELLED' || String(error.message || '').toLowerCase().includes('cancel'))) {
            console.warn('🟡 [PSF] Calculation cancelled:', error.message || error);
            try {
                hidePSFLoadingOverlay();
            } catch (_) {}
            return;
        }
        console.error('❌ [PSF] PSF計算処理エラー:', error);
        
        // ローディングオーバーレイを非表示
        hidePSFLoadingOverlay();
        
        const psfContainer = document.getElementById('psf-container');
        const rawMessage = String(error?.message || 'PSF calculation failed');
        const hintIdx = rawMessage.indexOf('hint=');
        const hint = hintIdx >= 0 ? rawMessage.slice(hintIdx + 'hint='.length).trim() : '';

        // Token-light global snapshot for debugging / AI context (no UX change)
        try {
            window.lastPsfError = {
                at: new Date().toISOString(),
                code: error?.code ?? null,
                message: rawMessage,
                rawMessage,
                hint,
                wavelength: wavelength ?? null,
                gridSize: psfSamplingSize ?? null,
                objectIndex: (typeof selectedObjectIndex === 'number') ? selectedObjectIndex : null,
                debugMode: debugMode ?? null
            };
        } catch (_) {}

        // Persist error snapshot for other windows / AI context
        try {
            localStorage.setItem('lastPsfError', JSON.stringify(window.lastPsfError));
        } catch (_) {}

        if (psfContainer) {
            const isWavefrontUnavailable = (error?.code === 'WAVEFRONT_UNAVAILABLE') || /stop unreachable|reference ray|chief ray|marginal ray/i.test(rawMessage);
            if (isWavefrontUnavailable) {
                psfContainer.innerHTML = `
                    <div style="padding: 16px; text-align: left; color: #b71c1c; border: 1px solid #d32f2f; border-radius: 6px; background-color: #ffebee;">
                        <h3 style="margin: 0 0 8px 0;">PSF計算不能</h3>
                        <div style="margin: 0 0 8px 0; color: #333;">このフィールドでは基準光線が作れず、PSF を定義できませんでした（ビネッティング/有効FOV外の可能性）。</div>
                        <pre style="margin: 0; white-space: pre-wrap; word-break: break-word; color: #b71c1c;">${rawMessage}</pre>
                        ${hint ? `<div style=\"margin-top: 10px; color: #333;\"><b>hint</b>: ${hint}</div>` : ''}
                        <div style="margin-top: 10px; color: #333;">フィールド角/高さを小さくして再試行してください。</div>
                    </div>
                `;
            } else {
                psfContainer.innerHTML = `
                    <div style="padding: 20px; text-align: center; color: #d32f2f; border: 1px solid #d32f2f; border-radius: 5px; background-color: #ffebee;">
                        <h3>PSF計算エラー</h3>
                        <p>PSF計算処理中にエラーが発生しました: ${rawMessage}</p>
                        <p>光学系とオブジェクトの設定を確認してください。</p>
                        <p>詳細なエラーはコンソールを確認してください。</p>
                    </div>
                `;
            }
        }

        // Avoid disruptive alerts for the expected “out-of-FOV / vignetted” failure mode.
        if (error?.code !== 'WAVEFRONT_UNAVAILABLE') {
            alert(`PSF計算エラー: ${rawMessage}`);
        }
    }
    finally {
        try {
            if (window.__psfActiveCancelToken === cancelToken) window.__psfActiveCancelToken = null;
            const stopBtn = document.getElementById('stop-psf-btn');
            if (stopBtn) stopBtn.disabled = true;
        } catch (_) {}
    }
}

/**
 * PSF表示設定のイベントリスナーを設定
 */
function setupPSFDisplaySettings() {
    // チェックボックスの要素を取得（IDを統一）
    const psfLogScaleCb = document.getElementById('psf-log-scale-checkbox') || 
                         document.getElementById('psf-log-scale-cb');
    const psfContoursCb = document.getElementById('psf-contours-cb');
    const psfCharacteristicsCb = document.getElementById('psf-characteristics-cb');
    
    function updatePSFDisplay() {
        console.log('🔄 [PSF] Updating PSF display with new settings');
        
        // ローディングオーバーレイを非表示（念のため）
        hidePSFLoadingOverlay();
        
        if (window.lastPsfResult) {
            // チェックボックスの状態を取得（IDを統一）
            const logScaleCheckbox = document.getElementById('psf-log-scale-checkbox') || 
                                    document.getElementById('psf-log-scale-cb');
            const logScaleEnabled = logScaleCheckbox?.checked || false;
            
            console.log('🔄 [PSF] ログスケール設定:', logScaleEnabled);
            
            // 新しいPSF表示システムを使用
            if (typeof window.displayPSFResult === 'function') {
                window.displayPSFResult(window.lastPsfResult, 'psf-container', {
                    plotType: '2D',
                    logScale: logScaleEnabled,
                    colorscale: 'BGR',
                    showMetrics: true
                }).catch(error => {
                    console.error('❌ [PSF] 表示更新エラー:', error);
                });
            } else {
                console.warn('⚠️ [PSF] displayPSFResult関数が利用できません');
            }
            const contoursEnabled = psfContoursCb?.checked || false;
            const characteristicsEnabled = psfCharacteristicsCb?.checked || true;
            
            console.log('🎛️ [PSF] Display settings:', {
                logScale: logScaleEnabled,
                contours: contoursEnabled,
                characteristics: characteristicsEnabled
            });
            
            // 現在のアクティブな表示モードを判定
            const activeButton = document.querySelector('.psf-display-btn.active');
            const plotlyContainer = document.getElementById('psf-plotly-container');
            const isPlotlyMode = plotlyContainer && plotlyContainer.style.display !== 'none';
            
            if (isPlotlyMode && activeButton) {
                // Plot.lyモードの場合は対応する関数を呼び出し
                const psfData = {
                    data: window.lastPsfResult.psf,
                    gridSize: window.lastPsfResult.gridSize,
                    characteristics: window.lastPsfResult.characteristics,
                    imageScale: window.lastPsfResult.imageScale  // 重要：imageScaleを追加
                };
                
                const options = {
                    logScale: logScaleEnabled,
                    contours: contoursEnabled,
                    characteristics: characteristicsEnabled
                };
                
                const buttonId = activeButton.id;
                switch (buttonId) {
                    case 'psf-2d-btn':
                        if (window.PSFPlotter) {
                            const plotter = new window.PSFPlotter('psf-plotly-container');
                            const ch = psfData.characteristics;
                            const fwhmX = Number(ch?.fwhmX || 0);
                            const fwhmY = Number(ch?.fwhmY || 0);
                            const metrics = options.characteristics && ch ? {
                                strehlRatio: Number(ch.strehlRatio || 0),
                                fwhm: { x: fwhmX, y: fwhmY, average: (fwhmX + fwhmY) / 2 },
                                peakIntensity: Number(ch.peakIntensity || 0),
                                totalEnergy: Number(ch.totalEnergy || 0),
                                encircledEnergy: ch.encircledEnergy || []
                            } : null;
                            plotter.plot2DPSF({ psfData: psfData.data, metrics }, {
                                logScale: !!options.logScale,
                                colorscale: 'BGR',
                                showMetrics: !!options.characteristics,
                                title: 'Point Spread Function'
                            }).catch(e => {
                                console.error('❌ [PSF] 2D plot update error:', e);
                                if (typeof createPSFHeatmap === 'function') {
                                    createPSFHeatmap(psfData, options, 'psf-plotly-container');
                                }
                            });
                        } else if (typeof createPSFHeatmap === 'function') {
                            createPSFHeatmap(psfData, options, 'psf-plotly-container');
                        }
                        break;
                    case 'psf-3d-btn':
                        if (window.PSFPlotter) {
                            const plotter = new window.PSFPlotter('psf-plotly-container');
                            const ch = psfData.characteristics;
                            const fwhmX = Number(ch?.fwhmX || 0);
                            const fwhmY = Number(ch?.fwhmY || 0);
                            const metrics = options.characteristics && ch ? {
                                strehlRatio: Number(ch.strehlRatio || 0),
                                fwhm: { x: fwhmX, y: fwhmY, average: (fwhmX + fwhmY) / 2 },
                                peakIntensity: Number(ch.peakIntensity || 0),
                                totalEnergy: Number(ch.totalEnergy || 0),
                                encircledEnergy: ch.encircledEnergy || []
                            } : null;
                            plotter.plot3DPSF({ psfData: psfData.data, metrics }, {
                                logScale: !!options.logScale,
                                colorscale: 'BGR',
                                showMetrics: !!options.characteristics,
                                title: 'Point Spread Function'
                            }).catch(e => {
                                console.error('❌ [PSF] 3D plot update error:', e);
                                if (typeof createPSF3DSurface === 'function') {
                                    createPSF3DSurface(psfData, options, 'psf-plotly-container');
                                }
                            });
                        } else if (typeof createPSF3DSurface === 'function') {
                            createPSF3DSurface(psfData, options, 'psf-plotly-container');
                        }
                        break;
                    case 'psf-profile-btn':
                        createPSFProfile(psfData, options, 'psf-plotly-container');
                        break;
                    case 'psf-energy-btn':
                        createEncircledEnergyPlot(psfData, options, 'psf-plotly-container');
                        break;
                    case 'wavefront-btn':
                        // 波面収差モードの場合は、設定変更では再計算しない
                        console.log('🌊 [Wavefront] Settings changed, but wavefront display requires recalculation');
                        break;
                    default:
                        break;
                }
            } else {
                // 従来のcanvas描画モード
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    
                    // 最適化された高速描画を使用
                    plotPSF2DFast('psf-canvas', window.lastPsfResult, {
                        logScale: logScaleEnabled,
                        showContours: contoursEnabled,
                        showCrosshair: false,
                        showCharacteristics: characteristicsEnabled,
                        title: window.lastPsfResult.title || 'PSF',
                        showColorBar: true
                    });
                }
            }
            
            // 計算時間とその他の情報を更新 - disabled to hide PSF characteristics
            // updatePSFInfo(window.lastPsfResult, window.lastPsfObjectData, window.lastPsfWavelength, window.lastPsfGridSize);
        } else {
            console.warn('⚠️ [PSF] No PSF result available for display update');
        }
    }
    
    if (psfLogScaleCb) {
        psfLogScaleCb.addEventListener('change', updatePSFDisplay);
    }
    if (psfContoursCb) {
        psfContoursCb.addEventListener('change', updatePSFDisplay);
        console.log('✅ [PSF] Contours checkbox listener added');
    }
    if (psfCharacteristicsCb) {
        psfCharacteristicsCb.addEventListener('change', updatePSFDisplay);
        console.log('✅ [PSF] Characteristics checkbox listener added');
    }
}

/**
 * PSF情報パネルを更新
 */
export function updatePSFInfo(psfResult, objectData, wavelength, gridSize) {
    console.log('📊 [PSF] PSF info panel is disabled - not displaying characteristics');
    
    // PSF info panel is disabled - hide it
    const psfInfoPanel = document.getElementById('psf-info');
    if (psfInfoPanel) {
        psfInfoPanel.style.display = 'none';
    }
}

/**
 * テーブル変更イベントリスナーを設定
 */
function setupTableChangeListeners() {
    // Bind once per Tabulator instance, but allow retries in case this runs
    // before the table globals are assigned (common during startup).
    if (!window.__cooptSurfaceSelectListenerState || typeof window.__cooptSurfaceSelectListenerState !== 'object') {
        window.__cooptSurfaceSelectListenerState = {
            opticalSystemTabulator: false,
            tableOpticalSystem: false,
            initialRefreshDone: false,
            attempts: 0,
            retryScheduled: false,
        };
    }
    const state = window.__cooptSurfaceSelectListenerState;
    if (state.opticalSystemTabulator && state.tableOpticalSystem) return;

    // 面選択の初期更新
    if (!state.initialRefreshDone) {
        state.initialRefreshDone = true;
        setTimeout(() => {
            try { updateSurfaceNumberSelectLegacy(); } catch (_) {}
            try { updateSurfaceNumberSelect(); } catch (_) {}
        }, 1500);
    }

    const refreshSurfaceNumberSelect = () => {
        // Prefer the modern implementation (rowId-aware) last.
        try { updateSurfaceNumberSelectLegacy(); } catch (_) {}
        try { updateSurfaceNumberSelect(); } catch (_) {}
    };

    const bindSurfaceSelectRefresh = (tab, key, name) => {
        if (state[key]) return true;
        if (!tab || typeof tab.on !== 'function') return false;
        try {
            tab.on('dataChanged', refreshSurfaceNumberSelect);
            tab.on('rowAdded', refreshSurfaceNumberSelect);
            tab.on('rowDeleted', refreshSurfaceNumberSelect);
            // Some edits (e.g., quick insert/delete flows) may not always emit dataChanged immediately.
            tab.on('cellEdited', refreshSurfaceNumberSelect);
            state[key] = true;
            return true;
        } catch (e) {
            console.warn(`⚠️ Failed to bind surface select refresh on ${name}:`, e);
            return false;
        }
    };

    // 光学系テーブル変更時に面選択を更新
    state.attempts++;
    const okLegacy = bindSurfaceSelectRefresh(window.opticalSystemTabulator, 'opticalSystemTabulator', 'opticalSystemTabulator');
    const okCurrent = bindSurfaceSelectRefresh(window.tableOpticalSystem, 'tableOpticalSystem', 'tableOpticalSystem');
    if (!okLegacy && !okCurrent) {
        console.warn('⚠️ Optical system table is not initialized or does not have .on method');
    }

    // Safety net: some update paths may mutate rows without emitting Tabulator events.
    // Poll a compact signature and refresh Surf options when it changes.
    try {
        if (!window.__cooptSurfSelectPollId) {
            const computeSig = () => {
                try {
                    const rows = (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function')
                        ? window.tableOpticalSystem.getData()
                        : (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.getData === 'function')
                            ? window.opticalSystemTabulator.getData()
                            : null;
                    if (!Array.isArray(rows) || rows.length === 0) return '';
                    let s = '';
                    for (let i = 0; i < rows.length; i++) {
                        const r = rows[i] || {};
                        const id = (r.id !== undefined && r.id !== null) ? r.id : i;
                        const ot = String(r['object type'] ?? r.object ?? r.objectType ?? '');
                        const st = String(r.surfType ?? r['surf type'] ?? r.type ?? '');
                        s += `${id}:${ot}:${st}|`;
                    }
                    return s;
                } catch (_) {
                    return '';
                }
            };

            window.__cooptSurfSelectPollId = setInterval(() => {
                try {
                    const sig = computeSig();
                    if (sig && sig !== window.__cooptLastSurfSelectDataSig) {
                        window.__cooptLastSurfSelectDataSig = sig;
                        refreshSurfaceNumberSelect();
                    }
                } catch (_) {}
            }, 1000);
        }
    } catch (_) {}

    // If one of the two table globals is assigned later, retry binding briefly.
    if ((!state.opticalSystemTabulator || !state.tableOpticalSystem) && state.attempts < 50) {
        if (!state.retryScheduled) {
            state.retryScheduled = true;
            setTimeout(() => {
                try { state.retryScheduled = false; } catch (_) {}
                try { setupTableChangeListeners(); } catch (_) {}
            }, 200);
        }
    }
    
    // PSF関連の機能は削除されました
    if (window.objectTabulator && typeof window.objectTabulator.on === 'function') {
    } else {
        console.warn('⚠️ objectTabulator is not initialized or does not have .on method');
    }
    
    // tableObjectが利用可能な場合の確認
    if (window.tableObject && typeof window.tableObject.on === 'function') {

    }
}

/**
 * テーブルの初期化を待つ関数
 */
function waitForTableInitialization() {
    // Cache: multiple callers should share one waiter to avoid duplicated timers/logs.
    if (window.__tableInitReady) return Promise.resolve();
    if (window.__tableInitPromise) return window.__tableInitPromise;

    window.__tableInitPromise = new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (window.tableOpticalSystem && 
                typeof window.tableOpticalSystem.on === 'function' &&
                window.tableObject && 
                typeof window.tableObject.on === 'function') {
                clearInterval(checkInterval);
                window.__tableInitReady = true;
                resolve();
            }
        }, 100); // 100ms間隔でチェック
        
        // 5秒後にタイムアウト
        setTimeout(() => {
            clearInterval(checkInterval);
            if (!window.__tableInitReady) {
                console.warn('⚠️ Table initialization timeout');
            }
            resolve();
        }, 5000);
    });

    return window.__tableInitPromise;
}

/**
 * PSFの初期化を試行
 */
function tryInitializePSF() {
    let initAttempts = 0;
    const maxAttempts = 10;
    
    function attemptInitialization() {
        initAttempts++;
        
        const objectRows = getObjectRows();
        if (objectRows && objectRows.length > 0) {
            // PSF機能は削除されました
        } else if (initAttempts < maxAttempts) {
            setTimeout(attemptInitialization, 200);
        }
    }
    
    // 初期化試行を開始
    setTimeout(attemptInitialization, 100);
    
    // PSF機能は削除されました
}

/**
 * PSF表示モード切り替えボタンのイベントハンドラーを設定
 */
function setupPSFDisplayModeButtons() {
    const psf2DBtn = document.getElementById('psf-2d-btn');
    const psf3DBtn = document.getElementById('psf-3d-btn');
    const psfProfileBtn = document.getElementById('psf-profile-btn');
    const psfEnergyBtn = document.getElementById('psf-energy-btn');
    const wavefrontBtn = document.getElementById('wavefront-btn');
    
    const canvas = document.getElementById('psf-canvas');
    
    // Plot.lyコンテナの存在確認と作成
    function ensurePlotlyContainer() {
        let plotlyContainer = document.getElementById('psf-plotly-container');
        if (!plotlyContainer) {
            console.log('⚠️ [PSF] Creating missing Plot.ly container');
            const psfContainer = document.getElementById('psf-container');
            if (psfContainer) {
                plotlyContainer = document.createElement('div');
                plotlyContainer.id = 'psf-plotly-container';
                plotlyContainer.style.cssText = `
                    width: 600px;
                    height: 600px;
                    border: 1px solid #ddd;
                    background-color: #f8f9fa;
                    border-radius: 4px;
                    margin: 10px auto;
                `;
                psfContainer.appendChild(plotlyContainer);
            }
        }
        return plotlyContainer;
    }
    
    // 現在のアクティブボタンを管理
    let currentActiveBtn = psf2DBtn;
    
    function setActiveButton(btn) {
        // 全ボタンからactiveクラスを削除
        [psf2DBtn, psf3DBtn, psfProfileBtn, psfEnergyBtn, wavefrontBtn].forEach(b => {
            if (b) b.classList.remove('active');
        });
        
        // 選択されたボタンにactiveクラスを追加
        if (btn) {
            btn.classList.add('active');
            currentActiveBtn = btn;
        }
    }
    
    function getPSFDisplayOptions() {
        const logScaleCb = document.getElementById('psf-log-scale-cb');
        const contoursCb = document.getElementById('psf-contours-cb');
        const characteristicsCb = document.getElementById('psf-characteristics-cb');
        
        return {
            logScale: logScaleCb?.checked || false,
            contours: contoursCb?.checked || false,
            characteristics: characteristicsCb?.checked || false
        };
    }

    function characteristicsToMetrics(characteristics) {
        if (!characteristics) return null;
        const fwhmX = Number(characteristics.fwhmX || 0);
        const fwhmY = Number(characteristics.fwhmY || 0);
        return {
            strehlRatio: Number(characteristics.strehlRatio || 0),
            fwhm: {
                x: fwhmX,
                y: fwhmY,
                average: (fwhmX + fwhmY) / 2
            },
            peakIntensity: Number(characteristics.peakIntensity || 0),
            totalEnergy: Number(characteristics.totalEnergy || 0),
            encircledEnergy: characteristics.encircledEnergy || []
        };
    }

    async function renderPSFWithNewPlotter(kind, psfData, options, containerId) {
        if (!window.PSFPlotter) return false;

        const plotter = new window.PSFPlotter(containerId);
        const psfResultForPlotter = {
            psfData: psfData.data,
            metrics: options.characteristics ? characteristicsToMetrics(psfData.characteristics) : null
        };

        if (kind === '2D') {
            await plotter.plot2DPSF(psfResultForPlotter, {
                logScale: !!options.logScale,
                colorscale: 'BGR',
                showMetrics: !!options.characteristics,
                title: 'Point Spread Function'
            });
            return true;
        }

        if (kind === '3D') {
            await plotter.plot3DPSF(psfResultForPlotter, {
                logScale: !!options.logScale,
                colorscale: 'BGR',
                showMetrics: !!options.characteristics,
                title: 'Point Spread Function'
            });
            return true;
        }

        return false;
    }
    
    // 2D Heatmapボタン
    if (psf2DBtn) {
        psf2DBtn.addEventListener('click', async () => {
            console.log('📊 2D Heatmap button clicked');
            
            // ローディングオーバーレイを非表示（念のため）
            hidePSFLoadingOverlay();
            
            if (window.lastPsfResult) {
                setActiveButton(psf2DBtn);
                
                // Ensure Plot.ly container exists
                const plotlyContainer = ensurePlotlyContainer();
                
                // Hide canvas, show Plot.ly
                if (canvas) canvas.style.display = 'none';
                if (plotlyContainer) plotlyContainer.style.display = 'block';
                
                // Convert data format
                const psfData = {
                    data: window.lastPsfResult.psf,
                    gridSize: window.lastPsfResult.gridSize,
                    characteristics: window.lastPsfResult.characteristics,
                    imageScale: window.lastPsfResult.imageScale  // 重要：imageScaleを追加
                };
                
                const options = getPSFDisplayOptions();
                try {
                    const ok = await renderPSFWithNewPlotter('2D', psfData, options, 'psf-plotly-container');
                    if (!ok && typeof createPSFHeatmap === 'function') {
                        createPSFHeatmap(psfData, options, 'psf-plotly-container');
                    }
                } catch (e) {
                    console.error('❌ [PSF] 2D plot error:', e);
                    if (typeof createPSFHeatmap === 'function') {
                        createPSFHeatmap(psfData, options, 'psf-plotly-container');
                    }
                }
            } else {
                alert('PSFを計算してください。');
            }
        });
    }
    
    // 3D Surface button
    if (psf3DBtn) {
        psf3DBtn.addEventListener('click', async () => {
            console.log('📊 3D Surface button clicked');
            
            // ローディングオーバーレイを非表示（念のため）
            hidePSFLoadingOverlay();
            
            if (window.lastPsfResult) {
                setActiveButton(psf3DBtn);
                
                // Ensure Plot.ly container exists
                const plotlyContainer = ensurePlotlyContainer();
                
                // Hide canvas, show Plot.ly
                if (canvas) canvas.style.display = 'none';
                if (plotlyContainer) plotlyContainer.style.display = 'block';
                
                // Convert data format
                const psfData = {
                    data: window.lastPsfResult.psf,
                    gridSize: window.lastPsfResult.gridSize,
                    characteristics: window.lastPsfResult.characteristics,
                    imageScale: window.lastPsfResult.imageScale  // 重要：imageScaleを追加
                };
                
                const options = getPSFDisplayOptions();
                try {
                    const ok = await renderPSFWithNewPlotter('3D', psfData, options, 'psf-plotly-container');
                    if (!ok && typeof createPSF3DSurface === 'function') {
                        createPSF3DSurface(psfData, options, 'psf-plotly-container');
                    }
                } catch (e) {
                    console.error('❌ [PSF] 3D plot error:', e);
                    if (typeof createPSF3DSurface === 'function') {
                        createPSF3DSurface(psfData, options, 'psf-plotly-container');
                    }
                }
            } else {
                alert('PSFを計算してください。');
            }
        });
    }
    
    // Profile button
    if (psfProfileBtn) {
        psfProfileBtn.addEventListener('click', () => {
            console.log('📊 Profile button clicked');
            
            // ローディングオーバーレイを非表示（念のため）
            hidePSFLoadingOverlay();
            
            if (window.lastPsfResult) {
                setActiveButton(psfProfileBtn);
                
                // Ensure Plot.ly container exists
                const plotlyContainer = ensurePlotlyContainer();
                
                // Hide canvas, show Plot.ly
                if (canvas) canvas.style.display = 'none';
                if (plotlyContainer) plotlyContainer.style.display = 'block';
                
                // Convert data format
                const psfData = {
                    data: window.lastPsfResult.psf,
                    gridSize: window.lastPsfResult.gridSize,
                    characteristics: window.lastPsfResult.characteristics,
                    imageScale: window.lastPsfResult.imageScale  // 重要：imageScaleを追加
                };
                
                const options = getPSFDisplayOptions();
                createPSFProfile(psfData, options, 'psf-plotly-container');
            } else {
                alert('PSFを計算してください。');
            }
        });
    }
    
    // Encircled Energy button
    if (psfEnergyBtn) {
        psfEnergyBtn.addEventListener('click', () => {
            console.log('📊 Encircled Energy button clicked');
            
            // ローディングオーバーレイを非表示（念のため）
            hidePSFLoadingOverlay();
            
            if (window.lastPsfResult) {
                setActiveButton(psfEnergyBtn);
                
                // Ensure Plot.ly container exists
                const plotlyContainer = ensurePlotlyContainer();
                
                // Hide canvas, show Plot.ly
                if (canvas) canvas.style.display = 'none';
                if (plotlyContainer) plotlyContainer.style.display = 'block';
                
                // Convert data format
                const psfData = {
                    data: window.lastPsfResult.psf,
                    gridSize: window.lastPsfResult.gridSize,
                    characteristics: window.lastPsfResult.characteristics,
                    imageScale: window.lastPsfResult.imageScale  // 重要：imageScaleを追加
                };
                
                const options = getPSFDisplayOptions();
                createEncircledEnergyPlot(psfData, options, 'psf-plotly-container');
            } else {
                alert('PSFを計算してください。');
            }
        });
    }
    
    // Wavefront button
    if (wavefrontBtn) {
        wavefrontBtn.addEventListener('click', async () => {
            console.log('🌊 Wavefront button clicked');
            
            // ローディングオーバーレイを非表示（念のため）
            hidePSFLoadingOverlay();
            
            // PSF結果の代わりに、オブジェクトデータから直接波面収差を計算
            const psfObjectSelect = document.getElementById('psf-object-select');
            if (!psfObjectSelect || !psfObjectSelect.value) {
                alert('波面収差表示のためのオブジェクトを選択してください');
                return;
            }
            
            const selectedObjectIndex = parseInt(psfObjectSelect.value);
            const objectRows = getObjectRows();
            const opticalSystemRows = getOpticalSystemRows();
            
            if (!objectRows || selectedObjectIndex >= objectRows.length) {
                alert('選択されたオブジェクトが無効です');
                return;
            }
            
            if (!opticalSystemRows || opticalSystemRows.length === 0) {
                alert('光学系データが見つかりません');
                return;
            }
            
            const selectedObject = objectRows[selectedObjectIndex];
            const wavelengthSelect = document.getElementById('psf-wavelength-select');
            const gridSizeSelect = document.getElementById('psf-grid-size-select');
            const wavelength = wavelengthSelect ? parseFloat(wavelengthSelect.value) : 0.5876;
            const gridSize = gridSizeSelect ? parseInt(gridSizeSelect.value) : 64;
            
            try {
                setActiveButton(wavefrontBtn);
                
                // Show loading overlay
                showPSFLoadingOverlay(gridSize, wavelength.toString(), false);
                
                // Create field setting from object
                const fieldSetting = createFieldSettingFromObject(selectedObject);
                if (!fieldSetting) {
                    alert('選択されたオブジェクトからフィールド設定の作成に失敗しました');
                    return;
                }
                
                // Calculate wavefront aberration
                console.log('🌊 [Wavefront] Calculating wavefront aberration...');
                const wavefrontData = await calculateWavefrontAberration(opticalSystemRows, fieldSetting, wavelength, {
                    gridSize: gridSize,
                    debugMode: false
                });
                
                // Hide loading overlay
                hidePSFLoadingOverlay();
                
                // Ensure Plot.ly container exists
                const plotlyContainer = ensurePlotlyContainer();
                
                // Hide canvas, show Plot.ly
                if (canvas) canvas.style.display = 'none';
                if (plotlyContainer) plotlyContainer.style.display = 'block';
                
                // Get display options
                const options = {
                    showStatistics: document.getElementById('psf-characteristics-cb')?.checked || true,
                    contours: document.getElementById('psf-contours-cb')?.checked || false
                };
                
                // Create wavefront heatmap
                await createWavefrontHeatmap(wavefrontData, options, 'psf-plotly-container');
                
                console.log('✅ [Wavefront] Wavefront visualization completed');
                
            } catch (error) {
                console.error('❌ [Wavefront] Error displaying wavefront:', error);
                hidePSFLoadingOverlay();
                alert(`波面収差表示エラー: ${error.message}`);
            }
        });
    }
}

function setupExpandedOpticalSystemToggle() {
    try {
        const btn = document.getElementById('toggle-expanded-optical-system-btn');
        const content = document.getElementById('expanded-optical-system-content');
        if (!btn || !content) return;

        const isCollapsed = () => {
            try {
                if (content.style.display === 'none') return true;
                return (typeof getComputedStyle === 'function')
                    ? (getComputedStyle(content).display === 'none')
                    : false;
            } catch (_) {
                return content.style.display === 'none';
            }
        };

        const setCollapsed = (collapsed) => {
            content.style.display = collapsed ? 'none' : '';
            btn.textContent = collapsed ? 'Expand' : 'Collapse';
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        };

        // Default: expanded
        setCollapsed(false);

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            setCollapsed(!isCollapsed());
        });
    } catch (e) {
        console.warn('⚠️ Failed to setup Expanded Optical System toggle:', e);
    }
}

/**
 * PSF計算用のローディングオーバーレイを表示
 */
function showPSFLoadingOverlay(gridSize, wavelength, debugMode = false) {
    const psfContainer = document.getElementById('psf-container');
    let loadingOverlay = document.getElementById('psf-loading-overlay');
    
    if (loadingOverlay) {
        loadingOverlay.remove();
    }
    
    loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'psf-loading-overlay';
    loadingOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.9);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        border-radius: 5px;
    `;
    
    const modeText = debugMode ? '🔧 デバッグモードでPSFを計算中...' : '🔬 WASM高速化でPSFを計算中...';
    const additionalInfo = debugMode ? '<p>🔍 最大16本の光線追跡詳細ログを出力中...</p>' : '';
    
    loadingOverlay.innerHTML = `
        <div class="psf-spinner" style="width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
        <p>${modeText}</p>
        <p>グリッドサイズ: ${gridSize}×${gridSize}</p>
        <p>波長: ${wavelength} ${wavelength === 'polychromatic' ? '' : 'μm'}</p>
        ${additionalInfo}
        <style>
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    `;
    
    if (psfContainer) {
        psfContainer.style.position = 'relative';
        psfContainer.appendChild(loadingOverlay);
    }
    
    console.log('✅ PSF loading overlay shown');
}

/**
 * PSF計算用のローディングオーバーレイを非表示
 */
function hidePSFLoadingOverlay() {
    const loadingOverlay = document.getElementById('psf-loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.remove();
        console.log('✅ PSF loading overlay hidden');
    }
}

/**
 * すべてのDOMイベントハンドラーを設定（メイン関数）
 */
export function setupDOMEventHandlers() {
    // Guard: avoid registering the same UI/table listeners multiple times.
    // Some load flows can call this more than once.
    if (window.__domEventHandlersInitialized) {

        return;
    }
    window.__domEventHandlersInitialized = true;

    console.log('🎯 DOM Content Loaded - イベントリスナーを設定中...');
    
    // WASMテストボタンのハンドラーを設定
    const wasmTestBtn = document.getElementById('debug-wasm-system');
    if (wasmTestBtn) {
        wasmTestBtn.addEventListener('click', function() {
            console.log('🔥 WASM System Test initiated...');
            debugWASMSystem();
            setTimeout(() => quickWASMComparison(), 1000);
        });
    }
    
    // グローバルアクセス用にテーブルオブジェクトを設定
    // 可能ならモジュール側のTabulatorインスタンスを優先してwindowへバインド
    window.tableSource = window.tableSource || tableSource;
    window.tableObject = window.tableObject || tableObject;
    window.tableOpticalSystem = window.tableOpticalSystem || tableOpticalSystem;
    // 互換性のための別名
    window.objectTabulator = window.objectTabulator || window.tableObject;
    window.opticalSystemTabulator = window.opticalSystemTabulator || window.tableOpticalSystem;
    console.log('✅ テーブルがwindowオブジェクトに設定されました');
    
    // テーブルの初期化状況を確認
    console.log('🔍 テーブル初期化状況:');
    console.log('- window.tableOpticalSystem:', !!window.tableOpticalSystem);
    console.log('- window.opticalSystemTabulator:', !!window.opticalSystemTabulator);
    console.log('- window.tableObject:', !!window.tableObject);
    console.log('- window.objectTabulator:', !!window.objectTabulator);
    
    if (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.on === 'function') {
        console.log('✅ opticalSystemTabulator.on method is available');
    } else {
        console.warn('⚠️ opticalSystemTabulator.on method is not available');
        console.log('   - opticalSystemTabulator type:', typeof window.opticalSystemTabulator);
        console.log('   - opticalSystemTabulator.on type:', typeof window.opticalSystemTabulator?.on);
    }
    
    // 関数が利用可能かどうかを確認
    console.log('🔍 関数の利用可能性をチェック:');
    console.log('- outputParaxialDataToDebug:', typeof outputParaxialDataToDebug);
    console.log('- displayCoordinateTransformMatrix:', typeof displayCoordinateTransformMatrix);
    console.log('- window.outputParaxialDataToDebug:', typeof window.outputParaxialDataToDebug);
    console.log('- window.displayCoordinateTransformMatrix:', typeof window.displayCoordinateTransformMatrix);
    
    try {
        // UIイベントハンドラーを設定
        setupSaveButton();
        setupLoadButton();
        setupShareUrlButton();
        setupImportZemaxButton();
        setupExportZemaxButton();
        setupClearStorageButton();
        setupSuggestOptimizeButtons();
        setupApplyToDesignIntentButton();
        setupParaxialButton();
        setupSeidelButton();
        setupSeidelAfocalButton();
        setupCoordinateTransformButton();
        setupSpotDiagramConfigSelect();
        setupSpotDiagramButton();
        setupLongitudinalAberrationButton();
        setupTransverseAberrationButton();
        setupDistortionButton();
        setupIntegratedAberrationButton();
        setupAstigmatismButton();
        setupWavefrontAberrationButton();
        setupPSFCalculationButton();
        setupDebugPSFCalculationButton();
        setupPSFDisplaySettings();
        setupExpandedOpticalSystemToggle();
        setupPSFDisplayModeButtons();

        // System Requirements summary (BFL etc.) is rendered from surface rows; no user input here.
        
        // 初期化後にObject選択オプションを更新
        updateWavefrontObjectOptions();
        setupPSFObjectSelect();
        
        // PSFオブジェクト選択肢の定期更新（テーブルデータ変更を検知）
        // UI初期化が複数回走ると setInterval が多重登録されてログ/負荷が増えるため、window に1つだけ保持する
        if (!window.__psfObjectOptionsIntervalId) {
            window.__psfObjectOptionsIntervalId = setInterval(() => {
                if (typeof updatePSFObjectOptions === 'function') {
                    updatePSFObjectOptions();
                }
            }, 10000); // 10秒ごとに更新（頻度を下げてユーザーの選択を保護）
        }
        
        // テーブルの初期化を待ってからリスナーを設定
        waitForTableInitialization().then(() => {
            setupTableChangeListeners();
        });
        setupPSFDisplayModeButtons(); // PSF表示モード切り替えボタンのセットアップ
        

    } catch (error) {
        console.error('❌ UIイベントハンドラー設定エラー:', error);
    }

    try { refreshBlockInspector(); } catch (_) {}
    
    // PSF初期化を試行
    tryInitializePSF();
    
    // テーブル初期化待機
    waitForTableInitialization().then(() => {
        // PSF設定のイベントリスナーを遅延設定（DOM要素が確実に存在するように）
        setTimeout(() => {
            setupPSFDisplaySettings();
            setupPSFObjectSelect(); // PSFオブジェクト選択も遅延初期化
        }, 1000);
        
        // さらに遅延してPSFオブジェクト選択を再設定（テーブルデータが確実に読み込まれた後）
        setTimeout(() => {
            if (globalThis.__PSF_DEBUG) console.log('🔄 [PSF] 遅延PSFオブジェクト選択設定');
            setupPSFObjectSelect();
        }, 2000);
    }).catch(err => {
        console.error('❌ テーブル初期化エラー:', err);
    });
    
    // プロットパフォーマンステストUIを初期化 (disabled)
    // setTimeout(() => {
    //     createPlotPerformanceTestButton();
    // }, 500);
}

/**
 * PSF図表示メイン関数
 * @param {string} plotType - プロットタイプ ('2d', '3d', 'encircled')
 * @param {number} samplingSize - サンプリングサイズ (32, 64, 128, 256)
 * @param {boolean} logScale - ログスケール
 * @param {number} objectIndex - オブジェクトインデックス
 */
async function showPSFDiagram(plotType, samplingSize, logScale, objectIndex, options = {}) {
    try {
        const cancelToken = (options && options.cancelToken) ? options.cancelToken : null;
        throwIfCancelled(cancelToken);
        const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);
        if (PSF_DEBUG) console.log('🔬 [PSF] PSF計算・表示開始');

        const getActiveConfigLabel = () => {
            try {
                if (typeof localStorage === 'undefined') return '';
                const raw = localStorage.getItem('systemConfigurations');
                if (!raw) return '';
                const sys = JSON.parse(raw);
                const activeId = sys?.activeConfigId;
                const cfg = Array.isArray(sys?.configurations)
                    ? sys.configurations.find(c => String(c?.id) === String(activeId))
                    : null;
                if (!cfg) return activeId !== undefined && activeId !== null ? `id=${activeId}` : '';
                return `id=${cfg.id} name=${cfg.name || ''}`.trim();
            } catch (_) {
                return '';
            }
        };

        const externalOnProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        const emitProgress = (percent, phase, message) => {
            if (!externalOnProgress) return;
            try {
                const p = Number(percent);
                externalOnProgress({
                    percent: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
                    phase: phase || null,
                    message: message || null
                });
            } catch (_) {
                // ignore
            }
        };

        const calcFNV1a32 = (str) => {
            let hash = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) {
                hash ^= str.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193);
            }
            return (hash >>> 0).toString(16);
        };

        const summarizeOpticalSystemRows = (rows) => {
            if (!Array.isArray(rows) || rows.length === 0) return { checksum: '0', first: null, last: null };
            const parts = [];
            for (const r of rows) {
                if (!r) continue;
                const obj = r['object type'] ?? r.object ?? r.Object ?? '';
                const radius = r.radius ?? r.Radius ?? '';
                const thickness = r.thickness ?? r.Thickness ?? '';
                const material = r.material ?? r.Material ?? '';
                const semidia = r.semidia ?? r.semidiameter ?? r.SemiDia ?? '';
                const id = r.id ?? '';
                parts.push(`${id}|${obj}|${radius}|${thickness}|${material}|${semidia}`);
            }
            const joined = parts.join(';');
            return {
                checksum: calcFNV1a32(joined),
                first: parts[0] || null,
                last: parts[parts.length - 1] || null
            };
        };
        
        // 必要なモジュールを動的インポート
        // PSFCalculator はシングルトンで再利用（WASM初期化を使い回す）
        const { PSFPlotter } = await import('../evaluation/psf/psf-plot.js');
        const { createOPDCalculator } = await import('../evaluation/wavefront/wavefront.js');
        
        // 光学システムデータを取得（live table を優先）
        const opticalSystemRows = getOpticalSystemRows(window.tableOpticalSystem);
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学システムデータがありません。まず光学システムを設定してください。');
        }

        const opticalSystemSource = (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function')
            ? 'table'
            : (typeof localStorage !== 'undefined' && !!localStorage.getItem('OpticalSystemTableData'))
                ? 'localStorage'
                : 'dummy';

        const opticalSystemSummary = summarizeOpticalSystemRows(opticalSystemRows);

        if (PSF_DEBUG) {
            try {
                const idx4 = opticalSystemRows?.[4];
                const idx5 = opticalSystemRows?.[5];
                console.log(
                    `🧾 [PSF] activeConfig=${getActiveConfigLabel() || '(none)'} source=${opticalSystemSource} rows=${opticalSystemRows.length} checksum=${opticalSystemSummary.checksum}` +
                    ` idx4(th=${idx4?.thickness}) idx5(th=${idx5?.thickness})`
                );
            } catch (_) {}
        }
        
        // Objectデータを取得（live table を優先）
        const objects = getObjectRows(window.tableObject);
        if (!objects || objects.length === 0) {
            throw new Error('オブジェクトデータがありません。まずオブジェクトを設定してください。');
        }
        
        if (objectIndex >= objects.length) {
            throw new Error('指定されたオブジェクトが見つかりません。');
        }
        
        if (PSF_DEBUG) {
            console.log(`🔍 [PSF] showPSFDiagram - objectIndex: ${objectIndex}, objects.length: ${objects.length}`);
            console.log(`🔍 [PSF] Available objects:`, objects.map((obj, idx) => ({ 
                index: idx, 
                x: obj.x || obj.xHeightAngle || 0, 
                y: obj.y || obj.yHeightAngle || 0 
            })));
        }
        
        const selectedObject = objects[objectIndex];
        if (PSF_DEBUG) {
            console.log(`🔍 [PSF] Selected object:`, {
                index: objectIndex,
                object: selectedObject,
                x: selectedObject.x || selectedObject.xHeightAngle || 0,
                y: selectedObject.y || selectedObject.yHeightAngle || 0
            });
        }
        
        // 光源データから波長を取得
        const sources = getSourceRows(window.tableSource);
        // Sourceテーブルの主波長を優先
        const wavelength = (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
            ? (Number(window.getPrimaryWavelength()) || 0.5876)
            : ((sources && sources.length > 0) ? (sources[0].wavelength || 0.5876) : 0.5876);
        
        // PSF performance mode (auto/wasm/javascript)
        // - popup can override via options.forceImplementation without touching main UI
        const performanceSelect = document.getElementById('psf-performance-select');
        const selectedMode = performanceSelect ? performanceSelect.value : 'auto';
        const forcedModeRaw = options && Object.prototype.hasOwnProperty.call(options, 'forceImplementation')
            ? options.forceImplementation
            : undefined;
        const forcedMode = (forcedModeRaw === 'wasm' || forcedModeRaw === 'javascript' || forcedModeRaw === 'auto' || forcedModeRaw === null)
            ? forcedModeRaw
            : undefined;
        const performanceMode = forcedMode !== undefined ? forcedMode : selectedMode;

        // OPDデータを計算
        // OPD表示と同じ固定条件でPSF入力格子を生成する:
        // - opdMode: referenceSphere
        // - Zernike fit なし
        // - piston+tilt removed
        if (PSF_DEBUG) console.log('📊 [PSF] Fixed wavefront map (referenceSphere/no-Zernike/piston+tilt removed) からOPD格子を生成中...');
        const { WavefrontAberrationAnalyzer } = await import('../evaluation/wavefront/wavefront.js');
        const opdCalculator = createOPDCalculator(opticalSystemRows, wavelength);
        const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);
        
        // フィールド設定（選択されたオブジェクトの座標を使用）
        // NOTE: 0 を falsy として扱わないために ?? を使用
        // Object tableのデータ形式に応じて角度または高さを設定
        const objectX = (selectedObject.x ?? selectedObject.xHeightAngle ?? 0);
        const objectY = (selectedObject.y ?? selectedObject.yHeightAngle ?? 0);
        
        // Object typeを確認（Angle / Height / Rectangle / Point ...）
        const objectTypeRaw = String(selectedObject.position ?? selectedObject.object ?? selectedObject.Object ?? selectedObject.objectType ?? 'Point');
        const objectType = objectTypeRaw;
        const objectTypeLower = objectTypeRaw.toLowerCase();

        let fieldAngle = { x: 0, y: 0 };
        let xHeight = 0;
        let yHeight = 0;

        // IMPORTANT: 'rectangle' contains the substring 'angle'.
        // Use a word-boundary test so Rectangle is not treated as Angle.
        if (/\bangle\b/.test(objectTypeLower)) {
            // Angle (deg): interpret as field angle. Solver selection is handled by eva-wavefront.js.
            fieldAngle = { x: Number(objectX) || 0, y: Number(objectY) || 0 };
            xHeight = 0;
            yHeight = 0;
        } else {
            // Point/Rectangle/Height 等は高さ扱い
            fieldAngle = { x: 0, y: 0 };
            xHeight = Number(objectX) || 0;
            yHeight = Number(objectY) || 0;
        }

        const fieldSetting = {
            objectIndex: objectIndex,
            type: objectType,
            fieldAngle,
            xHeight,
            yHeight,
            wavelength: wavelength
        };

        if (PSF_DEBUG) {
            console.log(`🧭 [PSF] objectIndex=${objectIndex} type=${objectType} fieldAngle=(${fieldSetting.fieldAngle.x},${fieldSetting.fieldAngle.y}) height=(${fieldSetting.xHeight},${fieldSetting.yHeight}) wl=${wavelength}`);
        }
        
        if (PSF_DEBUG) {
            console.log(`🔍 [PSF] Field setting created:`, fieldSetting);
            console.log(`🔍 [PSF] Object type: ${objectType}, coordinates: (${objectX}, ${objectY})`);
        }
        
        const psfSamplingSize = Number.isFinite(Number(samplingSize)) ? Math.max(16, Math.floor(Number(samplingSize))) : 64;

        emitProgress(0, 'wavefront', 'Wavefront start');
        const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, psfSamplingSize, 'circular', {
            recordRays: false,
            progressEvery: 0,
            zernikeMaxNoll: 37,
            renderFromZernike: false,
            skipZernikeFit: true,
            opdMode: 'referenceSphere',
            opdDisplayMode: 'pistonTiltRemoved',
            diagnoseDiscontinuities: PSF_DEBUG,
            diagTopK: 8,
            cancelToken,
            onProgress: (evt) => {
                const p = Number(evt?.percent);
                if (!Number.isFinite(p)) {
                    emitProgress(null, evt?.phase || 'wavefront', evt?.message || 'Wavefront...');
                    return;
                }
                // Map wavefront progress 0..100 => overall 0..80
                const overall = 0 + 0.8 * p;
                emitProgress(overall, evt?.phase || 'wavefront', evt?.message || `Wavefront ${Math.floor(p)}%`);
            }
        });

        throwIfCancelled(cancelToken);

        emitProgress(80, 'wavefront', 'Wavefront done');

        if (wavefrontMap?.error) {
            throw new Error(wavefrontMap.error?.message || 'Wavefront generation failed');
        }

        // PSF入力格子は、PSFサンプリングと同じ解像度で「波面マップのサンプル値」を格子に詰め直して作る。
        // ここでは piston+tilt removed の display OPD を使用する（defocus は残す）。
        const s = Math.max(2, Math.floor(Number(psfSamplingSize)));
        // Row-major [y][x]
        const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
        const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
        const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));
        const xCoords = new Float32Array(s);
        const yCoords = new Float32Array(s);

        const pupilRange = (Number.isFinite(Number(wavefrontMap?.pupilRange)) && Number(wavefrontMap.pupilRange) > 0)
            ? Number(wavefrontMap.pupilRange)
            : 1.0;
        for (let i = 0; i < s; i++) {
            const t = (i / (s - 1 || 1)) * 2 - 1;
            xCoords[i] = t * pupilRange;
            yCoords[i] = t * pupilRange;
        }

        const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
        const opdMicrons = (wavefrontMap?.display && Array.isArray(wavefrontMap.display.opds))
            ? wavefrontMap.display.opds
            : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
        const n = Math.min(coords.length, opdMicrons.length);
        for (let k = 0; k < n; k++) {
            if ((k % 1024) === 0) {
                throwIfCancelled(cancelToken);
            }
            const c = coords[k];
            const ix = Number.isInteger(c?.ix) ? c.ix : null;
            const iy = Number.isInteger(c?.iy) ? c.iy : null;
            if (ix === null || iy === null) continue;
            if (ix < 0 || ix >= s || iy < 0 || iy >= s) continue;
            const vMicrons = Number(opdMicrons[k]);
            if (!Number.isFinite(vMicrons)) continue;
            maskGrid[iy][ix] = true;
            opdGrid[iy][ix] = vMicrons;
            ampGrid[iy][ix] = 1.0;
        }

        if (PSF_DEBUG) {
            try {
                let valid = 0;
                let sum = 0;
                let sum2 = 0;
                let min = Infinity;
                let max = -Infinity;
                for (let iy = 0; iy < s; iy++) {
                    for (let ix = 0; ix < s; ix++) {
                        if (!maskGrid[iy][ix]) continue;
                        const v = opdGrid[iy][ix];
                        if (!Number.isFinite(v)) continue;
                        valid++;
                        sum += v;
                        sum2 += v * v;
                        if (v < min) min = v;
                        if (v > max) max = v;
                    }
                }
                const mean = valid ? (sum / valid) : NaN;
                const rms = valid ? Math.sqrt(Math.max(0, sum2 / valid - mean * mean)) : NaN;
                const ptp = (Number.isFinite(min) && Number.isFinite(max)) ? (max - min) : NaN;
                const rmsW = (Number.isFinite(rms) && Number.isFinite(wavelength) && wavelength > 0) ? (rms / wavelength) : NaN;
                const ptpW = (Number.isFinite(ptp) && Number.isFinite(wavelength) && wavelength > 0) ? (ptp / wavelength) : NaN;
                console.log(`📌 [PSF] OPD grid stats: valid=${valid}/${s * s} (${(100 * valid / (s * s)).toFixed(1)}%) rms=${rms.toExponential(3)}µm (${rmsW.toExponential(3)}λ) ptp=${ptp.toExponential(3)}µm (${ptpW.toExponential(3)}λ)`);
                if (wavefrontMap?.pupilMaskStats) {
                    console.log('📌 [PSF] pupilMaskStats:', wavefrontMap.pupilMaskStats);
                }
            } catch (_) {
                // ignore
            }
        }

        const opdData = {
            gridSize: s,
            wavelength: wavelength,
            gridData: {
                opd: opdGrid,
                amplitude: ampGrid,
                pupilMask: maskGrid,
                xCoords,
                yCoords
            }
        };

        let skippedCount = 0;
        
        // PSF計算器を初期化
        const psfCalculator = await getPSFCalculatorSingleton();
        
        // PSFを計算
        // Use paraxial pupil diameter when available.
        const preferEntrancePupilForPSF = /\bangle\b/.test(objectTypeLower);
        const derivedPSFScale = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wavelength, preferEntrancePupilForPSF);
        const pupilDiameterMm = derivedPSFScale.pupilDiameterMm;
        const focalLengthMm = derivedPSFScale.focalLengthMm;

        if (PSF_DEBUG) console.log(`🔬 [PSF] PSF計算中... (${psfSamplingSize}x${psfSamplingSize}) D=${pupilDiameterMm}mm f=${focalLengthMm}mm`);
        // Zero padding selection (shared with main PSF UI).
        const zeroPadSelect = document.getElementById('psf-zeropad-select');
        const zpRaw = zeroPadSelect ? String(zeroPadSelect.value || 'auto') : 'auto';
        const zeroPadTo = (zpRaw === 'none')
            ? psfSamplingSize
            : (zpRaw === 'auto')
                ? 0
                : (Number.isFinite(parseInt(zpRaw)) ? parseInt(zpRaw) : 0);

        const psfResult = await raceWithCancel(psfCalculator.calculatePSF(opdData, {
            samplingSize: psfSamplingSize,
            pupilDiameter: pupilDiameterMm,
            focalLength: focalLengthMm,
            zeroPadTo,
            forceImplementation: performanceMode === 'auto' ? null : performanceMode,
            // Zernike render already removes piston+tilt (Noll 1..3) in eva-wavefront.js.
            // Avoid double-detrending here.
            removeTilt: false,
            onProgress: (evt) => {
                const p = Number(evt?.percent);
                const msg = evt?.message || evt?.phase || 'PSF...';
                if (!Number.isFinite(p)) {
                    emitProgress(null, evt?.phase || 'psf', msg);
                    return;
                }
                // Map PSF progress 0..100 => overall 80..100
                const overall = 80 + 0.2 * p;
                emitProgress(overall, evt?.phase || 'psf', msg);
            }
        }), cancelToken);

        throwIfCancelled(cancelToken);

        emitProgress(100, 'psf', 'PSF done');

        const extract2D = (r) => r?.psfData || r?.psf || r?.intensity || null;
        const psf2D = extract2D(psfResult);
        const psfMethod = psfResult?.metadata?.method || psfResult?.metadata?.calculator || psfResult?.implementationUsed || 'unknown';

        const summarizePSF2D = (arr) => {
            if (!arr || !Array.isArray(arr) || !Array.isArray(arr[0])) return null;
            const h = arr.length;
            const w = arr[0].length;
            let sum = 0;
            let sumX = 0;
            let sumY = 0;
            let peak = -Infinity;
            let peakX = 0;
            let peakY = 0;
            // lightweight checksum: sample every Nth element to keep it cheap
            const step = Math.max(1, Math.floor(Math.max(h, w) / 32));
            let chk = 0x811c9dc5;
            for (let y = 0; y < h; y++) {
                const row = arr[y];
                for (let x = 0; x < w; x++) {
                    const v = Number(row[x]);
                    if (!isFinite(v)) continue;
                    sum += v;
                    sumX += v * x;
                    sumY += v * y;
                    if (v > peak) {
                        peak = v;
                        peakX = x;
                        peakY = y;
                    }
                    if ((x % step === 0) && (y % step === 0)) {
                        const q = Math.max(-1e9, Math.min(1e9, v));
                        const scaled = Math.floor(q * 1e6);
                        chk ^= (scaled & 0xff);
                        chk = Math.imul(chk, 0x01000193);
                    }
                }
            }
            const cx = sum > 0 ? (sumX / sum) : null;
            const cy = sum > 0 ? (sumY / sum) : null;
            return {
                checksum: ((chk >>> 0).toString(16)),
                size: `${w}x${h}`,
                peak,
                peakXY: [peakX, peakY],
                centroidXY: [cx, cy]
            };
        };

        const psfSummary = summarizePSF2D(psf2D);

        // Attach minimal provenance so users can confirm which sampling was used.
        try {
            psfResult.metadata = psfResult.metadata || {};
            psfResult.metadata.zernikeFitSamplingSize = zernikeFitSamplingSize;
            psfResult.metadata.psfSamplingSize = psfSamplingSize;
        } catch (_) {}

        // デバッグ時のみ、入力/OPD の状態を結果に添付（console 依存せず stats に出せるように）
        if (PSF_DEBUG) {
            let opdMin = Infinity;
            let opdMax = -Infinity;
            // gridData のOPD[μm]からmin/maxを集計
            for (let ix = 0; ix < gridSize; ix++) {
                for (let iy = 0; iy < gridSize; iy++) {
                    if (!opdData?.gridData?.pupilMask?.[ix]?.[iy]) continue;
                    const v = opdData?.gridData?.opd?.[ix]?.[iy];
                    if (!isFinite(v)) continue;
                    if (v < opdMin) opdMin = v;
                    if (v > opdMax) opdMax = v;
                }
            }
            psfResult.diagnostics = {
                opticalSystemRows: opticalSystemRows.length,
                opticalSystemSource,
                opticalSystemChecksum: opticalSystemSummary.checksum,
                opticalSystemFirst: opticalSystemSummary.first,
                opticalSystemLast: opticalSystemSummary.last,
                objectIndex,
                objectType,
                objectX,
                objectY,
                wavelength,
                gridSize,
                pupilRadius,
                raysTotal: gridSize * gridSize,
                raysInsidePupil: null,
                raysUsed: null,
                raysSkipped: skippedCount,
                opdMinMicrons: isFinite(opdMin) ? opdMin : null,
                opdMaxMicrons: isFinite(opdMax) ? opdMax : null,
                psfMethod,
                psfChecksum: psfSummary?.checksum || null,
                psfSize: psfSummary?.size || null,
                psfPeakXY: psfSummary?.peakXY || null,
                psfCentroidXY: psfSummary?.centroidXY || null
            };

            const countInside = (() => {
                let c = 0;
                for (let ix = 0; ix < gridSize; ix++) {
                    for (let iy = 0; iy < gridSize; iy++) {
                        if (opdData?.gridData?.pupilMask?.[ix]?.[iy]) c++;
                    }
                }
                return c;
            })();

            console.log(
                `🧪 [PSF][diag] sys=${opticalSystemSource} n=${opticalSystemRows.length} chk=${opticalSystemSummary.checksum} obj=${objectIndex} field=(${objectX},${objectY}) OPD[μm]=${isFinite(opdMin) ? opdMin.toFixed(4) : 'n/a'}..${isFinite(opdMax) ? opdMax.toFixed(4) : 'n/a'} grid=${gridSize} inside=${countInside} skip=${skippedCount} psf=${psfSummary?.size || 'n/a'} psfChk=${psfSummary?.checksum || 'n/a'} method=${psfMethod}`
            );
        }
        
        // プロッターを初期化
        const plotter = new PSFPlotter(options?.containerElement || 'psf-container');
        
        // プロットタイプに応じて表示
        const plotOptions = {
            logScale: logScale,
            showMetrics: true,
            pixelSize: psfResult.options?.pixelSize || 1.0
        };
        
        switch (plotType) {
            case '2d':
                await plotter.plot2DPSF(psfResult, plotOptions);
                break;
            case '3d':
                await plotter.plot3DPSF(psfResult, plotOptions);
                break;
            case 'encircled':
                await plotter.plotEncircledEnergy(psfResult, plotOptions);
                break;
            default:
                await plotter.plot3DPSF(psfResult, plotOptions);
        }
        
        // 統計情報を表示
        plotter.displayStatistics(psfResult, options?.statsElement || 'psf-container-stats');

        // === Persist last PSF status for AI context / other windows ===
        // (Popup PSF uses showPSFDiagram; it does not go through handlePSFCalculation.)
        try {
            window.lastPsfResult = psfResult;
            window.lastPsfObjectData = selectedObject;
            window.lastPsfWavelength = wavelength;
            window.lastPsfGridSize = psfSamplingSize;
            window.lastPsfDebugMode = false;
            window.lastPsfError = null;

            const metrics = psfResult?.metrics || psfResult?.characteristics || null;
            const summary = {
                at: new Date().toISOString(),
                wavelength: psfResult?.wavelength ?? wavelength ?? null,
                gridSize: psfResult?.gridSize ?? psfSamplingSize ?? null,
                calculationTime: psfResult?.calculationTime ?? null,
                hasMetrics: !!metrics,
                metricKeys: metrics ? Object.keys(metrics).slice(0, 30) : [],
                objectIndex: Number.isFinite(objectIndex) ? objectIndex : null,
                zernikeFitSamplingSize: zernikeFitSamplingSize ?? null,
                performanceMode: performanceMode ?? null,
                psfMethod: psfMethod ?? null,
                psfSummary: psfSummary || null,
            };
            localStorage.setItem('lastPsfMeta', JSON.stringify(summary));
            localStorage.removeItem('lastPsfError');
        } catch (_) {}
        
        if (PSF_DEBUG) console.log('✅ [PSF] PSF表示完了');

        return psfResult;
        
    } catch (error) {
        if (error && (error.code === 'CANCELLED' || String(error.message || '').toLowerCase().includes('cancel'))) {
            console.warn('🟡 [PSF] Calculation cancelled:', error.message || error);
            return;
        }
        console.error('❌ [PSF] PSF表示エラー:', error);

        // Persist token-light error snapshot for AI context / other windows
        try {
            const rawMessage = String(error?.message || 'PSF calculation failed');
            const hintIdx = rawMessage.indexOf('hint=');
            const hint = hintIdx >= 0 ? rawMessage.slice(hintIdx + 'hint='.length).trim() : '';

            window.lastPsfError = {
                at: new Date().toISOString(),
                code: error?.code ?? null,
                message: rawMessage,
                rawMessage,
                hint,
                wavelength: (typeof wavelength !== 'undefined') ? wavelength : null,
                gridSize: (typeof psfSamplingSize !== 'undefined') ? psfSamplingSize : null,
                objectIndex: (typeof objectIndex === 'number') ? objectIndex : null,
                zernikeFitSamplingSize: (typeof zernikeFitSamplingSize !== 'undefined') ? zernikeFitSamplingSize : null,
                performanceMode: (typeof performanceMode !== 'undefined') ? performanceMode : null,
            };
            localStorage.setItem('lastPsfError', JSON.stringify(window.lastPsfError));
        } catch (_) {}
        
        // エラーメッセージを表示
        const container = options?.containerElement || document.getElementById('psf-container');
        if (container) {
            container.innerHTML = `
                <div style="color: red; text-align: center; padding: 20px;">
                    <strong>PSF計算エラー</strong><br>
                    ${error.message}<br><br>
                    <small>まずOptical Path DifferenceセクションでOPDデータを生成してください。</small>
                </div>
            `;
        }
        
        throw error;
    }
}

/**
 * MTF図表示（PSF -> OTF -> MTF）
 * - 波長選択: wavelengthMicrons
 * - フィールド選択: objectIndex
 * - 表示最大周波数: maxFrequencyLpmm
 */
async function showMTFDiagram({ wavelengthMicrons, objectIndex, maxFrequencyLpmm, samplingSize, samplingPoints, containerElement, onProgress } = {}) {
    const safeNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };

    // Match Spherical Aberration diagram color mapping.
    const getColorForWavelength = (wavelength) => {
        if (wavelength < 0.45) {
            return '#8B00FF'; // violet (380-450nm)
        } else if (wavelength < 0.495) {
            return '#0000FF'; // blue (450-495nm)
        } else if (wavelength < 0.57) {
            return '#00FF00'; // green (495-570nm)
        } else if (wavelength < 0.59) {
            return '#9ACD32'; // yellow-green (570-590nm)
        } else if (wavelength < 0.62) {
            return '#FF8800'; // orange (590-620nm)
        } else {
            return '#FF0000'; // red (620-750nm)
        }
    };

    const reportProgress = (percent, message) => {
        try {
            if (typeof onProgress !== 'function') return;
            const evt = { percent, message };
            onProgress(evt);
        } catch (_) {}
    };

    const primaryWl = (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
        ? safeNumber(window.getPrimaryWavelength(), 0.5876)
        : 0.5876;

    const isAllWavelengths = (typeof wavelengthMicrons === 'string')
        ? (String(wavelengthMicrons).toLowerCase() === 'all')
        : false;

    const wl = isAllWavelengths ? primaryWl : safeNumber(wavelengthMicrons, primaryWl);
    const objIndex = Number.isFinite(Number(objectIndex)) ? Math.max(0, Math.floor(Number(objectIndex))) : 0;
    const maxLpmm = Math.max(0, safeNumber(maxFrequencyLpmm, 100));

    const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    // samplingSize is the FFT grid size (NxN). Legacy samplingPoints is treated as alias when it looks like a valid grid size.
    const samplingCandidate = Math.floor(safeNumber(samplingSize, NaN));
    const legacyCandidate = Math.floor(safeNumber(samplingPoints, NaN));
    const gridCandidate = Number.isFinite(samplingCandidate) ? samplingCandidate : legacyCandidate;
    const gridSize = isPowerOfTwo(gridCandidate) ? clamp(gridCandidate, 32, 4096) : 256;

    const containerEl = containerElement || document.getElementById('mtf-container');
    if (!containerEl) {
        throw new Error('MTF container element not found');
    }
    try { containerEl.innerHTML = ''; } catch (_) {}

    reportProgress(0, 'Starting...');

    // Prefer Plotly from the container's window (popup), fallback to opener.
    const plotly = containerEl?.ownerDocument?.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    if (!plotly) {
        throw new Error('Plotly is not available');
    }

    reportProgress(5, 'Loading modules...');

    // Dynamic imports (reuse the same infra as PSF)
    const { createOPDCalculator } = await import('../evaluation/wavefront/wavefront.js');
    const { WavefrontAberrationAnalyzer } = await import('../evaluation/wavefront/wavefront.js');
    const { SimpleFFT } = await import('../evaluation/psf/psf-calculator.js');

    reportProgress(10, 'Preparing optical system...');

    // Optical system and objects (live table preferred)
    const opticalSystemRows = getOpticalSystemRows(window.tableOpticalSystem);
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        throw new Error('光学システムデータがありません。まず光学システムを設定してください。');
    }
    const objects = getObjectRows(window.tableObject);
    if (!objects || objects.length === 0) {
        throw new Error('オブジェクトデータがありません。まずオブジェクトを設定してください。');
    }
    if (objIndex >= objects.length) {
        throw new Error('指定されたオブジェクトが見つかりません。');
    }

    const selectedObject = objects[objIndex];
    const objectX = (selectedObject.x ?? selectedObject.xHeightAngle ?? 0);
    const objectY = (selectedObject.y ?? selectedObject.yHeightAngle ?? 0);
    const objectTypeRaw = String(selectedObject.position ?? selectedObject.object ?? selectedObject.Object ?? selectedObject.objectType ?? 'Point');
    const objectTypeLower = objectTypeRaw.toLowerCase();

    let fieldAngle = { x: 0, y: 0 };
    let xHeight = 0;
    let yHeight = 0;
    if (/\bangle\b/.test(objectTypeLower)) {
        fieldAngle = { x: safeNumber(objectX, 0), y: safeNumber(objectY, 0) };
    } else {
        xHeight = safeNumber(objectX, 0);
        yHeight = safeNumber(objectY, 0);
    }

    // Meridional/Sagittal: without directional interpolation, choose the nearest principal axis
    // based on field direction (x-dominant => meridional=x, otherwise meridional=y).
    const fieldVecRaw = (/\bangle\b/.test(objectTypeLower))
        ? { x: safeNumber(fieldAngle?.x, 0), y: safeNumber(fieldAngle?.y, 0) }
        : { x: safeNumber(xHeight, 0), y: safeNumber(yHeight, 0) };

    let tdx = fieldVecRaw.x;
    let tdy = fieldVecRaw.y;
    if (!(Math.abs(tdx) > 0 || Math.abs(tdy) > 0)) {
        tdx = 1;
        tdy = 0;
    }
    const tanAxis = (Math.abs(tdx) >= Math.abs(tdy)) ? 'x' : 'y';
    const sagAxis = (tanAxis === 'x') ? 'y' : 'x';

    const psfCalculator = await getPSFCalculatorSingleton();

    const getAllWavelengths = () => {
        try {
            const sources = getSourceRows(window.tableSource);
            const wls = [];
            for (let i = 0; i < (Array.isArray(sources) ? sources.length : 0); i++) {
                const w = Number(sources[i]?.wavelength);
                if (!Number.isFinite(w) || w <= 0) continue;
                wls.push(w);
            }
            return wls;
        } catch (_) {
            return [];
        }
    };

    const wavelengthsToPlot = isAllWavelengths ? getAllWavelengths() : [wl];
    const uniqueWavelengths = Array.from(new Set(wavelengthsToPlot.map(w => Number(w)).filter(w => Number.isFinite(w) && w > 0)));
    if (uniqueWavelengths.length === 0) uniqueWavelengths.push(primaryWl);

    const traces = [];
    let maxPlotLpmmGlobal = 0;

    const computeForWavelength = async (wlLocal, idx, total) => {
        const wlProgressBase = 10;
        const wlProgressSpan = 85;
        const localBase = wlProgressBase + (idx * wlProgressSpan / Math.max(1, total));
        const localSpan = wlProgressSpan / Math.max(1, total);

        const fieldSetting = {
            objectIndex: objIndex,
            type: objectTypeRaw,
            fieldAngle,
            xHeight,
            yHeight,
            wavelength: wlLocal
        };

        const samplingSizeForPSF = gridSize;

        const opdCalculator = createOPDCalculator(opticalSystemRows, wlLocal);
        const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);

        const titleNmLocal = (wlLocal * 1000).toFixed(1);
        reportProgress(localBase, `λ=${titleNmLocal} nm: Generating wavefront...`);

        const onWavefrontProgress = (evt) => {
            try {
                const p = Number(evt?.percent);
                const msg = evt?.message || evt?.phase || 'Generating wavefront...';
                if (Number.isFinite(p)) {
                    reportProgress(localBase + (p / 100) * (localSpan * 0.55), `λ=${titleNmLocal} nm: ${msg}`);
                } else {
                    reportProgress(undefined, `λ=${titleNmLocal} nm: ${msg}`);
                }
            } catch (_) {}
        };

        // Use the same fixed OPD definition as OPD/PSF (referenceSphere, no Zernike fit, piston+tilt removed).
        const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, samplingSizeForPSF, 'circular', {
            recordRays: false,
            progressEvery: 512,
            zernikeMaxNoll: 37,
            renderFromZernike: false,
            skipZernikeFit: true,
            opdMode: 'referenceSphere',
            opdDisplayMode: 'pistonTiltRemoved',
            onProgress: onWavefrontProgress
        });
        if (wavefrontMap?.error) {
            throw new Error(wavefrontMap.error?.message || 'Wavefront generation failed');
        }

        reportProgress(localBase + localSpan * 0.60, `λ=${titleNmLocal} nm: Building OPD grid...`);

        // Re-grid sampled wavefront values into an NxN OPD grid for PSF/MTF.
        const s = Math.max(16, Math.floor(Number(samplingSizeForPSF)));
        const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
        const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
        const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));
        const xCoords = new Float32Array(s);
        const yCoords = new Float32Array(s);

        const pupilRange = (Number.isFinite(Number(wavefrontMap?.pupilRange)) && Number(wavefrontMap.pupilRange) > 0)
            ? Number(wavefrontMap.pupilRange)
            : 1.0;
        for (let i = 0; i < s; i++) {
            const t = (i / (s - 1 || 1)) * 2 - 1;
            xCoords[i] = t * pupilRange;
            yCoords[i] = t * pupilRange;
        }

        const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
        const opdMicrons = (wavefrontMap?.display && Array.isArray(wavefrontMap.display.opds))
            ? wavefrontMap.display.opds
            : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
        const n = Math.min(coords.length, opdMicrons.length);
        for (let k = 0; k < n; k++) {
            const c = coords[k];
            const ix = Number.isInteger(c?.ix) ? c.ix : null;
            const iy = Number.isInteger(c?.iy) ? c.iy : null;
            if (ix === null || iy === null) continue;
            if (ix < 0 || ix >= s || iy < 0 || iy >= s) continue;
            const vMicrons = Number(opdMicrons[k]);
            if (!Number.isFinite(vMicrons)) continue;
            maskGrid[iy][ix] = true;
            opdGrid[iy][ix] = vMicrons;
            ampGrid[iy][ix] = 1.0;
        }

        const opdData = {
            gridSize: s,
            wavelength: wlLocal,
            gridData: {
                opd: opdGrid,
                amplitude: ampGrid,
                pupilMask: maskGrid,
                xCoords,
                yCoords
            }
        };

        // IMPORTANT: For MTF vs spatial frequency (lp/mm), keep pixelSize independent of FFT grid.
        const preferEntrancePupilForMTF = /\bangle\b/.test(objectTypeLower);
        const derivedMTFScale = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wlLocal, preferEntrancePupilForMTF);
        const pupilDiameterMm = derivedMTFScale.pupilDiameterMm;
        const focalLengthMm = derivedMTFScale.focalLengthMm;

        const pixelSizeMicronsForMTF = (pupilDiameterMm > 0)
            ? (wlLocal * focalLengthMm / pupilDiameterMm)
            : 1.0;

        reportProgress(localBase + localSpan * 0.75, `λ=${titleNmLocal} nm: Calculating PSF...`);
        const psfResult = await psfCalculator.calculatePSF(opdData, {
            samplingSize: s,
            pupilDiameter: pupilDiameterMm,
            focalLength: focalLengthMm,
            pixelSize: pixelSizeMicronsForMTF,
            forceImplementation: null,
            // OPD grid is already piston+tilt removed by opdDisplayMode.
            removeTilt: false
        });

        reportProgress(localBase + localSpan * 0.85, `λ=${titleNmLocal} nm: Computing OTF/MTF...`);

        const psf2D = psfResult?.psfData || psfResult?.psf || psfResult?.intensity || null;
        const pixelSizeMicrons = safeNumber(pixelSizeMicronsForMTF, safeNumber(psfResult?.options?.pixelSize, 1.0));
        if (!psf2D || !Array.isArray(psf2D) || !Array.isArray(psf2D[0])) {
            throw new Error('PSF data missing for MTF');
        }
        const N = psf2D.length;
        if (N < 2 || psf2D[0].length !== N) {
            throw new Error('PSF grid must be NxN');
        }

        const real = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => safeNumber(psf2D[y][x], 0)));
        const imag = Array.from({ length: N }, () => Array.from({ length: N }, () => 0));
        const otf = SimpleFFT.fft2D(real, imag);
        const dcRe = safeNumber(otf?.real?.[0]?.[0], 0);
        const dcIm = safeNumber(otf?.imag?.[0]?.[0], 0);
        const dcMag = Math.hypot(dcRe, dcIm);
        if (!Number.isFinite(dcMag) || dcMag <= 0) {
            throw new Error('Invalid OTF DC component');
        }

        const dfCyclesPerMicron = 1.0 / (N * pixelSizeMicrons);
        const dfLpmm = dfCyclesPerMicron * 1000.0;
        const nyquistLpmm = 0.5 / pixelSizeMicrons * 1000.0;
        const maxPlotLpmm = (maxLpmm > 0) ? Math.min(maxLpmm, nyquistLpmm) : nyquistLpmm;
        maxPlotLpmmGlobal = Math.max(maxPlotLpmmGlobal, maxPlotLpmm);

        const maxBin = Math.floor(N / 2);
        const kMax = Math.max(0, Math.min(maxBin, Math.floor(maxPlotLpmm / (dfLpmm || 1e-9))));

        const sample1DAxis = (axis) => {
            const freq = [];
            const mtfVals = [];
            for (let k = 0; k <= kMax; k++) {
                const f = k * dfLpmm;
                let re = 0;
                let im = 0;
                if (axis === 'x') {
                    re = safeNumber(otf.real?.[0]?.[k], 0);
                    im = safeNumber(otf.imag?.[0]?.[k], 0);
                } else {
                    re = safeNumber(otf.real?.[k]?.[0], 0);
                    im = safeNumber(otf.imag?.[k]?.[0], 0);
                }
                const mtf = Math.hypot(re, im) / dcMag;
                freq.push(f);
                mtfVals.push(Number.isFinite(mtf) ? mtf : null);
            }
            if (mtfVals.length > 0) mtfVals[0] = 1.0;
            return { freq, mtfVals };
        };

        const tan = sample1DAxis(tanAxis);
        const sag = sample1DAxis(sagAxis);

        const color = getColorForWavelength(wlLocal);
        traces.push({
            x: tan.freq,
            y: tan.mtfVals,
            type: 'scatter',
            mode: 'lines',
            name: `M (${titleNmLocal}nm)`,
            showlegend: true,
            line: { color, width: 2, dash: 'solid' }
        });
        traces.push({
            x: sag.freq,
            y: sag.mtfVals,
            type: 'scatter',
            mode: 'lines',
            name: `S (${titleNmLocal}nm)`,
            showlegend: true,
            line: { color, width: 2, dash: 'dot' }
        });
    };

    const totalWl = uniqueWavelengths.length;
    for (let i = 0; i < totalWl; i++) {
        await computeForWavelength(uniqueWavelengths[i], i, totalWl);
    }

    const titlePart = isAllWavelengths
        ? 'All wavelengths'
        : `${(wl * 1000).toFixed(1)} nm`;

    const layout = {
        title: `Modulation Transfer Function (${titlePart}, Object ${objIndex})`,
        xaxis: { title: 'Spatial frequency (lp/mm)', range: [0, maxPlotLpmmGlobal || 0] },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 50, b: 50 }
    };

    reportProgress(95, 'Rendering plot...');
    await plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
    reportProgress(100, 'Done');
}

if (typeof window !== 'undefined') {
    window.showPSFDiagram = showPSFDiagram;
    window.showMTFDiagram = showMTFDiagram;
}

/**
 * PSF Object選択肢のセットアップ
 */
function setupPSFObjectSelect() {
    if (globalThis.__PSF_DEBUG) console.log('🔄 [PSF] Object選択肢のセットアップ開始');
    
    // Object selectの初期化
    const objectSelect = document.getElementById('psf-object-select');
    if (!objectSelect) {
        if (globalThis.__PSF_DEBUG) console.warn('❌ [PSF] psf-object-select要素が見つかりません');
        return;
    }
    
    // 複数のソースからObjectデータを取得を試行
    let objects = [];
    
    // 方法1: window.getObjectRows
    if (typeof window.getObjectRows === 'function') {
        try {
            objects = window.getObjectRows();
            if (globalThis.__PSF_DEBUG) console.log('📊 [PSF] getObjectRows()からデータ取得:', objects.length, '個');
        } catch (error) {
            if (globalThis.__PSF_DEBUG) console.warn('⚠️ [PSF] getObjectRows()でエラー:', error);
        }
    }
    
    // 方法2: window.tableObject
    if ((!objects || objects.length === 0) && window.tableObject) {
        try {
            objects = window.tableObject.getData();
            if (globalThis.__PSF_DEBUG) console.log('📊 [PSF] tableObject.getData()からデータ取得:', objects.length, '個');
        } catch (error) {
            if (globalThis.__PSF_DEBUG) console.warn('⚠️ [PSF] tableObject.getData()でエラー:', error);
        }
    }
    
    // 方法3: window.objectTabulator
    if ((!objects || objects.length === 0) && window.objectTabulator) {
        try {
            objects = window.objectTabulator.getData();
            if (globalThis.__PSF_DEBUG) console.log('📊 [PSF] objectTabulator.getData()からデータ取得:', objects.length, '個');
        } catch (error) {
            if (globalThis.__PSF_DEBUG) console.warn('⚠️ [PSF] objectTabulator.getData()でエラー:', error);
        }
    }
    
    // 有効なObjectデータのみ（ただし value は「元配列のインデックス」を保持する）
    const validEntries = [];
    for (let i = 0; i < (Array.isArray(objects) ? objects.length : 0); i++) {
        const obj = objects[i];
        if (!obj || obj.id === undefined || obj.id === null) continue;
        validEntries.push({ index: i, obj });
    }
    
    // 現在の選択を保存
    const currentSelectedValue = objectSelect.value;
    const currentSelectedIndex = objectSelect.selectedIndex;
    if (globalThis.__PSF_DEBUG) console.log('🔍 [PSF] 現在の選択を保存:', { value: currentSelectedValue, index: currentSelectedIndex });
    
    // 選択肢を更新
    objectSelect.innerHTML = '';
    
    if (validEntries.length > 0) {
        validEntries.forEach((entry, displayIndex) => {
            const obj = entry.obj;
            const option = document.createElement('option');
            // IMPORTANT: keep original row index so downstream uses getObjectRows()[index]
            option.value = String(entry.index);
            
            // Object表示名を生成（座標情報含む）
            const xValue = (obj.x ?? obj.xHeightAngle ?? 0);
            const yValue = (obj.y ?? obj.yHeightAngle ?? 0);
            option.textContent = `Object ${displayIndex + 1} (${Number(xValue).toFixed(2)}, ${Number(yValue).toFixed(2)})`;
            
            objectSelect.appendChild(option);
        });
        
        // 以前の選択を復元
        if (currentSelectedValue !== null && currentSelectedValue !== '' && Array.from(objectSelect.options).some(o => o.value === currentSelectedValue)) {
            objectSelect.value = currentSelectedValue;
            if (globalThis.__PSF_DEBUG) console.log('✅ [PSF] 以前の選択を復元:', currentSelectedValue);
        } else if (currentSelectedIndex >= 0 && currentSelectedIndex < objectSelect.options.length) {
            objectSelect.selectedIndex = currentSelectedIndex;
            if (globalThis.__PSF_DEBUG) console.log('✅ [PSF] 以前の選択インデックスを復元:', currentSelectedIndex);
        }
        
        if (globalThis.__PSF_DEBUG) console.log('✅ [PSF] Object選択肢を更新:', validEntries.length, '個');
    } else {
        // デフォルトオプションを追加
        const defaultOption = document.createElement('option');
        defaultOption.value = 0;
        defaultOption.textContent = 'Object 1 (データ未設定)';
        objectSelect.appendChild(defaultOption);
        if (globalThis.__PSF_DEBUG) console.log('⚠️ [PSF] Objectデータなし、デフォルト選択肢を設定');
    }

    // 現在のObject内容シグネチャを保存（config切替などで内容が変わったか判定するため）
    try {
        const objectsNow = window.getObjectRows ? window.getObjectRows() : (window.tableObject ? window.tableObject.getData() : []);
        const validNow = Array.isArray(objectsNow)
            ? objectsNow.map((obj, i) => ({ obj, i })).filter(e => e.obj && e.obj.id !== undefined && e.obj.id !== null)
            : [];
        const signature = validNow.map(e => {
            const obj = e.obj;
            const id = obj.id;
            const x = Number(obj.x ?? obj.xHeightAngle ?? 0);
            const y = Number(obj.y ?? obj.yHeightAngle ?? 0);
            const type = obj.type ?? obj.objectType ?? '';
            return `${e.i}:${id}:${type}:${x.toFixed(6)}:${y.toFixed(6)}`;
        }).join('|');
        objectSelect.dataset.psfObjectSignature = signature;
    } catch {
        // ignore
    }
}

/**
 * PSF Object選択肢を強制更新（テーブル変更時に呼び出し）
 */
function updatePSFObjectOptions() {
    if (globalThis.__PSF_DEBUG) console.log('🔄 [PSF] Object選択肢の強制更新');
    
    const objectSelect = document.getElementById('psf-object-select');
    if (!objectSelect) {
        setupPSFObjectSelect();
        return;
    }

    const currentValue = objectSelect.value;
    const currentText = objectSelect.options[objectSelect.selectedIndex]?.text;
    if (globalThis.__PSF_DEBUG) console.log('🔍 [PSF] 更新前の選択状態:', { value: currentValue, text: currentText });

    // オプション数だけではConfig切替（同じ件数で中身が変わる）を検出できないため、内容シグネチャで判定
    let newSignature = '';
    try {
        const objects = window.getObjectRows ? window.getObjectRows() : (window.tableObject ? window.tableObject.getData() : []);
        const validObjects = Array.isArray(objects)
            ? objects.map((obj, i) => ({ obj, i })).filter(e => e.obj && e.obj.id !== undefined && e.obj.id !== null)
            : [];
        newSignature = validObjects.map(e => {
            const obj = e.obj;
            const id = obj.id;
            const x = Number(obj.x ?? obj.xHeightAngle ?? 0);
            const y = Number(obj.y ?? obj.yHeightAngle ?? 0);
            const type = obj.type ?? obj.objectType ?? '';
            return `${e.i}:${id}:${type}:${x.toFixed(6)}:${y.toFixed(6)}`;
        }).join('|');
    } catch {
        // ignore
    }

    const oldSignature = objectSelect.dataset.psfObjectSignature || '';
    if (oldSignature === newSignature && objectSelect.options.length > 0) {
        if (globalThis.__PSF_DEBUG) console.log('🔍 [PSF] Object内容が同じのため更新をスキップ');
        return;
    }

    setupPSFObjectSelect();
    objectSelect.dataset.psfObjectSignature = newSignature;
}

// 外部（Configuration切替など）から呼べるように公開
if (typeof window !== 'undefined') {
    window.updatePSFObjectOptions = updatePSFObjectOptions;
    window.setupPSFObjectSelect = setupPSFObjectSelect;

    // Debug helper: dump expanded-row provenance (_blockType/_blockId)
    window.dumpOpticalSystemProvenance = function dumpOpticalSystemProvenance(options = {}) {
        const quiet = !!options?.quiet;
        const raw = localStorage.getItem('OpticalSystemTableData');
        if (!raw) {
            if (!quiet) console.warn('No OpticalSystemTableData found');
            return { groups: {}, summary: [] };
        }

        let rows;
        try {
            rows = JSON.parse(raw);
        } catch (e) {
            if (!quiet) console.error('Failed to parse OpticalSystemTableData', e);
            return { groups: {}, summary: [] };
        }

        // --- group by _blockId ---
        /** @type {Record<string, { blockType: string, rows: Array<{ row: any, surfaceIndex: number }> }>} */
        const groups = {};
        (Array.isArray(rows) ? rows : []).forEach((row, i) => {
            const blockId = row?._blockId ?? '(none)';
            if (!groups[blockId]) {
                groups[blockId] = {
                    blockType: row?._blockType ?? '(none)',
                    rows: []
                };
            }
            groups[blockId].rows.push({ row, surfaceIndex: i });
        });

        // --- display ---
        const summary = [];

        Object.entries(groups).forEach(([blockId, g]) => {
            const count = g.rows.length;
            summary.push({
                blockId,
                blockType: g.blockType,
                surfaceCount: count
            });

            if (!quiet) {
                console.group(`Block ${blockId} : ${g.blockType} (${count} surfaces)`);
                console.table(
                    g.rows.map(({ row, surfaceIndex }) => ({
                        surfaceIndex,
                        uiIndex: surfaceIndex + 1,
                        type: row?.surfType ?? row?.type,
                        radius: row?.radius,
                        thickness: row?.thickness,
                        material: row?.material
                    }))
                );
                console.groupEnd();
            }
        });

        // --- overall summary ---
        if (!quiet) {
            console.log('Block summary:');
            console.table(summary);
        }

        // DevTools $1 用
        return { groups, summary };
    };

    window.renderBlockInspector = renderBlockInspector;
    window.refreshBlockInspector = refreshBlockInspector;

    // Dev helper: Surface edit -> Block change mapping (Apply to Design Intent)
    window.mapSurfaceEditToBlockChange = __blocks_mapSurfaceEditToBlockChange;

    // ------------------------------------------------------------
    // Dev helper: focus scan (defocus vs spot)
    // ------------------------------------------------------------
    // Usage (DevTools console):
    //   await window.__debugFocusScan({ startMm:-30, endMm:30, steps:31 })
    // Output:
    //   - defocusWaves: Noll=5 coefficient in waves (reference-sphere OPD)
    //   - spotRmsMm: geometric RMS spot radius at Image surface (same configuration)
    //   - evalSurfaceIndex: internal OPD evaluation surface index (should match imageIndex)
    window.__debugFocusScan = async (options = {}) => {
        const opts = options && typeof options === 'object' ? options : {};
        const startMm = Number.isFinite(Number(opts.startMm)) ? Number(opts.startMm) : -30;
        const endMm = Number.isFinite(Number(opts.endMm)) ? Number(opts.endMm) : 30;
        const steps = Number.isFinite(Number(opts.steps)) ? Math.max(3, Math.floor(Number(opts.steps))) : 31;
        const rayCount = Number.isFinite(Number(opts.rayCount)) ? Math.max(5, Math.floor(Number(opts.rayCount))) : 21;
        const rings = Number.isFinite(Number(opts.rings)) ? Math.max(2, Math.floor(Number(opts.rings))) : 4;
        const spokes = Number.isFinite(Number(opts.spokes)) ? Math.max(6, Math.floor(Number(opts.spokes))) : 12;

        const tbl = window.tableOpticalSystem || globalThis.tableOpticalSystem;
        const rows0 = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
        if (!Array.isArray(rows0) || rows0.length < 2) throw new Error('OpticalSystem rows not available');

        const sourceRows = (window.tableSource && typeof window.tableSource.getData === 'function') ? window.tableSource.getData() : [];
        const objectRows = (window.tableObject && typeof window.tableObject.getData === 'function') ? window.tableObject.getData() : [];

        const getPrimaryWavelength = () => {
            try {
                if (typeof window.getPrimaryWavelength === 'function') {
                    const w = Number(window.getPrimaryWavelength());
                    if (Number.isFinite(w) && w > 0) return w;
                }
            } catch (_) {}
            // fallback: classic d line
            return 0.5876;
        };

        const wavelength = Number.isFinite(Number(opts.wavelengthUm)) ? Number(opts.wavelengthUm) : getPrimaryWavelength();
        const objRow0 = Array.isArray(objectRows) && objectRows.length > 0 ? objectRows[0] : {};

        const isInfinite = (() => {
            const t0 = rows0[0]?.thickness;
            if (t0 === Infinity) return true;
            const s = String(t0 ?? '').trim();
            return /^inf(inity)?$/i.test(s);
        })();

        // Center field
        const fieldSetting = (() => {
            try {
                // imported from ../analysis/optical-analysis.js
                if (typeof createFieldSettingFromObject === 'function') {
                    return createFieldSettingFromObject(objRow0, 0, isInfinite);
                }
            } catch (_) {}
            return isInfinite
                ? { type: 'infinite', fieldAngle: { x: 0, y: 0 }, displayName: 'center' }
                : { type: 'finite', xHeight: 0, yHeight: 0, displayName: 'center' };
        })();

        const findImageIndex = (rows) => {
            let lastImageIndex = -1;
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const surfType = String(r?.surfType ?? r?.['surf type'] ?? r?.surfTypeName ?? '').toLowerCase();
                const objectType = String(r?.['object type'] ?? r?.object ?? r?.Object ?? '').toLowerCase();
                const comment = String(r?.comment ?? r?.Comment ?? '').toLowerCase();
                if (surfType.includes('image') || objectType.includes('image') || comment.includes('image')) lastImageIndex = i;
            }
            return lastImageIndex >= 0 ? lastImageIndex : (rows.length - 1);
        };

        const imageIndex0 = findImageIndex(rows0);
        const preImageIndex0 = Math.max(0, imageIndex0 - 1);
        const baseThickness = (() => {
            const v = rows0?.[preImageIndex0]?.thickness;
            const n = Number.parseFloat(String(v ?? '0'));
            return Number.isFinite(n) ? n : 0;
        })();

        const sampleUnitDisk = () => {
            /** @type {{x:number,y:number}[]} */
            const pts = [];
            pts.push({ x: 0, y: 0 });
            for (let ir = 1; ir <= rings; ir++) {
                const r = ir / rings;
                for (let it = 0; it < spokes; it++) {
                    const t = (2 * Math.PI * it) / spokes;
                    pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
                }
            }
            return pts;
        };

        const calcWavefrontMetrics = async (rows) => {
            const { createOPDCalculator, WavefrontAberrationAnalyzer } = await import('../evaluation/wavefront/wavefront.js');
            const opdCalculator = createOPDCalculator(rows, wavelength);
            const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);
            try {
                opdCalculator.setReferenceRay(fieldSetting);
            } catch (e) {
                return { defocusWaves: NaN, sphericalWaves: NaN, wfeRmsWavesPT: NaN, wfeRmsWavesPTD: NaN, opdSampleCount: 0, evalSurfaceIndex: opdCalculator?.evaluationSurfaceIndex ?? null, error: e };
            }

            const pts = sampleUnitDisk();
            const pupilCoordinates = [];
            const opds = [];
            const tryOpts = [{ fastMarginalRay: true }, { fastMarginalRay: false }];

            for (const o of tryOpts) {
                pupilCoordinates.length = 0;
                opds.length = 0;
                for (const p of pts) {
                    let opd = NaN;
                    try {
                        opd = opdCalculator.calculateOPDReferenceSphere(p.x, p.y, fieldSetting, false, o);
                    } catch (_) {
                        opd = NaN;
                    }
                    if (!Number.isFinite(opd)) continue;
                    pupilCoordinates.push({ x: p.x, y: p.y, r: Math.sqrt(p.x * p.x + p.y * p.y) });
                    opds.push(opd);
                }
                if (pupilCoordinates.length >= 6) break;
            }

            if (pupilCoordinates.length < 6) {
                return {
                    defocusWaves: NaN,
                    sphericalWaves: NaN,
                    wfeRmsWavesPT: NaN,
                    wfeRmsWavesPTD: NaN,
                    opdSampleCount: pupilCoordinates.length,
                    evalSurfaceIndex: opdCalculator?.evaluationSurfaceIndex ?? null,
                    error: new Error('insufficient-valid-opd-samples')
                };
            }

            const wavefrontMap = { pupilCoordinates, opds };

            const readCoeff = (coeffObj, j) => {
                if (!coeffObj) return NaN;
                const v = (typeof coeffObj.get === 'function') ? coeffObj.get(j) : (coeffObj[j] ?? coeffObj[String(j)]);
                return Number.isFinite(Number(v)) ? Number(v) : NaN;
            };

            const rmsResidualWaves = (removedModelMicrons) => {
                if (!Array.isArray(removedModelMicrons) || removedModelMicrons.length !== opds.length) return NaN;
                const wl = wavelength;
                if (!(Number.isFinite(wl) && wl > 0)) return NaN;
                let sum2 = 0;
                let count = 0;
                for (let i = 0; i < opds.length; i++) {
                    const opd = opds[i];
                    const model = removedModelMicrons[i];
                    if (!Number.isFinite(opd) || !Number.isFinite(model)) continue;
                    const residWaves = (opd - model) / wl;
                    sum2 += residWaves * residWaves;
                    count++;
                }
                return count > 0 ? Math.sqrt(sum2 / count) : NaN;
            };

            const getFitWithRemoved = (removeList) => {
                let prev = undefined;
                try { prev = globalThis.__WAVEFRONT_REMOVE_NOLL; } catch (_) {}
                try { globalThis.__WAVEFRONT_REMOVE_NOLL = Array.isArray(removeList) ? removeList : []; } catch (_) {}
                try {
                    return analyzer.fitZernikePolynomials(wavefrontMap, 15);
                } finally {
                    try {
                        if (prev === undefined) {
                            delete globalThis.__WAVEFRONT_REMOVE_NOLL;
                        } else {
                            globalThis.__WAVEFRONT_REMOVE_NOLL = prev;
                        }
                    } catch (_) {}
                }
            };

            // Full coefficients (for defocus/spherical) are returned regardless of removed model.
            const fitPT = getFitWithRemoved([1, 2, 3]);
            const fitPTD = getFitWithRemoved([1, 2, 3, 5]);

            const defocusWaves = readCoeff(fitPT?.coefficientsWaves, 5);
            // NOTE: In this codebase, Noll index mapping is sequential in m for each n:
            //   j0=n(n+1)/2+1, m=-n,-n+2,...,n.
            // Thus spherical (n=4,m=0) is j=13 (not 11).
            const sphericalWaves = readCoeff(fitPT?.coefficientsWaves, 13);
            const wfeRmsWavesPT = rmsResidualWaves(fitPT?.removedModelMicrons);
            const wfeRmsWavesPTD = rmsResidualWaves(fitPTD?.removedModelMicrons);

            return {
                defocusWaves,
                sphericalWaves,
                wfeRmsWavesPT,
                wfeRmsWavesPTD,
                opdSampleCount: pupilCoordinates.length,
                evalSurfaceIndex: opdCalculator?.evaluationSurfaceIndex ?? null
            };
        };

        const calcSpotRmsMm = async (rows, imageIndex) => {
            const positionsFinite = [{ x: 0, y: 0, z: 0 }];
            const anglesInf = [{ x: 0, y: 0 }];

            let crossBeamResult = null;
            if (isInfinite && typeof window.generateInfiniteSystemCrossBeam === 'function') {
                crossBeamResult = await window.generateInfiniteSystemCrossBeam(rows, anglesInf, {
                    rayCount,
                    debugMode: false,
                    wavelength,
                    crossType: 'both',
                    angleUnit: 'deg',
                    chiefZ: -20,
                    targetSurfaceIndex: imageIndex
                });
            } else if (!isInfinite && typeof window.generateCrossBeam === 'function') {
                crossBeamResult = await window.generateCrossBeam(rows, positionsFinite, {
                    rayCount,
                    debugMode: false,
                    wavelength,
                    crossType: 'both'
                });
            }

            /** @type {{x:number,y:number}[]} */
            const pts = [];
            if (crossBeamResult) {
                if (Array.isArray(crossBeamResult.rays) && crossBeamResult.rays.length > 0) {
                    for (const ray of crossBeamResult.rays) {
                        const p = ray?.rayPath?.[imageIndex];
                        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push({ x: p.x, y: p.y });
                    }
                } else if (Array.isArray(crossBeamResult.objectResults)) {
                    for (const obj of crossBeamResult.objectResults) {
                        const traced = Array.isArray(obj?.tracedRays) ? obj.tracedRays : [];
                        for (const ray of traced) {
                            const p = ray?.rayPath?.[imageIndex];
                            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push({ x: p.x, y: p.y });
                        }
                    }
                }
            }

            if (pts.length === 0) return NaN;
            let sum = 0;
            for (const p of pts) sum += (p.x * p.x + p.y * p.y);
            return Math.sqrt(sum / pts.length);
        };

        const results = [];
        for (let k = 0; k < steps; k++) {
            const t = steps === 1 ? 0 : (k / (steps - 1));
            const delta = startMm + (endMm - startMm) * t;
            const rows = rows0.map(r => (r && typeof r === 'object') ? { ...r } : r);

            // Move image plane by adjusting spacing into the Image surface.
            const newTh = baseThickness + delta;
            if (rows[preImageIndex0] && typeof rows[preImageIndex0] === 'object') {
                rows[preImageIndex0].thickness = newTh;
            }

            const imageIndex = findImageIndex(rows);
            const wf = await calcWavefrontMetrics(rows);
            const spot = await calcSpotRmsMm(rows, imageIndex);

            const strehlFromSigmaWaves = (sigmaWaves) => {
                const s = Number(sigmaWaves);
                if (!Number.isFinite(s) || s < 0) return NaN;
                // Maréchal approximation: S ≈ exp(-(2πσ)^2), σ in waves RMS
                const a = 2 * Math.PI * s;
                const st = Math.exp(-(a * a));
                return Number.isFinite(st) ? Math.max(0, Math.min(1, st)) : NaN;
            };

            results.push({
                deltaMm: delta,
                preImageThicknessMm: newTh,
                imageIndex,
                evalSurfaceIndex: wf.evalSurfaceIndex,
                defocusWaves: wf.defocusWaves,
                sphericalWaves: wf.sphericalWaves,
                wfeRmsWavesPT: wf.wfeRmsWavesPT,
                wfeRmsWavesPTD: wf.wfeRmsWavesPTD,
                strehlPT: strehlFromSigmaWaves(wf.wfeRmsWavesPT),
                strehlPTD: strehlFromSigmaWaves(wf.wfeRmsWavesPTD),
                opdSampleCount: wf.opdSampleCount,
                spotRmsMm: spot
            });
        }

        const finite = (v) => Number.isFinite(Number(v));
        const bestDef = results
            .filter(r => finite(r.defocusWaves))
            .slice()
            .sort((a, b) => Math.abs(a.defocusWaves) - Math.abs(b.defocusWaves))[0] || null;
        const bestSpot = results
            .filter(r => finite(r.spotRmsMm))
            .slice()
            .sort((a, b) => a.spotRmsMm - b.spotRmsMm)[0] || null;

        const bestWfePTD = results
            .filter(r => finite(r.wfeRmsWavesPTD))
            .slice()
            .sort((a, b) => a.wfeRmsWavesPTD - b.wfeRmsWavesPTD)[0] || null;

        const bestStrehlPTD = results
            .filter(r => finite(r.strehlPTD))
            .slice()
            .sort((a, b) => b.strehlPTD - a.strehlPTD)[0] || null;

        console.table(results.map(r => ({
            deltaMm: Number(r.deltaMm.toFixed(3)),
            preImgT: Number(r.preImageThicknessMm.toFixed(3)),
            defocusWaves: finite(r.defocusWaves) ? Number(r.defocusWaves.toFixed(6)) : null,
            sphericalWaves: finite(r.sphericalWaves) ? Number(r.sphericalWaves.toFixed(6)) : null,
            wfeRmsWavesPT: finite(r.wfeRmsWavesPT) ? Number(r.wfeRmsWavesPT.toFixed(6)) : null,
            wfeRmsWavesPTD: finite(r.wfeRmsWavesPTD) ? Number(r.wfeRmsWavesPTD.toFixed(6)) : null,
            strehlPT: finite(r.strehlPT) ? Number(r.strehlPT.toFixed(6)) : null,
            strehlPTD: finite(r.strehlPTD) ? Number(r.strehlPTD.toFixed(6)) : null,
            log10StrehlPT: finite(r.strehlPT) && r.strehlPT > 0 ? Number(Math.log10(r.strehlPT).toFixed(3)) : null,
            log10StrehlPTD: finite(r.strehlPTD) && r.strehlPTD > 0 ? Number(Math.log10(r.strehlPTD).toFixed(3)) : null,
            opdSamples: Number.isFinite(Number(r.opdSampleCount)) ? Number(r.opdSampleCount) : null,
            spotRmsMm: finite(r.spotRmsMm) ? Number(r.spotRmsMm.toFixed(6)) : null,
            imageIndex: r.imageIndex,
            evalSurfaceIndex: r.evalSurfaceIndex
        })));

        console.log('🧪 [FocusScan] wl(um)=', wavelength, 'isInfinite=', isInfinite, 'imageIndex0=', imageIndex0, 'preImageIndex0=', preImageIndex0, 'baseThickness(mm)=', baseThickness);
        console.log('🧪 [FocusScan] bestDefocus≈0 at delta(mm)=', bestDef?.deltaMm, 'defocusWaves=', bestDef?.defocusWaves);
        console.log('🧪 [FocusScan] bestSpot(min RMS) at delta(mm)=', bestSpot?.deltaMm, 'spotRmsMm=', bestSpot?.spotRmsMm);
        console.log('🧪 [FocusScan] bestWfePTD(min) at delta(mm)=', bestWfePTD?.deltaMm, 'wfeRmsWavesPTD=', bestWfePTD?.wfeRmsWavesPTD);
        console.log('🧪 [FocusScan] bestStrehlPTD(max) at delta(mm)=', bestStrehlPTD?.deltaMm, 'strehlPTD=', bestStrehlPTD?.strehlPTD);
        if (bestDef && bestSpot) {
            console.log('🧪 [FocusScan] separation(mm)=', (bestSpot.deltaMm - bestDef.deltaMm));
        }

        return { results, bestDefocus: bestDef, bestSpot, bestWfePTD, bestStrehlPTD };
    };
}

// System Configuration管理モジュール
// 複数のConfigurationを保存・切り替え可能にする

const STORAGE_KEY = "systemConfigurations";

// 初期Configuration構造
function createDefaultConfiguration(id, name) {
    const defaultBlocks = [
        {
            blockId: 'ObjectSurface-1',
            blockType: 'ObjectSurface',
            role: null,
            constraints: {},
            parameters: {
                objectDistanceMode: 'INF'
            },
            variables: {},
            metadata: { source: 'default' }
        },
        {
            blockId: 'Stop-1',
            blockType: 'Stop',
            role: null,
            constraints: {},
            parameters: {
                semiDiameter: DEFAULT_STOP_SEMI_DIAMETER
            },
            variables: {},
            metadata: { source: 'default' }
        },
        {
            blockId: 'ImageSurface-1',
            blockType: 'ImageSurface',
            role: null,
            constraints: {},
            parameters: undefined,
            variables: {},
            metadata: { source: 'default' }
        }
    ];

  return {
    id: id,
    name: name,
        // Block schema (canonical). Empty array means "no blocks yet" but still editable.
        schemaVersion: BLOCK_SCHEMA_VERSION,
        blocks: defaultBlocks,
    source: [],
    object: [],
    opticalSystem: [],
    meritFunction: [],
    metadata: {
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      optimizationTarget: null,  // 将来のAI最適化用
      locked: false
    }
  };
}

// システム全体のConfiguration状態を管理
const defaultSystemConfig = {
  configurations: [
    createDefaultConfiguration(1, "Config 1")
  ],
  activeConfigId: 1,
  optimizationRules: {}  // フェーズ4用（空で準備）
};

// localStorageからConfiguration全体を読み込み
export function loadSystemConfigurations() {
  console.log('🔵 [Configuration] Loading system configurations from localStorage...');
  const json = localStorage.getItem(STORAGE_KEY);
  
  if (json) {
    try {
      const parsed = JSON.parse(json);
      console.log('🔵 [Configuration] Loaded configurations:', parsed.configurations.length);
      return parsed;
    } catch (e) {
      console.warn('⚠️ [Configuration] Parse error:', e);
      console.warn("Configuration読み込みに失敗しました。デフォルトを使用します。");
    }
  }
  
  console.log('🔵 [Configuration] Using default system config');
  return defaultSystemConfig;
}

// Configuration全体を保存
export function saveSystemConfigurations(systemConfig) {
  console.log('🔵 [Configuration] Saving system configurations...');
  if (systemConfig && systemConfig.configurations) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(systemConfig));
    console.log(`💾 [Configuration] Saved ${systemConfig.configurations.length} configurations`);
  } else {
    console.warn('⚠️ [Configuration] Invalid system config, not saving:', systemConfig);
  }
}

// アクティブなConfigurationを取得
export function getActiveConfiguration() {
  const systemConfig = loadSystemConfigurations();
  const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
  
  if (!activeConfig) {
    console.warn('⚠️ [Configuration] Active config not found, using first');
    return systemConfig.configurations[0];
  }
  
  return activeConfig;
}

// アクティブなConfiguration IDを取得
export function getActiveConfigId() {
  const systemConfig = loadSystemConfigurations();
  return systemConfig.activeConfigId;
}

// アクティブなConfigurationを変更
export function setActiveConfiguration(configId) {
  const systemConfig = loadSystemConfigurations();
  const config = systemConfig.configurations.find(c => c.id === configId);
  
  if (!config) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  systemConfig.activeConfigId = configId;
  saveSystemConfigurations(systemConfig);
  console.log(`✅ [Configuration] Active config changed to: ${config.name}`);
  return true;
}

// 現在のテーブルデータをアクティブなConfigurationに保存
export function saveCurrentToActiveConfiguration() {
  console.log('🔵 [Configuration] Saving current table data to active configuration...');
  
  const systemConfig = loadSystemConfigurations();
  const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
  
  if (!activeConfig) {
    console.error('❌ [Configuration] Active config not found');
    return;
  }
  
  // 各テーブルからデータを取得
    // Source is global (shared across configurations). Persist it separately.
    try {
        const globalSource = window.tableSource ? window.tableSource.getData() : [];
        localStorage.setItem('sourceTableData', JSON.stringify(globalSource));
    } catch (_) {}
  activeConfig.object = window.tableObject ? window.tableObject.getData() : [];
  activeConfig.opticalSystem = window.tableOpticalSystem ? window.tableOpticalSystem.getData() : [];
  activeConfig.meritFunction = window.meritFunctionEditor ? window.meritFunctionEditor.getData() : [];
  
  // メタデータ更新
  activeConfig.metadata.modified = new Date().toISOString();
  
  // designer情報が存在しない場合はデフォルト値で初期化
  if (!activeConfig.metadata.designer) {
    activeConfig.metadata.designer = {
      type: "human",
      name: "user",
      confidence: null
    };
  }
  
  saveSystemConfigurations(systemConfig);
  console.log(`✅ [Configuration] Saved to: ${activeConfig.name}`);
}

// アクティブなConfigurationのデータをlocalStorageに展開（各テーブル用）
export function loadActiveConfigurationToTables() {
  console.log('🔵 [Configuration] Loading active configuration to tables...');
  
  const activeConfig = getActiveConfiguration();
  
  if (!activeConfig) {
    console.error('❌ [Configuration] No active config found');
    return;
  }
  
  // 各テーブルのlocalStorageに書き込み
    // Source is global. Do not override it on configuration switches.
    // Back-compat: if global source is missing but config has legacy source, seed it once.
    try {
        const hasGlobal = !!localStorage.getItem('sourceTableData');
        const legacy = Array.isArray(activeConfig.source) ? activeConfig.source : null;
        if (!hasGlobal && legacy && legacy.length > 0) {
            localStorage.setItem('sourceTableData', JSON.stringify(legacy));
        }
    } catch (_) {}
  if (activeConfig.object) {
    localStorage.setItem('objectTableData', JSON.stringify(activeConfig.object));
  }
  if (activeConfig.opticalSystem) {
    localStorage.setItem('OpticalSystemTableData', JSON.stringify(activeConfig.opticalSystem));
  }
  if (activeConfig.meritFunction) {
    localStorage.setItem('meritFunctionData', JSON.stringify(activeConfig.meritFunction));
  }
  
  console.log(`✅ [Configuration] Loaded: ${activeConfig.name}`);
}

// 新しいConfigurationを追加
export function addConfiguration(name) {
  const systemConfig = loadSystemConfigurations();
  
  // 新しいID生成（最大ID + 1）
  const maxId = Math.max(...systemConfig.configurations.map(c => c.id), 0);
  const newId = maxId + 1;
  
  const newConfig = createDefaultConfiguration(newId, name);
  
  // 現在のアクティブなConfigurationのデータをコピー
  const activeConfig = getActiveConfiguration();
  if (activeConfig) {
    newConfig.object = JSON.parse(JSON.stringify(activeConfig.object));
    newConfig.opticalSystem = JSON.parse(JSON.stringify(activeConfig.opticalSystem));
    newConfig.meritFunction = JSON.parse(JSON.stringify(activeConfig.meritFunction));
  }
  
  systemConfig.configurations.push(newConfig);
  saveSystemConfigurations(systemConfig);
  
  console.log(`✅ [Configuration] Added new configuration: ${name} (ID: ${newId})`);
  return newId;
}

// Configurationを削除
export function deleteConfiguration(configId) {
  const systemConfig = loadSystemConfigurations();
  
  // 最後の1つは削除不可
  if (systemConfig.configurations.length <= 1) {
    console.warn('⚠️ [Configuration] Cannot delete last configuration');
    return false;
  }
  
  const index = systemConfig.configurations.findIndex(c => c.id === configId);
  
  if (index === -1) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  const configName = systemConfig.configurations[index].name;
  systemConfig.configurations.splice(index, 1);
  
  // アクティブなConfigurationが削除された場合、最初のConfigurationをアクティブに
  if (systemConfig.activeConfigId === configId) {
    systemConfig.activeConfigId = systemConfig.configurations[0].id;
    console.log(`🔄 [Configuration] Active config changed to: ${systemConfig.configurations[0].name}`);
  }
  
  saveSystemConfigurations(systemConfig);
  console.log(`✅ [Configuration] Deleted configuration: ${configName}`);
  return true;
}

// Configurationを複製
export function duplicateConfiguration(configId) {
  const systemConfig = loadSystemConfigurations();
  const sourceConfig = systemConfig.configurations.find(c => c.id === configId);
  
  if (!sourceConfig) {
    console.error('❌ [Configuration] Config not found:', configId);
    return null;
  }
  
  // 新しいID生成
  const maxId = Math.max(...systemConfig.configurations.map(c => c.id), 0);
  const newId = maxId + 1;
  
  // 完全なコピーを作成
  const newConfig = JSON.parse(JSON.stringify(sourceConfig));
  newConfig.id = newId;
  newConfig.name = `${sourceConfig.name} (Copy)`;
  newConfig.metadata.created = new Date().toISOString();
  newConfig.metadata.modified = new Date().toISOString();
  
  systemConfig.configurations.push(newConfig);
  saveSystemConfigurations(systemConfig);
  
  console.log(`✅ [Configuration] Duplicated configuration: ${newConfig.name} (ID: ${newId})`);
  return newId;
}

// Configuration名を変更
export function renameConfiguration(configId, newName) {
  const systemConfig = loadSystemConfigurations();
  const config = systemConfig.configurations.find(c => c.id === configId);
  
  if (!config) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  const oldName = config.name;
  config.name = newName;
  config.metadata.modified = new Date().toISOString();
  
  saveSystemConfigurations(systemConfig);
  console.log(`✅ [Configuration] Renamed: ${oldName} → ${newName}`);
  return true;
}

// 全Configuration一覧を取得（テーブル表示用）
export function getConfigurationList() {
  const systemConfig = loadSystemConfigurations();
  return systemConfig.configurations.map(c => ({
    id: c.id,
    name: c.name,
    active: c.id === systemConfig.activeConfigId,
    created: c.metadata.created,
    modified: c.metadata.modified,
    locked: c.metadata.locked
  }));
}

// グローバルにエクスポート
if (typeof window !== 'undefined') {
    // NOTE: table-configuration.js also exports window.ConfigurationManager.
    // Do not clobber it (it supports applyToUI refresh). Only fill missing methods.
    const prev = window.ConfigurationManager;
    const base = (prev && typeof prev === 'object') ? prev : {};
    window.ConfigurationManager = {
        ...base,
        loadSystemConfigurations: base.loadSystemConfigurations || loadSystemConfigurations,
        saveSystemConfigurations: base.saveSystemConfigurations || saveSystemConfigurations,
        getActiveConfiguration: base.getActiveConfiguration || getActiveConfiguration,
        getActiveConfigId: base.getActiveConfigId || getActiveConfigId,
        setActiveConfiguration: base.setActiveConfiguration || setActiveConfiguration,
        saveCurrentToActiveConfiguration: base.saveCurrentToActiveConfiguration || saveCurrentToActiveConfiguration,
        // Prefer existing loadActiveConfigurationToTables (applyToUI-capable)
        loadActiveConfigurationToTables: base.loadActiveConfigurationToTables || loadActiveConfigurationToTables,
        addConfiguration: base.addConfiguration || addConfiguration,
        deleteConfiguration: base.deleteConfiguration || deleteConfiguration,
        duplicateConfiguration: base.duplicateConfiguration || duplicateConfiguration,
        renameConfiguration: base.renameConfiguration || renameConfiguration,
        getConfigurationList: base.getConfigurationList || getConfigurationList,
    };
}

// Optimizer integration (Blocks is canonical): expose a small API for future optimization loop.
// UI does not use this directly; it is for debugging / future optimizer wiring.
try {
    if (typeof window !== 'undefined') {
        window.BlockDesignVariables = {
            listActive: () => {
                const cfg = getActiveConfiguration();
                return listDesignVariablesFromBlocks(cfg);
            },
            setActiveValue: (variableId, newValue) => {
                const systemConfig = (typeof loadSystemConfigurationsFromTableConfig === 'function')
                    ? loadSystemConfigurationsFromTableConfig()
                    : null;
                if (!systemConfig || !Array.isArray(systemConfig.configurations)) return false;
                const activeId = systemConfig.activeConfigId;
                const activeCfg = systemConfig.configurations.find(c => c && c.id === activeId) || systemConfig.configurations[0];
                if (!activeCfg) return false;

                const ok = setDesignVariableValue(activeCfg, variableId, newValue);
                if (!ok) return false;

                try {
                    if (!activeCfg.metadata) activeCfg.metadata = {};
                    activeCfg.metadata.modified = new Date().toISOString();
                } catch (_) {}

                if (typeof saveSystemConfigurationsFromTableConfig === 'function') {
                    saveSystemConfigurationsFromTableConfig(systemConfig);
                }

                try { refreshBlockInspector(); } catch (_) {}
                return true;
            }
        };
    }
} catch (_) {}

// =============================================================================
// Blocks / Apply-to-Design-Intent + Block Inspector (override clean)
// =============================================================================

function __blocks_isAutoOrInfValue(v) {
    const s = String(v ?? '').trim();
    if (s === '') return true;
    if (/^inf(inity)?$/i.test(s)) return true;
    if (/^(a|auto|u)$/i.test(s)) return true;
    return false;
}

function __blocks_isAutoOrBlankValue(v) {
    const s = String(v ?? '').trim();
    if (s === '') return true;
    if (/^(a|auto|u)$/i.test(s)) return true;
    return false;
}

function __blocks_isInfValue(v) {
    const s = String(v ?? '').trim();
    return /^inf(inity)?$/i.test(s);
}

function __blocks_explainSurfaceEditMappingFailure(edit) {
    try {
        const row = edit?.row;
        if (!row || typeof row !== 'object') return 'row missing';
        const blockId = row._blockId;
        const blockType = __blocks_normalizeProvenanceBlockType(row._blockType);
        const role = __blocks_normalizeRole(row._surfaceRole);
        const field = __blocks_normalizeEditedFieldKey(edit?.field);
        const oldValue = edit?.oldValue;
        const newValue = edit?.newValue;

        if (!blockId || blockId === '(none)') return 'missing provenance: _blockId';
        if (!blockType) return 'missing provenance: _blockType';
        if (!role) return 'missing provenance: _surfaceRole';
        if (!field) return 'field missing';
        if (oldValue === newValue) return 'no-op (oldValue === newValue)';
        if (__blocks_isAutoOrBlankValue(newValue)) return 'AUTO/blank value not mappable';
        if (__blocks_isInfValue(newValue) && field !== 'radius') return 'INF only allowed for radius';

        return 'field not supported or role mismatch';
    } catch (_) {
        return 'unknown mapping error';
    }
}

function __blocks_normalizeProvenanceBlockType(raw) {
    const s = String(raw ?? '').trim();
    if (s === '') return '';
    const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
    if (key === 'lens' || key === 'positivelens' || key === 'singlet') return 'Lens';
    if (key === 'doublet' || key === 'cementeddoublet') return 'Doublet';
    if (key === 'triplet' || key === 'cementedtriplet') return 'Triplet';
    if (key === 'stop' || key === 'aperturestop' || key === 'aperture') return 'Stop';
    if (key === 'mirror' || key === 'mir' || key === 'reflector') return 'Mirror';
    if (key === 'gap' || key === 'airgap' || key === 'space' || key === 'air') return 'Gap';
    if (key === 'imagesurface' || key === 'image') return 'ImageSurface';
    return s;
}

function __blocks_normalizeRole(raw) {
    const s = String(raw ?? '').trim();
    if (s === '') return '';
    return s.toLowerCase();
}

function __blocks_normalizeEditedFieldKey(field) {
    const s = String(field ?? '').trim();
    if (!s) return '';
    const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
    // Optimization flags (expanded surface table)
    if (key === 'optimizer') return 'optimizeR';
    if (key === 'optimizet') return 'optimizeT';
    if (key === 'optimizematerial') return 'optimizeMaterial';
    if (key === 'optimizesemidia' || key === 'optimizesemidiameter') return 'optimizeSemiDia';
    if (key === 'surftype' || key === 'type') return 'surftype';
    if (key === 'radius') return 'radius';
    if (key === 'thickness') return 'thickness';
    if (key === 'material' || key === 'glass') return 'material';
    if (key === 'conic') return 'conic';
    if (key === 'semidia' || key === 'semidiameter' || key === 'semidia(mm)') return 'semidia';
    const m = /^coef(\d+)$/.exec(key);
    if (m) return `coef${m[1]}`;
    return key;
}

function __blocks_parseSurfaceIndexFromRole(role) {
    const m = /^s(\d+)$/.exec(String(role ?? '').trim().toLowerCase());
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 1 ? n : null;
}

function __blocks_findFollowingAirGapBlockId(ownerBlockId) {
    try {
        const activeCfg = getActiveConfiguration();
        const blocks = activeCfg && Array.isArray(activeCfg.blocks) ? activeCfg.blocks : null;
        if (!blocks || blocks.length === 0) return null;

        const id = String(ownerBlockId ?? '').trim().toLowerCase();
        if (!id) return null;
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            if (!b || typeof b !== 'object') continue;
            if (String(b.blockId ?? '').trim().toLowerCase() !== id) continue;
            const next = blocks[i + 1];
            if (next && typeof next === 'object') {
                const nt = String(next.blockType ?? '').trim();
                if (nt === 'Gap' || nt === 'AirGap') {
                    const nextId = String(next.blockId ?? '').trim();
                    return nextId || null;
                }
            }
            return null;
        }
        return null;
    } catch (_) {
        return null;
    }
}

function __blocks_autoCreateFollowingAirGap(ownerBlockId, thickness) {
    try {
        console.log(`   [DEBUG] ownerBlockId=${ownerBlockId}, thickness=${thickness}`);
        // IMPORTANT: mutate and persist the same systemConfig instance.
        // If we mutate an activeCfg returned by getActiveConfiguration(), then loadSystemConfigurations() again
        // and save that fresh object, the inserted AirGap will be lost.
        const systemConfig = loadSystemConfigurations();
        const activeCfg = systemConfig && Array.isArray(systemConfig.configurations)
            ? systemConfig.configurations.find(c => c && String(c.id) === String(systemConfig.activeConfigId))
            : null;
        console.log(`   [DEBUG] activeCfg=`, activeCfg ? 'found' : 'null');
        const blocks = activeCfg && Array.isArray(activeCfg.blocks) ? activeCfg.blocks : null;
        console.log(`   [DEBUG] blocks=`, blocks ? `array[${blocks.length}]` : 'null');
        if (!activeCfg || !blocks || blocks.length === 0) {
            console.error('   Cannot auto-create Gap: activeCfg/blocks not found');
            return null;
        }

        // Generate unique Gap ID (legacy: AirGap-*)
        let maxNum = 0;
        for (const b of blocks) {
            if (!b || typeof b !== 'object' || !b.blockId) continue;
            const bt = String(b.blockType ?? '').trim();
            if (!(bt === 'Gap' || bt === 'AirGap')) continue;
            const idRaw = String(b.blockId).trim();
            const m = /^(?:Gap|AirGap)-(\d+)$/i.exec(idRaw);
            if (!m) continue;
            const num = Number(m[1]);
            if (Number.isFinite(num) && num > maxNum) maxNum = num;
        }
        const newGapId = `Gap-${maxNum + 1}`;
        console.log(`   [DEBUG] Generated newGapId=${newGapId}`);

        // Find insertion index
        const id = String(ownerBlockId ?? '').trim().toLowerCase();
        let insertIndex = -1;
        for (let i = 0; i < blocks.length; i++) {
            if (blocks[i] && String(blocks[i].blockId ?? '').trim().toLowerCase() === id) {
                insertIndex = i + 1;
                break;
            }
        }
        console.log(`   [DEBUG] insertIndex=${insertIndex}`);
        if (insertIndex < 0) {
            console.error(`   Cannot auto-create Gap: owner block ${ownerBlockId} not found`);
            return null;
        }

        // Create new Gap block
        const newGap = {
            blockId: newGapId,
            blockType: 'Gap',
            role: null,
            constraints: {},
            parameters: {
                thickness: thickness,
                material: 'AIR'
            },
            variables: {},
            metadata: { source: 'auto-create', after: String(ownerBlockId ?? '') }
        };
        console.log(`   [DEBUG] Created newGap object:`, newGap);

        // Insert into blocks array
        blocks.splice(insertIndex, 0, newGap);
        console.log(`   [DEBUG] Inserted into blocks array at index ${insertIndex}`);

        // Persist to localStorage
        try {
            console.log(`   [DEBUG] Saving systemConfig, configurations.length=${systemConfig?.configurations?.length}`);
            saveSystemConfigurations(systemConfig);
            console.log(`   [DEBUG] Saved systemConfig to localStorage`);
        } catch (err) {
            console.error('   Failed to persist auto-created AirGap to localStorage:', err);
        }

        console.log(`   ✅ Auto-created ${newGapId} with thickness=${thickness} after ${ownerBlockId}`);
        return newGapId;
    } catch (err) {
        console.error('   Error in __blocks_autoCreateFollowingAirGap:', err);
        return null;
    }
}

function formatBlockPreview(block) {
    const b = block && typeof block === 'object' ? block : null;
    if (!b) return '';

    const pick = (key) => {
        const pObj = (b.parameters && typeof b.parameters === 'object') ? b.parameters : null;
        const fromParam = pObj ? pObj[key] : undefined;
        if (fromParam !== undefined && fromParam !== null && String(fromParam).trim() !== '') return fromParam;
        const vObj = (b.variables && typeof b.variables === 'object') ? b.variables : null;
        const fromVar = vObj && vObj[key] && typeof vObj[key] === 'object' ? vObj[key].value : undefined;
        if (fromVar !== undefined && fromVar !== null && String(fromVar).trim() !== '') return fromVar;
        return '';
    };

    const toFiniteNumberOrNull = (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        const s = String(v ?? '').trim();
        if (s === '') return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    };

    const normalizeSurfTypeShort = (v) => {
        const s = String(v ?? '').trim();
        if (s === '') return '';
        const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
        if (key === 'spherical') return 'Sph';
        if (key === 'asphericeven' || key === 'asphericaleven') return 'Even';
        if (key === 'asphericodd' || key === 'asphericalodd') return 'Odd';
        return s;
    };

    const summarizeAsphere = (surfTypeKey, conicKey, coefPrefix) => {
        const st = pick(surfTypeKey);
        const conic = pick(conicKey);
        const conicN = toFiniteNumberOrNull(conic);

        /** @type {number[]} */
        const nz = [];
        for (let i = 1; i <= 10; i++) {
            const v = pick(`${coefPrefix}${i}`);
            const n = toFiniteNumberOrNull(v);
            if (n !== null && Math.abs(n) > 0) nz.push(i);
        }

        const stShort = normalizeSurfTypeShort(st);
        const isNonSpherical = stShort && stShort !== 'Sph';
        const hasConic = conicN !== null && Math.abs(conicN) > 0;
        const hasCoefs = nz.length > 0;
        if (!isNonSpherical && !hasConic && !hasCoefs) return '';

        const parts = [];
        if (stShort) parts.push(`ST=${stShort}`);
        if (hasConic) parts.push(`K=${String(conic)}`);
        if (hasCoefs) parts.push(`coefNZ=${nz.length}(${nz.join(',')})`);
        return parts.join(' ');
    };

    const type = String(b.blockType ?? '');
    if (type === 'Lens' || type === 'PositiveLens') {
        const r1 = pick('frontRadius');
        const r2 = pick('backRadius');
        const ct = pick('centerThickness');
        const mat = pick('material');

        const frontAs = summarizeAsphere('frontSurfType', 'frontConic', 'frontCoef');
        const backAs = summarizeAsphere('backSurfType', 'backConic', 'backCoef');

        const parts = [];
        if (String(r1) !== '') parts.push(`R1=${String(r1)}`);
        if (String(r2) !== '') parts.push(`R2=${String(r2)}`);
        if (String(ct) !== '') parts.push(`CT=${String(ct)}`);
        if (String(mat) !== '') parts.push(`G=${String(mat)}`);
        if (frontAs) parts.push(`F[${frontAs}]`);
        if (backAs) parts.push(`B[${backAs}]`);
        return parts.join(' ');
    }

    if (type === 'Doublet' || type === 'Triplet') {
        const elemCount = (type === 'Doublet') ? 2 : 3;
        const surfCount = elemCount + 1;
        const parts = [];

        /** @type {string[]} */
        const r = [];
        for (let si = 1; si <= surfCount; si++) {
            const v = pick(`radius${si}`);
            if (String(v) !== '') r.push(String(v));
        }
        if (r.length > 0) parts.push(`R=[${r.join(',')}]`);

        /** @type {string[]} */
        const t = [];
        /** @type {string[]} */
        const m = [];
        for (let ei = 1; ei <= elemCount; ei++) {
            const tv = pick(`thickness${ei}`);
            const mv = pick(`material${ei}`);
            if (String(tv) !== '') t.push(String(tv));
            if (String(mv) !== '') m.push(String(mv));
        }
        if (t.length > 0) parts.push(`T=[${t.join(',')}]`);
        if (m.length > 0) parts.push(`G=[${m.join(',')}]`);

        /** @type {string[]} */
        const as = [];
        for (let si = 1; si <= surfCount; si++) {
            const a = summarizeAsphere(`surf${si}SurfType`, `surf${si}Conic`, `surf${si}Coef`);
            if (a) as.push(`${si}:${a}`);
        }
        if (as.length > 0) parts.push(`Asph{${as.join(' | ')}}`);
        return parts.join(' ');
    }

    if (type === 'Gap' || type === 'AirGap') {
        const th = pick('thickness');
        const mat = pick('material');
        const parts = [];
        if (String(th) !== '') parts.push(`T=${String(th)}`);
        if (String(mat) !== '' && String(mat).trim().toUpperCase() !== 'AIR') parts.push(`M=${String(mat)}`);
        return parts.join(' ');
    }

    if (type === 'ObjectSurface') {
        const modeRaw = pick('objectDistanceMode');
        const mode = String(modeRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
        if (mode === 'INF' || mode === 'INFINITY') return 'INF';
        const d = pick('objectDistance');
        return String(d) !== '' ? `D=${String(d)}` : '';
    }

    if (type === 'Stop') {
        const sd = pick('semiDiameter');
        return String(sd) !== '' ? `SD=${String(sd)}` : '';
    }

    if (type === 'CoordTrans') {
        const dx = pick('decenterX');
        const dy = pick('decenterY');
        const dz = pick('decenterZ');
        const tx = pick('tiltX');
        const ty = pick('tiltY');
        const tz = pick('tiltZ');
        const order = pick('order');

        const parts = [];
        if (String(dx) !== '' || String(dy) !== '' || String(dz) !== '') parts.push(`D=[${String(dx)},${String(dy)},${String(dz)}]`);
        if (String(tx) !== '' || String(ty) !== '' || String(tz) !== '') parts.push(`T=[${String(tx)},${String(ty)},${String(tz)}]`);
        if (String(order) !== '') parts.push(`order=${String(order)}`);
        return parts.join(' ');
    }

    return '';
}

let __blockInspectorExpandedBlockId = null;

// Remembers which material key (material/material1/material2/...) the user last interacted with
// for each expanded blockId, so the toolbar "Find Glass" targets the correct field.
const __blockInspectorPreferredMaterialKeyByBlockId = new Map();

let __blocks_lastScopeErrors = [];

function __blocks_generateUniqueBlockId(blocks, baseType) {
    const base = String(baseType ?? '').trim();
    if (!Array.isArray(blocks) || !base) return `${base}-1`;
    let maxNum = 0;
    const re = new RegExp(`^${base.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}-(\\d+)$`, 'i');
    for (const b of blocks) {
        const id = b && typeof b === 'object' ? String(b.blockId ?? '').trim() : '';
        const m = re.exec(id);
        if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
    }
    return `${base}-${maxNum + 1}`;
}

function __blocks_makeDefaultBlock(blockType, blockId) {
    const type = String(blockType ?? '').trim();
    const id = String(blockId ?? '').trim();
    const base = {
        blockId: id,
        blockType: type,
        role: null,
        constraints: {},
        parameters: {},
        variables: {},
        metadata: { source: 'ui-add' }
    };

    if (type === 'Lens' || type === 'PositiveLens') {
        base.parameters = {
            frontRadius: 'INF',
            backRadius: 'INF',
            centerThickness: 1,
            material: 'N-BK7'
        };
        return base;
    }
    if (type === 'Doublet') {
        base.parameters = {
            radius1: 'INF',
            radius2: 'INF',
            radius3: 'INF',
            thickness1: 1,
            thickness2: 1,
            material1: 'N-BK7',
            material2: 'N-F2'
        };
        return base;
    }
    if (type === 'Triplet') {
        base.parameters = {
            radius1: 'INF',
            radius2: 'INF',
            radius3: 'INF',
            radius4: 'INF',
            thickness1: 1,
            thickness2: 1,
            thickness3: 1,
            material1: 'N-BK7',
            material2: 'N-F2',
            material3: 'N-BK7'
        };
        return base;
    }
    if (type === 'Gap' || type === 'AirGap') {
        base.blockType = 'Gap';
        base.parameters = { thickness: 1, material: 'AIR', thicknessMode: '' };
        return base;
    }
    if (type === 'ObjectSurface') {
        base.parameters = {
            objectDistanceMode: 'Finite',
            objectDistance: 100
        };
        return base;
    }
    if (type === 'Stop') {
        base.parameters = { semiDiameter: DEFAULT_STOP_SEMI_DIAMETER };
        return base;
    }
    if (type === 'Mirror') {
        base.parameters = {
            radius: 'INF',
            thickness: 10,
            material: 'MIRROR',
            surfType: 'Spherical',
            conic: 0,
            coef1: 0,
            coef2: 0,
            coef3: 0,
            coef4: 0,
            coef5: 0,
            coef6: 0,
            coef7: 0,
            coef8: 0,
            coef9: 0,
            coef10: 0,
            apertureShape: 'Circular',
            semidia: 10,
            apertureWidth: 20,
            apertureHeight: 20
        };
        return base;
    }
    if (type === 'CoordTrans') {
        base.parameters = {
            decenterX: 0,
            decenterY: 0,
            decenterZ: 0,
            tiltX: 0,
            tiltY: 0,
            tiltZ: 0,
            order: 0
        };
        return base;
    }
    if (type === 'ImageSurface') {
        // Optional parameters supported: semidia + optimizeSemiDia.
        base.parameters = {
            semidia: '',
            optimizeSemiDia: ''
        };
        // Keep variables absent (ImageSurface is not a design variable).
        delete base.variables;
        return base;
    }

    // Fallback: keep empty parameters to satisfy validation rule for non-ImageSurface.
    base.parameters = {};
    return base;
}

function __blocks_addBlockToActiveConfig(blockType, insertAfterBlockId = null) {
    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return { ok: false, reason: 'systemConfigurations not found.' };

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex(c => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };
    const blocks = activeCfg.blocks;

    const type = String(blockType ?? '').trim();
    if (!type) return { ok: false, reason: 'blockType is required.' };

    if (type === 'ImageSurface') {
        const already = blocks.some(b => b && String(b.blockType ?? '').trim() === 'ImageSurface');
        if (already) return { ok: false, reason: 'ImageSurface already exists (only one is supported).' };
    }

    if (type === 'ObjectSurface') {
        const already = blocks.some(b => b && String(b.blockType ?? '').trim() === 'ObjectSurface');
        if (already) return { ok: false, reason: 'ObjectSurface already exists (only one is supported).' };
    }

    const newId = __blocks_generateUniqueBlockId(blocks, type);
    const newBlock = __blocks_makeDefaultBlock(type, newId);

    // Insert position: after selected block, but never after ImageSurface.
    let imageIdx = blocks.findIndex(b => b && String(b.blockType ?? '').trim() === 'ImageSurface');
    if (imageIdx < 0) imageIdx = blocks.length;

    let insertIdx = imageIdx; // default: before ImageSurface (or end)

    // ObjectSurface defines the object-to-first-surface distance; keep it first since there is no reorder UI.
    if (type === 'ObjectSurface') {
        insertIdx = 0;
    }
    const afterId = String(insertAfterBlockId ?? '').trim();
    if (afterId) {
        const idx = blocks.findIndex(b => b && String(b.blockId ?? '').trim() === afterId);
        if (idx >= 0) insertIdx = Math.min(idx + 1, imageIdx);
    }

    blocks.splice(insertIdx, 0, newBlock);

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    // Validate whole config; if fatal, rollback.
    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) {
            blocks.splice(insertIdx, 1);
            try { showLoadErrors(issues, { filename: '(active config)' }); } catch (_) {}
            return { ok: false, reason: 'block validation failed.' };
        }
    } catch (_) {
        // ignore
    }

    try {
        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
        } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        }
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true, blockId: newId };
}

function __blocks_deleteBlockFromActiveConfig(blockId) {
    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return { ok: false, reason: 'systemConfigurations not found.' };

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex(c => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };
    const blocks = activeCfg.blocks;

    const id = String(blockId ?? '').trim();
    if (!id) return { ok: false, reason: 'blockId is required.' };

    const idx = blocks.findIndex(b => b && String(b.blockId ?? '').trim() === id);
    if (idx < 0) return { ok: false, reason: `block not found: ${id}` };

    const type = String(blocks[idx]?.blockType ?? '').trim();
    if (type === 'ImageSurface') return { ok: false, reason: 'ImageSurface cannot be deleted.' };

    const removed = blocks.splice(idx, 1);

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    // Validate whole config; if fatal, rollback.
    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) {
            blocks.splice(idx, 0, ...(removed || []));
            try { showLoadErrors(issues, { filename: '(active config)' }); } catch (_) {}
            return { ok: false, reason: 'block validation failed.' };
        }
    } catch (_) {
        // ignore
    }

    // Sync expanded optical system with updated blocks so Save/export won't reintroduce deleted surfaces.
    try {
        const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
        if (expanded && Array.isArray(expanded.rows)) {
            activeCfg.opticalSystem = expanded.rows;
            try { localStorage.setItem('OpticalSystemTableData', JSON.stringify(expanded.rows)); } catch (_) {}
            try { if (typeof saveLensTableData === 'function') saveLensTableData(expanded.rows); } catch (_) {}
            try {
                if (window.tableOpticalSystem && typeof window.tableOpticalSystem.setData === 'function') {
                    window.tableOpticalSystem.setData(expanded.rows);
                }
            } catch (_) {}
        }
    } catch (_) {}

    try {
        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
        } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        }
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true };
}

function __blocks_setExpandedOpticalSystemUIVisible(visible) {
    try {
        const header = document.querySelector('.expanded-optical-system-header');
        const content = document.getElementById('expanded-optical-system-content');
        if (header) header.style.display = visible ? '' : 'none';
        if (content) content.style.display = visible ? '' : 'none';
    } catch (_) {}
}

function __blocks_coerceParamValue(blockType, key, raw) {
    const s = String(raw ?? '').trim();

    // Allow blank to mean "unset" for optional fields.
    if (s === '') return '';

    // Special-case: ImageSurface.optimizeSemiDia uses a single-letter token 'A'
    // (not the generic 'AUTO' token used elsewhere).
    if (String(key ?? '') === 'optimizeSemiDia') {
        if (/^(a|auto|u)$/i.test(s)) return 'A';
        return s;
    }

    // Common tokens
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    if (/^(a|auto|u)$/i.test(s)) return 'AUTO';

    // Materials and surf types are strings
    if (/^material\d*$/i.test(key) || /^material$/i.test(key)) return s;
    if (/^apertureshape$/i.test(key)) return s;
    if (/surftype$/i.test(key)) return s;

    // Numeric: parse when possible
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    return s;
}

function __blocks_setBlockParamValue(blockId, key, rawValue) {
    console.log(`[Undo] __blocks_setBlockParamValue called: blockId=${blockId}, key=${key}, rawValue=${rawValue}`);
    console.log(`[Undo] window.SetBlockParameterCommand exists:`, !!window.SetBlockParameterCommand);
    console.log(`[Undo] window.undoHistory exists:`, !!window.undoHistory);
    
    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return { ok: false, reason: 'systemConfigurations not found.' };

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex(c => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };

    const b = activeCfg.blocks.find(x => x && String(x.blockId ?? '') === String(blockId));
    if (!b) return { ok: false, reason: `block not found: ${String(blockId)}` };

    // If this key is marked as Shared (all configs), propagate the value edit across all configs.
    // (Previously only numeric values were synced; string parameters like SurfType were not.)
    try {
        const vars = (b.variables && typeof b.variables === 'object') ? b.variables : null;
        const entry = vars ? vars[String(key)] : null;
        if (__blocks_getVarScope(entry) === 'global') {
            return __blocks_setBlockParamValueAllConfigs(blockId, key, rawValue);
        }
    } catch (_) {}

    if (!b.parameters || typeof b.parameters !== 'object') b.parameters = {};

    const coerced = __blocks_coerceParamValue(String(b.blockType ?? ''), String(key ?? ''), rawValue);
    
    // Record undo command
    const oldValue = b.parameters[String(key)];
    const newValue = coerced;
    if (oldValue !== newValue && window.undoHistory && !window.undoHistory.isExecuting) {
        console.log(`[Undo] Recording block param change: ${blockId}.${key} from ${oldValue} to ${newValue}`);
        const cmd = new SetBlockParameterCommand(activeId, blockId, `parameters.${String(key)}`, oldValue, newValue);
        window.undoHistory.record(cmd);
    } else {
        console.log(`[Undo] Not recording: oldValue=${oldValue}, newValue=${newValue}, undoHistory=${!!window.undoHistory}, isExecuting=${window.undoHistory?.isExecuting}`);
    }
    
    b.parameters[String(key)] = coerced;

    // If SurfType was explicitly set to Spherical, auto-clear any leftover asphere params.
    // This prevents a mismatch where "Spherical" is selected but non-zero conic/coefs
    // would otherwise keep the surface aspheric via inference.
    try {
        const k = String(key ?? '');
        const isSurfTypeKey = /surftype$/i.test(k);
        const v = String(coerced ?? '').trim();
        const isExplicitSpherical = /^spherical$/i.test(v);
        if (isSurfTypeKey && isExplicitSpherical) {
            /** @type {string|null} */
            let conicKey = null;
            /** @type {string|null} */
            let coefPrefix = null;

            if (k === 'frontSurfType') { conicKey = 'frontConic'; coefPrefix = 'frontCoef'; }
            else if (k === 'backSurfType') { conicKey = 'backConic'; coefPrefix = 'backCoef'; }
            else {
                const m = /^surf(\d+)SurfType$/i.exec(k);
                if (m) {
                    conicKey = `surf${m[1]}Conic`;
                    coefPrefix = `surf${m[1]}Coef`;
                }
            }

            if (conicKey) b.parameters[conicKey] = 0;
            if (coefPrefix) {
                for (let i = 1; i <= 10; i++) b.parameters[`${coefPrefix}${i}`] = 0;
            }
        }
    } catch (_) {}

    // Basic validation: don't persist obviously invalid Stop.semiDiameter
    if (String(b.blockType ?? '') === 'Stop' && String(key) === 'semiDiameter') {
        const n = (typeof coerced === 'number') ? coerced : Number(String(coerced ?? '').trim());
        if (!Number.isFinite(n) || n <= 0) {
            return { ok: false, reason: `Stop.semiDiameter must be positive: ${String(rawValue)}` };
        }
    }

    // Validate whole config; if fatal, abort.
    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) {
            try { showLoadErrors(issues, { filename: '(active config)' }); } catch (_) {}
            return { ok: false, reason: 'block validation failed.' };
        }
    } catch (_) {
        // If validation throws, still attempt to save the edit.
    }

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
        } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        }
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true };
}

function __blocks_setBlockParamValueAllConfigs(blockId, key, rawValue) {
    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return { ok: false, reason: 'systemConfigurations not found.' };

    const id = String(blockId ?? '').trim();
    const k = String(key ?? '').trim();
    if (!id) return { ok: false, reason: 'blockId is required.' };
    if (!k) return { ok: false, reason: 'key is required.' };

    /** @type {Array<{configId:string, configName?:string}>} */
    const missing = [];
    /** @type {Map<string, any>} */
    const prevByConfigId = new Map();

    try {
        for (const cfg of (systemConfig.configurations || [])) {
            if (!cfg || !Array.isArray(cfg.blocks)) {
                missing.push({ configId: String(cfg?.id ?? '(none)'), configName: cfg?.name });
                continue;
            }
            const b = cfg.blocks.find(x => x && String(x.blockId ?? '') === id);
            if (!b) {
                missing.push({ configId: String(cfg?.id ?? '(none)'), configName: cfg?.name });
                continue;
            }
            if (!b.parameters || typeof b.parameters !== 'object') b.parameters = {};
            const prev = b.parameters[k];
            const coerced = __blocks_coerceParamValue(String(b.blockType ?? ''), k, rawValue);
            b.parameters[k] = coerced;
            prevByConfigId.set(String(cfg?.id ?? ''), prev);
        }
    } catch (e) {
        return { ok: false, reason: `failed to apply: ${e?.message || String(e)}` };
    }

    if (missing.length > 0) {
        // Roll back any changes.
        try {
            for (const cfg of (systemConfig.configurations || [])) {
                if (!cfg || !Array.isArray(cfg.blocks)) continue;
                const b = cfg.blocks.find(x => x && String(x.blockId ?? '') === id);
                if (!b || !b.parameters || typeof b.parameters !== 'object') continue;
                const cid = String(cfg?.id ?? '');
                if (prevByConfigId.has(cid)) b.parameters[k] = prevByConfigId.get(cid);
            }
        } catch (_) {}
        return {
            ok: false,
            reason: `Cannot apply to all configs because block is missing: ${id}.${k} / missing in ${missing.length} config(s)`
        };
    }

    // Validate each config; if fatal, rollback that config.
    try {
        for (const cfg of (systemConfig.configurations || [])) {
            if (!cfg || !Array.isArray(cfg.blocks)) continue;
            const issues = validateBlocksConfiguration(cfg);
            const fatals = issues.filter(i => i && i.severity === 'fatal');
            if (fatals.length > 0) {
                // rollback mutated key
                try {
                    for (const cfg2 of (systemConfig.configurations || [])) {
                        if (!cfg2 || !Array.isArray(cfg2.blocks)) continue;
                        const cid2 = String(cfg2?.id ?? '');
                        if (!prevByConfigId.has(cid2)) continue;
                        const b2 = cfg2.blocks.find(x => x && String(x.blockId ?? '') === id);
                        if (!b2 || !b2.parameters || typeof b2.parameters !== 'object') continue;
                        b2.parameters[k] = prevByConfigId.get(cid2);
                    }
                } catch (_) {}
                try { showLoadErrors(issues, { filename: '(systemConfigurations)' }); } catch (_) {}
                return { ok: false, reason: 'block validation failed.' };
            }
        }
    } catch (_) {
        // ignore
    }

    try {
        for (const cfg of (systemConfig.configurations || [])) {
            if (!cfg) continue;
            if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
            cfg.metadata.modified = new Date().toISOString();
        }
    } catch (_) {}

    try {
        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
        } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        }
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true };
}

function __blocks_getSystemRequirementsData() {
    try {
        if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.getData === 'function') {
            const d = window.systemRequirementsEditor.getData();
            if (Array.isArray(d)) return d;
        }
    } catch (_) {}
    try {
        const json = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemRequirementsData') : null;
        const d = json ? JSON.parse(json) : null;
        return Array.isArray(d) ? d : [];
    } catch (_) {}
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        if (systemConfig && Array.isArray(systemConfig.systemRequirements)) return systemConfig.systemRequirements;
    } catch (_) {}
    return [];
}

function __blocks_findRequirementTarget(operand, configId) {
    const op = String(operand ?? '').trim().toUpperCase();
    const cid = String(configId ?? '').trim();
    const reqs = __blocks_getSystemRequirementsData();
    for (const r of (reqs || [])) {
        if (!r || typeof r !== 'object') continue;
        if (r.enabled === false || String(r.enabled ?? '').trim().toLowerCase() === 'false') continue;
        const rop = String(r.operand ?? '').trim().toUpperCase();
        if (rop !== op) continue;
        const rcid = String(r.configId ?? '').trim();
        if (rcid !== '' && cid !== '' && rcid !== cid) continue;
        const tRaw = r.target;
        const n = (typeof tRaw === 'number') ? tRaw : Number(String(tRaw ?? '').trim());
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function __blocks_coerceApertureValue(raw) {
    const s = String(raw ?? '').trim();

    // Blank means unset.
    if (s === '') return '';

    // Allow AUTO/Auto as a special token (meaning: no semidia limit).
    if (/^(a|auto|u)$/i.test(s)) return 'AUTO';

    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (n <= 0) return '';
    return n;
}

function __blocks_setBlockApertureValue(blockId, role, rawValue) {
    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return { ok: false, reason: 'systemConfigurations not found.' };

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex(c => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };

    const b = activeCfg.blocks.find(x => x && String(x.blockId ?? '') === String(blockId));
    if (!b) return { ok: false, reason: `block not found: ${String(blockId)}` };

    if (!b.aperture || typeof b.aperture !== 'object') b.aperture = {};
    const r = String(role ?? '').trim();
    if (!r) return { ok: false, reason: 'role is required.' };

    const coerced = __blocks_coerceApertureValue(rawValue);
    
    // Record undo command
    const oldValue = b.aperture[r];
    const newValue = (String(coerced ?? '').trim() === '') ? undefined : coerced;
    console.log(`[Undo] Aperture change: ${blockId}.aperture.${r} from ${oldValue} to ${newValue}`);
    console.log(`[Undo] Check: oldValue !== newValue = ${oldValue !== newValue}, undoHistory = ${!!window.undoHistory}, isExecuting = ${window.undoHistory?.isExecuting}`);
    if (oldValue !== newValue && window.undoHistory && !window.undoHistory.isExecuting) {
        console.log(`[Undo] Recording aperture command`);
        const cmd = new SetBlockParameterCommand(activeId, blockId, `aperture.${r}`, oldValue, newValue);
        window.undoHistory.record(cmd);
    } else {
        console.log(`[Undo] NOT recording aperture command`);
    }
    
    if (String(coerced ?? '').trim() === '') {
        // Unset
        try { delete b.aperture[r]; } catch (_) { b.aperture[r] = ''; }
    } else {
        b.aperture[r] = coerced;
    }

    // Validate whole config; if fatal, abort.
    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) {
            try { showLoadErrors(issues, { filename: '(active config)' }); } catch (_) {}
            return { ok: false, reason: 'block validation failed.' };
        }
    } catch (_) {
        // ignore
    }

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
        } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        }
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true };
}

function __blocks_shouldMarkVar(v) {
    if (!v || typeof v !== 'object') return false;
    const mode = v?.optimize?.mode;
    return mode === 'V' || mode === true;
}

function __blocks_getVarScope(v) {
    try {
        const s = String(v?.optimize?.scope ?? '').trim();
        if (s === 'global' || s === 'shared') return 'global';
        if (s === 'perConfig' || s === 'local' || s === 'per-config') return 'perConfig';
    } catch (_) {}
    return 'perConfig';
}

function __blocks_setVarScope(blockId, key, scope) {
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;

        const activeId = systemConfig.activeConfigId;
        const cfgIdx = systemConfig.configurations.findIndex(c => c && c.id === activeId);
        if (cfgIdx < 0) return;

        const activeCfg = systemConfig.configurations[cfgIdx];
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) return;

        const b = activeCfg.blocks.find(x => x && String(x.blockId ?? '') === String(blockId));
        if (!b) return;

        if (!b.variables || typeof b.variables !== 'object') b.variables = {};
        if (!b.variables[key] || typeof b.variables[key] !== 'object') b.variables[key] = { value: b.parameters?.[key] ?? '' };
        if (!b.variables[key].optimize || typeof b.variables[key].optimize !== 'object') b.variables[key].optimize = {};
        b.variables[key].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

        try {
            if (typeof saveSystemConfigurations === 'function') {
                saveSystemConfigurations(systemConfig);
            } else if (typeof localStorage !== 'undefined') {
                localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
            }
        } catch (_) {}
    } catch (_) {}
}

function __blocks_setVarMode(blockId, key, enabled, scope = 'perConfig') {
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;

        /** @type {Array<{configId:string, configName?:string}>} */
        const missing = [];

        const activeId = systemConfig.activeConfigId;
        const targets = (scope === 'global')
            ? (systemConfig.configurations || [])
            : [systemConfig.configurations.find(c => c && c.id === activeId) || systemConfig.configurations[0]];

        // If making a variable global/shared, prefer syncing numeric parameter values across configs
        // to avoid inconsistent starting states (which can look like "doesn't converge").
        let sharedNumericValue = null;
        if (enabled && scope === 'global') {
            try {
                const activeCfg0 = systemConfig.configurations.find(c => c && c.id === activeId);
                const b0 = activeCfg0 && Array.isArray(activeCfg0.blocks)
                    ? activeCfg0.blocks.find(x => x && String(x.blockId ?? '') === String(blockId))
                    : null;
                const raw0 = b0?.parameters?.[key] ?? b0?.variables?.[key]?.value;
                const n0 = (typeof raw0 === 'number') ? raw0 : Number(String(raw0 ?? '').trim());
                if (Number.isFinite(n0)) sharedNumericValue = n0;
            } catch (_) {}
        }

        for (const cfg of targets) {
            if (!cfg || !Array.isArray(cfg.blocks)) {
                missing.push({ configId: String(cfg?.id ?? '(none)'), configName: cfg?.name });
                continue;
            }
            const b = cfg.blocks.find(x => x && String(x.blockId ?? '') === String(blockId));
            if (!b) {
                missing.push({ configId: String(cfg?.id ?? '(none)'), configName: cfg?.name });
                continue;
            }

            if (!b.variables || typeof b.variables !== 'object') b.variables = {};
            if (!b.variables[key] || typeof b.variables[key] !== 'object') b.variables[key] = { value: b.parameters?.[key] ?? '' };
            if (!b.variables[key].optimize || typeof b.variables[key].optimize !== 'object') b.variables[key].optimize = {};
            b.variables[key].optimize.mode = enabled ? 'V' : 'F';
            b.variables[key].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

            // Sync numeric value when switching to global.
            if (sharedNumericValue !== null && scope === 'global') {
                try {
                    if (!b.parameters || typeof b.parameters !== 'object') b.parameters = {};
                    b.parameters[key] = sharedNumericValue;
                    if (b.variables[key] && typeof b.variables[key] === 'object' && Object.prototype.hasOwnProperty.call(b.variables[key], 'value')) {
                        b.variables[key].value = sharedNumericValue;
                    }
                } catch (_) {}
            }
        }

        __blocks_lastScopeErrors = missing.length > 0
            ? [{
                blockId: String(blockId),
                key: String(key),
                scope: String(scope),
                missing
            }]
            : [];

        try {
            if (typeof saveSystemConfigurations === 'function') {
                saveSystemConfigurations(systemConfig);
            } else if (typeof localStorage !== 'undefined') {
                localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
            }
        } catch (_) {}
    } catch (_) {}
}

function renderBlockInspector(summary, groups, blockById = null, blocksInOrder = null) {
    const container = document.getElementById('block-inspector');
    if (!container) return;

    container.innerHTML = '';

    try {
        if (Array.isArray(__blocks_lastScopeErrors) && __blocks_lastScopeErrors.length > 0) {
            const e0 = __blocks_lastScopeErrors[0];
            const miss = Array.isArray(e0?.missing) ? e0.missing : [];
            const names = miss.slice(0, 6).map(m => m?.configName ? `${String(m.configName)}(${String(m.configId)})` : String(m?.configId ?? '')).filter(Boolean);
            const banner = document.createElement('div');
            banner.style.padding = '8px 10px';
            banner.style.margin = '6px 0 10px 0';
            banner.style.border = '1px solid #f2c2c2';
            banner.style.background = '#fff5f5';
            banner.style.color = '#8a1f1f';
            banner.style.borderRadius = '6px';
            banner.style.fontSize = '12px';
            banner.textContent = `ERROR: Cannot apply “Shared (all configs)” because this Block is missing in some configurations: ${String(e0?.blockId ?? '')}.${String(e0?.key ?? '')} / missing in ${miss.length} config(s): ${names.join(', ')}${miss.length > names.length ? ', ...' : ''}`;
            container.appendChild(banner);
        }
    } catch (_) {}
    const list = Array.isArray(summary) ? summary : [];
    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.style.padding = '8px';
        empty.style.fontSize = '13px';
        empty.style.color = '#666';
        empty.textContent = 'No blocks (or no provenance).';
        container.appendChild(empty);
        return;
    }

    // Compute per-block surface index ranges from the expanded Optical System.
    // Requirements operands that accept S1/S2 refer to these surface numbers.
    /** @type {Map<string, {min:number, max:number}>} */
    const surfRangeByBlockId = new Map();
    try {
        if (Array.isArray(blocksInOrder) && blocksInOrder.length > 0 && typeof expandBlocksToOpticalSystemRows === 'function') {
            const exp = expandBlocksToOpticalSystemRows(blocksInOrder);
            const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const bid = String(r?._blockId ?? '').trim();
                if (!bid) continue;
                // Surface numbering convention here: Surf 0 = Object (row 0), then surfaces follow.
                // So expanded row index i maps directly to Surf i.
                const surfNo = i;
                const prev = surfRangeByBlockId.get(bid);
                if (!prev) surfRangeByBlockId.set(bid, { min: surfNo, max: surfNo });
                else {
                    if (surfNo < prev.min) prev.min = surfNo;
                    if (surfNo > prev.max) prev.max = surfNo;
                }
            }
        }
    } catch (_) {
        // ignore
    }

    const formatSingletonBlockLabel = (blockType, blockIdRaw) => {
        const t = String(blockType ?? '').trim();
        const id = String(blockIdRaw ?? '').trim();
        if (t === 'ObjectSurface' || t === 'ImageSurface') return t;
        const m = /^(ObjectSurface|ImageSurface)-\d+$/i.exec(id);
        if (m) return m[1];
        return id || '(none)';
    };

    // UI display label mapping: keep internal blockId stable for references,
    // but show human-friendly sequential names in the block list.
    /** @type {Map<string, string>} */
    const displayLabelByBlockId = new Map();
    try {
        const counts = new Map();
        const blocks = Array.isArray(blocksInOrder) ? blocksInOrder : [];
        for (const bb of blocks) {
            if (!bb || typeof bb !== 'object') continue;
            const realId = String(bb.blockId ?? '').trim();
            if (!realId) continue;
            const tRaw = String(bb.blockType ?? '').trim();
            if (!tRaw) continue;

            // Singletons: show without numbering.
            if (tRaw === 'ObjectSurface' || tRaw === 'ImageSurface') {
                displayLabelByBlockId.set(realId, tRaw);
                continue;
            }

            // Normalize display base type.
            const baseType = (tRaw === 'PositiveLens') ? 'Lens' : tRaw;
            const next = (counts.get(baseType) || 0) + 1;
            counts.set(baseType, next);
            displayLabelByBlockId.set(realId, `${baseType}-${next}`);
        }
    } catch (_) {}

    // Blocks-only toolbar: add a new block to the active configuration.
    for (const b of list) {
        const blockId = String(b.blockId ?? '').trim();

        const row = document.createElement('div');
        row.className = 'block-inspector-row';
        if (blockId && __blockInspectorExpandedBlockId === blockId) row.classList.add('selected');

        const colId = document.createElement('div');
        colId.className = 'block-inspector-col-id';
        {
            const rawId = String(b.blockId ?? '(none)');
            const label = displayLabelByBlockId.get(rawId) || formatSingletonBlockLabel(b.blockType, rawId);

            // Special-case: ObjectSurface corresponds to the Object surface (Surf 0).
            if (String(b.blockType ?? '').trim() === 'ObjectSurface') {
                colId.textContent = `${label} → Surf 0`;
            } else {
                const range = surfRangeByBlockId.get(String(b.blockId ?? '').trim());
                if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
                    const surfText = (range.min === range.max)
                        ? `Surf ${range.min}`
                        : `Surf ${range.min}–${range.max}`;
                    colId.textContent = `${label} → ${surfText}`;
                } else {
                    colId.textContent = label;
                }
            }
        }

        const colType = document.createElement('div');
        colType.className = 'block-inspector-col-type';
        colType.textContent = String(b.blockType ?? '(none)');

        const colParams = document.createElement('div');
        colParams.className = 'block-inspector-col-params';
        colParams.textContent = String(b.preview ?? '');

        const colCount = document.createElement('div');
        colCount.className = 'block-inspector-col-count';
        {
            const n = Number(b.surfaceCount ?? 0);
            colCount.textContent = `→ ${Number.isFinite(n) ? n : 0} surfaces`;
        }

        row.appendChild(colId);
        row.appendChild(colType);
        row.appendChild(colParams);
        row.appendChild(colCount);

        row.onclick = () => {
            if (!blockId) return;
            __blockInspectorExpandedBlockId = (__blockInspectorExpandedBlockId === blockId) ? null : blockId;
            try { refreshBlockInspector(); } catch (_) {}
        };

        container.appendChild(row);

        const blockType = String(b.blockType ?? '');
        const realBlock = blockById && typeof blockById.get === 'function' ? blockById.get(blockId) : null;
        if (realBlock && __blockInspectorExpandedBlockId === blockId) {
            const panel = document.createElement('div');
            panel.style.padding = '6px 8px 10px 8px';
            panel.style.borderTop = '1px solid #eee';
            panel.style.fontSize = '12px';
            panel.style.color = '#333';

            /** @type {Array<{key:string,label:string}>} */
            const items = [];

            const vars = realBlock.variables && typeof realBlock.variables === 'object' ? realBlock.variables : {};
            const params = realBlock.parameters && typeof realBlock.parameters === 'object' ? realBlock.parameters : {};

            // Precompute expanded semidia by provenance so the inspector can show
            // per-surface semidia even if not explicitly stored in block.aperture.
            /** @type {Map<string, any>} */
            const semidiaByProv = new Map();
            try {
                if (Array.isArray(blocksInOrder) && blocksInOrder.length > 0 && typeof expandBlocksToOpticalSystemRows === 'function') {
                    const exp = expandBlocksToOpticalSystemRows(blocksInOrder);
                    const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
                    for (const r of rows) {
                        const bid = String(r?._blockId ?? '').trim();
                        const role = String(r?._surfaceRole ?? '').trim();
                        if (!bid || !role) continue;
                        const key = `p:${bid}|${role}`;
                        if (!semidiaByProv.has(key)) semidiaByProv.set(key, r?.semidia);
                    }
                }
            } catch (_) {}

            const getApertureDisplayValue = (role) => {
                try {
                    const ap = (realBlock.aperture && typeof realBlock.aperture === 'object') ? realBlock.aperture : null;
                    const r = String(role ?? '').trim();
                    if (ap && Object.prototype.hasOwnProperty.call(ap, r)) {
                        const v = ap[r];
                        const s = String(v ?? '').trim();
                        if (s !== '') return s;
                    }
                    const key = `p:${String(blockId).trim()}|${r}`;
                    const v2 = semidiaByProv.get(key);
                    return String(v2 ?? '');
                } catch (_) {
                    return '';
                }
            };

            const getValue = (k) => {
                if (Object.prototype.hasOwnProperty.call(params, k)) return params[k];
                if (vars[k] && typeof vars[k] === 'object' && Object.prototype.hasOwnProperty.call(vars[k], 'value')) return vars[k].value;
                return '';
            };

            const getDisplayValue = (k) => {
                const v = getValue(k);
                // Show a meaningful default for Stop.semiDiameter when omitted.
                if (blockType === 'Stop' && String(k) === 'semiDiameter') {
                    const s = String(v ?? '').trim();
                    if (s === '') return String(DEFAULT_STOP_SEMI_DIAMETER);
                }
                return String(v ?? '');
            };

            const isSphericalSurfType = (v) => {
                const s = String(v ?? '').trim();
                if (s === '') return true;
                const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
                return key === 'spherical' || key === 'sph';
            };

            const shouldShowCoefsForSurfTypeKey = (surfTypeKey) => {
                const st = getValue(surfTypeKey);
                return !isSphericalSurfType(st);
            };

            const normalizeAsphereMode = (v) => {
                const s = String(v ?? '').trim();
                if (s === '') return null;
                const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
                if (key === 'asphericeven' || key === 'asphericaleven' || key === 'evenasphere' || key === 'evenaspheric') return 'even';
                if (key === 'asphericodd' || key === 'asphericalodd' || key === 'oddasphere' || key === 'oddaspheric') return 'odd';
                return null;
            };

            const asphereCoefLabel = (prefix, surfTypeValue, coefIndex, fallback) => {
                const mode = normalizeAsphereMode(surfTypeValue);
                if (!mode) return String(fallback ?? '');
                // IMPORTANT: Match ray-tracing.js coefficient convention.
                // - even: coef1..10 multiply r^4, r^6, ..., r^22  -> A4..A22
                // - odd:  coef1..10 multiply r^3, r^5, ..., r^21  -> A3..A21
                const a = (mode === 'even') ? (2 * (coefIndex + 1)) : (2 * coefIndex + 1);
                return `${String(prefix)} coefA${a}`;
            };

            const normalizeApertureShape = (v) => {
                const s = String(v ?? '').trim();
                if (!s) return 'Circular';
                const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
                if (key === 'circle' || key === 'circular') return 'Circular';
                if (key === 'square' || key === 'sq') return 'Square';
                if (key === 'rect' || key === 'rectangle' || key === 'rectangular') return 'Rectangular';
                return s;
            };

            const mirrorShape = (blockType === 'Mirror') ? normalizeApertureShape(getValue('apertureShape')) : null;
            const isMirrorCircular = mirrorShape === 'Circular';
            const isMirrorSquare = mirrorShape === 'Square';
            const isMirrorRect = mirrorShape === 'Rectangular';

            if (blockType === 'ObjectSurface') {
                items.push(
                    { kind: 'objectMode', key: 'objectDistanceMode', label: 'object (INF/finite)', noOptimize: true },
                    { kind: 'objectDistance', key: 'objectDistance', label: 'distance to 1st lens', noOptimize: true }
                );
            } else if (blockType === 'Lens' || blockType === 'PositiveLens') {
                items.push(
                    { kind: 'aperture', role: 'front', label: 'semidia(front)' },
                    { kind: 'aperture', role: 'back', label: 'semidia(back)' },
                    { key: 'frontRadius', label: 'frontRadius' },
                    { key: 'backRadius', label: 'backRadius' },
                    { key: 'centerThickness', label: 'centerThickness' },
                    { key: 'material', label: 'material' },
                    { key: 'frontSurfType', label: 'frontSurfType' },
                    { key: 'backSurfType', label: 'backSurfType' },
                    { key: 'frontConic', label: 'frontConic' },
                    { key: 'backConic', label: 'backConic' }
                );

                // Coef* is unused for Spherical. Hide to keep Design Intent concise.
                if (shouldShowCoefsForSurfTypeKey('frontSurfType')) {
                    const st = getValue('frontSurfType');
                    for (let i = 1; i <= 10; i++) {
                        const fb = `frontCoef${i}`;
                        items.push({ key: fb, label: asphereCoefLabel('front', st, i, fb) });
                    }
                }
                if (shouldShowCoefsForSurfTypeKey('backSurfType')) {
                    const st = getValue('backSurfType');
                    for (let i = 1; i <= 10; i++) {
                        const fb = `backCoef${i}`;
                        items.push({ key: fb, label: asphereCoefLabel('back', st, i, fb) });
                    }
                }
            } else if (blockType === 'Doublet' || blockType === 'Triplet') {
                const elemCount = (blockType === 'Doublet') ? 2 : 3;
                const surfCount = elemCount + 1;

                for (let si = 1; si <= surfCount; si++) items.push({ kind: 'aperture', role: `s${si}`, label: `semidia(s${si})` });
                for (let si = 1; si <= surfCount; si++) items.push({ key: `radius${si}`, label: `radius${si}` });
                for (let ei = 1; ei <= elemCount; ei++) {
                    items.push({ key: `thickness${ei}`, label: `thickness${ei}` });
                    items.push({ key: `material${ei}`, label: `material${ei}` });
                }
                for (let si = 1; si <= surfCount; si++) {
                    items.push({ key: `surf${si}SurfType`, label: `surf${si}SurfType` });
                    items.push({ key: `surf${si}Conic`, label: `surf${si}Conic` });

                    // Coef* is unused for Spherical. Hide per-surface.
                    if (shouldShowCoefsForSurfTypeKey(`surf${si}SurfType`)) {
                        const st = getValue(`surf${si}SurfType`);
                        for (let k = 1; k <= 10; k++) {
                            const fb = `surf${si}Coef${k}`;
                            items.push({ key: fb, label: asphereCoefLabel(`surf${si}`, st, k, fb) });
                        }
                    }
                }
            } else if (blockType === 'Gap' || blockType === 'AirGap') {
                // Only show thicknessMode for the last Gap before ImageSurface.
                try {
                    const blocks = Array.isArray(blocksInOrder) ? blocksInOrder : [];
                    const myIdx = blocks.findIndex(b => b && String(b.blockId ?? '') === String(blockId));
                    const imgIdx = blocks.findIndex(b => b && String(b.blockType ?? '') === 'ImageSurface');
                    let isPreImageGap = false;
                    if (myIdx >= 0 && imgIdx > myIdx) {
                        isPreImageGap = true;
                        for (let k = myIdx + 1; k < imgIdx; k++) {
                            const bt = String(blocks[k]?.blockType ?? '');
                            if (bt === 'Gap' || bt === 'AirGap') { isPreImageGap = false; break; }
                        }
                    }
                    if (isPreImageGap) {
                        items.push({ kind: 'gapThicknessMode', key: 'thicknessMode', label: 'thickness (IMD/BFL)', noOptimize: true });
                    }
                } catch (_) {}
                items.push({ key: 'thickness', label: 'thickness' });
                items.push({ key: 'material', label: 'material' });
            } else if (blockType === 'Stop') {
                // UX alias: the surface table uses "semidia"; Blocks store it as Stop.parameters.semiDiameter.
                items.push({ key: 'semiDiameter', label: 'semidia' });
            } else if (blockType === 'Mirror') {
                items.push(
                    { kind: 'apertureShape', key: 'apertureShape', label: 'apertureShape', noOptimize: true },
                    { key: 'semidia', label: 'semidia', noOptimize: true },
                    { key: 'apertureWidth', label: 'apertureWidth', noOptimize: true },
                    { key: 'apertureHeight', label: 'apertureHeight', noOptimize: true },
                    { key: 'radius', label: 'radius' },
                    { key: 'thickness', label: 'thickness' },
                    { key: 'surfType', label: 'surfType' },
                    { key: 'conic', label: 'conic' }
                );

                if (shouldShowCoefsForSurfTypeKey('surfType')) {
                    const st = getValue('surfType');
                    for (let i = 1; i <= 10; i++) {
                        const fb = `coef${i}`;
                        items.push({ key: fb, label: asphereCoefLabel('mirror', st, i, fb) });
                    }
                }
            } else if (blockType === 'CoordTrans') {
                items.push(
                    { key: 'decenterX', label: 'decenterX' },
                    { key: 'decenterY', label: 'decenterY' },
                    { key: 'decenterZ', label: 'decenterZ' },
                    { key: 'tiltX', label: 'tiltX (deg)' },
                    { key: 'tiltY', label: 'tiltY (deg)' },
                    { key: 'tiltZ', label: 'tiltZ (deg)' },
                    { key: 'order', label: 'order (0/1)' }
                );
            } else if (blockType === 'ImageSurface') {
                items.push({ kind: 'imageSemiDiaMode', key: 'optimizeSemiDia', label: 'auto semidia (chief ray)', noOptimize: true });
                items.push({ key: 'semidia', label: 'semidia', noOptimize: true });
            }
            for (const it of items) {
                const isApertureItem = it && typeof it === 'object' && String(it.kind ?? '') === 'aperture';
                const isObjectModeItem = !isApertureItem && it && typeof it === 'object' && String(it.kind ?? '') === 'objectMode';
                const isObjectDistanceItem = !isApertureItem && it && typeof it === 'object' && String(it.kind ?? '') === 'objectDistance';
                const isImageSemiDiaModeItem = !isApertureItem && it && typeof it === 'object' && String(it.kind ?? '') === 'imageSemiDiaMode';
                const isGapThicknessModeItem = !isApertureItem && it && typeof it === 'object' && String(it.kind ?? '') === 'gapThicknessMode';
                const isApertureShapeItem = !isApertureItem && it && typeof it === 'object' && String(it.kind ?? '') === 'apertureShape';
                const isSurfTypeItem = !isApertureItem && it && typeof it === 'object' && typeof it.key === 'string' && /surftype$/i.test(String(it.key));
                const isMaterialItem = !isApertureItem && it && typeof it === 'object' && typeof it.key === 'string' && /^material\d*$/i.test(String(it.key));
                const allowOptimize = !isApertureItem && !(it && typeof it === 'object' && it.noOptimize);

                if (blockType === 'Mirror') {
                    const k = String(it?.key ?? '');
                    if (k === 'semidia' && !isMirrorCircular) continue;
                    if (k === 'apertureWidth' && !(isMirrorSquare || isMirrorRect)) continue;
                    if (k === 'apertureHeight' && !isMirrorRect) continue;
                }
                const line = document.createElement('div');
                line.style.display = 'flex';
                line.style.alignItems = 'center';
                line.style.gap = '8px';
                line.style.padding = '2px 0';

                if (isMaterialItem) {
                    // Clicking the row (not only the input) should make toolbar "Find Glass" target this key.
                    line.addEventListener('click', (e) => {
                        try { e?.stopPropagation?.(); } catch (_) {}
                        try {
                            const mk = String(it?.key ?? '').trim();
                            if (mk) __blockInspectorPreferredMaterialKeyByBlockId.set(String(blockId), mk);
                        } catch (_) {}
                    });
                }

                let scopeSel = null;
                let cb = null;
                if (allowOptimize) {
                    scopeSel = document.createElement('select');
                    scopeSel.style.flex = '0 0 auto';
                    scopeSel.style.fontSize = '12px';
                    scopeSel.style.padding = '2px 4px';
                    scopeSel.innerHTML = '<option value="perConfig">Per-config</option><option value="global">Shared (all configs)</option>';
                    scopeSel.value = __blocks_getVarScope(vars[it.key]);

                    cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = __blocks_shouldMarkVar(vars[it.key]);
                    cb.addEventListener('click', (e) => e.stopPropagation());
                    cb.addEventListener('change', (e) => {
                        e.stopPropagation();
                        try { scopeSel.disabled = !cb.checked; } catch (_) {}
                        __blocks_setVarMode(blockId, it.key, cb.checked, String(scopeSel.value));
                        try { refreshBlockInspector(); } catch (_) {}
                    });
                    scopeSel.disabled = !cb.checked;
                    scopeSel.addEventListener('click', (e) => e.stopPropagation());
                    scopeSel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newScope = String(scopeSel.value);
                        __blocks_setVarScope(blockId, it.key, newScope);
                        // If already variable, re-apply mode with the new scope.
                        if (cb.checked) {
                            __blocks_setVarMode(blockId, it.key, true, newScope);
                        }
                        try { refreshBlockInspector(); } catch (_) {}
                    });
                }

                const name = document.createElement('div');
                name.textContent = it.label;
                name.style.flex = '1 1 auto';
                name.style.fontFamily = 'monospace';

                // Editable value (Design Intent canonical edits)
                const currentValue = isApertureItem ? getApertureDisplayValue(it.role) : getDisplayValue(it.key);
                console.log(`[Undo] Getting current value for ${it.key || it.role}:`, currentValue, 'isAperture:', isApertureItem);

                const commitValue = (nextRaw) => {
                    console.log('[Undo] commitValue called:', { blockId, key: it.key, role: it.role, nextRaw, currentValue, isApertureItem });
                    const next = String(nextRaw ?? '');
                    const current = currentValue;
                    if (next === current) {
                        console.log('[Undo] Value unchanged, skipping');
                        return;
                    }
                    console.log('[Undo] Calling', isApertureItem ? '__blocks_setBlockApertureValue' : '__blocks_setBlockParamValue');
                    const res = isApertureItem
                        ? __blocks_setBlockApertureValue(blockId, it.role, next)
                        : __blocks_setBlockParamValue(blockId, it.key, next);
                    console.log('[Undo] Function returned:', res);
                    if (!res || res.ok !== true) {
                        const desc = isApertureItem ? `${blockId}.aperture.${String(it.role ?? '')}` : `${blockId}.${it.key}`;
                        alert(`Failed to update ${desc}: ${res?.reason || 'unknown error'}`);
                        return false;
                    }
                    try { refreshBlockInspector(); } catch (_) {}
                    return true;
                };

                let valueEl;
                if (isObjectModeItem || isImageSemiDiaModeItem || isGapThicknessModeItem || isApertureShapeItem) {
                    const sel = document.createElement('select');
                    sel.style.flex = '0 0 180px';
                    sel.style.fontSize = '12px';
                    sel.style.padding = '2px 6px';
                    sel.style.border = '1px solid #ddd';
                    sel.style.borderRadius = '4px';
                    sel.addEventListener('click', (e) => e.stopPropagation());

                    if (isObjectModeItem) {
                        sel.innerHTML = [
                            '<option value="Finite">Finite</option>',
                            '<option value="INF">INF</option>'
                        ].join('');
                        const cur = String(currentValue ?? '').trim().replace(/\s+/g, '').toUpperCase();
                        const normalized = (cur === 'INF' || cur === 'INFINITY') ? 'INF' : 'Finite';
                        sel.value = normalized;
                        sel.addEventListener('change', (e) => {
                            e.stopPropagation();
                            const desired = String(sel.value ?? 'Finite');
                            const ok = commitValue(desired);
                            if (!ok) sel.value = normalized;
                        });
                    } else if (isImageSemiDiaModeItem) {
                        // ImageSurface.optimizeSemiDia
                        sel.innerHTML = [
                            '<option value="">(manual)</option>',
                            '<option value="A">Auto (chief ray)</option>'
                        ].join('');
                        const cur = String(currentValue ?? '').trim().toUpperCase();
                        const normalized = cur === 'A' ? 'A' : '';
                        sel.value = normalized;
                        sel.addEventListener('change', (e) => {
                            e.stopPropagation();
                            const desired = String(sel.value ?? '');
                            const ok = commitValue(desired);
                            if (!ok) {
                                sel.value = normalized;
                                return;
                            }

                            // If Auto was selected, run chief-ray semidia update immediately.
                            if (desired === 'A' && typeof window.calculateImageSemiDiaFromChiefRays === 'function') {
                                (async () => {
                                    try {
                                        await window.calculateImageSemiDiaFromChiefRays();
                                    } catch (err) {
                                        console.error('❌ calculateImageSemiDiaFromChiefRays failed:', err);
                                    }
                                    try { refreshBlockInspector(); } catch (_) {}
                                })();
                            }
                        });
                    } else if (isGapThicknessModeItem) {
                        // Gap.thicknessMode (pre-image gap only)
                        sel.innerHTML = [
                            '<option value="">(manual)</option>',
                            '<option value="IMD">Image Distance</option>',
                            '<option value="BFL">Back Focal Length</option>'
                        ].join('');

                        const cur = String(currentValue ?? '').trim().replace(/\s+/g, '').toUpperCase();
                        const normalized = (cur === 'IMD' || cur === 'BFL') ? cur : '';
                        sel.value = normalized;

                        sel.addEventListener('change', (e) => {
                            e.stopPropagation();
                            const desired = String(sel.value ?? '').toUpperCase();
                            const ok = commitValue(desired);
                            if (!ok) {
                                sel.value = normalized;
                                return;
                            }

                            if (desired !== 'IMD' && desired !== 'BFL') {
                                try { refreshBlockInspector(); } catch (_) {}
                                return;
                            }

                            // Compute and write thickness immediately.
                            (async () => {
                                try {
                                    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
                                    const activeId = systemConfig?.activeConfigId;
                                    const cfg = Array.isArray(systemConfig?.configurations)
                                        ? systemConfig.configurations.find(c => c && c.id === activeId)
                                        : null;
                                    const blocks = Array.isArray(cfg?.blocks) ? cfg.blocks : null;
                                    if (!blocks || typeof expandBlocksToOpticalSystemRows !== 'function') return;

                                    const exp = expandBlocksToOpticalSystemRows(blocks);
                                    const rows = exp && Array.isArray(exp.rows) ? exp.rows : null;
                                    if (!rows || rows.length < 2) return;

                                    const primaryWavelength = (typeof window.getPrimaryWavelength === 'function')
                                        ? (Number(window.getPrimaryWavelength()) || 0.5876)
                                        : 0.5876;

                                    // Prefer System Requirements target (when present) so this can
                                    // directly satisfy the IMD/BFL requirement for the active config.
                                    // Fallback: compute from current system.
                                    let val = __blocks_findRequirementTarget(desired, activeId);
                                    if (!Number.isFinite(val)) {
                                        val = (desired === 'BFL')
                                            ? calculateBackFocalLength(rows, primaryWavelength)
                                            : calculateImageDistance(rows, primaryWavelength);
                                    }

                                    if (!Number.isFinite(val)) {
                                        alert(`${desired} の計算に失敗しました。`);
                                        return;
                                    }

                                    // If the thickness variable is marked Shared(all configs), apply the
                                    // same thickness across configs to avoid per-config drift.
                                    const thScope = __blocks_getVarScope(vars?.thickness);
                                    const res2 = (thScope === 'global')
                                        ? __blocks_setBlockParamValueAllConfigs(blockId, 'thickness', val)
                                        : __blocks_setBlockParamValue(blockId, 'thickness', val);
                                    if (!res2 || res2.ok !== true) {
                                        alert(`Failed to update ${blockId}.thickness: ${res2?.reason || 'unknown error'}`);
                                        return;
                                    }
                                } catch (err) {
                                    console.error('❌ Failed to compute/apply IMD/BFL thickness:', err);
                                }
                                try { refreshBlockInspector(); } catch (_) {}
                            })();
                        });
                    } else {
                        // Mirror.apertureShape
                        sel.innerHTML = [
                            '<option value="Circular">Circular</option>',
                            '<option value="Square">Square</option>',
                            '<option value="Rectangular">Rectangular</option>'
                        ].join('');

                        const cur = normalizeApertureShape(currentValue);
                        sel.value = cur;

                        sel.addEventListener('change', (e) => {
                            e.stopPropagation();
                            const desired = String(sel.value ?? 'Circular');
                            const ok = commitValue(desired);
                            if (!ok) {
                                sel.value = cur;
                                return;
                            }
                            try { refreshBlockInspector(); } catch (_) {}
                        });
                    }

                    valueEl = sel;
                } else if (isSurfTypeItem) {
                    const sel = document.createElement('select');
                    sel.style.flex = '0 0 180px';
                    sel.style.fontSize = '12px';
                    sel.style.padding = '2px 6px';
                    sel.style.border = '1px solid #ddd';
                    sel.style.borderRadius = '4px';
                    sel.addEventListener('click', (e) => e.stopPropagation());

                    sel.innerHTML = [
                        '<option value="">(default: Spherical)</option>',
                        '<option value="Spherical">Spherical</option>',
                        '<option value="Aspheric even">Aspheric even</option>',
                        '<option value="Aspheric odd">Aspheric odd</option>'
                    ].join('');

                    // Normalize current value into one of the options
                    const cur = String(currentValue ?? '').trim();
                    const key = cur.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
                    let normalized = '';
                    if (cur === '') normalized = '';
                    else if (key === 'spherical' || key === 'sph' || key === 'std' || key === 'standard') normalized = 'Spherical';
                    else if (key === 'asphericeven' || key === 'asphericaleven' || key === 'evenaspheric' || key === 'evenasphere') normalized = 'Aspheric even';
                    else if (key === 'asphericodd' || key === 'asphericalodd' || key === 'oddaspheric' || key === 'oddasphere') normalized = 'Aspheric odd';
                    else normalized = cur;

                    sel.value = ['','Spherical','Aspheric even','Aspheric odd'].includes(normalized) ? normalized : '';
                    sel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const ok = commitValue(String(sel.value ?? ''));
                        if (!ok) {
                            // restore
                            sel.value = ['','Spherical','Aspheric even','Aspheric odd'].includes(normalized) ? normalized : '';
                        }
                    });
                    valueEl = sel;
                } else {
                    const valueInput = document.createElement('input');
                    valueInput.type = 'text';
                    valueInput.value = currentValue;
                    console.log(`[Undo] Creating input for ${it.key || it.role}, value:`, currentValue);
                    valueInput.placeholder = '';
                    valueInput.style.flex = '0 0 180px';
                    valueInput.style.fontSize = '12px';
                    valueInput.style.padding = '2px 6px';
                    valueInput.style.border = '1px solid #ddd';
                    valueInput.style.borderRadius = '4px';
                    valueInput.addEventListener('click', (e) => e.stopPropagation());

                    // Object distance is ignored when objectDistanceMode is INF.
                    if (isObjectDistanceItem) {
                        try {
                            const mRaw = getDisplayValue('objectDistanceMode');
                            const m = String(mRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
                            const isInf = m === 'INF' || m === 'INFINITY';
                            valueInput.disabled = isInf;
                            if (isInf) valueInput.placeholder = '(ignored)';
                        } catch (_) {}
                    }

                    const tryCommit = () => {
                        const ok = commitValue(String(valueInput.value ?? ''));
                        if (!ok) valueInput.value = currentValue;
                    };
                    valueInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            tryCommit();
                        }
                    });
                    valueInput.addEventListener('blur', () => {
                        tryCommit();
                    });

                    valueEl = valueInput;
                }

                // Material helper UI (inline): keep material + ref index + abbe on the SAME LINE.
                // Suggest behavior (triggered by Enter in ref index / abbe inputs):
                // - If nd/vd inputs are provided: use them.
                // - Else if material is a known glass: use its nd/vd.
                // - Else if material is unknown: show name-based suggestions.
                let materialListEl = null;
                if (isMaterialItem) {
                    const materialKey = String(it?.key ?? '').trim();
                    const mat = String(currentValue ?? '').trim();
                    let curNd = '';
                    let curVd = '';
                    let matIsKnownGlass = false;
                    let matIsNumeric = false;
                    let matNumericNd = NaN;
                    try {
                        if (mat !== '' && mat.toUpperCase() !== 'AIR') {
                            const gd = getGlassDataWithSellmeier(mat);
                            if (gd && Number.isFinite(gd.nd)) {
                                curNd = String(gd.nd);
                                matNumericNd = gd.nd;
                            }
                            if (gd && Number.isFinite(gd.vd)) curVd = String(gd.vd);
                            // Numeric material returns vd=undefined; known glass returns finite vd.
                            matIsKnownGlass = !!(gd && Number.isFinite(gd.nd) && Number.isFinite(gd.vd));
                            matIsNumeric = !!(gd && Number.isFinite(gd.nd) && !Number.isFinite(gd.vd));
                        }
                    } catch (_) {}

                    const ndInput = document.createElement('input');
                    ndInput.type = 'text';
                    ndInput.dataset.glassHelper = 'nd';
                    ndInput.dataset.blockId = String(blockId ?? '');
                    ndInput.dataset.materialKey = materialKey;
                    ndInput.placeholder = curNd !== '' ? curNd : 'ref index';
                    ndInput.value = '';
                    ndInput.style.flex = '0 0 86px';
                    ndInput.style.fontSize = '12px';
                    ndInput.style.padding = '2px 6px';
                    ndInput.style.border = '1px solid #ddd';
                    ndInput.style.borderRadius = '4px';
                    ndInput.title = 'ref index (nd)';
                    ndInput.addEventListener('click', (e) => e.stopPropagation());

                    const vdInput = document.createElement('input');
                    vdInput.type = 'text';
                    vdInput.dataset.glassHelper = 'vd';
                    vdInput.dataset.blockId = String(blockId ?? '');
                    vdInput.dataset.materialKey = materialKey;
                    vdInput.placeholder = curVd !== '' ? curVd : 'abbe';
                    vdInput.value = '';
                    vdInput.style.flex = '0 0 86px';
                    vdInput.style.fontSize = '12px';
                    vdInput.style.padding = '2px 6px';
                    vdInput.style.border = '1px solid #ddd';
                    vdInput.style.borderRadius = '4px';
                    vdInput.title = 'Abbe number (vd)';
                    vdInput.addEventListener('click', (e) => e.stopPropagation());

                    const markPreferred = () => {
                        try {
                            if (materialKey) __blockInspectorPreferredMaterialKeyByBlockId.set(String(blockId), materialKey);
                        } catch (_) {}
                    };
                    try {
                        // Prefer the currently focused field for toolbar "Find Glass".
                        ndInput.addEventListener('focus', markPreferred);
                        vdInput.addEventListener('focus', markPreferred);
                        if (valueEl && typeof valueEl === 'object' && 'addEventListener' in valueEl) {
                            valueEl.addEventListener('focus', markPreferred);
                        }
                    } catch (_) {}

                    const listEl = document.createElement('div');
                    listEl.style.display = 'none';
                    listEl.style.margin = '2px 0 0 0';
                    listEl.style.padding = '6px';
                    listEl.style.border = '1px solid #eee';
                    listEl.style.borderRadius = '6px';
                    listEl.style.background = '#fafafa';
                    listEl.style.fontSize = '12px';
                    listEl.addEventListener('click', (e) => e.stopPropagation());

                    const renderNdVdCandidates = (targetNd, targetVd) => {
                        const candidates = findSimilarGlassesByNdVd(targetNd, targetVd, 12);
                        if (!Array.isArray(candidates) || candidates.length === 0) {
                            listEl.style.display = '';
                            listEl.textContent = 'No candidates.';
                            return;
                        }
                        listEl.style.display = '';
                        listEl.innerHTML = '';

                        const head = document.createElement('div');
                        head.style.marginBottom = '4px';
                        head.style.color = '#666';
                        head.textContent = `Closest glasses to nd=${targetNd} vd=${targetVd}`;
                        listEl.appendChild(head);

                        for (let i = 0; i < Math.min(10, candidates.length); i++) {
                            const g = candidates[i];
                            const rowEl = document.createElement('div');
                            rowEl.style.display = 'flex';
                            rowEl.style.alignItems = 'center';
                            rowEl.style.justifyContent = 'space-between';
                            rowEl.style.padding = '2px 4px';
                            rowEl.style.borderRadius = '4px';
                            rowEl.style.cursor = 'pointer';
                            rowEl.addEventListener('mouseenter', () => { rowEl.style.background = '#f2f2f2'; });
                            rowEl.addEventListener('mouseleave', () => { rowEl.style.background = ''; });
                            rowEl.addEventListener('click', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const name = String(g?.name ?? '').trim();
                                if (!name) return;
                                const current = String(currentValue ?? '').trim();
                                const ok = (name === current) ? true : commitValue(name);
                                if (ok) {
                                    listEl.style.display = 'none';
                                    listEl.innerHTML = '';
                                }
                            });

                            const left = document.createElement('div');
                            const manufacturer = g.manufacturer ? ` [${g.manufacturer}]` : '';
                            left.textContent = `${i + 1}. ${String(g.name)}${manufacturer}`;
                            const right = document.createElement('div');
                            right.style.color = '#777';
                            right.style.fontSize = '11px';
                            right.style.textAlign = 'left';
                            right.style.whiteSpace = 'pre';
                            right.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
                            {
                                const ndStr = Number(g.nd).toFixed(6).padStart(10);
                                const vdStr = Number(g.vd).toFixed(2).padStart(6);
                                const ndDiffStr = ((Number(g.ndDiff) >= 0 ? '+' : '') + Number(g.ndDiff).toFixed(6)).padStart(11);
                                const vdDiffStr = ((Number(g.vdDiff) >= 0 ? '+' : '') + Number(g.vdDiff).toFixed(2)).padStart(7);
                                const priceStr = (Number.isFinite(g?.price) ? Number(g.price).toFixed(4) : 'null').padStart(8);
                                right.textContent = `${ndStr} / ${vdStr}  (Δn=${ndDiffStr}, Δv=${vdDiffStr})  price=${priceStr}`;
                            }
                            rowEl.appendChild(left);
                            rowEl.appendChild(right);
                            listEl.appendChild(rowEl);
                        }
                    };

                    const renderNameCandidates = (query) => {
                        const candidates = findSimilarGlassNames(String(query ?? ''), 12);
                        if (!Array.isArray(candidates) || candidates.length === 0) {
                            listEl.style.display = '';
                            listEl.textContent = 'No name matches.';
                            return;
                        }
                        listEl.style.display = '';
                        listEl.innerHTML = '';

                        const head = document.createElement('div');
                        head.style.marginBottom = '4px';
                        head.style.color = '#666';
                        head.textContent = `Unknown glass. Name suggestions for "${String(query)}"`;
                        listEl.appendChild(head);

                        for (let i = 0; i < Math.min(10, candidates.length); i++) {
                            const g = candidates[i];
                            const rowEl = document.createElement('div');
                            rowEl.style.display = 'flex';
                            rowEl.style.alignItems = 'center';
                            rowEl.style.justifyContent = 'space-between';
                            rowEl.style.padding = '2px 4px';
                            rowEl.style.borderRadius = '4px';
                            rowEl.style.cursor = 'pointer';
                            rowEl.addEventListener('mouseenter', () => { rowEl.style.background = '#f2f2f2'; });
                            rowEl.addEventListener('mouseleave', () => { rowEl.style.background = ''; });
                            rowEl.addEventListener('click', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const name = String(g?.name ?? '').trim();
                                if (!name) return;
                                const current = String(currentValue ?? '').trim();
                                const ok = (name === current) ? true : commitValue(name);
                                if (ok) {
                                    listEl.style.display = 'none';
                                    listEl.innerHTML = '';
                                }
                            });

                            const left = document.createElement('div');
                            const manufacturer = g.manufacturer ? ` [${g.manufacturer}]` : '';
                            left.textContent = `${i + 1}. ${String(g.name)}${manufacturer}`;
                            const right = document.createElement('div');
                            right.style.color = '#777';
                            right.style.fontSize = '11px';
                            right.style.textAlign = 'left';
                            right.style.whiteSpace = 'pre';
                            right.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
                            {
                                const scoreStr = String(Number(g.score).toFixed(0)).padStart(3);
                                const priceStr = (Number.isFinite(g?.price) ? Number(g.price).toFixed(4) : 'null').padStart(8);
                                right.textContent = `score=${scoreStr}  price=${priceStr}`;
                            }
                            rowEl.appendChild(left);
                            rowEl.appendChild(right);
                            listEl.appendChild(rowEl);
                        }
                    };

                    const pickTargetNdVd = () => {
                        const nRaw = Number.parseFloat(String(ndInput.value ?? '').trim());
                        const vRaw = Number.parseFloat(String(vdInput.value ?? '').trim());
                        if (Number.isFinite(nRaw) && Number.isFinite(vRaw)) return { nd: nRaw, vd: vRaw };

                        // If material is a known glass, Suggest should work without manual nd/vd.
                        if (matIsKnownGlass) {
                            const nd = Number.parseFloat(curNd);
                            const vd = Number.parseFloat(curVd);
                            if (Number.isFinite(nd) && Number.isFinite(vd)) return { nd, vd };
                        }

                        // Numeric material: allow using vd input if provided.
                        if (matIsNumeric) {
                            const vd = Number.parseFloat(String(vdInput.value ?? '').trim());
                            if (Number.isFinite(matNumericNd) && Number.isFinite(vd)) return { nd: matNumericNd, vd };
                        }
                        return null;
                    };

                    const suggest = () => {
                        const t = pickTargetNdVd();
                        if (t) {
                            renderNdVdCandidates(t.nd, t.vd);
                            return;
                        }
                        // Fall back to name-based suggestions for unknown glass names.
                        const q = String(mat ?? '').trim();
                        if (q === '') {
                            alert('Enter a material name or nd/vd first.');
                            return;
                        }
                        renderNameCandidates(q);
                    };

                    const suggestOnEnter = (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            suggest();
                        }
                    };
                    ndInput.addEventListener('keydown', suggestOnEnter);
                    vdInput.addEventListener('keydown', suggestOnEnter);

                    materialListEl = listEl;

                    // Defer inserting ref index/abbe until after the material input is added,
                    // so the final order is: Optimize, Per-config, material, ref index, abbe.
                    // Expose suggestion helpers so the UI can trigger candidate search
                    // (e.g. via a per-row Find Glass button) while reusing the same logic.
                    materialListEl.__inlineControls = { ndInput, vdInput, suggest, materialKey };
                }

                if (allowOptimize) {
                    const label = document.createElement('label');
                    label.style.display = 'flex';
                    label.style.alignItems = 'center';
                    label.style.gap = '6px';
                    label.style.flex = '0 0 auto';
                    label.addEventListener('click', (e) => e.stopPropagation());
                    {
                        const txt = document.createElement('span');
                        txt.textContent = 'Optimize';
                        label.appendChild(cb);
                        label.appendChild(txt);
                    }
                    line.appendChild(label);
                    line.appendChild(scopeSel);
                } else {
                    const spacer = document.createElement('div');
                    spacer.style.flex = '0 0 176px';
                    line.appendChild(spacer);
                }
                line.appendChild(name);
                line.appendChild(valueEl);

                if (isMaterialItem) {
                    const mapBtn = document.createElement('button');
                    mapBtn.type = 'button';
                    mapBtn.textContent = '🗺️ Map';
                    mapBtn.title = 'Select a glass region (nd/vd) constraint from the Abbe diagram';
                    mapBtn.style.flex = '0 0 auto';
                    mapBtn.style.fontSize = '12px';
                    // Match the adjacent material/nd/vd text inputs.
                    mapBtn.style.boxSizing = 'border-box';
                    mapBtn.style.height = '22px';
                    mapBtn.style.display = 'inline-flex';
                    mapBtn.style.alignItems = 'center';
                    mapBtn.style.padding = '2px 6px';
                    mapBtn.style.border = '1px solid #ddd';
                    mapBtn.style.borderRadius = '4px';
                    mapBtn.style.background = '#fff';
                    mapBtn.style.cursor = 'pointer';
                    mapBtn.addEventListener('click', (e) => {
                        try { e?.preventDefault?.(); } catch (_) {}
                        try { e?.stopPropagation?.(); } catch (_) {}

                        try {
                            openGlassMapWindow((region) => {
                                const res = __blocks_setBlockGlassRegionConstraint(String(blockId), {
                                    minNd: region?.ndMin,
                                    maxNd: region?.ndMax,
                                    minVd: region?.vdMin,
                                    maxVd: region?.vdMax
                                });
                                if (!res || res.ok !== true) {
                                    alert(`Failed to apply glassRegion constraint: ${res?.reason || 'unknown error'}`);
                                    return;
                                }
                                try { refreshBlockInspector(); } catch (_) {}
                            }, (glass) => {
                                const name = String(glass?.name ?? '').trim();
                                if (!name) return false;

                                const manufacturer = String(glass?.manufacturer ?? '').trim();
                                const hasMfr = !!manufacturer;
                                const priceStr = Number.isFinite(glass?.price) ? Number(glass.price).toFixed(4) : 'null';

                                const msg = `Replace material with ${hasMfr ? (manufacturer + ' ') : ''}${name}?\nprice=${priceStr}`;
                                if (!confirm(msg)) return false;

                                const current = String(currentValue ?? '').trim();
                                const ok = (name === current) ? true : commitValue(name);
                                if (!ok) {
                                    alert('Failed to replace material.');
                                    return false;
                                }
                                try { refreshBlockInspector(); } catch (_) {}
                                return true;
                            });
                        } catch (err) {
                            console.error('Failed to open glass map window', err);
                            alert(err?.message || 'Failed to open glass map window');
                        }
                    });

                    const findBtn = document.createElement('button');
                    findBtn.type = 'button';
                    findBtn.textContent = '🔍';
                    findBtn.title = 'Find similar glasses (nd/vd or name)';
                    findBtn.setAttribute('aria-label', 'Find Glass');
                    findBtn.style.flex = '0 0 auto';
                    findBtn.style.fontSize = '12px';
                    // Match the adjacent material/nd/vd text inputs.
                    findBtn.style.boxSizing = 'border-box';
                    findBtn.style.height = '22px';
                    findBtn.style.display = 'inline-flex';
                    findBtn.style.alignItems = 'center';
                    findBtn.style.justifyContent = 'center';
                    findBtn.style.padding = '2px 6px';
                    findBtn.style.border = '1px solid #ddd';
                    findBtn.style.borderRadius = '4px';
                    findBtn.style.background = '#fff';
                    findBtn.style.cursor = 'pointer';
                    findBtn.addEventListener('click', (e) => {
                        try { e?.preventDefault?.(); } catch (_) {}
                        try { e?.stopPropagation?.(); } catch (_) {}
                        try {
                            const ctrls = materialListEl && materialListEl.__inlineControls ? materialListEl.__inlineControls : null;
                            const mk = String(ctrls?.materialKey ?? materialKey ?? '').trim();
                            if (mk) __blockInspectorPreferredMaterialKeyByBlockId.set(String(blockId), mk);
                            if (ctrls && typeof ctrls.suggest === 'function') ctrls.suggest();
                        } catch (err) {
                            console.error('Find Glass failed', err);
                        }
                    });

                    // Place buttons to the left of the material textbox.
                    // Order: 🗺️ Map, 🔍 Find
                    try { line.insertBefore(mapBtn, valueEl); } catch (_) { line.appendChild(mapBtn); }
                    try { line.insertBefore(findBtn, valueEl); } catch (_) { line.appendChild(findBtn); }
                }

                // For material rows: add ref index + abbe after the material input.
                try {
                    const ctrls = materialListEl && materialListEl.__inlineControls ? materialListEl.__inlineControls : null;
                    if (ctrls && ctrls.ndInput && ctrls.vdInput) {
                        line.appendChild(ctrls.ndInput);
                        line.appendChild(ctrls.vdInput);
                    }
                } catch (_) {}
                panel.appendChild(line);

                if (materialListEl) {
                    panel.appendChild(materialListEl);
                }
            }

            container.appendChild(panel);
        }
    }
}

export function refreshBlockInspector() {
    console.log('[Undo] refreshBlockInspector() called - starting UI rebuild');
    const banner = document.getElementById('import-analyze-mode-banner');
    const setBannerVisible = (isVisible) => {
        if (!banner) return;
        banner.style.display = isVisible ? '' : 'none';
    };

    try {
        // IMPORTANT: use the same configuration source as Load/Save (localStorage systemConfigurations).
        // A missing active config here makes the UI falsely fall back into Import/Analyze mode.
        const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
        const blocks = activeCfg && Array.isArray(activeCfg.blocks) ? activeCfg.blocks : null;
        console.log('[Undo] refreshBlockInspector() - blocks count:', blocks ? blocks.length : 0);

        try {
            // Show Import/Analyze banner only when blocks are actually unavailable.
            // (Some legacy imports may carry metadata.importAnalyzeMode=true; ignore it when blocks exist.)
            const isImportAnalyze = !blocks || blocks.length === 0;
            setBannerVisible(!!isImportAnalyze);
        } catch (_) {}

        if (blocks && blocks.length > 0) {
            // Blocks-only mode: hide Expanded Optical System surface editor.
            __blocks_setExpandedOpticalSystemUIVisible(false);

            // In Blocks-only mode we intentionally do NOT maintain OpticalSystemTableData,
            // so dumpOpticalSystemProvenance() would return empty. Instead, derive counts
            // from the deterministic Blocks->Rows expansion.
            const countById = new Map();
            let expandedRowsForUI = null;
            try {
                if (typeof expandBlocksToOpticalSystemRows === 'function') {
                    const exp = expandBlocksToOpticalSystemRows(blocks);
                    const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
                    expandedRowsForUI = rows;
                    for (const r of rows) {
                        const bid = r?._blockId;
                        if (bid === null || bid === undefined) continue;
                        const id = String(bid).trim();
                        if (!id || id === '(none)') continue;
                        countById.set(id, (countById.get(id) || 0) + 1);
                    }
                }
            } catch (_) {}

            // Keep the evaluation/Spot UI in sync with live Blocks edits (e.g., add/delete CoordTrans)
            // without requiring a full page reload.
            try {
                if (Array.isArray(expandedRowsForUI) && expandedRowsForUI.length > 0) {
                    const rowsForTable = expandedRowsForUI.map((r, idx) => {
                        const row = (r && typeof r === 'object') ? { ...r } : {};
                        row.id = idx;
                        // Ensure first/last rows stay Object/Image for downstream assumptions.
                        if (idx === 0) row['object type'] = 'Object';
                        else if (idx === expandedRowsForUI.length - 1) row['object type'] = 'Image';
                        return row;
                    });

                    const tab = (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function')
                        ? window.tableOpticalSystem
                        : (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.getData === 'function')
                            ? window.opticalSystemTabulator
                            : null;

                    if (tab) {
                        if (typeof tab.replaceData === 'function') {
                            tab.replaceData(rowsForTable);
                        } else if (typeof tab.setData === 'function') {
                            tab.setData(rowsForTable);
                        }
                    }

                    // Force Surf dropdown refresh immediately.
                    try {
                        if (typeof updateSurfaceNumberSelect === 'function') updateSurfaceNumberSelect();
                    } catch (_) {}
                }
            } catch (_) {}

            const merged = blocks.map(b => {
                const id = String(b?.blockId ?? '(none)');
                return {
                    blockId: id,
                    blockType: String(b?.blockType ?? '(none)'),
                    surfaceCount: countById.has(id) ? countById.get(id) : 0,
                    preview: formatBlockPreview(b)
                };
            });

            const blockById = new Map();
            for (const b of blocks) {
                const id = String(b?.blockId ?? '').trim();
                if (!id) continue;
                blockById.set(id, b);
            }
            renderBlockInspector(merged, {}, blockById, blocks);
        } else {
            __blocks_setExpandedOpticalSystemUIVisible(true);
            if (typeof window.dumpOpticalSystemProvenance !== 'function') return;
            const result = window.dumpOpticalSystemProvenance({ quiet: true });
            renderBlockInspector(result?.summary || [], result?.groups || {}, null, null);
        }
    } catch (e) {
        console.warn('⚠️ [Blocks] Failed to refresh block inspector:', e);
    }
}

function __blocks_mapSurfaceEditToBlockChange(edit) {
    const row = edit?.row;
    const field = __blocks_normalizeEditedFieldKey(edit?.field);
    const oldValue = edit?.oldValue;
    const newValue = edit?.newValue;

    if (!row || typeof row !== 'object') return null;
    const blockId = row._blockId;
    const blockType = __blocks_normalizeProvenanceBlockType(row._blockType);
    const role = __blocks_normalizeRole(row._surfaceRole);
    if (!blockId || blockId === '(none)') return null;
    if (!blockType) return null;
    if (oldValue === newValue) return null;
    const isOptimizeFlagField = field === 'optimizeT' || field === 'optimizeR' || field === 'optimizeMaterial' || field === 'optimizeSemiDia';
    if (!isOptimizeFlagField) {
        // Allow INF for radius (common for plane surfaces). Still reject AUTO/blank.
        if (__blocks_isAutoOrBlankValue(newValue)) return null;
        if (__blocks_isInfValue(newValue) && field !== 'radius') return null;
    }

    const normalizeSurfType = (v) => {
        const s = String(v ?? '').trim();
        if (s === '') return null;
        const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
        if (key === 'spherical') return 'Spherical';
        if (key === 'asphericeven' || key === 'asphericaleven') return 'Aspheric even';
        if (key === 'asphericodd' || key === 'asphericalodd') return 'Aspheric odd';
        return null;
    };

    // When applying coef/conic edits, also infer the surface type from the *current* expanded row.
    // This prevents coef=0 from being "normalized away" during Blocks->Surfaces re-expansion
    // when the canonical block surfType field is blank.
    const inferRowSurfType = () => {
        try {
            const stRaw = row?.surfType ?? row?.['surf type'] ?? row?.surfTypeName ?? row?.type;
            return normalizeSurfType(stRaw);
        } catch (_) {
            return null;
        }
    };

    const maybeSurfTypeChange = (variableKey) => {
        // If the user is editing conic/coef fields, we must ensure the canonical SurfType
        // is non-spherical. Otherwise, Blocks->Surfaces expansion will choose 'Spherical'
        // when all terms are zero and will clear coef/conic fields, making "apply 0"
        // appear as a no-op.
        const st = inferRowSurfType();
        const normalized = (st === 'Aspheric even' || st === 'Aspheric odd') ? st : null;
        return {
            blockId: String(blockId),
            blockType: String(blockType),
            variable: String(variableKey),
            oldValue: null,
            newValue: normalized || 'Aspheric even'
        };
    };

    if (blockType === 'Mirror') {
        if (field === 'semidia') {
            return { blockId: String(blockId), blockType: 'Mirror', variable: 'semidia', oldValue, newValue };
        }
        if (field === 'surftype') {
            const normalized = normalizeSurfType(newValue);
            if (!normalized) return null;
            return { blockId: String(blockId), blockType: 'Mirror', variable: 'surfType', oldValue, newValue: normalized };
        }
        if (field === 'conic') {
            const stCh = maybeSurfTypeChange('surfType');
            return stCh ? [stCh, { blockId: String(blockId), blockType: 'Mirror', variable: 'conic', oldValue, newValue }] : { blockId: String(blockId), blockType: 'Mirror', variable: 'conic', oldValue, newValue };
        }
        const m = /^coef(\d+)$/.exec(field);
        if (m) {
            const idx = Number(m[1]);
            if (!Number.isFinite(idx) || idx < 1 || idx > 10) return null;
            const stCh = maybeSurfTypeChange('surfType');
            return stCh ? [stCh, { blockId: String(blockId), blockType: 'Mirror', variable: `coef${idx}`, oldValue, newValue }] : { blockId: String(blockId), blockType: 'Mirror', variable: `coef${idx}`, oldValue, newValue };
        }
        if (field === 'radius') {
            return { blockId: String(blockId), blockType: 'Mirror', variable: 'radius', oldValue, newValue };
        }
        if (field === 'thickness') {
            return { blockId: String(blockId), blockType: 'Mirror', variable: 'thickness', oldValue, newValue };
        }
        return null;
    }

    if (blockType === 'Lens') {
        if (field === 'semidia') {
            if (role !== 'front' && role !== 'back') return null;
            return { blockId: String(blockId), blockType: 'Lens', kind: 'apertureSemidia', role, oldValue, newValue };
        }
        if (field === 'optimizeT') {
            const mode = String(newValue ?? '').trim().toUpperCase() === 'V' ? 'V' : 'F';
            if (role === 'front') return { blockId: String(blockId), blockType: 'Lens', kind: 'optimizeMode', variable: 'centerThickness', oldValue, newValue: mode };
            if (role === 'back') {
                const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
                if (!airGapId) {
                    console.warn(`⚠️ Lens back optimizeT edit: no following AirGap found for blockId=${blockId}.`);
                    return null;
                }
                return { blockId: String(airGapId), blockType: 'AirGap', kind: 'optimizeMode', variable: 'thickness', oldValue, newValue: mode };
            }
            return null;
        }
        if (field === 'surftype') {
            if (role !== 'front' && role !== 'back') return null;
            const normalized = normalizeSurfType(newValue);
            if (!normalized) return null;
            return { blockId: String(blockId), blockType: 'Lens', variable: role === 'front' ? 'frontSurfType' : 'backSurfType', oldValue, newValue: normalized };
        }
        if (field === 'conic') {
            if (role !== 'front' && role !== 'back') return null;
            const conicVar = role === 'front' ? 'frontConic' : 'backConic';
            const stVar = role === 'front' ? 'frontSurfType' : 'backSurfType';
            const stCh = maybeSurfTypeChange(stVar);
            return stCh ? [stCh, { blockId: String(blockId), blockType: 'Lens', variable: conicVar, oldValue, newValue }] : { blockId: String(blockId), blockType: 'Lens', variable: conicVar, oldValue, newValue };
        }
        const m = /^coef(\d+)$/.exec(field);
        if (m) {
            const idx = Number(m[1]);
            if (!Number.isFinite(idx) || idx < 1 || idx > 10) return null;
            if (role !== 'front' && role !== 'back') return null;
            const coefVar = `${role === 'front' ? 'front' : 'back'}Coef${idx}`;
            const stVar = role === 'front' ? 'frontSurfType' : 'backSurfType';
            const stCh = maybeSurfTypeChange(stVar);
            return stCh ? [stCh, { blockId: String(blockId), blockType: 'Lens', variable: coefVar, oldValue, newValue }] : { blockId: String(blockId), blockType: 'Lens', variable: coefVar, oldValue, newValue };
        }
        if (field === 'radius') {
            if (role === 'front') return { blockId: String(blockId), blockType: 'Lens', variable: 'frontRadius', oldValue, newValue };
            if (role === 'back') return { blockId: String(blockId), blockType: 'Lens', variable: 'backRadius', oldValue, newValue };
            return null;
        }
        if (field === 'material') {
            if (role !== 'front' && role !== 'back') return null;
            const mat = String(newValue ?? '').trim();
            if (!mat || mat.toUpperCase() === 'AIR') return null;
            return { blockId: String(blockId), blockType: 'Lens', variable: 'material', oldValue, newValue: mat };
        }
        if (field === 'thickness') {
            if (role === 'front') return { blockId: String(blockId), blockType: 'Lens', variable: 'centerThickness', oldValue, newValue };
            if (role === 'back') {
                let airGapId = __blocks_findFollowingAirGapBlockId(blockId);
                if (!airGapId) {
                    console.warn(`⚠️ Lens back thickness edit: no following AirGap found for blockId=${blockId}.`);
                    console.log(`✨ Auto-creating AirGap block after ${blockId}...`);
                    airGapId = __blocks_autoCreateFollowingAirGap(blockId, newValue);
                    if (!airGapId) {
                        console.warn(`   Failed to auto-create AirGap. Using fallback: backAirThickness on Lens itself.`);
                        return { blockId: String(blockId), blockType: 'Lens', variable: 'backAirThickness', oldValue, newValue };
                    }
                }
                return { blockId: String(airGapId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
            }
            // Fallback: if role is missing or unknown, try to infer or default to centerThickness
            // This handles cases where provenance is incomplete
            console.warn(`⚠️ Lens thickness edit with unknown role: ${role}. Defaulting to centerThickness.`);
            return { blockId: String(blockId), blockType: 'Lens', variable: 'centerThickness', oldValue, newValue };
        }
        return null;
    }

    if (blockType === 'Doublet' || blockType === 'Triplet') {
        if (field === 'semidia') {
            if (!role) return null;
            return { blockId: String(blockId), blockType, kind: 'apertureSemidia', role, oldValue, newValue };
        }
        const surfIdx = __blocks_parseSurfaceIndexFromRole(role);
        if (!surfIdx) {
            // Role is missing or unparseable - try to handle thickness as a fallback
            if (field === 'thickness') {
                console.warn(`⚠️ ${blockType} thickness edit with unparseable role: ${role}. Attempting to apply to following AirGap.`);
                const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
                if (airGapId) {
                    return { blockId: String(airGapId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
                }
            }
            return null;
        }
        const elemCount = (blockType === 'Doublet') ? 2 : 3;
        const lastSurfIdx = elemCount + 1;

        if (field === 'optimizeT') {
            const mode = String(newValue ?? '').trim().toUpperCase() === 'V' ? 'V' : 'F';
            if (surfIdx >= 1 && surfIdx <= elemCount) {
                return { blockId: String(blockId), blockType, kind: 'optimizeMode', variable: `thickness${surfIdx}`, oldValue, newValue: mode };
            }
            if (surfIdx === lastSurfIdx) {
                const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
                if (!airGapId) {
                    console.warn(`⚠️ ${blockType} last surface optimizeT edit: no following AirGap found for blockId=${blockId}.`);
                    return null;
                }
                return { blockId: String(airGapId), blockType: 'AirGap', kind: 'optimizeMode', variable: 'thickness', oldValue, newValue: mode };
            }
            return null;
        }

        if (field === 'surftype') {
            const normalized = normalizeSurfType(newValue);
            if (!normalized) return null;
            return { blockId: String(blockId), blockType, variable: `surf${surfIdx}SurfType`, oldValue, newValue: normalized };
        }
        if (field === 'conic') {
            const conicVar = `surf${surfIdx}Conic`;
            const stVar = `surf${surfIdx}SurfType`;
            const stCh = maybeSurfTypeChange(stVar);
            return stCh ? [stCh, { blockId: String(blockId), blockType, variable: conicVar, oldValue, newValue }] : { blockId: String(blockId), blockType, variable: conicVar, oldValue, newValue };
        }
        const m = /^coef(\d+)$/.exec(field);
        if (m) {
            const idx = Number(m[1]);
            if (!Number.isFinite(idx) || idx < 1 || idx > 10) return null;
            const coefVar = `surf${surfIdx}Coef${idx}`;
            const stVar = `surf${surfIdx}SurfType`;
            const stCh = maybeSurfTypeChange(stVar);
            return stCh ? [stCh, { blockId: String(blockId), blockType, variable: coefVar, oldValue, newValue }] : { blockId: String(blockId), blockType, variable: coefVar, oldValue, newValue };
        }
        if (field === 'radius') return { blockId: String(blockId), blockType, variable: `radius${surfIdx}`, oldValue, newValue };
        if (field === 'material') {
            if (surfIdx > elemCount) return null;
            const mat = String(newValue ?? '').trim();
            if (!mat || mat.toUpperCase() === 'AIR') return null;
            return { blockId: String(blockId), blockType, variable: `material${surfIdx}`, oldValue, newValue: mat };
        }
        if (field === 'thickness') {
            if (surfIdx >= 1 && surfIdx <= elemCount) return { blockId: String(blockId), blockType, variable: `thickness${surfIdx}`, oldValue, newValue };
            if (surfIdx === lastSurfIdx) {
                let airGapId = __blocks_findFollowingAirGapBlockId(blockId);
                if (!airGapId) {
                    console.warn(`⚠️ ${blockType} last surface thickness edit: no following AirGap found for blockId=${blockId}.`);
                    console.log(`✨ Auto-creating AirGap block after ${blockId}...`);
                    airGapId = __blocks_autoCreateFollowingAirGap(blockId, newValue);
                    if (!airGapId) {
                        console.warn(`   Failed to auto-create AirGap. Using fallback.`);
                        return { blockId: String(blockId), blockType, variable: `backAirThickness`, oldValue, newValue };
                    }
                }
                return { blockId: String(airGapId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
            }
            return null;
        }
        return null;
    }

    if (blockType === 'Stop') {
        if (field === 'optimizeT') {
            const mode = String(newValue ?? '').trim().toUpperCase() === 'V' ? 'V' : 'F';
            const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
            if (!airGapId) {
                console.warn(`⚠️ Stop optimizeT edit: no following AirGap found for blockId=${blockId}.`);
                return null;
            }
            return { blockId: String(airGapId), blockType: 'AirGap', kind: 'optimizeMode', variable: 'thickness', oldValue, newValue: mode };
        }
        if (field === 'semidia') return { blockId: String(blockId), blockType: 'Stop', variable: 'semiDiameter', oldValue, newValue };
        if (field === 'thickness') {
            let airGapId = __blocks_findFollowingAirGapBlockId(blockId);
            if (!airGapId) {
                console.warn(`⚠️ Stop thickness edit: no following AirGap found for blockId=${blockId}.`);
                console.log(`✨ Auto-creating AirGap block after ${blockId}...`);
                airGapId = __blocks_autoCreateFollowingAirGap(blockId, newValue);
                if (!airGapId) {
                    console.warn(`   Failed to auto-create AirGap. Using fallback.`);
                    return { blockId: String(blockId), blockType: 'Stop', variable: 'thickness', oldValue, newValue };
                }
            }
            return { blockId: String(airGapId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
        }
        return null;
    }

    if (blockType === 'CoordTrans') {
        // Expanded Coord Break row field reuse:
        // semidia->decenterX, material->decenterY, thickness->decenterZ,
        // rindex->tiltX, abbe->tiltY, conic->tiltZ, coef1->order
        if (field === 'semidia') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'decenterX', oldValue, newValue };
        if (field === 'material') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'decenterY', oldValue, newValue };
        if (field === 'thickness') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'decenterZ', oldValue, newValue };
        if (field === 'rindex') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'tiltX', oldValue, newValue };
        if (field === 'abbe') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'tiltY', oldValue, newValue };
        if (field === 'conic') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'tiltZ', oldValue, newValue };
        if (field === 'coef1') return { blockId: String(blockId), blockType: 'CoordTrans', variable: 'order', oldValue, newValue };
        return null;
    }

    if (blockType === 'AirGap') {
        if (field === 'optimizeT') {
            const mode = String(newValue ?? '').trim().toUpperCase() === 'V' ? 'V' : 'F';
            return { blockId: String(blockId), blockType: 'AirGap', kind: 'optimizeMode', variable: 'thickness', oldValue, newValue: mode };
        }
        if (field === 'thickness') return { blockId: String(blockId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
        return null;
    }

    if (blockType === 'ImageSurface') {
        // ImageSurface itself typically doesn't have thickness, but the air space before it does
        if (field === 'optimizeT') {
            const mode = String(newValue ?? '').trim().toUpperCase() === 'V' ? 'V' : 'F';
            const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
            if (airGapId) {
                return { blockId: String(airGapId), blockType: 'AirGap', kind: 'optimizeMode', variable: 'thickness', oldValue, newValue: mode };
            }
            return null;
        }
        if (field === 'thickness') {
            const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
            if (airGapId) {
                return { blockId: String(airGapId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
            }
            // ImageSurface is usually the last block, so no following AirGap is expected
            // Try to apply to the block itself in case it has a thickness parameter
            console.warn('⚠️ ImageSurface thickness edit: no following AirGap found, attempting to apply to ImageSurface itself');
            return { blockId: String(blockId), blockType: 'ImageSurface', variable: 'thickness', oldValue, newValue };
        }
        if (field === 'semidia') {
            return { blockId: String(blockId), blockType: 'ImageSurface', variable: 'semidia', oldValue, newValue };
        }
        if (field === 'optimizeSemiDia') {
            return { blockId: String(blockId), blockType: 'ImageSurface', variable: 'optimizeSemiDia', oldValue, newValue };
        }
        return null;
    }

    // Generic fallback for other block types (e.g., Window, Mirror, etc.)
    // If thickness field is edited, try to apply it to the following AirGap
    if (field === 'thickness') {
        const airGapId = __blocks_findFollowingAirGapBlockId(blockId);
        if (airGapId) {
            console.log(`✅ Mapping thickness for blockType=${blockType} to following AirGap ${airGapId}`);
            return { blockId: String(airGapId), blockType: 'AirGap', variable: 'thickness', oldValue, newValue };
        }
        // If no following AirGap, check if this block itself has a thickness parameter/variable
        // (Some blocks like Window or custom types might have their own thickness)
        console.log(`✅ Mapping thickness for blockType=${blockType} to block itself (no following AirGap)`);
        return { blockId: String(blockId), blockType, variable: 'thickness', oldValue, newValue };
    }

    return null;
}

function __blocks_applyChangeToActiveConfig(change) {
    const activeCfg = getActiveConfiguration();
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return false;
    const target = activeCfg.blocks.find(b => b && String(b.blockId ?? '') === String(change.blockId));
    if (!target) {
        console.warn(`⚠️ Target block not found: ${change.blockId}`);
        return false;
    }

    // Optimization-flag change: update variables[*].optimize.mode.
    if (change && change.kind === 'optimizeMode') {
        const key = String(change.variable ?? '').trim();
        if (!key) return false;
        const enabled = String(change.newValue ?? '').trim().toUpperCase() === 'V';

        if (!target.variables || typeof target.variables !== 'object') target.variables = {};
        if (!target.variables[key] || typeof target.variables[key] !== 'object') {
            target.variables[key] = { value: target.parameters?.[key] ?? '' };
        }
        if (!target.variables[key].optimize || typeof target.variables[key].optimize !== 'object') {
            target.variables[key].optimize = {};
        }

        target.variables[key].optimize.mode = enabled ? 'V' : 'F';
        console.log(`📝 Applying optimize flag to ${change.blockId}.${key}: ${enabled ? 'V' : 'F'}`);

        try {
            const systemConfig = loadSystemConfigurations();
            if (systemConfig && Array.isArray(systemConfig.configurations)) {
                const activeId = systemConfig.activeConfigId;
                const idx = systemConfig.configurations.findIndex(c => c && String(c.id) === String(activeId));
                if (idx >= 0) {
                    systemConfig.configurations[idx] = activeCfg;
                    saveSystemConfigurations(systemConfig);
                    console.log(`💾 Saved optimize flag to localStorage: ${change.blockId}.${key} = ${enabled ? 'V' : 'F'}`);
                }
            }
        } catch (err) {
            console.error('Failed to save optimize flag to localStorage:', err);
        }

        return true;
    }

    // Semidia (aperture) change: persist into Design Intent (blocks) as block.aperture[role].
    if (change && change.kind === 'apertureSemidia') {
        const role = String(change.role ?? '').trim();
        if (!role) return false;
        if (!target.aperture || typeof target.aperture !== 'object') target.aperture = {};
        target.aperture[role] = change.newValue;

        try {
            const systemConfig = loadSystemConfigurations();
            if (systemConfig && Array.isArray(systemConfig.configurations)) {
                const activeId = systemConfig.activeConfigId;
                const idx = systemConfig.configurations.findIndex(c => c && String(c.id) === String(activeId));
                if (idx >= 0) {
                    systemConfig.configurations[idx] = activeCfg;
                    saveSystemConfigurations(systemConfig);
                    console.log(`💾 Saved aperture semidia to localStorage: ${change.blockId} [${role}] = ${change.newValue}`);
                }
            }
        } catch (err) {
            console.error('Failed to save aperture semidia to localStorage:', err);
        }
        return true;
    }

    if (!target.parameters || typeof target.parameters !== 'object') target.parameters = {};
    
    console.log(`📝 Applying change to ${change.blockId}.${change.variable}: ${change.oldValue} → ${change.newValue}`);
    
    // Canonical value lives in parameters (used by expandBlocksToOpticalSystemRows via getParamOrVarValue).
    // Also mirror into variables.value when present so inspector/UI stays consistent.
    target.parameters[change.variable] = change.newValue;
    if (target.variables && typeof target.variables === 'object' && target.variables[change.variable] && typeof target.variables[change.variable] === 'object') {
        target.variables[change.variable].value = change.newValue;
    }
    
    // Persist to localStorage
    try {
        const systemConfig = loadSystemConfigurations();
        if (systemConfig && Array.isArray(systemConfig.configurations)) {
            const activeId = systemConfig.activeConfigId;
            const idx = systemConfig.configurations.findIndex(c => c && String(c.id) === String(activeId));
            if (idx >= 0) {
                systemConfig.configurations[idx] = activeCfg;
                saveSystemConfigurations(systemConfig);
                console.log(`💾 Saved change to localStorage: ${change.blockId}.${change.variable} = ${change.newValue}`);
            }
        }
    } catch (err) {
        console.error('Failed to save change to localStorage:', err);
    }
    
    return true;
}

function __blocks_debugVerifyAppliedChanges(activeCfg, changes, expandedRows) {
    try {
        const debugEnabled = !!globalThis.__cooptDebugApplyToDesignIntent;
        if (!debugEnabled) return;
        const cfg = activeCfg && typeof activeCfg === 'object' ? activeCfg : null;
        const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
        const rows = Array.isArray(expandedRows) ? expandedRows : [];

        const mapChangeToRoleField = (ch) => {
            if (!ch || typeof ch !== 'object') return null;
            if (ch.kind) return null; // optimizeMode / apertureSemidia
            const variable = String(ch.variable ?? '').trim();
            if (!variable) return null;

            let role = null;
            let field = null;

            // Lens
            if (variable.startsWith('front')) role = 'front';
            if (variable.startsWith('back')) role = 'back';

            // Doublet/Triplet surfN
            const mSurf = /^surf(\d+)(SurfType|Conic|Coef\d+)$/.exec(variable);
            if (mSurf) role = `s${mSurf[1]}`;

            if (variable.endsWith('SurfType')) field = 'surfType';
            else if (variable.endsWith('Conic')) field = 'conic';
            else {
                const m = /Coef(\d+)$/.exec(variable);
                if (m) field = `coef${m[1]}`;
            }
            if (!role || !field) return null;
            return { role, field };
        };

        const records = [];
        for (const ch of changes.slice(0, 20)) {
            const blockId = String(ch?.blockId ?? '');
            const blockType = String(ch?.blockType ?? '');
            const variable = String(ch?.variable ?? ch?.kind ?? '');
            const mapping = mapChangeToRoleField(ch);

            const b = blocks.find(x => x && String(x.blockId ?? '') === blockId) || null;
            const stored = b && b.parameters && typeof b.parameters === 'object' ? b.parameters[ch.variable] : undefined;

            let rowValue = undefined;
            if (mapping) {
                const rr = rows.find(r => r && String(r._blockId ?? '') === blockId && String(r._surfaceRole ?? '') === mapping.role) || null;
                rowValue = rr ? rr[mapping.field] : undefined;
            }

            records.push({
                blockId,
                blockType,
                variable,
                oldValue: ch?.oldValue,
                newValue: ch?.newValue,
                role: mapping?.role ?? null,
                surfaceField: mapping?.field ?? null,
                storedInBlock: stored,
                expandedRowValue: rowValue
            });
        }

        console.log('🧪 [ApplyToDesignIntent] Debug verify (enable flag: __cooptDebugApplyToDesignIntent=true):');
        console.table(records);
    } catch (e) {
        console.warn('⚠️ [ApplyToDesignIntent] Debug verify failed:', e);
    }
}

function setupApplyToDesignIntentButton() {
    const btn = document.getElementById('apply-to-design-intent-btn');
    if (!btn) return;

    // Guard: setupDOMEventHandlers can be invoked more than once in some loading flows.
    // Avoid registering duplicate click handlers (would Apply twice).
    if (btn.dataset && btn.dataset.applyToDesignIntentBound === '1') return;
    if (btn.dataset) btn.dataset.applyToDesignIntentBound = '1';

    btn.addEventListener('click', () => {
        try {
            const tbl = window.tableOpticalSystem || globalThis.tableOpticalSystem;
            const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
            if (!Array.isArray(rows) || rows.length === 0) {
                alert('Expanded Optical System が見つかりません。');
                return;
            }

            const ensureBlocksFromCurrentSurfacesIfNeeded = () => {
                const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
                if (!activeCfg) return { ok: false, reason: 'active configuration not found.' };

                // If expanded rows carry no provenance, Blocks are effectively unavailable.
                const hasProvenance = rows.some(r => r && typeof r === 'object' && r._blockId && String(r._blockId).trim() !== '');
                const hasBlocks = Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0;
                if (hasBlocks && hasProvenance) return { ok: true, changed: false };

                const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
                const fatals = Array.isArray(derived?.issues) ? derived.issues.filter(i => i && i.severity === 'fatal') : [];
                if (fatals.length > 0) {
                    // Keep surface workflow; report why Blocks could not be derived.
                    try {
                        const warnings = fatals.map(f => ({ ...f, severity: 'warning', message: `Blocks conversion skipped: ${f?.message || String(f)}` }));
                        showLoadErrors(warnings, { filename: '(apply)' });
                    } catch (_) {}
                    return { ok: false, reason: 'Blocks conversion failed.' };
                }

                activeCfg.schemaVersion = activeCfg.schemaVersion || BLOCK_SCHEMA_VERSION;
                activeCfg.blocks = Array.isArray(derived?.blocks) ? derived.blocks : [];
                if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                activeCfg.metadata.importAnalyzeMode = false;

                // Persist mutated active config back into localStorage systemConfigurations.
                try {
                    const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
                    if (systemConfig && Array.isArray(systemConfig.configurations)) {
                        const activeId = systemConfig.activeConfigId;
                        const idx = systemConfig.configurations.findIndex(c => c && String(c.id) === String(activeId));
                        if (idx >= 0) systemConfig.configurations[idx] = activeCfg;
                        localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
                    }
                } catch (_) {}

                // Re-expand now so rows get provenance for subsequent Apply.
                try {
                    const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
                    try { __blocks_mergeLegacyIndexFieldsIntoExpandedRows(rows, expanded.rows); } catch (_) {}
                    localStorage.setItem('OpticalSystemTableData', JSON.stringify(expanded.rows));
                    try { saveLensTableData(expanded.rows); } catch (_) {}
                    try { if (tbl && typeof tbl.setData === 'function') tbl.setData(expanded.rows); } catch (_) {}
                    try { refreshBlockInspector(); } catch (_) {}
                } catch (_) {}

                return { ok: true, changed: true };
            };

            /** @type {Array<{row:any, field:string, oldValue:any, newValue:any}>} */
            const edits = [];
            try {
                const pending = globalThis.__pendingSurfaceEdits;
                if (pending && typeof pending === 'object') {
                    for (const [key, v] of Object.entries(pending)) {
                        const [sidRaw, fieldRaw] = String(key).split(':');
                        const surfaceId = Number(sidRaw);
                        const field = String(fieldRaw ?? '').trim();
                        if (!Number.isFinite(surfaceId) || !field) continue;
                        const row = rows.find(r => r && typeof r.id === 'number' && r.id === surfaceId);
                        if (!row) continue;
                        edits.push({ row, field, oldValue: v?.oldValue, newValue: row[field] });
                    }
                }
            } catch (_) {}
            if (edits.length === 0 && globalThis.__lastSurfaceEdit) edits.push(globalThis.__lastSurfaceEdit);

            // Fallback: Tabulator may not have populated __pendingSurfaceEdits/__lastSurfaceEdit in some setups.
            // Use the currently selected cell as an Apply target.
            if (edits.length === 0) {
                try {
                    const cells = (tbl && typeof tbl.getSelectedCells === 'function') ? tbl.getSelectedCells() : [];
                    const cell = Array.isArray(cells) && cells.length > 0 ? cells[cells.length - 1] : null;
                    if (cell && typeof cell.getField === 'function' && typeof cell.getRow === 'function') {
                        const field = cell.getField();
                        const rowData = cell.getRow()?.getData?.() ?? null;
                        const newValue = (typeof cell.getValue === 'function') ? cell.getValue() : (rowData ? rowData[field] : undefined);
                        let oldValue = undefined;
                        try { oldValue = (typeof cell.getOldValue === 'function') ? cell.getOldValue() : undefined; } catch (_) {}
                        // If we still don't have oldValue, use a neutral value so the mapping path runs.
                        if (oldValue === undefined) oldValue = null;
                        if (rowData) edits.push({ row: rowData, field, oldValue, newValue });
                    }
                } catch (_) {}
            }

            // Fallback 2: if selection is unavailable, use the last active surface cell metadata.
            if (edits.length === 0) {
                try {
                    const last = globalThis.__lastActiveSurfaceCell || globalThis.__lastSelectedSurfaceCell;
                    const surfaceId = Number(last?.surfaceId);
                    const field = String(last?.field ?? '').trim();
                    if (Number.isFinite(surfaceId) && field) {
                        const row = rows.find(r => r && typeof r.id === 'number' && r.id === surfaceId);
                        if (row) edits.push({ row, field, oldValue: null, newValue: row[field] });
                    }
                } catch (_) {}
            }
            if (edits.length === 0) {
                alert('Apply対象の変更が見つかりません。');
                return;
            }

            const changes = edits.flatMap((e) => {
                const mapped = __blocks_mapSurfaceEditToBlockChange(e);
                if (!mapped) return [];
                return Array.isArray(mapped) ? mapped.filter(Boolean) : [mapped];
            });
            if (changes.length === 0) {
                let debugInfo = '';
                try {
                    console.warn('⚠️ [Blocks] No mappable changes from edits. Details:');
                    for (const e of edits) {
                        const reason = __blocks_explainSurfaceEditMappingFailure(e);
                        const normalizedField = __blocks_normalizeEditedFieldKey(e?.field);
                        const normalizedBlockType = __blocks_normalizeProvenanceBlockType(e?.row?._blockType);
                        const normalizedRole = __blocks_normalizeRole(e?.row?._surfaceRole);
                        const info = {
                            field: e?.field,
                            normalizedField,
                            oldValue: e?.oldValue,
                            newValue: e?.newValue,
                            blockId: e?.row?._blockId,
                            blockType: e?.row?._blockType,
                            normalizedBlockType,
                            surfaceRole: e?.row?._surfaceRole,
                            normalizedRole,
                            reason
                        };
                        console.warn('  - edit:', info);
                        debugInfo += `\n• Field: ${normalizedField} (raw: ${e?.field})\n  BlockType: ${normalizedBlockType} (raw: ${info.blockType || '(none)'})\n  Role: ${normalizedRole} (raw: ${info.surfaceRole || '(none)'})\n  Reason: ${reason}`;
                    }
                } catch (_) {}

                // If we can't map edits, Blocks/provenance may be missing. Auto-derive Blocks once.
                const ensured = ensureBlocksFromCurrentSurfacesIfNeeded();
                if (ensured && ensured.ok && ensured.changed) {
                    alert('Design Intent (Blocks) を Surface から自動生成しました。\n\nもう一度 Apply を押してください。');
                    return;
                }

                alert('Apply可能な変更がありません（Blocksへ逆マッピング未対応か、値が不正です）。\n\n詳細はコンソールを確認してください。' + debugInfo);
                return;
            }

            let applied = 0;
            for (const ch of changes) if (__blocks_applyChangeToActiveConfig(ch)) applied++;
            if (applied === 0) {
                // Common failure mode: expanded rows have provenance but the active configuration
                // has no matching blocks (e.g. storage mismatch / legacy import state).
                // Try to derive Blocks once from current surfaces, then ask user to Apply again.
                try {
                    const ensured = ensureBlocksFromCurrentSurfacesIfNeeded();
                    if (ensured && ensured.ok && ensured.changed) {
                        alert('Design Intent (Blocks) を Surface から自動生成しました。\n\nもう一度 Apply を押してください。');
                        return;
                    }
                } catch (_) {}

                try {
                    const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
                    const ids = new Set((activeCfg && Array.isArray(activeCfg.blocks)) ? activeCfg.blocks.map(b => String(b?.blockId ?? '')) : []);
                    const missing = changes
                        .map(c => String(c?.blockId ?? ''))
                        .filter(id => id && !ids.has(id));
                    if (missing.length > 0) {
                        console.warn('⚠️ [Blocks] Apply failed: target blocks missing in active config:', missing);
                    }
                } catch (_) {}

                alert('Blocksへの反映に失敗しました。\n\n詳細はコンソールを確認してください。');
                return;
            }

            try {
                const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
                if (activeCfg && Array.isArray(activeCfg.blocks)) {
                    const issues = validateBlocksConfiguration(activeCfg);
                    const fatals = issues.filter(i => i && i.severity === 'fatal');
                    if (fatals.length > 0) {
                        try { showLoadErrors(issues, { filename: '(active config)' }); } catch (_) {}
                        return;
                    }
                    const prevRows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
                    const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
                    try { __blocks_debugVerifyAppliedChanges(activeCfg, changes, expanded.rows); } catch (_) {}
                    try { __blocks_mergeLegacyIndexFieldsIntoExpandedRows(prevRows, expanded.rows); } catch (_) {}
                    try { __blocks_mergeLegacySemidiaIntoExpandedRows(prevRows, expanded.rows); } catch (_) {}
                    localStorage.setItem('OpticalSystemTableData', JSON.stringify(expanded.rows));
                    try { saveLensTableData(expanded.rows); } catch (_) {}
                    try { if (window.tableOpticalSystem && typeof window.tableOpticalSystem.setData === 'function') window.tableOpticalSystem.setData(expanded.rows); } catch (_) {}
                }
            } catch (e) {
                console.warn('⚠️ Failed to validate/expand blocks:', e);
            }

            try { refreshBlockInspector(); } catch (_) {}
            try { globalThis.__pendingSurfaceEdits = {}; } catch (_) {}
            // Auto redraw 3D popup after Apply
            try {
                const popup = window.popup3DWindow;
                if (popup && !popup.closed && typeof popup.postMessage === 'function') {
                    popup.postMessage({ action: 'request-redraw' }, '*');
                }
            } catch (_) {}
            console.log(`✅ Applied ${applied}/${changes.length} changes to Blocks`);
        } catch (e) {
            console.error('❌ Apply to Design Intent failed:', e);
            alert(`Apply failed: ${e?.message || String(e)}`);
        }
    });
}
