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
            const ys = points
                .map((p: any) => Number(p?.yUm))
                .filter((v: number) => Number.isFinite(v));
            if (ys.length === 0) return null;
            const mean = ys.reduce((a: number, b: number) => a + b, 0) / ys.length;
            return (mean / 1000) * mirrorSign;
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
                chiefRayDefinition,
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
        const { runNativeSpotRaytrace } = await import('../../src/desktop/ipc/client.ts');
        const {
            traceChiefRayLocalImagePointForObject,
            convertImageHeightToEffectiveObject,
        } = await import('../../optical/ray-renderer.ts');

        const tracedObjectRows = imageHeightMode
            ? objectRowsNativeLike.map((obj) => {
                const effectiveObj = convertImageHeightToEffectiveObject(
                    obj,
                    opticalSystemRows,
                    referenceWavelength,
                    imageHeightConjugateType === 'finite' ? 'finite' : 'infinite',
                    {
                        skipTsValidation: true,
                        validationTraceBackend: 'rust',
                    },
                );
                return effectiveObj && effectiveObj !== obj ? effectiveObj : obj;
            })
            : objectRowsNativeLike;

        const perWavelengthHeights = new Map<number, Array<number | null>>();
        const stopCenterMode = chiefRayMode.startsWith('stop-center');
        const beamAveragedMode = chiefRayMode.startsWith('beam-centroid') || chiefRayMode.startsWith('beam-midpoint');
        const stopCenterExactOnly = stopCenterMode && requestedRayCount === null && requestedRingCount === null;
        const defaultRayCount = stopCenterMode ? 101 : (beamAveragedMode ? 1001 : 101);
        const defaultRingCount = stopCenterMode ? 3 : (beamAveragedMode ? 7 : 1);
        const lcaRayCount = requestedRayCount ?? defaultRayCount;
        const lcaRingCount = requestedRingCount ?? defaultRingCount;
        const lcaPattern = (stopCenterMode || beamAveragedMode) ? 'annular' : 'cross';
        for (let wi = 0; wi < wavelengthCandidates.length; wi++) {
            const wl = wavelengthCandidates[wi];
            const imageHeights = new Array<number | null>(sortedFieldValues.length).fill(null);
            if (stopCenterMode && stopCenterExactOnly) {
                for (let fi = 0; fi < sortedFieldValues.length; fi++) {
                    const obj = tracedObjectRows[fi] || {
                        id: `Field-${fi}`,
                        name: `Field-${fi}`,
                        position: 'Angle',
                        xHeightAngle: 0,
                        yHeightAngle: sortedFieldValues[fi],
                    };
                    const localHit = traceChiefRayLocalImagePointForObject(
                        opticalSystemRows,
                        obj,
                        wl,
                        {
                            traceBackend: 'rust',
                            conjugateType: imageHeightConjugateType === 'finite' ? 'finite' : 'infinite',
                            imageHeightValidationTraceBackend: 'rust',
                        },
                    );
                    const yLocal = Number(localHit?.y);
                    imageHeights[fi] = Number.isFinite(yLocal) ? (yLocal * mirrorSign) : null;
                }
            } else {
                const sourceRowsForWl = defaultLcaSourceRows(wl);
                const spotResponse = await runNativeSpotRaytrace({
                    opticalSystemRows,
                    sourceRows: sourceRowsForWl,
                    objectRows: tracedObjectRows,
                    surfaceIndex: imageSurfaceIndex,
                    rayCount: lcaRayCount,
                    ringCount: lcaRingCount,
                    pattern: lcaPattern,
                    wavelengthMode: 'primary',
                    forceRustWasm: true,
                });
                const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
                for (const s of series) {
                    const objectIndex = Number(s?.objectIndex);
                    const idx = Number.isInteger(objectIndex)
                        ? objectIndex
                        : parseFieldIndex(String(s?.label || ''));
                    if (!Number.isInteger(idx) || idx < 0 || idx >= imageHeights.length) continue;
                    imageHeights[idx] = selectImageHeightMm(s);
                }
                if (stopCenterMode) {
                    for (let fi = 0; fi < imageHeights.length; fi++) {
                        if (Number.isFinite(Number(imageHeights[fi]))) continue;
                        const obj = tracedObjectRows[fi];
                        if (!obj) continue;
                        const localHit = traceChiefRayLocalImagePointForObject(
                            opticalSystemRows,
                            obj,
                            wl,
                            {
                                traceBackend: 'rust',
                                conjugateType: imageHeightConjugateType === 'finite' ? 'finite' : 'infinite',
                                imageHeightValidationTraceBackend: 'rust',
                            },
                        );
                        const yLocal = Number(localHit?.y);
                        imageHeights[fi] = Number.isFinite(yLocal) ? (yLocal * mirrorSign) : null;
                    }
                }
            }
            perWavelengthHeights.set(wl, imageHeights);

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
                return (Number.isFinite(Number(h)) && Number.isFinite(Number(ref))) ? (Number(h) - Number(ref)) : null;
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
            };
        });
        try {
            console.log('📊 [LCA][Web] displacement stats:', displacementStats);
        } catch (_) {}

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
                source: 'typescript-spot-series-native-like',
                requireRustWasm,
                sourceRowCount: Array.isArray(sourceRows) ? sourceRows.length : 0,
                finiteSystem,
                mirrorSign,
                lcaPattern,
                lcaRayCount,
                lcaRingCount,
                displacementStats,
            },
            message: 'Computed via Rust/WASM ray tracing + Rust/WASM LCA reduction on Web'
        };
    } catch (error) {
        console.error('❌ LCA failed:', error);
        return null;
    }
}
