import { preloadRustRayTracingWasm } from '../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import { detectConjugateType } from '../../utils/conjugate-detection.ts';

function isCoordTransRowForLca(row: any): boolean {
    const raw = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '').trim().toLowerCase();
    const compact = raw.replace(/[\s_-]+/g, '');
    return raw === 'coord trans' || raw === 'coordinate transform' || compact === 'coordtrans' || compact === 'coordinatebreak' || compact === 'ct';
}

function isObjectRowForLca(row: any): boolean {
    const raw = String(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '').trim().toLowerCase();
    return raw === 'object' || raw === 'obj';
}

function isGapRowForLca(row: any): boolean {
    const norm = (v: any) => String(v ?? '').trim().toLowerCase();
    const compact = (v: any) => norm(v).replace(/[\s_-]+/g, '');
    const surfType = norm(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const surfTypeCompact = compact(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const blockType = norm(row?._blockType ?? row?.blockType ?? '');
    const blockTypeCompact = compact(row?._blockType ?? row?.blockType ?? '');
    const kind = norm(row?.kind ?? '');
    const kindCompact = compact(row?.kind ?? '');
    return (
        surfType === 'gap' || surfType === 'air gap' || surfTypeCompact === 'gap' || surfTypeCompact === 'airgap' ||
        blockType === 'gap' || blockType === 'air gap' || blockTypeCompact === 'gap' || blockTypeCompact === 'airgap' ||
        kind === 'gap' || kind === 'air gap' || kindCompact === 'gap' || kindCompact === 'airgap'
    );
}

function surfaceIndexToRayPathPointIndexForLca(opticalSystemRows: any[], surfaceIndex: number): number | null {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const sIdx = Math.max(0, Math.min(surfaceIndex, opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (isCoordTransRowForLca(row)) continue;
        if (isObjectRowForLca(row)) continue;
        if (isGapRowForLca(row)) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function readAnyProp(source: any, keys: string[]): any {
    if (!source) return undefined;
    for (const key of keys) {
        if (source instanceof Map && source.has(key)) return source.get(key);
        if (typeof source === 'object' && key in source) return (source as any)[key];
    }
    return undefined;
}

function toArrayMaybe(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (value instanceof Float64Array) return Array.from(value);
    if (value && typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') {
        try { return Array.from(value as any); } catch (_) { return []; }
    }
    return [];
}

function normalizeRustLcaEntry(raw: any): any | null {
    if (!raw) return null;
    const wavelengthRaw = readAnyProp(raw, ['wavelength', 'lambda', 'wavelength_um', 'wavelengthUm']);
    const displacementsRaw = readAnyProp(raw, ['displacements', 'displacement', 'disp']);
    const imageHeightsRaw = readAnyProp(raw, ['imageHeights', 'image_heights', 'heights']);

    const wavelength = Number(wavelengthRaw);
    const displacements = toArrayMaybe(displacementsRaw);
    const imageHeights = toArrayMaybe(imageHeightsRaw);

    if (!Number.isFinite(wavelength)) return null;
    return {
        wavelength,
        displacements,
        imageHeights,
    };
}

function extractChiefRaySegmentsForLca(chief: any): any[] {
    if (!chief || typeof chief !== 'object') return [];
    const direct = Array.isArray(chief?.segments) ? chief.segments : null;
    if (direct && direct.length) return direct;
    const rayData = Array.isArray(chief?.rayData?.segments) ? chief.rayData.segments : null;
    if (rayData && rayData.length) return rayData;
    const rayPath = Array.isArray(chief?.ray?.path) ? chief.ray.path : null;
    if (rayPath && rayPath.length) return rayPath;
    return [];
}

function normalizeRustLcaReducerResult(raw: any): Array<any> {
    if (!raw) return [];

    let value: any = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch (_) {
            return [];
        }
    }

    const data = readAnyProp(value, ['dataByWavelength', 'data_by_wavelength']);
    if (Array.isArray(data)) {
        return data
            .map((entry) => normalizeRustLcaEntry(entry))
            .filter((entry) => !!entry);
    }

    if (data instanceof Map) {
        const fromMap = readAnyProp(data, ['items', 'values']);
        if (Array.isArray(fromMap)) {
            return fromMap
                .map((entry) => normalizeRustLcaEntry(entry))
                .filter((entry) => !!entry);
        }
    }

    return [];
}

function withWebRustWasmTraceOverride<T>(callback: () => Promise<T> | T, requireRustWasm = true): Promise<T> | T {
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : null;
    if (!g) return callback();

    const key = '__cooptTraceOptionsOverride';
    const prev = g[key];
    const prevObj = (prev && typeof prev === 'object' && !Array.isArray(prev)) ? prev : null;
    g[key] = {
        ...(prevObj || {}),
        useRustWasm: true,
        requireRustWasm: !!requireRustWasm,
        // Keep Rust/WASM path, but avoid dropping all rays in strict forward-hit mode.
        requireForwardHit: false,
        allowNonStrict: true,
    };

    const restore = () => {
        if (prev === undefined) delete g[key];
        else g[key] = prev;
    };

    try {
        const out = callback();
        if (out && typeof (out as any).then === 'function') {
            return (out as Promise<T>).finally(() => {
                try { restore(); } catch (_) {}
            });
        }
        restore();
        return out;
    } catch (error) {
        restore();
        throw error;
    }
}

function normalizeChiefRayMode(mode: any): string {
    return String(mode || 'stop-center')
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-');
}

function summarizeFiniteSeries(values: Array<number | null>) {
    const finite = (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
        return {
            finiteCount: 0,
            minMm: null,
            maxMm: null,
            meanMm: null,
            spanMm: null,
        };
    }
    const minMm = Math.min(...finite);
    const maxMm = Math.max(...finite);
    const meanMm = finite.reduce((sum, value) => sum + value, 0) / finite.length;
    return {
        finiteCount: finite.length,
        minMm,
        maxMm,
        meanMm,
        spanMm: maxMm - minMm,
    };
}

function weightedMean(values: Array<{ y: number; w: number }>): number | null {
    let sumW = 0;
    let sumYW = 0;
    for (const item of values) {
        const y = Number(item?.y);
        const w = Number(item?.w);
        if (!Number.isFinite(y) || !Number.isFinite(w) || w <= 0) continue;
        sumW += w;
        sumYW += y * w;
    }
    if (!Number.isFinite(sumW) || sumW <= 0) return null;
    return sumYW / sumW;
}

function annularAreaWeights(points: any[]): Array<{ y: number; w: number }> {
    const samples = (Array.isArray(points) ? points : [])
        .map((point) => {
            const y = Number(point?.yUm);
            const u = Number(point?.pupilU);
            const v = Number(point?.pupilV);
            if (!Number.isFinite(y)) return null;
            const r = (Number.isFinite(u) && Number.isFinite(v)) ? Math.hypot(u, v) : Number.NaN;
            return { y, r };
        })
        .filter((item: any) => !!item);
    if (samples.length === 0) return [];

    const hasFiniteRadius = samples.some((item: any) => Number.isFinite(item.r));
    if (!hasFiniteRadius) {
        return samples.map((item: any) => ({ y: Number(item.y), w: 1 }));
    }

    const bins = new Map<number, { radius: number; count: number }>();
    for (const item of samples) {
        const r = Number(item.r);
        if (!Number.isFinite(r)) continue;
        const key = Math.round(r * 1000) / 1000;
        const prev = bins.get(key);
        bins.set(key, {
            radius: key,
            count: (prev?.count || 0) + 1,
        });
    }

    const radii = Array.from(bins.values())
        .map((bin) => Number(bin.radius))
        .filter((radius) => Number.isFinite(radius))
        .sort((a, b) => a - b);
    if (radii.length === 0) {
        return samples.map((item: any) => ({ y: Number(item.y), w: 1 }));
    }

    const areaPerKey = new Map<number, number>();
    for (let i = 0; i < radii.length; i++) {
        const ri = radii[i];
        const rPrev = i > 0 ? radii[i - 1] : 0;
        const rNext = i + 1 < radii.length ? radii[i + 1] : 1;
        const inner = i > 0 ? (rPrev + ri) * 0.5 : 0;
        const outer = i + 1 < radii.length ? (ri + rNext) * 0.5 : 1;
        const annularArea = Math.max(0, (outer * outer) - (inner * inner));
        const count = Math.max(1, Number(bins.get(ri)?.count || 1));
        areaPerKey.set(ri, annularArea / count);
    }

    return samples.map((item: any) => {
        const r = Number(item.r);
        if (!Number.isFinite(r)) return { y: Number(item.y), w: 1 };
        const key = Math.round(r * 1000) / 1000;
        const w = Number(areaPerKey.get(key));
        return {
            y: Number(item.y),
            w: (Number.isFinite(w) && w > 0) ? w : 1,
        };
    });
}

export async function calculateMagnificationChromaticAberrationData(
    opticalSystemRows,
    fieldValues,
    wavelengths,
    options: any = {}
) {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        console.error('❌ magnification chromatic aberration: opticalSystemRows invalid');
        return null;
    }
    if (!Array.isArray(fieldValues) || fieldValues.length === 0) {
        console.error('❌ magnification chromatic aberration: fieldValues empty');
        return null;
    }

    const referenceWavelength = Number.isFinite(Number(options.referenceWavelength))
        ? Number(options.referenceWavelength)
        : 0.5876;
    const requireRustWasm = options?.requireRustWasm !== false;
    const forceWasmInTauri = options?.forceWasmInTauri === true;
    const heightMode = !!options.heightMode;
    const imageHeightMode = !!options.imageHeightMode;
    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const chiefRayDefinition = (options && typeof options === 'object' && typeof options.chiefRayDefinition === 'string')
        ? options.chiefRayDefinition
        : 'stop-center';
    const chiefRayMode = normalizeChiefRayMode(chiefRayDefinition);
    const requestedRayCount = Number.isInteger(Number(options?.rayCount)) && Number(options?.rayCount) > 0
        ? Number(options.rayCount)
        : null;
    const requestedRingCount = Number.isInteger(Number(options?.ringCount)) && Number(options?.ringCount) > 0
        ? Number(options.ringCount)
        : null;
    const sourceRows = (options && typeof options === 'object' && Array.isArray(options.sourceRows))
        ? options.sourceRows
        : [];

    const sortedFieldValues = fieldValues
        .slice()
        .map(v => Number(v))
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);

    if (sortedFieldValues.length === 0) {
        console.error('❌ magnification chromatic aberration: no finite field values');
        return null;
    }

    const wavelengthCandidates = (Array.isArray(wavelengths) ? wavelengths : [])
        .map(v => Number(v))
        .filter(v => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);

    if (!wavelengthCandidates.some(w => Math.abs(w - referenceWavelength) < 1e-9)) {
        wavelengthCandidates.push(referenceWavelength);
        wavelengthCandidates.sort((a, b) => a - b);
    }

    const pickImageSurfaceIndex = () => {
        if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return 0;
        let imageIdx = -1;
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const row = opticalSystemRows[i] || {};
            const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
            if (objectType === 'image') imageIdx = i;
        }
        return imageIdx >= 0 ? imageIdx : Math.max(0, opticalSystemRows.length - 1);
    };

    const imageSurfaceIndex = pickImageSurfaceIndex();
    const finiteSystem = (() => {
        const row0 = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
        const raw = row0?.thickness ?? row0?.Thickness ?? row0?.distance;
        if (raw === Infinity || raw === -Infinity) return false;
        const txt = String(raw ?? '').trim().toUpperCase();
        return txt !== 'INF' && txt !== 'INFINITY' && txt !== '∞';
    })();
    const objectDistance = (() => {
        const row0 = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
        const raw = row0?.thickness ?? row0?.Thickness ?? row0?.distance;
        const v = Number(raw);
        return Number.isFinite(v) ? v : 0;
    })();
    const mirrorSign = (() => {
        const isMirrorRow = (row: any) => {
            const mat = String(row?.material ?? '').trim().toLowerCase();
            const rowType = String(row?.type ?? row?.rowType ?? '').trim().toLowerCase();
            const blockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase();
            const surfType = String(row?.surfType ?? row?.surfaceType ?? row?.type ?? '').trim().toLowerCase();
            return mat === 'mirror' || rowType === 'mirror' || blockType === 'mirror' || surfType === 'mirror';
        };
        const count = (Array.isArray(opticalSystemRows) ? opticalSystemRows : []).filter((r) => isMirrorRow(r)).length;
        return (count % 2 === 1) ? -1 : 1;
    })();

    const objectRowsNativeLike = sortedFieldValues.map((sample, index) => {
        if (imageHeightMode) {
            return {
                id: `Field-${index}`,
                name: `Field-${index}`,
                position: 'ImageHeight',
                xHeightAngle: 0,
                yHeightAngle: sample,
                x: 0,
                y: sample,
            };
        }
        if (heightMode) {
            return {
                id: `Field-${index}`,
                name: `Field-${index}`,
                position: 'Rectangle',
                xHeight: 0,
                yHeight: sample,
                x: 0,
                y: sample,
            };
        }
        if (finiteSystem) {
            const thetaRad = sample * Math.PI / 180;
            const hObj = objectDistance * Math.tan(thetaRad);
            return {
                id: `Field-${index}`,
                name: `Field-${index}`,
                position: 'Rectangle',
                xHeight: 0,
                yHeight: hObj,
                x: 0,
                y: hObj,
            };
        }
        return {
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: 'Angle',
            xHeightAngle: 0,
            yHeightAngle: sample,
            x: 0,
            y: sample,
        };
    });

    const imageHeightConjugateType = imageHeightMode
        ? detectConjugateType(opticalSystemRows)
        : null;

    const defaultLcaSourceRows = (wavelength: number) => [{
        id: 'NativeDistortionSource',
        name: 'NativeDistortionSource',
        wavelength,
        color: '#22c55e',
        isPrimary: true,
        intensity: 1,
    }];

    const parseFieldIndex = (label: string) => {
        const m = String(label || '').match(/Field-(\d+)/);
        if (!m) return null;
        const idx = Number(m[1]);
        return Number.isInteger(idx) ? idx : null;
    };

    const selectImageHeightMm = (series: any) => {
        const mode = chiefRayMode;
        const points = Array.isArray(series?.points) ? series.points : [];
        if (mode.startsWith('beam-midpoint')) {
            const ys = points
                .map((p: any) => Number(p?.yUm))
                .filter((v: number) => Number.isFinite(v));
            if (ys.length === 0) return null;
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            return ((minY + maxY) * 0.5 / 1000) * mirrorSign;
        }
        if (mode.startsWith('beam-centroid')) {
            const weighted = annularAreaWeights(points);
            if (weighted.length === 0) return null;
            const mean = weightedMean(weighted);
            if (!Number.isFinite(Number(mean))) return null;
            return (Number(mean) / 1000) * mirrorSign;
        }
        // Native-like stop-center: prefer ray closest to pupil center (u,v) when available.
        const centerByPupil = points
            .map((p: any) => {
                const u = Number(p?.pupilU);
                const v = Number(p?.pupilV);
                const y = Number(p?.yUm);
                if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(y)) return null;
                return { y, r2: u * u + v * v };
            })
            .filter((x: any) => !!x)
            .sort((a: any, b: any) => a.r2 - b.r2)[0];
        if (centerByPupil && Number.isFinite(Number(centerByPupil.y))) {
            return (Number(centerByPupil.y) / 1000) * mirrorSign;
        }

        // Secondary fallback: center-pupil hit by deterministic ray index.
        const centerHit = points.find((p: any) => Number(p?.rayIndex) === 0);
        const centerYUm = Number(centerHit?.yUm);
        if (Number.isFinite(centerYUm)) return (centerYUm / 1000) * mirrorSign;

        const chiefYUm = Number(series?.chiefPointUm?.yUm);
        if (Number.isFinite(chiefYUm)) return (chiefYUm / 1000) * mirrorSign;
        return null;
    };

    try {
        const runtime = await import('../../src/desktop/runtime.ts');
        const useNative = runtime?.isTauriRuntime && runtime.isTauriRuntime() && !forceWasmInTauri;

        if (useNative) {
            try { onProgress?.({ percent: 5, message: 'Running native LCA...' }); } catch (_) {}
            const { runNativeMagnificationChromaticAberration } = await import('../../src/desktop/ipc/client.ts');
            const response = await runNativeMagnificationChromaticAberration({
                opticalSystemRows,
                sourceRows,
                fieldSamples: sortedFieldValues,
                wavelengths: wavelengthCandidates,
                referenceWavelength,
                heightMode,
                chiefRayDefinition: chiefRayMode,
            });

            if (!response || typeof response !== 'object') {
                throw new Error('Native LCA returned invalid response');
            }

            if (!String(response.backend || '').includes('native-rust')) {
                throw new Error(`Unexpected LCA backend: ${String(response.backend || 'unknown')}`);
            }

            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            return response;
        }

        await preloadRustRayTracingWasm();
        const {
            generateRayStartPointsForObject,
            convertImageHeightToEffectiveObject,
            traceChiefRayForAngleDetails,
        } = await import('../../optical/ray-renderer.ts');
        const { traceRayEvalBatchSummary, calculateSurfaceOrigins } = await import('../../raytracing/core/ray-tracing.ts');
        const { calculateParaxialData } = await import('../../raytracing/core/ray-paraxial.ts');
        const { findStopSurface } = await import('../../optical/system-renderer.ts');

        const imageHeightSolveSurfaceOrigins = imageHeightMode ? calculateSurfaceOrigins(opticalSystemRows) : null;
        const imageHeightSolveStopInfo = imageHeightMode
            ? findStopSurface(opticalSystemRows, imageHeightSolveSurfaceOrigins)
            : null;
        const imageHeightSolveStopCenter = (() => {
            const src = imageHeightSolveStopInfo?.origin?.origin
                ?? imageHeightSolveStopInfo?.origin
                ?? imageHeightSolveStopInfo?.center
                ?? imageHeightSolveStopInfo?.position;
            const x = Number(src?.x);
            const y = Number(src?.y);
            const z = Number(src?.z);
            return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
        })();
        const imageHeightSolveScopeKey = imageHeightMode
            ? `${JSON.stringify(opticalSystemRows)}||${referenceWavelength}||${imageHeightConjugateType || 'infinite'}||rust-only`
            : null;

        // ImageHeight is the requested reference-wavelength chief-ray image height,
        // not merely EFL*tan(field angle). Solve that inverse mapping exactly once at
        // the reference wavelength, then keep the solved object field fixed for every
        // wavelength. The previous paraxial-only conversion switched chief-ray origin
        // fallbacks in Wide near 11 mm and produced artificial straight/kinked LCA curves.
        const tracedObjectRows = (() => {
            if (!imageHeightMode) return objectRowsNativeLike;
            const paraxial = calculateParaxialData(opticalSystemRows, referenceWavelength);
            return sortedFieldValues.map((sample, index) => {
                const yMm = Number(sample);
                const rawImageHeightObject = {
                    id: `Field-${index}`,
                    name: `Field-${index}`,
                    position: 'ImageHeight',
                    xHeightAngle: 0,
                    yHeightAngle: Number.isFinite(yMm) ? yMm : 0,
                    x: 0,
                    y: Number.isFinite(yMm) ? yMm : 0,
                    __cooptImageHeightTarget: { x: 0, y: Number.isFinite(yMm) ? yMm : 0 },
                };
                return convertImageHeightToEffectiveObject(
                    rawImageHeightObject,
                    opticalSystemRows,
                    referenceWavelength,
                    imageHeightConjugateType === 'finite' ? 'finite' : 'infinite',
                    {
                        skipTsValidation: true,
                        validationTraceBackend: 'rust',
                        precomputedParaxial: paraxial,
                        precomputedSurfaceOrigins: imageHeightSolveSurfaceOrigins,
                        precomputedImageSurfaceIndex: imageSurfaceIndex,
                        precomputedStopInfo: imageHeightSolveStopInfo,
                        precomputedStopCenter3d: imageHeightSolveStopCenter,
                        precomputedSolveScopeKey: imageHeightSolveScopeKey,
                    },
                );
            });
        })();

        const perWavelengthHeights = new Map<number, Array<number | null>>();
        const perWavelengthTraceStats = new Map<number, { attempted: number; hit: number }>();
        const stopCenterMode = chiefRayMode.startsWith('stop-center');
        const beamAveragedMode = chiefRayMode.startsWith('beam-centroid') || chiefRayMode.startsWith('beam-midpoint');
        const stopCenterExactOnly = stopCenterMode;
        const defaultRayCount = stopCenterMode ? 101 : (beamAveragedMode ? 1001 : 101);
        const defaultRingCount = stopCenterMode ? 3 : (beamAveragedMode ? 7 : 1);
        const lcaRayCount = requestedRayCount ?? defaultRayCount;
        const lcaRingCount = requestedRingCount ?? defaultRingCount;
        const lcaPattern = (stopCenterMode || beamAveragedMode) ? 'annular' : 'cross';
        const traceConjugateType = imageHeightMode
            ? (imageHeightConjugateType === 'finite' ? 'finite' : 'infinite')
            : detectConjugateType(opticalSystemRows);
        const traceOptions = {
            useRustWasm: true,
            requireRustWasm: true,
            disableWasmRayTracing: false,
            allowNonStrict: true,
        } as any;

        const traceChiefImageHeightMm = (obj: any, wl: number): number | null => {
            const solvedFieldX = Number(obj?.__cooptImageHeightSolve?.solved?.x);
            const solvedFieldY = Number(obj?.__cooptImageHeightSolve?.solved?.y);
            if (imageHeightMode
                && imageHeightConjugateType !== 'finite'
                && Number.isFinite(solvedFieldX)
                && Number.isFinite(solvedFieldY)) {
                const details = traceChiefRayForAngleDetails(
                    opticalSystemRows,
                    solvedFieldX,
                    solvedFieldY,
                    imageSurfaceIndex,
                    imageHeightSolveSurfaceOrigins?.[imageSurfaceIndex] || null,
                    wl,
                    {
                        surfaceOrigins: imageHeightSolveSurfaceOrigins,
                        stopInfo: imageHeightSolveStopInfo,
                        stopCenter3d: imageHeightSolveStopCenter,
                    },
                    'rust',
                );
                const localHitY = Number(details?.localHit?.y);
                if (Number.isFinite(localHitY)) return localHitY * mirrorSign;
            }

            const starts = generateRayStartPointsForObject(
                obj,
                opticalSystemRows,
                1,
                null,
                {
                    pattern: 'cross',
                    annularRingCount: 1,
                    wavelengthUm: wl,
                    conjugateType: traceConjugateType,
                    aimThroughStop: true,
                    useChiefRayAnalysis: true,
                    allowStopBasedOriginSolve: true,
                    originSolveTraceBackend: 'rust',
                    strictChiefDirectionSolve: true,
                    targetSurfaceIndex: imageSurfaceIndex,
                    skipImageHeightTsValidation: true,
                    imageHeightValidationTraceBackend: 'rust',
                },
            );
            const ray = Array.isArray(starts) && starts.length > 0 ? starts[0] : null;
            const startP = ray?.startP;
            const dir = ray?.dir;
            if (!startP || !dir) return null;
            const batch = [{
                wavelength: Number(wl),
                pos: {
                    x: Number(startP?.x) || 0,
                    y: Number(startP?.y) || 0,
                    z: Number(startP?.z) || 0,
                },
                dir: {
                    x: Number(dir?.x) || 0,
                    y: Number(dir?.y) || 0,
                    z: Number(dir?.z) || 1,
                },
            }];
            const summaries = traceRayEvalBatchSummary(
                opticalSystemRows,
                batch,
                1.0,
                imageSurfaceIndex,
                traceOptions,
            );
            const hitY = Number(Array.isArray(summaries) ? summaries[0]?.hitPoint?.y : NaN);
            return Number.isFinite(hitY) ? (hitY * mirrorSign) : null;
        };

        const traceSeriesImageHeightMm = (obj: any, wl: number): number | null => {
            const starts = generateRayStartPointsForObject(
                obj,
                opticalSystemRows,
                lcaRayCount,
                null,
                {
                    pattern: lcaPattern,
                    annularRingCount: lcaRingCount,
                    wavelengthUm: wl,
                    conjugateType: traceConjugateType,
                    aimThroughStop: stopCenterMode,
                    useChiefRayAnalysis: stopCenterMode,
                    allowStopBasedOriginSolve: stopCenterMode,
                    originSolveTraceBackend: stopCenterMode ? 'rust' : 'ts',
                    strictChiefDirectionSolve: stopCenterMode,
                    targetSurfaceIndex: imageSurfaceIndex,
                    skipImageHeightTsValidation: stopCenterMode,
                    imageHeightValidationTraceBackend: stopCenterMode ? 'rust' : 'ts',
                },
            );
            const rays = Array.isArray(starts) ? starts : [];
            if (rays.length === 0) return null;

            const batch = rays
                .map((ray: any) => {
                    const startP = ray?.startP;
                    const dir = ray?.dir;
                    if (!startP || !dir) return null;
                    return {
                        wavelength: Number(wl),
                        pos: {
                            x: Number(startP?.x) || 0,
                            y: Number(startP?.y) || 0,
                            z: Number(startP?.z) || 0,
                        },
                        dir: {
                            x: Number(dir?.x) || 0,
                            y: Number(dir?.y) || 0,
                            z: Number(dir?.z) || 1,
                        },
                    };
                })
                .filter((entry: any) => !!entry);
            if (batch.length === 0) return null;

            const summaries = traceRayEvalBatchSummary(
                opticalSystemRows,
                batch,
                1.0,
                imageSurfaceIndex,
                traceOptions,
            );

            const points = batch.map((_, index) => {
                const hitY = Number(Array.isArray(summaries) ? summaries[index]?.hitPoint?.y : NaN);
                if (!Number.isFinite(hitY)) return null;
                const ray = rays[index] || {};
                return {
                    rayIndex: index,
                    yUm: hitY * mirrorSign * 1000,
                    pupilU: Number(ray?.planeCoords?.u),
                    pupilV: Number(ray?.planeCoords?.v),
                };
            }).filter((entry: any) => !!entry);

            if (points.length === 0) return null;
            return selectImageHeightMm({ points });
        };

        for (let wi = 0; wi < wavelengthCandidates.length; wi++) {
            const wl = wavelengthCandidates[wi];
            const imageHeights = new Array<number | null>(sortedFieldValues.length).fill(null);
            for (let fi = 0; fi < imageHeights.length; fi++) {
                const obj = tracedObjectRows[fi] || {
                    id: `Field-${fi}`,
                    name: `Field-${fi}`,
                    position: 'Angle',
                    xHeightAngle: 0,
                    yHeightAngle: sortedFieldValues[fi],
                };
                const yLocal = stopCenterExactOnly
                    ? (traceChiefImageHeightMm(obj, wl) ?? traceSeriesImageHeightMm(obj, wl))
                    : traceSeriesImageHeightMm(obj, wl);
                imageHeights[fi] = (typeof yLocal === 'number' && Number.isFinite(yLocal)) ? yLocal : null;
            }
            perWavelengthHeights.set(wl, imageHeights);
            perWavelengthTraceStats.set(wl, {
                attempted: imageHeights.length,
                hit: imageHeights.filter((v) => Number.isFinite(Number(v))).length,
            });

            const p = 10 + (70 * (wi + 1)) / Math.max(1, wavelengthCandidates.length);
            try { onProgress?.({ percent: p, message: `Tracing λ=${(wl * 1000).toFixed(1)}nm (Rust/WASM)...` }); } catch (_) {}
        }

        let referenceHeights: Array<number | null> | null = null;
        for (const wl of wavelengthCandidates) {
            if (Math.abs(wl - referenceWavelength) < 1e-9) {
                referenceHeights = perWavelengthHeights.get(wl) || null;
                break;
            }
        }
        if (!referenceHeights) {
            throw new Error('Failed to compute LCA reference wavelength heights');
        }

        const dataByWavelength = wavelengthCandidates.map((wl) => {
            const imageHeights = perWavelengthHeights.get(wl) || new Array<number | null>(sortedFieldValues.length).fill(null);
            const displacements = imageHeights.map((h, i) => {
                const ref = referenceHeights?.[i];
                return (typeof h === 'number' && Number.isFinite(h) && typeof ref === 'number' && Number.isFinite(ref))
                    ? (h - ref)
                    : null;
            });
            return {
                wavelength: wl,
                displacements,
                imageHeights,
            };
        });

        const displacementStats = dataByWavelength.map((entry) => {
            const wl = Number(entry?.wavelength);
            const disp = Array.isArray(entry?.displacements) ? entry.displacements : [];
            let finiteCount = 0;
            let maxAbs = 0;
            for (const v of disp) {
                const n = (typeof v === 'number') ? v : Number.NaN;
                if (!Number.isFinite(n)) continue;
                finiteCount += 1;
                const a = Math.abs(n);
                if (a > maxAbs) maxAbs = a;
            }
            return {
                wavelength: wl,
                finiteCount,
                maxAbsMm: maxAbs,
                maxAbsUm: maxAbs * 1000,
                attemptedRays: Number(perWavelengthTraceStats.get(wl)?.attempted || 0),
                hitRays: Number(perWavelengthTraceStats.get(wl)?.hit || 0),
            };
        });
        const absoluteHeightStats = dataByWavelength.map((entry) => {
            const wl = Number(entry?.wavelength);
            const stats = summarizeFiniteSeries(Array.isArray(entry?.imageHeights) ? entry.imageHeights : []);
            return {
                wavelength: wl,
                ...stats,
            };
        });
        const referenceHeightStats = summarizeFiniteSeries(referenceHeights);
        const referenceMeanHeightMm = Number(referenceHeightStats.meanMm);
        const absoluteShiftVsReferenceMean = absoluteHeightStats.map((entry) => {
            const meanMm = Number(entry?.meanMm);
            return {
                wavelength: Number(entry?.wavelength),
                meanShiftMm: (Number.isFinite(meanMm) && Number.isFinite(referenceMeanHeightMm))
                    ? (meanMm - referenceMeanHeightMm)
                    : null,
            };
        });

        try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        return {
            backend: 'web-rust-wasm',
            fieldValues: sortedFieldValues,
            heightMode,
            imageHeightMode,
            referenceWavelength,
            imageSurfaceIndex,
            dataByWavelength,
            meta: {
                source: 'typescript-render-raytrace-native-like',
                requireRustWasm,
                sourceRowCount: Array.isArray(sourceRows) ? sourceRows.length : 0,
                finiteSystem,
                mirrorSign,
                lcaPattern,
                lcaRayCount,
                lcaRingCount,
                chiefRayMode,
                displacementStats,
                absoluteHeightStats,
                referenceHeightStats,
                absoluteShiftVsReferenceMean,
            },
            message: 'Computed via Rust/WASM ray tracing + Rust/WASM LCA reduction on Web'
        };
    } catch (error) {
        console.error('❌ LCA failed:', error);
        return null;
    }
}
