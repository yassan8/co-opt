import { calculateChiefRayNewton } from './transverse-aberration.ts';
import { preloadRustRayTracingWasm } from '../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

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
    const heightMode = !!options.heightMode;
    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const chiefRayDefinition = (options && typeof options === 'object' && typeof options.chiefRayDefinition === 'string')
        ? options.chiefRayDefinition
        : 'stop-center';
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

    const calcImageHeightFor = (fieldValue: number, wavelengthUm: number) => {
        const fieldSetting = heightMode
            ? {
                position: 'height',
                fieldType: 'height',
                xHeight: 0,
                yHeight: fieldValue,
                x: 0,
                y: fieldValue,
                displayName: `h=${fieldValue.toFixed(6)}mm`
            }
            : {
                position: 'angle',
                fieldType: 'angle',
                xFieldAngle: 0,
                yFieldAngle: fieldValue,
                xHeightAngle: 0,
                yHeightAngle: fieldValue,
                x: 0,
                y: fieldValue,
                displayName: `θ=${fieldValue.toFixed(6)}deg`
            };

        const chief = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelengthUm, 'unified', {
            targetSurfaceIndex: imageSurfaceIndex,
            chiefRayDefinition,
            requireRustWasm,
        });
        const segs = extractChiefRaySegmentsForLca(chief);
        if (!segs.length) return null;
        const mappedPointIndex = surfaceIndexToRayPathPointIndexForLca(opticalSystemRows, imageSurfaceIndex);
        const idx = Number.isInteger(mappedPointIndex)
            ? Math.max(0, Math.min(Number(mappedPointIndex), segs.length - 1))
            : Math.max(0, Math.min(imageSurfaceIndex, segs.length - 1));
        const p = segs[idx] || segs[segs.length - 1] || null;
        const y = Number(p?.y);
        return Number.isFinite(y) ? y : null;
    };

    try {
        const runtime = await import('../../src/desktop/runtime.ts');
        const useNative = runtime?.isTauriRuntime && runtime.isTauriRuntime();

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

        try { onProgress?.({ percent: 5, message: 'Running Web LCA...' }); } catch (_) {}

        const perWavelengthHeights = new Map<number, Array<number | null>>();
        await withWebRustWasmTraceOverride(async () => {
            for (let wi = 0; wi < wavelengthCandidates.length; wi++) {
                const wl = wavelengthCandidates[wi];
                const heights: Array<number | null> = [];
                for (let fi = 0; fi < sortedFieldValues.length; fi++) {
                    const fv = sortedFieldValues[fi];
                    heights.push(calcImageHeightFor(fv, wl));
                }
                perWavelengthHeights.set(wl, heights);
                const p = 10 + (70 * (wi + 1)) / Math.max(1, wavelengthCandidates.length);
                try { onProgress?.({ percent: p, message: `Tracing λ=${(wl * 1000).toFixed(1)}nm (Rust/WASM)...` }); } catch (_) {}
            }
        }, requireRustWasm);

        const rustWasm = await preloadRustRayTracingWasm();
        const rustLcaReducer = rustWasm?.compute_lca_series_from_image_heights;
        if (typeof rustLcaReducer !== 'function') {
            throw new Error('Rust/WASM LCA reducer not available: compute_lca_series_from_image_heights');
        }

        const imageHeightsFlat = new Float64Array(wavelengthCandidates.length * sortedFieldValues.length);
        for (let wi = 0; wi < wavelengthCandidates.length; wi++) {
            const wl = wavelengthCandidates[wi];
            const heights = perWavelengthHeights.get(wl) || new Array(sortedFieldValues.length).fill(null);
            for (let fi = 0; fi < sortedFieldValues.length; fi++) {
                const raw = heights[fi];
                const value = (typeof raw === 'number') ? raw : Number.NaN;
                imageHeightsFlat[wi * sortedFieldValues.length + fi] = Number.isFinite(value) ? value : Number.NaN;
            }
        }

        const rustReduced = rustLcaReducer(
            new Float64Array(sortedFieldValues),
            new Float64Array(wavelengthCandidates),
            referenceWavelength,
            imageHeightsFlat,
        ) as any;

        const dataByWavelength = normalizeRustLcaReducerResult(rustReduced);
        if (!dataByWavelength.length) {
            throw new Error('Rust/WASM LCA reducer returned empty dataByWavelength');
        }
        const nonRefCount = dataByWavelength.filter((entry) => {
            const wl = Number(entry?.wavelength);
            return Number.isFinite(wl) && Math.abs(wl - referenceWavelength) >= 1e-6;
        }).length;
        if (nonRefCount === 0) {
            console.warn('⚠️ LCA reducer returned no non-reference wavelength entries');
        }

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
            referenceWavelength,
            imageSurfaceIndex,
            dataByWavelength,
            meta: {
                source: 'typescript-raytrace-plus-rust-wasm-lca-reducer',
                requireRustWasm,
                sourceRowCount: Array.isArray(sourceRows) ? sourceRows.length : 0,
                displacementStats,
            },
            message: 'Computed via Rust/WASM ray tracing + Rust/WASM LCA reduction on Web'
        };
    } catch (error) {
        console.error('❌ LCA failed:', error);
        return null;
    }
}
