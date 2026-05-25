// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

// merit-function-editor.ts
import { OPERAND_DEFINITIONS, InspectorManager } from './merit-function-inspector.ts';
import {
    calculateFullSystemParaxialTrace,
    calculatePrincipalPointPositions,
    calculateParaxialData,
    findStopSurfaceIndex
} from '../../raytracing/core/ray-paraxial.ts';
import {
    traceRay,
    traceRayHitPoint,
    calculateSurfaceOrigins,
    transformPointToLocal
} from '../../raytracing/core/ray-tracing.ts';
import {
    getOpticalSystemRows,
    getObjectRows,
    getSourceRows
} from '../../utils/data-utils.ts';
import { calculateSeidelCoefficients } from '../../evaluation/aberrations/seidel-coefficients.ts';
import { calculateAfocalSeidelCoefficientsIntegrated } from '../../evaluation/aberrations/seidel-coefficients-afocal.ts';
import { generateSpotDiagram, generateSpotDiagramAsync, generateSurfaceOptions } from '../../evaluation/spot-diagram.ts';
import { createOPDCalculator, WavefrontAberrationAnalyzer } from '../../evaluation/wavefront/wavefront.ts';
import { expandBlocksToOpticalSystemRows } from '../../data/block-schema.ts';
import { generateRayStartPointsForObject, setRayEmissionPattern, getRayEmissionPattern, convertImageHeightToEffectiveObject } from '../../optical/ray-renderer.ts';
import { detectConjugateType } from '../../utils/conjugate-detection.ts';
import { asphericSurfaceZ, toricSurfaceZ } from '../../optical/surface-math.ts';
import { calculateLongitudinalAberration } from '../../evaluation/aberrations/longitudinal-aberration.ts';
import { calculateTransverseAberration } from '../../evaluation/aberrations/transverse-aberration.ts';
import { getTableOpticalSystem, getTableObject, getTableSource } from '../../core/app-config.ts';
import { loadSystemConfigurations } from '../../data/table-configuration.ts';
import { tryLoadPersistedTableData as tryLoadPersistedOpticalSystemTableData } from '../../data/table-optical-system.ts';
import { loadTableData as loadMeritFunctionTableData, saveTableData as saveMeritFunctionTableData } from '../../data/table-merit-function.ts';
import { loadLastSpotSettings } from '../spot-diagram-settings-storage.ts';
import { getLastWavefrontMap } from '../../evaluation/wavefront/last-wavefront-runtime.ts';
import { getDoubletBendingCurrentK } from '../../optimization/doublet-bending.ts';

function tryLoadSystemConfigurations(): any {
    try {
        if (typeof localStorage === 'undefined') return null;
        return loadSystemConfigurations();
    } catch {
        return null;
    }
}

function isPlainObject(value: any): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.prototype.toString.call(value) === '[object Object]'
    );
}

function shouldEmitOptimizationWarning(key: string, intervalMs = 1500): boolean {
    try {
        if (!(w && w.__cooptOptimizerIsRunning === true)) {
            return true;
        }
        if (!w.__cooptOptimizationWarningThrottle || typeof w.__cooptOptimizationWarningThrottle !== 'object') {
            w.__cooptOptimizationWarningThrottle = {};
        }
        const throttle = w.__cooptOptimizationWarningThrottle as Record<string, number>;
        const now = Date.now();
        const prev = Number(throttle[key] || 0);
        if (Number.isFinite(prev) && now - prev < intervalMs) {
            return false;
        }
        throttle[key] = now;
        return true;
    } catch {
        return true;
    }
}

function cloneJson(v: any): any {
    try {
        return JSON.parse(JSON.stringify(v));
    } catch {
        return v;
    }
}

const __meritWarnOnceKeys = new Set<string>();

function meritWarnOnce(key: string, message: string): void {
    if (!key) return;
    if (__meritWarnOnceKeys.has(key)) return;
    __meritWarnOnceKeys.add(key);
    console.warn(message);
}

function normalizeParaxialAxisSelection(value: any): '' | 'X' | 'Y' {
    const s = String(value ?? '').trim().toUpperCase();
    if (s === 'X') return 'X';
    if (s === 'Y') return 'Y';
    return '';
}

function getParaxialMeridianFromAxis(axis: '' | 'X' | 'Y'): 'average' | 'sagittal' | 'tangential' {
    if (axis === 'X') return 'sagittal';
    if (axis === 'Y') return 'tangential';
    return 'average';
}

function readParaxialMeridianScalar(value: any, axis: '' | 'X' | 'Y'): number {
    if (axis === 'X') {
        const sagittal = Number(value?.sagittal);
        if (Number.isFinite(sagittal)) return sagittal;
    }
    if (axis === 'Y') {
        const tangential = Number(value?.tangential);
        if (Number.isFinite(tangential)) return tangential;
    }
    if (value && typeof value === 'object') {
        const average = Number(value?.average);
        if (Number.isFinite(average)) return average;
        const tangential = Number(value?.tangential);
        if (Number.isFinite(tangential)) return tangential;
        const sagittal = Number(value?.sagittal);
        if (Number.isFinite(sagittal)) return sagittal;
    }
    const direct = Number(value);
    return Number.isFinite(direct) ? direct : NaN;
}

function parseZernikeUnit(raw: any): string {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (s === 'um' || s === 'µm' || s === 'μm' || s === 'micron' || s === 'microns') {
        return 'um';
    }
    return 'waves';
}

function isGapOpticalRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;

    const blockType = String(row._blockType ?? row.blockType ?? '').trim().toLowerCase();
    if (blockType === 'gap' || blockType === 'airgap') return true;

    const objectType = String(row['object type'] ?? row.object ?? row.objectType ?? row.type ?? '').trim().toLowerCase();
    if (objectType === 'gap' || objectType === 'airgap' || objectType === 'air gap') return true;

    const surfaceRole = String(row._surfaceRole ?? row.surfaceRole ?? '').trim().toLowerCase();
    return surfaceRole === 'gap' || surfaceRole === 'airgap';
}

function isCoordTransOpticalRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;

    const values = [
        row.surfType, row.type, row.surfaceType, row.surface_type,
        row['object type'], row.object, row.Object,
        row.comment, row.Comment,
        row._blockType, row.blockType, row.block_type, row.blockTypeName,
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

function isRequirementGapLikeRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;

    const objType = String(row['object type'] ?? row.object ?? row.surfType ?? row.objectType ?? row.type ?? '').trim().toLowerCase();
    const material = String(row.material ?? '').trim().toLowerCase();
    const thickness = Number(row.thickness);

    const isObject = objType === 'object';
    const isImage = objType === 'image';
    const isCT = objType === 'ct' || objType.includes('coordinate') || objType.includes('coordtrans');
    const isStop = objType === 'stop' || objType === 'sto' || objType === 'aperturestop';
    const isGlass = !!material && material !== 'air';
    const isGapType = objType === 'gap' || objType.includes('gap') || isGapOpticalRow(row);
    const hasFiniteThickness = Number.isFinite(thickness);
    const gapThicknessRaw = row.__cooptGapThickness;
    const hasAttachedGapThickness = gapThicknessRaw !== undefined
        && gapThicknessRaw !== null
        && String(gapThicknessRaw).trim() !== '';

    if (isObject || isImage || isCT) return false;
    return isGapType || isStop || hasAttachedGapThickness || (!isGlass && hasFiniteThickness && Math.abs(thickness) > 1e-12);
}

function readRequirementGapThickness(row: any, rows: any[]): number {
    if (!row || typeof row !== 'object') return NaN;

    const gapThicknessRaw = row.__cooptGapThickness;
    if (gapThicknessRaw !== undefined && gapThicknessRaw !== null && String(gapThicknessRaw).trim() !== '') {
        const gapThickness = Number(gapThicknessRaw);
        if (Number.isFinite(gapThickness)) return gapThickness;
    }

    const directThickness = Number(row.thickness);
    if (Number.isFinite(directThickness) && Math.abs(directThickness) > 1e-12) {
        return directThickness;
    }

    const blockId = String(row._blockId ?? '').trim();
    if (blockId && Array.isArray(rows)) {
        const relatedGapRow = rows.find((candidate: any) => {
            if (!candidate || typeof candidate !== 'object') return false;
            if (String(candidate._blockId ?? '').trim() !== blockId) return false;
            const candidateGapRaw = candidate.__cooptGapThickness;
            return candidateGapRaw !== undefined && candidateGapRaw !== null && String(candidateGapRaw).trim() !== '';
        });
        if (relatedGapRow) {
            const relatedGap = Number(relatedGapRow.__cooptGapThickness);
            if (Number.isFinite(relatedGap)) return relatedGap;
        }
    }

    return Number.isFinite(directThickness) ? directThickness : NaN;
}

function collectRequirementGapThicknesses(rows: any[]): number[] {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const values: number[] = [];
    for (const row of rows) {
        if (!isRequirementGapLikeRow(row)) continue;
        const thickness = readRequirementGapThickness(row, rows);
        if (Number.isFinite(thickness)) {
            values.push(thickness);
        }
    }
    return values;
}

function collectFiniteThicknessValues(rows: any[]): number[] {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const values: number[] = [];
    for (const row of rows) {
        const objectType = String(row?.['object type'] ?? row?.object ?? row?.objectType ?? row?.type ?? '').trim().toLowerCase();
        if (objectType === 'object') continue;
        if (isRequirementGapLikeRow(row)) continue;
        const tRaw = row ? row.thickness : undefined;
        if (tRaw === undefined || tRaw === null) continue;
        const s = String(tRaw).trim().toUpperCase();
        if (s === 'INF' || s === 'INFINITY') continue;
        const t = Number(tRaw);
        if (Number.isFinite(t)) values.push(t);
    }
    return values;
}

function isRequirementRealSurfaceRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;

    const objectType = String(row['object type'] ?? row.object ?? row.objectType ?? row.type ?? '').trim().toLowerCase();
    if (objectType === 'object' || objectType === 'image') return false;
    if (isCoordTransOpticalRow(row)) return false;
    if (isGapOpticalRow(row)) return false;
    return true;
}

function readRequirementRadiusState(row: any): { kind: 'finite'; value: number } | { kind: 'infinite' } | { kind: 'invalid' } {
    if (!row || typeof row !== 'object') return { kind: 'invalid' };

    const radiusRaw = row.radius;
    const radiusText = String(radiusRaw ?? '').trim().toUpperCase();
    if (!radiusText) return { kind: 'invalid' };
    if (radiusText === 'INF' || radiusText === 'INFINITY' || radiusRaw === Infinity) {
        return { kind: 'infinite' };
    }

    const radius = Number(radiusRaw);
    if (!Number.isFinite(radius) || Math.abs(radius) <= 1e-12) {
        return { kind: 'invalid' };
    }

    return { kind: 'finite', value: Math.abs(radius) };
}

function collectRequirementSurfaceRadiusStates(rows: any[]): { finiteValues: number[]; hasInfinite: boolean; hasInvalid: boolean } {
    const finiteValues: number[] = [];
    let hasInfinite = false;
    let hasInvalid = false;

    if (!Array.isArray(rows) || rows.length === 0) {
        return { finiteValues, hasInfinite, hasInvalid: true };
    }

    for (const row of rows) {
        if (!isRequirementRealSurfaceRow(row)) continue;
        const state = readRequirementRadiusState(row);
        if (state.kind === 'finite') {
            finiteValues.push(state.value);
        } else if (state.kind === 'infinite') {
            hasInfinite = true;
        } else {
            hasInvalid = true;
        }
    }

    if (finiteValues.length === 0 && !hasInfinite) {
        hasInvalid = true;
    }

    return { finiteValues, hasInfinite, hasInvalid };
}

function resolveRequirementSurfaceBySelection(rows: any[], selectionRaw: any): { row: any; index: number } | null {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const surfaceNum = Math.floor(Number(selectionRaw));
    if (!Number.isFinite(surfaceNum) || surfaceNum < 1) return null;

    const byIdIndex = rows.findIndex((row: any) => Number(row?.id) === surfaceNum);
    if (byIdIndex >= 0) {
        return { row: rows[byIdIndex], index: byIdIndex };
    }

    const surfaceIndex0 = surfaceNum - 1;
    if (surfaceIndex0 >= 0 && surfaceIndex0 < rows.length) {
        return { row: rows[surfaceIndex0], index: surfaceIndex0 };
    }

    return null;
}

function calculateRequirementSurfaceDistance(rows: any[], startSelectionRaw: any, endSelectionRaw: any): number {
    if (!Array.isArray(rows) || rows.length === 0) return NaN;

    const startHit = resolveRequirementSurfaceBySelection(rows, startSelectionRaw);
    const endHit = resolveRequirementSurfaceBySelection(rows, endSelectionRaw);
    if (!startHit || !endHit) return NaN;
    if (startHit.index >= endHit.index) return NaN;

    let total = 0;
    let sawFinite = false;
    for (let index = startHit.index; index < endHit.index; index++) {
        const row = rows[index];
        if (!row || typeof row !== 'object') continue;

        const objectType = String(row?.['object type'] ?? row?.object ?? row?.objectType ?? row?.type ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image' || objectType === 'ct' || objectType.includes('coordinate') || objectType.includes('coordtrans')) {
            continue;
        }

        const thickness = readRequirementGapThickness(row, rows);
        if (!Number.isFinite(thickness)) continue;

        total += thickness;
        sawFinite = true;
    }

    return sawFinite ? total : NaN;
}

function resolveRequirementArithmeticRefCurrent(operand: any, refRaw: any): number | null {
    const refId = String(refRaw ?? '').trim();
    if (!refId) return null;

    const selfId = String(operand?.__reqRowId ?? '').trim();
    if (selfId && refId === selfId) return null;

    const state = operand?.__reqEvaluationState;
    const byId = state?.currentById;
    if (!byId || typeof byId.get !== 'function') return null;

    const value = byId.get(refId);
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function resolvePhysicalSurfaceIdRangeFromOrdinals(opticalSystemData: any[], startOrdinal: number, endOrdinal: number): { startSurf: number; endSurf: number } | null {
    if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

    const normalizedStart = Math.max(0, Math.floor(Number(startOrdinal) || 0));
    const normalizedEnd = Math.max(normalizedStart, Math.floor(Number(endOrdinal) || normalizedStart));

    let physicalOrdinal = 0;
    let startSurf: number | null = null;
    let endSurf: number | null = null;

    for (const row of opticalSystemData) {
        if (!row || isGapOpticalRow(row) || isCoordTransOpticalRow(row)) continue;

        const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image') continue;

        const surfaceId = Number(row.id);
        if (!Number.isFinite(surfaceId)) {
            continue;
        }

        if (physicalOrdinal === normalizedStart) {
            startSurf = surfaceId;
        }
        if (physicalOrdinal === normalizedEnd) {
            endSurf = surfaceId;
            break;
        }

        physicalOrdinal += 1;
    }

    if (!Number.isFinite(startSurf) || !Number.isFinite(endSurf)) return null;
    return { startSurf: Number(startSurf), endSurf: Number(endSurf) };
}

function readCoeff(container: any, noll: any): number {
    const n = Number(noll);
    if (!Number.isFinite(n) || !container || typeof container !== 'object') return 0;
    const key = String(Math.floor(n));
    const v = container[key];
    const num = Number(v);
    return Number.isFinite(num) ? num : 0;
}

function toFiniteNumber(v: any, fallback: number = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function isInfiniteSystemFromRows(opticalSystemRows: any[]): boolean {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;
    const t = opticalSystemRows[0]?.thickness;
    if (t === Infinity) return true;
    const s = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
    return (s === 'INF' || s === 'INFINITY');
}

function toFieldSettingFromObjectRow(objRow: any, index0: number, opticalSystemRows: any[] | null, wavelength = 0.5876): any {
    const isInfiniteSystem = isInfiniteSystemFromRows(Array.isArray(opticalSystemRows) ? opticalSystemRows : []);
    if (!objRow || typeof objRow !== 'object') {
        return isInfiniteSystem
            ? {
                type: 'Angle',
                position: 'Angle',
                objectIndex: index0 + 1,
                displayName: `Object ${index0 + 1}`,
                x: 0,
                y: 0,
                fieldAngle: { x: 0, y: 0 },
                xFieldAngle: 0,
                yFieldAngle: 0,
                xHeightAngle: 0,
                yHeightAngle: 0,
                angleX: 0,
                angleY: 0,
                xHeight: 0,
                yHeight: 0
            }
            : {
                type: 'Rectangle',
                position: 'Rectangle',
                objectIndex: index0 + 1,
                displayName: `Object ${index0 + 1}`,
                x: 0,
                y: 0,
                xHeight: 0,
                yHeight: 0,
                fieldAngle: { x: 0, y: 0 },
                fieldX: 0,
                fieldY: 0
            };
    }
    let normalizedRow = objRow;
    const positionRaw = String(objRow.position ?? objRow.fieldType ?? objRow.type ?? '').trim().toLowerCase();
    if (positionRaw.includes('imageheight') && Array.isArray(opticalSystemRows) && opticalSystemRows.length > 0) {
        try {
            const conjugateType = detectConjugateType(opticalSystemRows) === 'finite' ? 'finite' : 'infinite';
            const effectiveRow = convertImageHeightToEffectiveObject(
                objRow,
                opticalSystemRows,
                wavelength,
                conjugateType,
                {
                    skipTsValidation: true,
                    validationTraceBackend: 'rust',
                }
            );
            if (effectiveRow && typeof effectiveRow === 'object') {
                normalizedRow = {
                    ...objRow,
                    ...effectiveRow,
                    position: effectiveRow.__cooptEffectivePosition ?? effectiveRow.position ?? objRow.position,
                    __cooptOriginalPosition: objRow.position,
                };
            }
        } catch (_) {
            normalizedRow = objRow;
        }
    }

    const pickFirstFinite = (values: any[], fallback = 0): number => {
        for (const value of values) {
            const n = toFiniteNumber(value, NaN);
            if (Number.isFinite(n)) return n;
        }
        return fallback;
    };

    const fieldX = pickFirstFinite([
        normalizedRow.xHeightAngle,
        normalizedRow.xFieldAngle,
        normalizedRow.xHeight,
        normalizedRow.x,
        normalizedRow.angleX,
        normalizedRow.Hx
    ], 0);

    const fieldY = pickFirstFinite([
        normalizedRow.yHeightAngle,
        normalizedRow.yFieldAngle,
        normalizedRow.fieldAngle,
        normalizedRow.yHeight,
        normalizedRow.y,
        normalizedRow.angleY,
        normalizedRow.Hy
    ], 0);

    const objectIndex1 = index0 + 1;
    const displayName = String(normalizedRow.comment || normalizedRow.name || `Object ${objectIndex1}`);

    if (isInfiniteSystem) {
        return {
            type: 'Angle',
            position: 'Angle',
            objectIndex: objectIndex1,
            displayName,
            x: fieldX,
            y: fieldY,
            fieldAngle: { x: fieldX, y: fieldY },
            xFieldAngle: fieldX,
            yFieldAngle: fieldY,
            xHeightAngle: fieldX,
            yHeightAngle: fieldY,
            angleX: fieldX,
            angleY: fieldY,
            xHeight: 0,
            yHeight: 0
        };
    }

    return {
        type: 'Rectangle',
        position: 'Rectangle',
        objectIndex: objectIndex1,
        displayName,
        x: fieldX,
        y: fieldY,
        xHeight: fieldX,
        yHeight: fieldY,
        fieldAngle: { x: 0, y: 0 },
        fieldX: fieldX,
        fieldY: fieldY
    };
}

function sampleUnitDiskPoints({ rings = 4, spokes = 12 }: { rings?: number; spokes?: number } = {}): any[] {
    const pts: any[] = [];
    for (let iRing = 1; iRing <= rings; iRing++) {
        const r = iRing / rings;
        for (let iSpoke = 0; iSpoke < spokes; iSpoke++) {
            const theta = (2 * Math.PI * iSpoke) / spokes;
            const x = r * Math.cos(theta);
            const y = r * Math.sin(theta);
            pts.push({ x, y });
        }
    }
    return pts;
}

function withRequirementRustRayTracing<T>(callback: () => T, traceOverride?: Record<string, any>): T;
function withRequirementRustRayTracing<T>(callback: () => Promise<T>, traceOverride?: Record<string, any>): Promise<T>;
function withRequirementRustRayTracing<T>(callback: () => T | Promise<T>, traceOverride?: Record<string, any>): T | Promise<T> {
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : null;
    if (!g) return callback();

    const key = '__cooptTraceOptionsOverride';
    const prev = g[key];
    const prevObj = (prev && typeof prev === 'object' && !Array.isArray(prev)) ? prev : null;

    const defaultOverride = {
        useRustWasm: true,
        requireRustWasm: true,
        requireForwardHit: true
    };
    g[key] = {
        ...(prevObj || {}),
        ...(defaultOverride || {}),
        ...((traceOverride && typeof traceOverride === 'object') ? traceOverride : {})
    };

    const restore = () => {
        if (prev === undefined) {
            delete g[key];
        } else {
            g[key] = prev;
        }
    };

    try {
        const result = callback();
        if (result && typeof (result as any).then === 'function') {
            return (result as Promise<T>).finally(() => {
                try { restore(); } catch (_) {}
            });
        }
        restore();
        return result as T;
    } catch (error) {
        restore();
        throw error;
    }
}

const REQUIREMENT_SPOT_TRACE_OVERRIDE = {
    useRustWasm: true,
    requireRustWasm: false,
    allowNonStrict: true,
    requireForwardHit: false
};

function computeZernikeFitLive({
    opticalSystemData,
    wavelengthUm,
    fieldSetting,
    zernikeMaxNoll = 15,
    samplingSize = 32
}: {
    opticalSystemData: any[];
    wavelengthUm: number;
    fieldSetting: any;
    zernikeMaxNoll?: number;
    samplingSize?: number;
}): any {
    try {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
            console.warn('⚠️ computeZernikeFitLive: no optical system data');
            return null;
        }

        const imageSurfaceIndex = (() => {
            for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                const row = opticalSystemData[i];
                if (row && typeof row === 'object') {
                    const ot = String(row['object type'] || row.objectType || row.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
            }
            return opticalSystemData.length - 1;
        })();

        if (imageSurfaceIndex < 0 || imageSurfaceIndex >= opticalSystemData.length) {
            console.warn('⚠️ computeZernikeFitLive: image surface not found');
            return null;
        }

        const opdCalc = createOPDCalculator(opticalSystemData, wavelengthUm);

        if (!opdCalc) {
            console.warn('⚠️ computeZernikeFitLive: OPD calculator creation failed');
            return null;
        }

        const gridSize = Math.max(8, Math.floor(samplingSize));
        const gridPoints: any[] = [];
        for (let iy = 0; iy < gridSize; iy++) {
            const py = iy / (gridSize - 1);
            for (let ix = 0; ix < gridSize; ix++) {
                const px = ix / (gridSize - 1);
                const nx = 2 * px - 1;
                const ny = 2 * py - 1;
                const r = Math.hypot(nx, ny);
                if (r > 1) continue;
                gridPoints.push({ nx, ny });
            }
        }

        const { validPoints, opdValues } = (() => {
            const vp: any[] = [];
            const opdVals: number[] = [];
            for (const pt of gridPoints) {
                const opd = opdCalc.calculateOPD(pt.nx, pt.ny, fieldSetting);
                if (opd !== null && Number.isFinite(opd)) {
                    vp.push(pt);
                    opdVals.push(opd);
                }
            }
            return { validPoints: vp, opdValues: opdVals };
        })();

        if (validPoints.length === 0) {
            console.warn('⚠️ computeZernikeFitLive: no valid OPD points');
            return null;
        }

        const analyzer = new WavefrontAberrationAnalyzer(opdCalc);
        const fit = analyzer.fitZernikePolynomials({
            pupilCoordinates: validPoints.map((p) => ({ x: p.nx, y: p.ny })),
            opds: opdValues
        }, zernikeMaxNoll) as any;

        if (!fit || ((!fit.coefficientsMicrons || typeof fit.coefficientsMicrons !== 'object')
            && (!fit.coefficientsWaves || typeof fit.coefficientsWaves !== 'object'))) {
            console.warn('⚠️ computeZernikeFitLive: Zernike fit failed');
            return null;
        }

        return fit;
    } catch (error) {
        console.error('⚠️ computeZernikeFitLive error:', error);
        return null;
    }
}

function __cooptBuildPrimaryOnlySourceRows(sourceRows: any[], wavelengthUm: number): any[] {
    const rows = Array.isArray(sourceRows)
        ? sourceRows.map((r: any) => (r && typeof r === 'object' ? { ...r } : r))
        : [];
    if (rows.length === 0) return rows;

    let bestIdx = -1;
    let bestDiff = Infinity;
    const targetWl = Number(wavelengthUm);
    for (let i = 0; i < rows.length; i++) {
        const wl = Number(rows[i]?.wavelength);
        if (!Number.isFinite(wl)) continue;
        const diff = Number.isFinite(targetWl) ? Math.abs(wl - targetWl) : i;
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) return rows;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || typeof row !== 'object') continue;
        row.primary = (i === bestIdx) ? 'Primary Wavelength' : '';
    }
    return rows;
}

function fieldSettingCacheKey(fieldSetting: any): string {
    try {
        if (!fieldSetting || typeof fieldSetting !== 'object') return 'default';
        const keys = Object.keys(fieldSetting).sort();
        const parts = keys.map(k => `${k}=${fieldSetting[k]}`);
        return parts.join(',');
    } catch {
        return 'default';
    }
}

const __taFastCrossEvalCacheMax = 512;
const __taFastCrossEvalCache = new Map<string, any>();

function getTaFastCrossEvalCache(key: string): any {
    if (!key || !__taFastCrossEvalCache.has(key)) return null;
    const value = __taFastCrossEvalCache.get(key);
    __taFastCrossEvalCache.delete(key);
    __taFastCrossEvalCache.set(key, value);
    return value;
}

function setTaFastCrossEvalCache(key: string, value: any): void {
    if (!key) return;
    if (__taFastCrossEvalCache.has(key)) __taFastCrossEvalCache.delete(key);
    while (__taFastCrossEvalCache.size >= __taFastCrossEvalCacheMax) {
        const oldest = __taFastCrossEvalCache.keys().next();
        if (!oldest || oldest.done) break;
        __taFastCrossEvalCache.delete(oldest.value);
    }
    __taFastCrossEvalCache.set(key, value);
}

function parseOverrideKey(variableId: any): { blockId: string | null; key: string | null } {
    if (typeof variableId !== 'string') return { blockId: null, key: null };
    const parts = variableId.split('.');
    if (parts.length < 2) return { blockId: null, key: null };
    const blockId = parts[0];
    const key = parts.slice(1).join('.');
    return { blockId, key };
}

function applyOverridesToBlocks(blocks: any[], overrides: any): any[] {
    if (!Array.isArray(blocks)) return [];
    if (!overrides || typeof overrides !== 'object') return blocks;

    const cloned = cloneJson(blocks);
    if (!Array.isArray(cloned)) return blocks;

    for (const [variableId, value] of Object.entries(overrides)) {
        const { blockId, key } = parseOverrideKey(variableId);
        if (!blockId || !key) continue;

        const block = cloned.find((b: any) => b && String(b.blockId ?? b.id ?? '') === String(blockId));
        if (!block || typeof block !== 'object') continue;

        const keys = key.split('.');
        let target: any = block;
        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (target[k] === undefined || target[k] === null) {
                target[k] = {};
            }
            target = target[k];
            if (typeof target !== 'object') break;
        }

        if (typeof target === 'object') {
            target[keys[keys.length - 1]] = value;
        }
    }

    return cloned;
}

class MeritFunctionEditor {
    operands: any[] = [];
    table: any | null = null;
    totalMeritValue: HTMLElement | null = null;
    inspector: InspectorManager | null = null;
    _runtimeCache: Map<string, any> | null = null;

    constructor() {
        this.loadFromStorage();
        this.initializeTable();
        this.initializeEventListeners();
    }

    private normalizeMeritOperands(data: any[]): { operands: any[]; droppedInvalidEffl: any[] } {
        const droppedInvalidEffl: any[] = [];

        let activeConfigId = "";
        try {
            const systemConfig = tryLoadSystemConfigurations();
            if (systemConfig && systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null) {
                activeConfigId = String(systemConfig.activeConfigId);
            }
        } catch (e) {
            console.warn('Active config ID取得エラー:', e);
        }

        const dropDeprecated = (op: any) => {
            const name = String(op?.operand ?? '').trim();
            return name === 'ZERN_WL_UM' || name === 'ZERN_FIT_TERMS';
        };

        const normalized = Array.isArray(data)
            ? data
                .filter((op: any) => !dropDeprecated(op))
                .map((operand: any) => {
                    if (operand.configId === undefined || operand.configId === null) {
                        return { ...operand, configId: activeConfigId };
                    }
                    return { ...operand, configId: String(operand.configId) };
                })
            : [];

        const validByConfigId = new Map<string, Set<number>>();
        const getValidSurfaceIds = (configId: any): Set<number> | null => {
            const key = (configId === undefined || configId === null) ? '' : String(configId).trim();
            if (validByConfigId.has(key)) return validByConfigId.get(key) ?? null;
            try {
                const opticalRows = this.getOpticalSystemDataByConfigId(key);
                const validIds = new Set<number>();
                if (Array.isArray(opticalRows)) {
                    for (const row of opticalRows) {
                        const objectType = String(row?.['object type'] ?? '').trim().toLowerCase();
                        if (objectType === 'object' || objectType === 'image') continue;
                        const surfaceId = Number(row?.id);
                        if (Number.isFinite(surfaceId)) validIds.add(surfaceId);
                    }
                }
                validByConfigId.set(key, validIds);
                return validIds;
            } catch (_) {
                validByConfigId.set(key, new Set<number>());
                return null;
            }
        };

        const operands = normalized.filter((operand: any) => {
            if (String(operand?.operand ?? '').trim().toUpperCase() !== 'EFFL') {
                return true;
            }

            const startSurf = Number.parseInt(String(operand?.param2 ?? '').trim(), 10);
            const endSurf = Number.parseInt(String(operand?.param3 ?? '').trim(), 10);
            if (!Number.isFinite(startSurf) || !Number.isFinite(endSurf)) {
                return true;
            }

            const validSurfaceIds = getValidSurfaceIds(operand?.configId);
            if (!validSurfaceIds || validSurfaceIds.size === 0) {
                return true;
            }

            if (!validSurfaceIds.has(startSurf) || !validSurfaceIds.has(endSurf)) {
                droppedInvalidEffl.push(operand);
                return false;
            }

            return true;
        });

        return { operands, droppedInvalidEffl };
    }

    initializeTable(): void {
        const container = document.getElementById('table-merit-function');
        if (!container) {
            const isAnalysisPopup = (() => {
                try {
                    const url = new URL(window.location.href);
                    return url.searchParams.get('coopt_analysis_window') === '1';
                } catch (_) {
                    return false;
                }
            })();
            if (!isAnalysisPopup) {
                console.warn('ℹ️ Merit Function テーブルコンテナ未マウント: noop tableで継続します');
            }
            this.table = this.createNoopTable();
            return;
        }

        try {
            this.table = new w.Tabulator(container, {
                data: this.operands,
                layout: "fitColumns",
                height: "100%",
                editTriggerEvent: "click",
                placeholder: "オペランドがありません。「Add Operand」ボタンでオペランドを追加してください。",
                rowHeight: 35,
                columns: [
                    {
                        title: "Num",
                        field: "id",
                        width: 60,
                        headerSort: false,
                        formatter: (cell: any) => {
                            const value = cell.getValue();
                            return value !== undefined ? value : '';
                        }
                    },
                    {
                        title: "Evaluation Function",
                        field: "operand",
                        width: 180,
                        editor: "list",
                        editorParams: {
                            values: (() => {
                                const operandKeys = InspectorManager.getAvailableOperands();
                                const valuesList: any = { "": "" };
                                operandKeys.forEach((key: string) => {
                                    valuesList[key] = key;
                                });
                                return valuesList;
                            })()
                        },
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                            const row = cell.getRow();
                            const rowData = row.getData();
                            this.updateParameterHeaders(rowData);
                        }
                    },
                    {
                        title: "Config",
                        field: "configId",
                        width: 120,
                        editor: "list",
                        editorParams: {
                            values: () => {
                                return this.getConfigurationList();
                            }
                        },
                        formatter: (cell: any) => {
                            const configId = cell.getValue();
                            return this.getConfigName(configId);
                        },
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "-",
                        field: "param1",
                        width: 80,
                        editor: "input",
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "-",
                        field: "param2",
                        width: 100,
                        editor: "list",
                        editorParams: {
                            values: {
                                '0': '0 (Imaging)',
                                '1': '1 (Afocal)'
                            }
                        },
                        formatter: (cell: any) => {
                            const value = String(cell.getValue() || '0');
                            if (value === '1') return '1 (Afocal)';
                            return '0 (Imaging)';
                        },
                        cellClick: (e: any, cell: any) => {
                            e?.stopPropagation?.();
                            try {
                                cell.edit(true);
                            } catch (_) {}
                        },
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "-",
                        field: "param3",
                        width: 140,
                        editor: (cell: any, onRendered: any, success: any, cancel: any) => {
                            const rowData = cell.getRow().getData();
                            const options = this.getMeritScopeOptions(rowData);
                            const input = document.createElement('input');
                            input.type = 'text';
                            input.style.width = '100%';
                            input.style.height = '100%';
                            input.style.border = 'none';
                            input.style.padding = '4px';
                            input.style.boxSizing = 'border-box';
                            input.value = String(cell.getValue() ?? '');

                            const dropdown = document.createElement('div');
                            dropdown.style.position = 'fixed';
                            dropdown.style.zIndex = '10000';
                            dropdown.style.background = '#fff';
                            dropdown.style.border = '1px solid #ccc';
                            dropdown.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
                            dropdown.style.maxHeight = '240px';
                            dropdown.style.overflowY = 'auto';
                            dropdown.style.minWidth = `${Math.max(cell.getElement().getBoundingClientRect().width, 180)}px`;

                            const renderOptions = () => {
                                const term = input.value.trim().toLowerCase();
                                dropdown.innerHTML = '';

                                const entries = Object.entries(options).filter(([value, label]) => {
                                    if (!term) return true;
                                    return String(value).toLowerCase().includes(term) || String(label).toLowerCase().includes(term);
                                });

                                if (entries.length === 0) {
                                    const empty = document.createElement('div');
                                    empty.textContent = 'No Scope Options';
                                    empty.style.padding = '8px 10px';
                                    empty.style.color = '#666';
                                    dropdown.appendChild(empty);
                                    return;
                                }

                                entries.forEach(([value, label]) => {
                                    const item = document.createElement('div');
                                    item.textContent = String(label);
                                    item.style.padding = '8px 10px';
                                    item.style.cursor = 'pointer';
                                    item.addEventListener('mouseenter', () => {
                                        item.style.background = '#f2f4f7';
                                    });
                                    item.addEventListener('mouseleave', () => {
                                        item.style.background = 'transparent';
                                    });
                                    item.addEventListener('mousedown', (event: MouseEvent) => {
                                        event.preventDefault();
                                        cleanup();
                                        success(value);
                                    });
                                    dropdown.appendChild(item);
                                });
                            };

                            const positionDropdown = () => {
                                const rect = cell.getElement().getBoundingClientRect();
                                dropdown.style.left = `${rect.left}px`;
                                dropdown.style.top = `${rect.bottom}px`;
                            };

                            const cleanup = () => {
                                dropdown.remove();
                                window.removeEventListener('scroll', positionDropdown, true);
                                window.removeEventListener('resize', positionDropdown);
                            };

                            input.addEventListener('input', () => {
                                positionDropdown();
                                renderOptions();
                            });

                            input.addEventListener('keydown', (event: KeyboardEvent) => {
                                if (event.key === 'Enter') {
                                    cleanup();
                                    success(input.value.trim());
                                } else if (event.key === 'Escape') {
                                    cleanup();
                                    cancel();
                                }
                            });

                            input.addEventListener('blur', () => {
                                window.setTimeout(() => {
                                    cleanup();
                                    success(input.value.trim());
                                }, 120);
                            });

                            onRendered(() => {
                                document.body.appendChild(dropdown);
                                positionDropdown();
                                renderOptions();
                                window.addEventListener('scroll', positionDropdown, true);
                                window.addEventListener('resize', positionDropdown);
                                input.focus();
                                input.select();
                            });

                            return input;
                        },
                        formatter: (cell: any) => {
                            const rowData = cell.getRow().getData();
                            return this.formatMeritScopeValue(rowData, cell.getValue());
                        },
                        cellClick: (e: any, cell: any) => {
                            e?.stopPropagation?.();
                            try {
                                cell.edit(true);
                            } catch (_) {}
                        },
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "-",
                        field: "param4",
                        width: 80,
                        editor: "input",
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "-",
                        field: "param5",
                        width: 100,
                        editor: (cell: any, onRendered: any, success: any, cancel: any) => {
                            const rowData = cell.getRow().getData();
                            const operandType = rowData?.operand || '';
                            const isSpotSizeOperand = operandType.startsWith('SPOT_SIZE');
                            
                            if (isSpotSizeOperand) {
                                // Create dropdown for SPOT_SIZE operands
                                const select = document.createElement('select');
                                select.style.width = '100%';
                                select.style.height = '100%';
                                select.style.border = 'none';
                                select.style.padding = '4px';
                                
                                const surfaceList = this.getSurfaceList(rowData);
                                Object.entries(surfaceList).forEach(([value, label]) => {
                                    const option = document.createElement('option');
                                    option.value = value;
                                    option.textContent = String(label);
                                    select.appendChild(option);
                                });
                                
                                const currentValue = String(cell.getValue() || '');
                                select.value = currentValue;
                                
                                select.addEventListener('change', () => {
                                    success(select.value);
                                });
                                
                                select.addEventListener('blur', () => {
                                    success(select.value);
                                });
                                
                                return select;
                            } else {
                                // Create text input for other operands
                                const input = document.createElement('input');
                                input.type = 'text';
                                input.style.width = '100%';
                                input.style.height = '100%';
                                input.style.border = 'none';
                                input.style.padding = '4px';
                                input.value = cell.getValue() || '';
                                
                                input.addEventListener('blur', () => {
                                    success(input.value);
                                });
                                
                                input.addEventListener('keydown', (e: any) => {
                                    if (e.key === 'Enter') {
                                        success(input.value);
                                    } else if (e.key === 'Escape') {
                                        cancel();
                                    }
                                });
                                
                                setTimeout(() => input.focus(), 10);
                                return input;
                            }
                        },
                        formatter: (cell: any) => {
                            const rowData = cell.getRow().getData();
                            const operandType = rowData?.operand || '';
                            const isSpotSizeOperand = operandType.startsWith('SPOT_SIZE');
                            const value = cell.getValue();
                            
                            if (isSpotSizeOperand) {
                                if (!value || value === '') {
                                    return '(Image)';
                                }
                                const surfaceList = this.getSurfaceList(rowData);
                                return surfaceList[String(value)] || value;
                            }
                            
                            return value || '';
                        },
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "Target",
                        field: "target",
                        width: 80,
                        editor: "input",
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "Weight",
                        field: "weight",
                        width: 80,
                        editor: "input",
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "Result",
                        field: "result",
                        width: 100,
                        formatter: (cell: any) => {
                            const value = cell.getValue();
                            if (value === undefined || value === null || value === '') return '';
                            const num = Number(value);
                            return Number.isFinite(num) ? num.toFixed(6) : String(value);
                        }
                    },
                    {
                        title: "Impact (%)",
                        field: "impact",
                        width: 100,
                        formatter: (cell: any) => {
                            const value = cell.getValue();
                            if (value === undefined || value === null || value === '') return '';
                            const num = Number(value);
                            return Number.isFinite(num) ? num.toFixed(2) : String(value);
                        }
                    }
                ]
            });

            this.table.on("rowClick", (e: any, row: any) => {
                const selectedRows = this.table.getSelectedRows();
                selectedRows.forEach((r: any) => r.deselect());
                row.toggleSelect();

                const rowData = row.getData();
                if (this.inspector) {
                    this.inspector.update(rowData);
                    this.updateParameterHeaders(rowData);
                }
            });

        } catch (error) {
            console.error('❌ Merit Function Tabulator初期化エラー:', error);
            this.table = this.createNoopTable();
        }

        this.totalMeritValue = document.getElementById('total-merit-value');

        try {
            const inspectorContainer = document.getElementById('merit-function-inspector');
            if (inspectorContainer) {
                this.inspector = new InspectorManager('merit-function-inspector');
            }
        } catch (error) {
            console.error('❌ Inspector初期化エラー:', error);
        }
    }

    createNoopTable(): any {
        return {
            setData: (data: any) => { console.log('Noop table setData:', data); },
            getData: () => [],
            addRow: () => {},
            deleteRow: () => {},
            getSelectedRows: () => [],
            redraw: () => {},
            getColumn: () => null
        };
    }

    initializeEventListeners(): void {
        const addBtn = document.getElementById('add-operand-btn');
        if (addBtn) {
            const newAddBtn = addBtn.cloneNode(true) as HTMLElement;
            addBtn.parentNode?.replaceChild(newAddBtn, addBtn);
            newAddBtn.addEventListener('click', () => {
                this.addOperand();
            });
        }

        const deleteBtn = document.getElementById('delete-operand-btn');
        if (deleteBtn) {
            const newDelBtn = deleteBtn.cloneNode(true) as HTMLElement;
            deleteBtn.parentNode?.replaceChild(newDelBtn, deleteBtn);
            newDelBtn.addEventListener('click', () => {
                this.deleteOperand();
            });
        }

        const calculateBtn = document.getElementById('calculate-merit-btn');
        if (calculateBtn) {
            const newCalcBtn = calculateBtn.cloneNode(true) as HTMLElement;
            calculateBtn.parentNode?.replaceChild(newCalcBtn, calculateBtn);
            newCalcBtn.addEventListener('click', () => {
                this.calculateMerit();
            });
        }
    }

    addOperand(operandType: string | null = null, params: any = {}): void {
        if (!this.table) return;

        const newOperand: any = {
            id: Date.now(),
            operand: operandType || null,
            configId: (() => {
                try {
                    const systemConfig = tryLoadSystemConfigurations();
                    const activeConfigId = systemConfig?.activeConfigId;
                    return (activeConfigId !== undefined && activeConfigId !== null) ? String(activeConfigId) : "";
                } catch {
                    return "";
                }
            })(),
            param1: params.param1 !== undefined ? params.param1 : null,
            param2: params.param2 !== undefined ? params.param2 : null,
            param3: params.param3 !== undefined ? params.param3 : null,
            param4: params.param4 !== undefined ? params.param4 : null,
            param5: params.param5 !== undefined ? params.param5 : null,
            target: params.target !== undefined ? params.target : 0,
            weight: params.weight !== undefined ? params.weight : 1,
            result: null,
            impact: null
        };

        const selectedRows = this.table.getSelectedRows();
        if (selectedRows && selectedRows.length > 0) {
            const selectedRow = selectedRows[0];
            const selectedRowData = selectedRow.getData();
            const index = this.operands.findIndex((op: any) => op.id === selectedRowData.id);
            if (index >= 0) {
                this.operands.splice(index + 1, 0, newOperand);
            } else {
                this.operands.push(newOperand);
            }
        } else {
            this.operands.push(newOperand);
        }

        this.updateRowNumbers();
        this.table.setData(this.operands);
        this.saveToStorage();
        console.log('✅ オペランドを追加しました:', newOperand);
    }

    deleteOperand(): void {
        if (!this.table) return;

        const selectedRows = this.table.getSelectedRows();
        if (!selectedRows || selectedRows.length === 0) {
            alert('削除する行を選択してください');
            return;
        }

        const selectedIds = selectedRows.map((row: any) => row.getData().id);
        this.operands = this.operands.filter((op: any) => !selectedIds.includes(op.id));

        this.updateRowNumbers();
        this.table.setData(this.operands);
        this.saveToStorage();
        console.log('✅ オペランドを削除しました:', selectedIds);
    }

    updateRowNumbers(): void {
        this.operands.forEach((op: any, index: number) => {
            op.id = index + 1;
        });
    }

    calculateMerit(): void {
        if (!this.table) return;

        this._runtimeCache = new Map();

        let totalMerit = 0;
        const terms: any[] = [];

        for (const operand of this.operands) {
            const calculatedValue = this.calculateOperandValue(operand);
            const target = Number(operand.target) || 0;
            const weight = Number(operand.weight) || 0;

            const error = calculatedValue - target;
            const weightedError = error * error * weight;

            operand.result = calculatedValue;
            totalMerit += weightedError;

            terms.push({
                id: operand.id,
                value: calculatedValue,
                target,
                weight,
                error,
                term: weightedError
            });
        }

        for (let i = 0; i < terms.length; i++) {
            const contribution = totalMerit > 0 ? (terms[i].term / totalMerit) * 100 : 0;
            this.operands[i].impact = contribution;
        }

        this._runtimeCache = null;

        this.table.setData(this.operands);

        if (this.totalMeritValue) {
            this.totalMeritValue.textContent = totalMerit.toFixed(6);
        }

        console.log('✅ Merit Function 計算完了:', {
            totalMerit: totalMerit.toFixed(6),
            terms: terms.length
        });

        requestAnimationFrame(() => {
            if (this.table && this.table.element) {
                const focused = document.activeElement;
                if (focused && this.table.element.contains(focused)) {
                    (focused as HTMLElement).focus();
                }
            }
        });
    }

    calculateMeritValueOnly(): number {
        this._runtimeCache = new Map();

        let totalMerit = 0;

        for (const operand of this.operands) {
            const calculatedValue = this.calculateOperandValue(operand);
            const target = Number(operand.target) || 0;
            const weight = Number(operand.weight) || 0;
            const error = calculatedValue - target;
            const weightedError = error * error * weight;
            totalMerit += weightedError;
        }

        this._runtimeCache = null;

        return totalMerit;
    }

    calculateMeritBreakdownOnly(): { total: number; terms: any[] } {
        this._runtimeCache = new Map();

        let totalMerit = 0;
        const terms: any[] = [];

        for (const operand of this.operands) {
            const calculatedValue = this.calculateOperandValue(operand);
            const target = Number(operand.target) || 0;
            const weight = Number(operand.weight) || 0;

            const error = calculatedValue - target;
            const weightedError = error * error * weight;

            totalMerit += weightedError;

            terms.push({
                id: operand.id,
                operand: operand.operand,
                configId: operand.configId,
                value: calculatedValue,
                target,
                weight,
                error,
                term: weightedError,
                impactPct: 0,
                weightedResidual: Math.sqrt(weight) * error,
                sqrtWeight: Math.sqrt(weight)
            });
        }

        for (const term of terms) {
            term.impactPct = totalMerit > 0 ? (term.term / totalMerit) * 100 : 0;
        }

        this._runtimeCache = null;

        return { total: totalMerit, terms };
    }

    calculateOperandValue(operand: any): number {
        if (!operand || !operand.operand) return 0;

        const opticalSystemData = this.getOpticalSystemDataByConfigId(operand.configId);

        const isOperandActiveConfig = (() => {
            try {
                const systemConfig = tryLoadSystemConfigurations();
                const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                    ? String(systemConfig.activeConfigId)
                    : '';
                const operandConfigId = (operand.configId !== undefined && operand.configId !== null)
                    ? String(operand.configId)
                    : '';
                return activeConfigId && operandConfigId && activeConfigId === operandConfigId;
            } catch {
                return false;
            }
        })();

        const isCurrentOperand = !operand.configId || String(operand.configId).trim() === '';

        const meritFast = (typeof globalThis !== 'undefined' && w.__cooptMeritFastMode) || null;

        switch (operand.operand) {
            case 'FL':
            case 'BFL':
            case 'IMD':
            case 'OBJD':
            case 'TSL':
            case 'BEXP':
            case 'EXPD':
            case 'EXPP':
            case 'ENPD':
            case 'ENPP':
            case 'ENPM':
            case 'PMAG':
            case 'FNO_OBJ':
            case 'FNO_IMG':
            case 'FNO_WRK':
            case 'NA_OBJ':
            case 'NA_IMG':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, operand.operand);
            
            case 'EFL':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'EFL');
            case 'PP1':
            case 'PP2':
                return this.calculatePrincipalPointMetric(operand, opticalSystemData, operand.operand);
            case 'EFFL':
                return this.calculateEFFL(operand, opticalSystemData);

            case 'TOT3_SPH':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'I');
            case 'TOT3_COMA':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'II');
            case 'TOT3_ASTI':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'III');
            case 'TOT3_FCUR':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'IV');
            case 'TOT3_DIST':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'V');
            case 'TOT3_PETZ':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'P');
            case 'TOT_LCA':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'LCA');
            case 'TOT_TCA':
                return this.calculateSeidelTotal(operand, opticalSystemData, 'TCA');

            case 'REAY':
            case 'RSCE':
            case 'TRAC':
            case 'DIST':
                return 0;

            case 'CLRH':
                return this.calculateClearanceVsSemidia(operand, opticalSystemData);

            case 'SPOT_SIZE_ANNULAR':
                return withRequirementRustRayTracing(() => this.calculateSpotSizeUm(operand, opticalSystemData, { pattern: 'annular', useUiDefaults: false }));
            case 'SPOT_SIZE_RECT':
                return withRequirementRustRayTracing(() => this.calculateSpotSizeUm(operand, opticalSystemData, { pattern: 'grid', useUiDefaults: false }));
            case 'SPOT_SIZE_CURRENT':
                return withRequirementRustRayTracing(() => this.calculateSpotSizeUm(operand, opticalSystemData, { pattern: 'annular', useUiDefaults: false }));

            case 'LA_RMS_UM':
                return this.calculateLongitudinalAberrationRmsUm(operand, opticalSystemData);

            case 'SA':
                return this.calculateSphericalAberrationUm(operand, opticalSystemData);

            case 'TA_RMS_UM':
                return withRequirementRustRayTracing(() => this.calculateTransverseAberrationRmsUm(operand, opticalSystemData));

            case 'OPD_RMS_WAVES':
            case 'OPD_RMS_UM':
                return withRequirementRustRayTracing(() => this.calculateOpdRmsWaves(operand, opticalSystemData));

            case 'CTCT': {
                // Center Thickness: Evaluate thickness of specified surface
                const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
                if (!param1Raw) {
                    return 1e9;
                }

                if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                    return 1e9;
                }

                const surfaceNum = Math.floor(Number(param1Raw));
                const resolveSurfaceBySelection = (rows: any[]): any => {
                    if (!Array.isArray(rows) || rows.length === 0 || !Number.isFinite(surfaceNum)) return null;

                    const byId = rows.find((row: any) => Number(row?.id) === surfaceNum) || null;
                    if (byId) return byId;

                    if (surfaceNum >= 1) {
                        const surfaceIndex0 = surfaceNum - 1;
                        if (surfaceIndex0 >= 0 && surfaceIndex0 < rows.length) {
                            return rows[surfaceIndex0];
                        }
                    }

                    return null;
                };

                let surface = resolveSurfaceBySelection(opticalSystemData);
                if (!surface) {
                    return 1e9;
                }

                let thickness = readRequirementGapThickness(surface, opticalSystemData);

                if ((!Number.isFinite(thickness) || Math.abs(thickness) <= 1e-12) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        const liveRows = getOpticalSystemRows(null);
                        const liveSurface = resolveSurfaceBySelection(liveRows);
                        const liveThickness = readRequirementGapThickness(liveSurface, liveRows);
                        if (Number.isFinite(liveThickness)) {
                            thickness = liveThickness;
                        }
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                if (!Number.isFinite(thickness)) {
                    return 1e9;
                }

                return thickness;
            }

            case 'GAP':
            case 'GMIN':
            case 'GMAX': {
                const modeRaw = String(operand?.param1 ?? '').trim().toUpperCase();
                const useMinimum = operand.operand === 'GMIN' || (operand.operand === 'GAP' && modeRaw !== 'MAX');
                let gapThicknesses = collectRequirementGapThicknesses(opticalSystemData);

                if ((gapThicknesses.length === 0 || gapThicknesses.every((value) => !Number.isFinite(value))) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        const liveRows = getOpticalSystemRows(null);
                        gapThicknesses = collectRequirementGapThicknesses(liveRows);
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                if (!Array.isArray(gapThicknesses) || gapThicknesses.length === 0) {
                    return 1e9;
                }

                const finiteValues = gapThicknesses.filter((value) => Number.isFinite(value));
                if (finiteValues.length === 0) return 1e9;
                return useMinimum ? Math.min(...finiteValues) : Math.max(...finiteValues);
            }

            case 'THIC': {
                const modeRaw = String(operand?.param1 ?? '').trim().toUpperCase();
                const useMinimum = modeRaw !== 'MAX';
                let thicknessValues = collectFiniteThicknessValues(opticalSystemData);

                if ((thicknessValues.length === 0 || thicknessValues.every((value) => !Number.isFinite(value))) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        const liveRows = getOpticalSystemRows(null);
                        thicknessValues = collectFiniteThicknessValues(liveRows);
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                if (!Array.isArray(thicknessValues) || thicknessValues.length === 0) {
                    return 1e9;
                }

                const finiteValues = thicknessValues.filter((value) => Number.isFinite(value));
                if (finiteValues.length === 0) return 1e9;
                return useMinimum ? Math.min(...finiteValues) : Math.max(...finiteValues);
            }

            case 'REQMATH': {
                const left = resolveRequirementArithmeticRefCurrent(operand, operand?.param1);
                const right = resolveRequirementArithmeticRefCurrent(operand, operand?.param3);
                const operator = String(operand?.param2 ?? '').trim();

                if (!Number.isFinite(left) || !Number.isFinite(right)) {
                    return 1e9;
                }

                switch (operator) {
                    case '+':
                        return left + right;
                    case '-':
                        return left - right;
                    case '*':
                        return left * right;
                    case '/':
                        if (Math.abs(right) <= 1e-12) return 1e9;
                        return left / right;
                    default:
                        return 1e9;
                }
            }

            case 'SDIST': {
                const startRaw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
                const endRaw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
                if (!startRaw || !endRaw || !Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                    return 1e9;
                }

                let distance = calculateRequirementSurfaceDistance(opticalSystemData, startRaw, endRaw);

                if (!Number.isFinite(distance) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        const liveRows = getOpticalSystemRows(null);
                        distance = calculateRequirementSurfaceDistance(liveRows, startRaw, endRaw);
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                return Number.isFinite(distance) ? distance : 1e9;
            }

            case 'RADI': {
                const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
                if (!param1Raw || !Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                    return 1e9;
                }

                const surfaceNum = Math.floor(Number(param1Raw));
                if (!Number.isFinite(surfaceNum) || surfaceNum < 1) {
                    return 1e9;
                }

                let surface = resolveRequirementSurfaceBySelection(opticalSystemData, surfaceNum)?.row || null;
                let radiusState = readRequirementRadiusState(surface);
                let radius = radiusState.kind === 'finite' ? radiusState.value : NaN;

                if ((!Number.isFinite(radius) || radius <= 1e-12) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        const liveRows = getOpticalSystemRows(null);
                        surface = resolveRequirementSurfaceBySelection(liveRows, surfaceNum)?.row || null;
                        radiusState = readRequirementRadiusState(surface);
                        if (radiusState.kind === 'finite') {
                            radius = radiusState.value;
                        }
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                return Number.isFinite(radius) ? radius : 1e9;
            }

            case 'RADI_ALL': {
                const mode = String(operand.param1 ?? '').trim().toUpperCase() === 'MAX' ? 'MAX' : 'MIN';
                if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                    return 1e9;
                }

                const evaluateRows = (rows: any[]): number => {
                    const summary = collectRequirementSurfaceRadiusStates(rows);
                    if (summary.hasInvalid) return 1e9;
                    if (mode === 'MAX') {
                        if (summary.hasInfinite || summary.finiteValues.length === 0) return 1e9;
                        return Math.max(...summary.finiteValues);
                    }
                    if (summary.finiteValues.length === 0) return 1e9;
                    return Math.min(...summary.finiteValues);
                };

                let radius = evaluateRows(opticalSystemData);
                if ((!Number.isFinite(radius) || radius >= 1e8) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        radius = evaluateRows(getOpticalSystemRows(null));
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                return Number.isFinite(radius) ? radius : 1e9;
            }

            case 'EDGE': {
                // Edge Thickness: thickness - sag1 - sag2 at specified height
                const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
                const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
                const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim().toUpperCase() : '';
                
                if (!param1Raw) {
                    return 1e9;
                }
                
                const surfaceIndex1 = Math.floor(Number(param1Raw));
                let height = Number(param2Raw);
                
                // If height is not provided, assume full diameter (100%)
                if (!Number.isFinite(height) || height <= 0) {
                    // Try to get semidia from the surface as default
                    if (!Array.isArray(opticalSystemData)) {
                        return 1e9;
                    }
                    
                    const surfaceIndex0Temp = surfaceIndex1 - 1;
                    if (surfaceIndex0Temp < opticalSystemData.length) {
                        const surfTemp = opticalSystemData[surfaceIndex0Temp];
                        if (surfTemp) {
                            const semidiaVal = Number(surfTemp.semidia);
                            if (Number.isFinite(semidiaVal) && semidiaVal > 0) {
                                height = semidiaVal;
                            } else {
                                height = 10; // hardcoded fallback
                            }
                        }
                    }
                }
                
                if (!Number.isFinite(surfaceIndex1) || surfaceIndex1 < 1) {
                    return 1e9;
                }
                if (!Number.isFinite(height) || height <= 0) {
                    return 1e9;
                }
                
                if (!Array.isArray(opticalSystemData)) {
                    return 1e9;
                }
                
                const surfaceIndex0 = surfaceIndex1 - 1;
                if (surfaceIndex0 >= opticalSystemData.length) {
                    return 1e9;
                }
                
                
                const computeEdgeThicknessForRows = (rows: any[]): number => {
                    if (!Array.isArray(rows)) return Number.NaN;
                    if (surfaceIndex0 < 0 || surfaceIndex0 >= rows.length) return Number.NaN;

                    const surface = rows[surfaceIndex0];
                    if (!surface) return Number.NaN;

                    const thickness = Number(surface.thickness);
                    if (!Number.isFinite(thickness)) return Number.NaN;

                    const computeSurfaceSag = (surfaceRow: any): number => {
                        if (!surfaceRow || typeof surfaceRow !== 'object') return 0;
                        const surfType = String(surfaceRow.surfType || surfaceRow.type || '').trim().toLowerCase();
                        const isToric = surfType === 'toric';

                        if (isToric) {
                            const radiusXRaw = surfaceRow.radiusX;
                            const radiusYRaw = surfaceRow.radiusY || surfaceRow.radius;
                            const radiusXInf = String(radiusXRaw ?? '').trim().toUpperCase() === 'INF' || radiusXRaw === Infinity;
                            const radiusYInf = String(radiusYRaw ?? '').trim().toUpperCase() === 'INF' || radiusYRaw === Infinity;
                            const radiusX = radiusXInf ? Infinity : Number(radiusXRaw);
                            const radiusY = radiusYInf ? Infinity : Number(radiusYRaw);

                            if ((Number.isFinite(radiusX) || radiusX === Infinity) && (Number.isFinite(radiusY) || radiusY === Infinity)) {
                                const toricParams = {
                                    radiusX,
                                    radiusY,
                                    conic: Number(surfaceRow.conic) || 0,
                                    axis: Number(surfaceRow.axis) || 0
                                };

                                if (param3Raw === 'X') return toricSurfaceZ(height, 0, toricParams);
                                if (param3Raw === 'Y') return toricSurfaceZ(0, height, toricParams);
                                const sagX = toricSurfaceZ(height, 0, toricParams);
                                const sagY = toricSurfaceZ(0, height, toricParams);
                                return Number.isFinite(sagX) && Number.isFinite(sagY) ? (sagX + sagY) / 2 : 0;
                            }
                            return 0;
                        }

                        const radiusRaw = surfaceRow.radius;
                        const radiusInf = String(radiusRaw ?? '').trim().toUpperCase() === 'INF' || radiusRaw === Infinity || radiusRaw === 0;
                        const radius = radiusInf ? Infinity : Number(radiusRaw);
                        if (!(Number.isFinite(radius) || radius === Infinity)) return 0;

                        const asphericParams = {
                            radius,
                            conic: Number(surfaceRow.conic) || 0,
                            coef1: Number(surfaceRow.coef1) || 0,
                            coef2: Number(surfaceRow.coef2) || 0,
                            coef3: Number(surfaceRow.coef3) || 0,
                            coef4: Number(surfaceRow.coef4) || 0,
                            coef5: Number(surfaceRow.coef5) || 0,
                            coef6: Number(surfaceRow.coef6) || 0,
                            coef7: Number(surfaceRow.coef7) || 0,
                            coef8: Number(surfaceRow.coef8) || 0,
                            coef9: Number(surfaceRow.coef9) || 0,
                            coef10: Number(surfaceRow.coef10) || 0
                        };
                        const mode = surfType.includes('odd') ? 'odd' : 'even';
                        return asphericSurfaceZ(height, asphericParams, mode);
                    };

                    let sag = computeSurfaceSag(surface);
                    if (!Number.isFinite(sag)) sag = 0;

                    let sag2 = 0;
                    const nextSurfaceIdx = surfaceIndex0 + 1;
                    if (nextSurfaceIdx < rows.length) {
                        const nextSurface = rows[nextSurfaceIdx];
                        const nextObjType = String(nextSurface?.['object type'] || nextSurface?.object || nextSurface?.surfType || '').trim().toLowerCase();
                        const isNextOpticalSurface = !!nextSurface && !(nextObjType === 'object'
                            || nextObjType === 'image'
                            || nextObjType === 'stop'
                            || nextObjType === 'sto'
                            || nextObjType === 'aperturestop'
                            || nextObjType === 'ct'
                            || nextObjType.includes('coordinate')
                            || nextObjType.includes('coordtrans'));
                        if (isNextOpticalSurface) {
                            sag2 = computeSurfaceSag(nextSurface);
                            if (!Number.isFinite(sag2)) sag2 = 0;
                        }
                    }

                    return thickness - sag + sag2;
                };

                let edgeThickness = computeEdgeThicknessForRows(opticalSystemData);
                if ((!Number.isFinite(edgeThickness) || Math.abs(edgeThickness) >= 1e8) && (isCurrentOperand || isOperandActiveConfig)) {
                    let prevPreferTable: any;
                    try {
                        if (typeof globalThis !== 'undefined') {
                            prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
                            (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
                        }
                        const liveRows = getOpticalSystemRows(null);
                        const liveEdgeThickness = computeEdgeThicknessForRows(liveRows);
                        if (Number.isFinite(liveEdgeThickness)) {
                            edgeThickness = liveEdgeThickness;
                        }
                    } catch (_) {
                    } finally {
                        try {
                            if (typeof globalThis !== 'undefined') {
                                if (prevPreferTable === undefined) {
                                    delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
                                } else {
                                    (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
                                }
                            }
                        } catch (_) {}
                    }
                }

                return Number.isFinite(edgeThickness) ? edgeThickness : 1e9;
            }

            case 'DBLT_K':
                return this.calculateDoubletBendingK(operand);

            case 'ZERN_COEFF': {
                const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
                const wavelength = (param1Raw === '')
                    ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                    : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

                const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
                const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
                const requestedObjectIndex0 = objectIndex1 - 1;
                const resolvedObjectIndex0 = Array.isArray(objectRows) && objectRows.length > 0
                    ? Math.min(Math.max(requestedObjectIndex0, 0), objectRows.length - 1)
                    : requestedObjectIndex0;
                const objectIndex0 = resolvedObjectIndex0;
                const objRow = Array.isArray(objectRows) ? objectRows[resolvedObjectIndex0] : null;

                const unit = parseZernikeUnit(operand.param3);

                const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
                const sampling = (param4Raw === '') ? 32 : Math.max(8, Math.floor(Number(param4Raw)));

                const param5Raw = (operand.param5 !== undefined && operand.param5 !== null) ? String(operand.param5).trim() : '';
                const nollIndex = (param5Raw === '') ? 0 : Math.floor(Number(param5Raw));

                if (!objRow || typeof objRow !== 'object') {
                    meritWarnOnce(
                        `zern-coeff-missing-object:${operand.configId ?? 'active'}:${requestedObjectIndex0}`,
                        '⚠️ ZERN_COEFF: object row not found, using on-axis fallback field'
                    );
                } else if (resolvedObjectIndex0 !== requestedObjectIndex0) {
                    meritWarnOnce(
                        `zern-coeff-clamped-object:${operand.configId ?? 'active'}:${requestedObjectIndex0}->${resolvedObjectIndex0}`,
                        `⚠️ ZERN_COEFF: object ${objectIndex1} not found, using object ${resolvedObjectIndex0 + 1}`
                    );
                }

                const fieldSetting = toFieldSettingFromObjectRow(objRow, objectIndex0, opticalSystemData, wavelength);

                const existingZernike = (() => {
                    try {
                        if (typeof window === 'undefined') return null;
                        const wfMap = getLastWavefrontMap(window);
                        if (!wfMap || typeof wfMap !== 'object') return null;
                        if (!wfMap.zernike || typeof wfMap.zernike !== 'object') return null;
                        const z = wfMap.zernike;

                        const wfWl = toFiniteNumber(wfMap.wavelengthUm, 0);
                        const wfObjIdx = Number.isFinite(wfMap.objectIndex) ? wfMap.objectIndex : -1;
                        const wfFieldKey = fieldSettingCacheKey(wfMap.fieldSetting);
                        const opFieldKey = fieldSettingCacheKey(fieldSetting);

                        const wlMatch = Math.abs(wfWl - wavelength) < 1e-9;
                        const objMatch = wfObjIdx === objectIndex0;
                        const fieldMatch = wfFieldKey === opFieldKey;

                        if (wlMatch && objMatch && fieldMatch) {
                            return z;
                        }
                        return null;
                    } catch {
                        return null;
                    }
                })();

                const fit = existingZernike || (() => {
                    const cfgKey = operand.configId ? String(operand.configId) : 'active';
                    const cacheKey = `zernike:${cfgKey}:wl=${wavelength}:obj=${objectIndex0}:samp=${sampling}`;

                    const cached = this._runtimeCache ? this._runtimeCache.get(cacheKey) : null;
                    if (cached) return cached;

                    const f = computeZernikeFitLive({
                        opticalSystemData,
                        wavelengthUm: wavelength,
                        fieldSetting,
                        zernikeMaxNoll: 37,
                        samplingSize: sampling
                    });

                    if (this._runtimeCache && f) this._runtimeCache.set(cacheKey, f);
                    return f;
                })();

                if (!fit || !fit.coefficientsWaves) {
                    console.warn('⚠️ ZERN_COEFF: Zernike fit failed');
                    return 1e9;
                }

                const nollToNM_deprecated = (noll: number): { n: number; m: number } => {
                    let n = 0;
                    let m = 0;
                    let j = 1;
                    for (n = 0; n <= 100; n++) {
                        const mList: number[] = [];
                        for (let mAbs = 0; mAbs <= n; mAbs++) {
                            if ((n - mAbs) % 2 === 0) {
                                if (mAbs > 0) {
                                    mList.push(-mAbs);
                                    mList.push(mAbs);
                                } else {
                                    mList.push(0);
                                }
                            }
                        }
                        for (const mVal of mList) {
                            if (j === noll) return { n, m: mVal };
                            j++;
                        }
                    }
                    return { n: 0, m: 0 };
                };

                if (nollIndex === 0) {
                    let sumSq = 0;
                    const coeffs = (unit === 'um') ? fit.coefficientsMicrons : fit.coefficientsWaves;
                    for (let n = 0; n <= 100; n++) {
                        for (let mAbs = 0; mAbs <= n; mAbs++) {
                            if ((n - mAbs) % 2 !== 0) continue;
                            const mVals = (mAbs === 0) ? [0] : [-mAbs, mAbs];
                            for (const m of mVals) {
                                const osaIndex = (n * (n + 2) + m) / 2;
                                if (osaIndex < 4) continue;
                                const c = readCoeff(coeffs, osaIndex);
                                sumSq += c * c;
                            }
                        }
                    }
                    return Math.sqrt(sumSq);
                }

                const { n, m } = nollToNM_deprecated(nollIndex);
                const osaIndex = (n * (n + 2) + m) / 2;

                const coeffs = (unit === 'um') ? fit.coefficientsMicrons : fit.coefficientsWaves;
                const value = readCoeff(coeffs, osaIndex);
                return value;
            }

            default:
                console.warn('⚠️ 未対応のオペランド:', operand.operand);
                return 0;
        }
    }

    async calculateOperandValueAsync(operand: any): Promise<number> {
        if (!operand || !operand.operand) return 0;

        const opticalSystemData = this.getOpticalSystemDataByConfigId(operand.configId);
        const runSpotWithFallback = async (pattern: 'annular' | 'grid'): Promise<number> => {
            const asyncVal = await withRequirementRustRayTracing(
                () => this.calculateSpotSizeUmAsync(operand, opticalSystemData, { pattern, useUiDefaults: false }),
                REQUIREMENT_SPOT_TRACE_OVERRIDE
            );
            const asyncNum = Number(asyncVal);
            if (Number.isFinite(asyncNum) && Math.abs(asyncNum) < 1e8) {
                return asyncNum;
            }
            const syncVal = withRequirementRustRayTracing(
                () => this.calculateSpotSizeUm(operand, opticalSystemData, { pattern, useUiDefaults: false }),
                REQUIREMENT_SPOT_TRACE_OVERRIDE
            );
            const syncNum = Number(syncVal);
            return Number.isFinite(syncNum) ? syncNum : 1e9;
        };
        switch (operand.operand) {
            case 'SPOT_SIZE_ANNULAR':
                return runSpotWithFallback('annular');
            case 'SPOT_SIZE_RECT':
                return runSpotWithFallback('grid');
            case 'SPOT_SIZE_CURRENT':
                return runSpotWithFallback('annular');
            case 'ZERN_COEFF': {
                const nativeVal = await this.calculateZernikeCoeffViaNativeAsync(operand, opticalSystemData);
                if (Number.isFinite(nativeVal as any)) {
                    return Number(nativeVal);
                }
                return this.calculateOperandValue(operand);
            }
            case 'TA_RMS_UM': {
                return this.calculateOperandValue(operand);
            }
            case 'OPD_RMS_WAVES':
            case 'OPD_RMS_UM': {
                const nativeVal = await this.calculateOpdRmsWavesViaNativeAsync(operand, opticalSystemData);
                if (Number.isFinite(nativeVal as any)) {
                    return Number(nativeVal);
                }
                return this.calculateOperandValue(operand);
            }
            case 'SA': {
                const nativeVal = await this.calculateSphericalAberrationUmViaNativeAsync(operand, opticalSystemData);
                if (Number.isFinite(nativeVal as any)) {
                    return Number(nativeVal);
                }
                return this.calculateOperandValue(operand);
            }
            default:
                return this.calculateOperandValue(operand);
        }
    }

    async calculateZernikeCoeffViaNativeAsync(operand: any, opticalSystemData: any[]): Promise<number | null> {
        try {
            const runtimeMod = await import('../../src/desktop/runtime.ts');
            if (!runtimeMod || typeof runtimeMod.isTauriRuntime !== 'function' || !runtimeMod.isTauriRuntime()) {
                return null;
            }
            const ipcMod = await import('../../src/desktop/ipc/client.ts');
            if (!ipcMod || typeof ipcMod.runNativeOpdMap !== 'function') {
                return null;
            }

            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId, {
                preferConfigTables: true
            });
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
            if (!Array.isArray(objectRows) || objectRows.length === 0) return null;

            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            const wavelengthUm = (param1Raw === '')
                ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

            const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
            const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
            const objectIndex0 = objectIndex1 - 1;

            const unit = parseZernikeUnit(operand.param3);
            const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
            const gridSize = (param4Raw === '') ? 32 : Math.max(8, Math.floor(Number(param4Raw)));
            const param5Raw = (operand.param5 !== undefined && operand.param5 !== null) ? String(operand.param5).trim() : '';
            const nollIndex = (param5Raw === '') ? 0 : Math.floor(Number(param5Raw));

            const imageSurfaceIndex = (() => {
                for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                    const row = opticalSystemData[i];
                    const ot = String(row?.['object type'] || row?.objectType || row?.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
                return opticalSystemData.length - 1;
            })();

            const opdResp = await ipcMod.runNativeOpdMap({
                opticalSystemRows: opticalSystemData,
                sourceRows,
                objectRows,
                objectIndex: objectIndex0,
                surfaceIndex: imageSurfaceIndex,
                gridSize,
                wavelengthUm,
                opdDisplayMode: 'pistonTiltRemoved'
            });

            const grid = Array.isArray(opdResp?.displayOpdGrid) ? opdResp.displayOpdGrid : [];
            const size = Number(opdResp?.gridSize);
            if (!Array.isArray(grid) || !Number.isFinite(size) || size < 4) return null;

            const wavefrontPoints: any[] = [];
            for (let iy = 0; iy < grid.length; iy++) {
                const row = grid[iy];
                if (!Array.isArray(row)) continue;
                for (let ix = 0; ix < row.length; ix++) {
                    const opd = Number(row[ix]);
                    if (!Number.isFinite(opd)) continue;
                    const nx = (2 * ix) / (size - 1) - 1;
                    const ny = (2 * iy) / (size - 1) - 1;
                    if (Math.hypot(nx, ny) > 1.000001) continue;
                    wavefrontPoints.push({ x: nx, y: ny, opd });
                }
            }
            if (wavefrontPoints.length === 0) return null;

            const analyzer = new WavefrontAberrationAnalyzer(createOPDCalculator(opticalSystemData, wavelengthUm));
            const fit = analyzer.fitZernikePolynomials({
                pupilCoordinates: wavefrontPoints.map((pt) => ({ x: pt.x, y: pt.y })),
                opds: wavefrontPoints.map((pt) => pt.opd)
            }, 37) as any;
            if (!fit || !fit.coefficientsWaves) return null;

            const nollToNM = (noll: number): { n: number; m: number } => {
                let j = 1;
                for (let n = 0; n <= 100; n++) {
                    const mList: number[] = [];
                    for (let mAbs = 0; mAbs <= n; mAbs++) {
                        if ((n - mAbs) % 2 === 0) {
                            if (mAbs > 0) {
                                mList.push(-mAbs);
                                mList.push(mAbs);
                            } else {
                                mList.push(0);
                            }
                        }
                    }
                    for (const mVal of mList) {
                        if (j === noll) return { n, m: mVal };
                        j++;
                    }
                }
                return { n: 0, m: 0 };
            };

            const coeffs = (unit === 'um') ? fit.coefficientsMicrons : fit.coefficientsWaves;
            if (!coeffs || typeof coeffs !== 'object') return null;

            if (nollIndex === 0) {
                let sumSq = 0;
                for (let n = 0; n <= 100; n++) {
                    for (let mAbs = 0; mAbs <= n; mAbs++) {
                        if ((n - mAbs) % 2 !== 0) continue;
                        const mVals = (mAbs === 0) ? [0] : [-mAbs, mAbs];
                        for (const m of mVals) {
                            const osaIndex = (n * (n + 2) + m) / 2;
                            if (osaIndex < 4) continue;
                            const c = readCoeff(coeffs, osaIndex);
                            sumSq += c * c;
                        }
                    }
                }
                return Math.sqrt(sumSq);
            }

            const { n, m } = nollToNM(nollIndex);
            const osaIndex = (n * (n + 2) + m) / 2;
            return readCoeff(coeffs, osaIndex);
        } catch {
            return null;
        }
    }

    async calculateSphericalAberrationUmViaNativeAsync(operand: any, opticalSystemData: any[]): Promise<number | null> {
        try {
            const runtimeMod = await import('../../src/desktop/runtime.ts');
            if (!runtimeMod || typeof runtimeMod.isTauriRuntime !== 'function' || !runtimeMod.isTauriRuntime()) {
                return null;
            }
            const ipcMod = await import('../../src/desktop/ipc/client.ts');
            if (!ipcMod || typeof ipcMod.runNativeSphericalAberration !== 'function') {
                return null;
            }

            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            const wavelength = (param1Raw === '')
                ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

            const imageSurfaceIndex = (() => {
                for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                    const row = opticalSystemData[i];
                    const ot = String(row?.['object type'] || row?.objectType || row?.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
                return Math.max(0, opticalSystemData.length - 1);
            })();

            const resp = await ipcMod.runNativeSphericalAberration({
                opticalSystemRows: opticalSystemData,
                sourceRows,
                objectRows,
                surfaceIndex: imageSurfaceIndex,
                wavelengthMode: 'primary'
            });

            const list = Array.isArray(resp?.meridionalData) ? resp.meridionalData : [];
            if (list.length === 0) return null;
            const series = list.find((d: any) => Math.abs(Number(d?.wavelength) - Number(wavelength)) < 1e-9) || list[0];
            const pointsRaw = Array.isArray(series?.points) ? series.points : [];
            const points = pointsRaw
                .map((d: any) => ({
                    pupilCoordinate: toFiniteNumber(d?.pupilCoordinate, NaN),
                    longitudinalAberration: toFiniteNumber(d?.longitudinalAberration, NaN)
                }))
                .filter((d: any) => Number.isFinite(d.pupilCoordinate) && Number.isFinite(d.longitudinalAberration))
                .sort((a: any, b: any) => a.pupilCoordinate - b.pupilCoordinate);
            if (points.length === 0) return null;

            const paraxial = points[0].longitudinalAberration;
            const marginal = points[points.length - 1].longitudinalAberration;
            const lsaMm = Math.abs(marginal - paraxial);
            return lsaMm * 1000;
        } catch {
            return null;
        }
    }

    calculateOpdRmsWaves(operand: any, opticalSystemData: any[]): number {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return Number.NaN;

            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);
            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            const wavelengthUm = (param1Raw === '')
                ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

            const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
            const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
            const objectIndex0 = objectIndex1 - 1;
            const objRow = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;
            if (!objRow || typeof objRow !== 'object') return Number.NaN;

            const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim() : '';
            const sampling = (param3Raw === '') ? 32 : Math.max(8, Math.floor(Number(param3Raw)));

            const fieldSetting = toFieldSettingFromObjectRow(objRow, objectIndex0, opticalSystemData, wavelengthUm);

            const calc = createOPDCalculator(opticalSystemData, wavelengthUm);
            if (!calc || typeof (calc as any).setReferenceRay !== 'function' || typeof (calc as any).calculateOPD !== 'function') {
                return Number.NaN;
            }

            (calc as any).setReferenceRay(fieldSetting);

            const pupilCoordinates: Array<{ x: number; y: number }> = [];
            const opdsMicrons: number[] = [];
            for (let iy = 0; iy < sampling; iy++) {
                const py = -1 + (2 * iy) / (sampling - 1);
                for (let ix = 0; ix < sampling; ix++) {
                    const px = -1 + (2 * ix) / (sampling - 1);
                    if ((px * px + py * py) > 1.000001) continue;

                    const opdUm = Number(
                        typeof (calc as any).calculateOPDReferenceSphere === 'function'
                            ? (calc as any).calculateOPDReferenceSphere(px, py, fieldSetting, false)
                            : (calc as any).calculateOPD(px, py, fieldSetting)
                    );
                    if (!Number.isFinite(opdUm)) continue;

                    pupilCoordinates.push({ x: px, y: py });
                    opdsMicrons.push(opdUm);
                }
            }

            if (opdsMicrons.length <= 0) return Number.NaN;

            const fit = (typeof (calc as any)._removeBestFitPlane === 'function')
                ? (calc as any)._removeBestFitPlane(pupilCoordinates, opdsMicrons)
                : null;
            if (fit && Array.isArray(fit.residualWaves) && fit.residualWaves.length > 0) {
                let count = 0;
                let sumSq = 0;
                for (const value of fit.residualWaves) {
                    const opdWaves = Number(value);
                    if (!Number.isFinite(opdWaves)) continue;
                    sumSq += opdWaves * opdWaves;
                    count += 1;
                }
                if (count > 0) {
                    return Math.sqrt(sumSq / count);
                }
            }

            let count = 0;
            let sum = 0;
            let sumSq = 0;
            for (const opdUm of opdsMicrons) {
                const opdWaves = opdUm / wavelengthUm;
                if (!Number.isFinite(opdWaves)) continue;
                sum += opdWaves;
                sumSq += opdWaves * opdWaves;
                count += 1;
            }
            if (count <= 0) return Number.NaN;
            const mean = sum / count;
            const variance = Math.max(0, (sumSq / count) - (mean * mean));
            return Math.sqrt(variance);
        } catch {
            return Number.NaN;
        }
    }

    async calculateOpdRmsWavesViaNativeAsync(operand: any, opticalSystemData: any[]): Promise<number | null> {
        try {
            const ipcMod = await import('../../src/desktop/ipc/client.ts');
            if (!ipcMod || typeof ipcMod.runNativeOpdRmsWaves !== 'function') {
                return null;
            }

            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId, {
                preferConfigTables: true
            });
            if (!Array.isArray(objectRows) || objectRows.length === 0) return null;

            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            const wavelengthUm = (param1Raw === '')
                ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

            const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
            const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
            const objectIndex0 = objectIndex1 - 1;
            const objRow = objectRows[objectIndex0];
            if (!objRow || typeof objRow !== 'object') return null;

            const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim() : '';
            const gridSize = (param3Raw === '') ? 32 : Math.max(8, Math.floor(Number(param3Raw)));

            const imageSurfaceIndex = (() => {
                for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                    const row = opticalSystemData[i];
                    const ot = String(row?.['object type'] || row?.objectType || row?.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
                return Math.max(0, opticalSystemData.length - 1);
            })();

            const opdResp = await ipcMod.runNativeOpdRmsWaves({
                opticalSystemRows: opticalSystemData,
                sourceRows,
                objectRows,
                objectIndex: objectIndex0,
                surfaceIndex: imageSurfaceIndex,
                gridSize,
                wavelengthUm,
                opdDisplayMode: 'pistonTiltRemoved'
            });
            const rmsWaves = Number(opdResp?.rmsWaves);
            return Number.isFinite(rmsWaves) ? rmsWaves : null;
        } catch {
            return null;
        }
    }

    private stampRequirementBackend(kind: 'spot' | 'ta', payload: Record<string, any>): void {
        try {
            if (typeof window === 'undefined') return;

            const backend = String(payload?.backend || 'unknown');
            const route = String(payload?.route || 'unknown');
            const storeKey = kind === 'spot'
                ? '__cooptLastSpotSizeDebug'
                : '__cooptLastTransverseAberrationDebug';
            const currentStore = (w as any)[storeKey];
            const nextStore = (currentStore && typeof currentStore === 'object') ? currentStore : {};
            Object.assign(nextStore, {
                requirementBackend: backend,
                requirementRoute: route,
                requirementLoggedAt: new Date().toISOString(),
                ...payload,
            });
            (w as any)[storeKey] = nextStore;

            if (!(w as any).__cooptRequirementBackendLogState || typeof (w as any).__cooptRequirementBackendLogState !== 'object') {
                (w as any).__cooptRequirementBackendLogState = {};
            }
            const signature = `${backend}|${route}`;
            const prev = (w as any).__cooptRequirementBackendLogState[kind];
            if (prev !== signature) {
                (w as any).__cooptRequirementBackendLogState[kind] = signature;
                console.info(`[Requirements][${kind}] backend=${backend} route=${route}`, payload);
            }
        } catch (_) {}
    }

    async calculateTransverseAberrationRmsUmViaNativeAsync(operand: any, opticalSystemData: any[]): Promise<number | null> {
        try {
            const ipcMod = await import('../../src/desktop/ipc/client.ts');
            if (!ipcMod || typeof ipcMod.runNativeTransverseAberration !== 'function') {
                return null;
            }

            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            const wavelength = (param1Raw === '')
                ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

            const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
            const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
            const objectIndex0 = objectIndex1 - 1;
            const objRow = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;
            if (!objRow || typeof objRow !== 'object') return null;

            const positionType = String(objRow?.__cooptOriginalPosition ?? objRow?.position ?? '').trim().toLowerCase();
            if (positionType === 'imageheight') {
                // The async IPC TA route still normalizes ImageHeight rows through the object-row path,
                // which can collapse them to the on-axis field in requirements evaluation.
                // Use the already-correct local TA path for ImageHeight until the shared async route
                // is made field-setting aware.
                return this.calculateTransverseAberrationRmsUm(operand, opticalSystemData);
            }

            const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim().toLowerCase() : '';
            const component = (() => {
                if (!param3Raw) return 'total';
                if (param3Raw === '1' || param3Raw === 'm' || param3Raw.includes('meri') || param3Raw.includes('tang')) return 'meridional';
                if (param3Raw === '2' || param3Raw === 's' || param3Raw.includes('sag')) return 'sagittal';
                if (param3Raw === '0' || param3Raw === 't' || param3Raw.includes('total') || param3Raw.includes('both')) return 'total';
                if (param3Raw === 'meridional' || param3Raw === 'sagittal' || param3Raw === 'total') return param3Raw;
                return 'total';
            })();

            const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
            let rayCount = (param4Raw === '') ? 51 : Math.floor(Number(param4Raw));
            if (!Number.isFinite(rayCount) || rayCount < 3) rayCount = 51;
            if (rayCount > 5000) rayCount = 5000;

            const imageSurfaceIndex = (() => {
                for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                    const row = opticalSystemData[i];
                    const ot = String(row?.['object type'] || row?.objectType || row?.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
                return Math.max(0, opticalSystemData.length - 1);
            })();

            const resp = await ipcMod.runNativeTransverseAberration({
                opticalSystemRows: opticalSystemData,
                sourceRows: __cooptBuildPrimaryOnlySourceRows(sourceRows, wavelength),
                objectRows: [objRow],
                surfaceIndex: imageSurfaceIndex,
                rayCount,
                wavelengthMode: 'primary',
                wavelength
            });

            this.stampRequirementBackend('ta', {
                backend: String(resp?.backend || 'unknown'),
                route: 'ipc-wrapper',
                operand: 'TA_RMS_UM',
                configId: operand?.configId ?? '',
                objectIndex0,
                wavelength,
                rayCount,
                component,
            });

            const collectStats = (series: any[]) => {
                let sumSq = 0;
                let count = 0;
                if (!Array.isArray(series)) return { sumSq, count };
                for (const item of series) {
                    const pts = Array.isArray(item?.points) ? item.points : [];
                    for (const p of pts) {
                        const t = toFiniteNumber(p?.transverseAberration, NaN);
                        if (!Number.isFinite(t)) continue;
                        sumSq += t * t;
                        count += 1;
                    }
                }
                return { sumSq, count };
            };

            const meridionalStats = collectStats(resp?.meridionalData);
            const sagittalStats = collectStats(resp?.sagittalData);

            let sumSq = 0;
            let count = 0;
            if (component === 'meridional') {
                sumSq = meridionalStats.sumSq;
                count = meridionalStats.count;
                if (count === 0 && sagittalStats.count > 0) {
                    sumSq = sagittalStats.sumSq;
                    count = sagittalStats.count;
                }
            } else if (component === 'sagittal') {
                sumSq = sagittalStats.sumSq;
                count = sagittalStats.count;
                if (count === 0 && meridionalStats.count > 0) {
                    sumSq = meridionalStats.sumSq;
                    count = meridionalStats.count;
                }
            } else {
                sumSq = meridionalStats.sumSq + sagittalStats.sumSq;
                count = meridionalStats.count + sagittalStats.count;
            }

            if (count <= 0) return null;
            const rmsMm = Math.sqrt(sumSq / count);
            return rmsMm * 1000;
        } catch {
            return null;
        }
    }

    async calculateSpotSizeUmAsync(operand: any, opticalSystemData: any[], options: any = {}): Promise<number> {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 1e9;

            const useUiDefaults = (options.useUiDefaults !== undefined) ? options.useUiDefaults : true;
            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId, {
                preferConfigTables: !useUiDefaults
            });

            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            const wavelength = (param1Raw === '')
                ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

            const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
            const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
            const objectIndex0 = objectIndex1 - 1;

            const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim().toLowerCase() : '';
            const metric = (param3Raw === 'diameter' || param3Raw === 'dia') ? 'diameter' : 'rms';

            const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
            const defaultRayCount = options.pattern === 'annular' ? 101 : 501;
            let rayCount = (param4Raw === '') ? defaultRayCount : Math.floor(Number(param4Raw));
            if (!Number.isFinite(rayCount) || rayCount < 1) rayCount = defaultRayCount;
            if (rayCount > 5000) rayCount = 5000;

            const param5Raw = (operand.param5 !== undefined && operand.param5 !== null) ? String(operand.param5).trim() : '';
            let targetSurfaceNumber1: number | null = null;
            if (param5Raw !== '') {
                const parsed = Math.floor(Number(param5Raw));
                if (Number.isFinite(parsed) && parsed > 0) targetSurfaceNumber1 = parsed;
            }

            const objectRow = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;
            if (!objectRow || typeof objectRow !== 'object') return 1e9;

            const imageSurfaceIndex = (() => {
                for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                    const row = opticalSystemData[i];
                    const ot = String(row?.['object type'] || row?.objectType || row?.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
                return opticalSystemData.length - 1;
            })();

            const targetSurfaceIndex = (() => {
                if (targetSurfaceNumber1 === null) return imageSurfaceIndex;
                try {
                    const opts = generateSurfaceOptions(opticalSystemData);
                    const hit = Array.isArray(opts)
                        ? opts.find((o: any) => Number(o?.value) === targetSurfaceNumber1 || Number(o?.surfaceId) === targetSurfaceNumber1)
                        : null;
                    if (hit && Number.isInteger(hit.rowIndex) && hit.rowIndex >= 0 && hit.rowIndex < opticalSystemData.length) {
                        return hit.rowIndex;
                    }
                } catch (_) {}
                const idx = targetSurfaceNumber1 - 1;
                return (idx >= 0 && idx < opticalSystemData.length) ? idx : imageSurfaceIndex;
            })();

            const surfaceNumber1 = targetSurfaceIndex + 1;
            const pattern = (options.pattern === 'grid' || options.pattern === 'annular') ? options.pattern : 'annular';
            const ringCount = (options.annularRingCount !== undefined && options.annularRingCount !== null)
                ? Math.max(1, Math.floor(Number(options.annularRingCount)))
                : 10;

            // Prefer desktop native Rust spot tracing on Tauri for optimizer hot path.
            const nativeSpotMetric = await this.calculateSpotSizeUmViaNativeAsync({
                opticalSystemData,
                sourceRows,
                objectRow,
                targetSurfaceIndex,
                rayCount,
                ringCount,
                pattern,
                wavelength,
                metric
            });
            if (Number.isFinite(nativeSpotMetric as any)) {
                return Number(nativeSpotMetric);
            }

            try {
                if (typeof window !== 'undefined' && w.__cooptLastSpotSizeDebug && typeof w.__cooptLastSpotSizeDebug === 'object') {
                    w.__cooptLastSpotSizeDebug.spotDiagramPath = 'async';
                    w.__cooptLastSpotSizeDebug.pattern = pattern;
                    w.__cooptLastSpotSizeDebug.targetSurfaceIndex = targetSurfaceIndex;
                    w.__cooptLastSpotSizeDebug.wavelength = wavelength;
                    w.__cooptLastSpotSizeDebug.rayCountRequested = rayCount;
                }
            } catch (_) {}

            const spotResult = await generateSpotDiagramAsync(
                opticalSystemData,
                sourceRows,
                [objectRow],
                surfaceNumber1,
                rayCount,
                ringCount,
                {
                    physicalVignetting: true,
                    pattern,
                    traceOptions: { ...REQUIREMENT_SPOT_TRACE_OVERRIDE }
                }
            );

            const hits = (spotResult && Array.isArray(spotResult.spotData) && spotResult.spotData.length > 0)
                ? (spotResult.spotData[0]?.spotPoints || [])
                : [];
            if (!Array.isArray(hits) || hits.length <= 0) return 1e9;

            const exactChief = this.resolveExactChiefSpotPoint(
                ctx.opticalSystemData,
                ctx.objectRow,
                ctx.wavelength,
                ctx.targetSurfaceIndex,
            );
            let chief = exactChief
                ? { x: exactChief.x, y: exactChief.y }
                : (hits.find((h: any) => h && h.isChiefRay) || null);
            if (!chief) chief = hits[0];
            if (!chief) return 1e9;

            let maxRUm = 0;
            let sumX2 = 0;
            let sumY2 = 0;
            let n = 0;
            for (const h of hits) {
                const dxUm = (Number(h?.x) - Number(chief?.x)) * 1000;
                const dyUm = (Number(h?.y) - Number(chief?.y)) * 1000;
                if (!Number.isFinite(dxUm) || !Number.isFinite(dyUm)) continue;
                const rUm = Math.hypot(dxUm, dyUm);
                if (rUm > maxRUm) maxRUm = rUm;
                sumX2 += dxUm * dxUm;
                sumY2 += dyUm * dyUm;
                n += 1;
            }
            if (n <= 0) return 1e9;

            const rmsX = Math.sqrt(sumX2 / n);
            const rmsY = Math.sqrt(sumY2 / n);
            const rmsTotal = Math.sqrt(rmsX * rmsX + rmsY * rmsY);
            const diameter = 2 * maxRUm;
            return (metric === 'diameter') ? diameter : rmsTotal;
        } catch {
            return 1e9;
        }
    }

    async calculateSpotSizeUmViaNativeAsync(ctx: {
        opticalSystemData: any[];
        sourceRows: any[];
        objectRow: any;
        targetSurfaceIndex: number;
        rayCount: number;
        ringCount: number;
        pattern: 'annular' | 'grid';
        wavelength: number;
        metric: 'rms' | 'diameter';
    }): Promise<number | null> {
        try {
            const ipcMod = await import('../../src/desktop/ipc/client.ts');
            if (!ipcMod || typeof ipcMod.runNativeSpotRaytrace !== 'function') {
                return null;
            }

            const nativeSourceRows = __cooptBuildPrimaryOnlySourceRows(ctx.sourceRows, ctx.wavelength);
            const response = await ipcMod.runNativeSpotRaytrace({
                opticalSystemRows: ctx.opticalSystemData,
                sourceRows: nativeSourceRows,
                objectRows: [ctx.objectRow],
                surfaceIndex: ctx.targetSurfaceIndex,
                rayCount: ctx.rayCount,
                ringCount: ctx.ringCount,
                pattern: ctx.pattern,
                wavelengthMode: 'primary'
            });

            this.stampRequirementBackend('spot', {
                backend: String(response?.backend || 'unknown'),
                route: 'ipc-wrapper',
                operand: ctx.pattern === 'grid' ? 'SPOT_SIZE_RECT' : 'SPOT_SIZE_ANNULAR',
                targetSurfaceIndex: ctx.targetSurfaceIndex,
                wavelength: ctx.wavelength,
                rayCount: ctx.rayCount,
                ringCount: ctx.ringCount,
                pattern: ctx.pattern,
                metric: ctx.metric,
            });

            const series = Array.isArray(response?.series) ? response.series : [];
            if (series.length <= 0) return null;
            const firstSeries = series[0] as any || null;
            if (!firstSeries) return null;
            const points = Array.isArray(firstSeries?.points) ? firstSeries.points : [];
            if (points.length <= 0) return null;

            const exactChief = this.resolveExactChiefSpotPoint(
                ctx.opticalSystemData,
                ctx.objectRow,
                ctx.wavelength,
                ctx.targetSurfaceIndex,
            );
            const chief = (() => {
                if (exactChief) {
                    return { xUm: exactChief.x * 1000, yUm: exactChief.y * 1000 };
                }
                const cp = firstSeries?.chiefPointUm;
                if (cp && Number.isFinite(Number(cp?.xUm)) && Number.isFinite(Number(cp?.yUm))) {
                    return { xUm: Number(cp.xUm), yUm: Number(cp.yUm) };
                }
                const p0 = points[0];
                if (p0 && Number.isFinite(Number(p0?.xUm)) && Number.isFinite(Number(p0?.yUm))) {
                    return { xUm: Number(p0.xUm), yUm: Number(p0.yUm) };
                }
                return null;
            })();
            if (!chief) return null;

            let maxRUm = 0;
            let sumX2 = 0;
            let sumY2 = 0;
            let n = 0;
            for (const p of points) {
                const xUm = Number(p?.xUm);
                const yUm = Number(p?.yUm);
                if (!Number.isFinite(xUm) || !Number.isFinite(yUm)) continue;
                const dxUm = xUm - chief.xUm;
                const dyUm = yUm - chief.yUm;
                const rUm = Math.hypot(dxUm, dyUm);
                if (rUm > maxRUm) maxRUm = rUm;
                sumX2 += dxUm * dxUm;
                sumY2 += dyUm * dyUm;
                n += 1;
            }
            if (n <= 0) return null;

            const rmsX = Math.sqrt(sumX2 / n);
            const rmsY = Math.sqrt(sumY2 / n);
            const rmsTotal = Math.sqrt(rmsX * rmsX + rmsY * rmsY);
            const diameter = 2 * maxRUm;
            return (ctx.metric === 'diameter') ? diameter : rmsTotal;
        } catch {
            return null;
        }
    }

    calculateLongitudinalAberrationRmsUm(operand: any, opticalSystemData: any[]): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;

        const { source: sourceRows } = this.getConfigTablesByConfigId(operand.configId);

        const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        const wavelength = (param1Raw === '')
            ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
            : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const imageSurfaceIndex = (() => {
            for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                const row = opticalSystemData[i];
                if (row && typeof row === 'object') {
                    const ot = String(row['object type'] || row.objectType || row.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
            }
            return Math.max(0, opticalSystemData.length - 1);
        })();

        const results = calculateLongitudinalAberration(
            opticalSystemData,
            imageSurfaceIndex,
            [wavelength],
            51,
            { silent: true }
        ) as any;

        const meridional = (() => {
            const list = results?.meridionalData;
            if (!Array.isArray(list) || list.length === 0) return null;
            const target = list.find((d: any) => Math.abs(Number(d?.wavelength) - wavelength) < 1e-9);
            return target || list[0];
        })();

        const data = meridional?.points;
        if (!Array.isArray(data) || data.length === 0) {
            console.warn('⚠️ LA_RMS_UM: longitudinal aberration calculation failed');
            return 0;
        }
        const N = data.length;

        let sumWeightedL = 0;
        let sumWeightedL2 = 0;
        let sumWeight = 0;

        for (let i = 0; i < N; i++) {
            const d = data[i];
            const r = toFiniteNumber(d.pupilCoordinate, 0);
            const L = toFiniteNumber(d.longitudinalAberration, 0);

            if (i === 0) {
                continue;
            }

            const rPrev = (i > 0) ? toFiniteNumber(data[i - 1].pupilCoordinate, 0) : 0;
            const weight = 2 * r * (r - rPrev);

            sumWeightedL += weight * L;
            sumWeightedL2 += weight * L * L;
            sumWeight += weight;
        }

        if (sumWeight === 0) return 0;

        const meanL = sumWeightedL / sumWeight;
        const variance = sumWeightedL2 / sumWeight - meanL * meanL;
        const rmsL = Math.sqrt(Math.max(0, variance));

        const rmsUm = rmsL * 1000;

        return rmsUm;
    }

    calculateSphericalAberrationUm(operand: any, opticalSystemData: any[]): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;

        const { source: sourceRows } = this.getConfigTablesByConfigId(operand.configId);

        const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        const wavelength = (param1Raw === '')
            ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
            : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const imageSurfaceIndex = (() => {
            for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                const row = opticalSystemData[i];
                if (row && typeof row === 'object') {
                    const ot = String(row['object type'] || row.objectType || row.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
            }
            return Math.max(0, opticalSystemData.length - 1);
        })();

        const results = calculateLongitudinalAberration(
            opticalSystemData,
            imageSurfaceIndex,
            [wavelength],
            51,
            { silent: true }
        ) as any;

        const meridional = (() => {
            const list = results?.meridionalData;
            if (!Array.isArray(list) || list.length === 0) return null;
            const target = list.find((d: any) => Math.abs(Number(d?.wavelength) - wavelength) < 1e-9);
            return target || list[0];
        })();

        const rawData = meridional?.points;
        if (!Array.isArray(rawData) || rawData.length === 0) {
            console.warn('⚠️ SA: longitudinal aberration calculation failed');
            return 0;
        }

        const data = rawData
            .map((d: any) => ({
                pupilCoordinate: toFiniteNumber(d?.pupilCoordinate, NaN),
                longitudinalAberration: toFiniteNumber(d?.longitudinalAberration, NaN)
            }))
            .filter((d: any) => Number.isFinite(d.pupilCoordinate) && Number.isFinite(d.longitudinalAberration))
            .sort((a: any, b: any) => a.pupilCoordinate - b.pupilCoordinate);

        if (data.length === 0) return 0;

        const paraxial = data[0].longitudinalAberration;
        const marginal = data[data.length - 1].longitudinalAberration;
        const lsaMm = Math.abs(marginal - paraxial);

        return lsaMm * 1000;
    }

    calculateTransverseAberrationRmsUm(operand: any, opticalSystemData: any[]): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;

        const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

        const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        const wavelength = (param1Raw === '')
            ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
            : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
        const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
        const objectIndex0 = objectIndex1 - 1;
        const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim().toLowerCase() : '';
        const component = (() => {
            if (!param3Raw) return 'total';
            if (param3Raw === '1' || param3Raw === 'm' || param3Raw.includes('meri') || param3Raw.includes('tang')) {
                return 'meridional';
            }
            if (param3Raw === '2' || param3Raw === 's' || param3Raw.includes('sag')) {
                return 'sagittal';
            }
            if (param3Raw === '0' || param3Raw === 't' || param3Raw.includes('total') || param3Raw.includes('both')) {
                return 'total';
            }
            if (param3Raw === 'meridional' || param3Raw === 'sagittal' || param3Raw === 'total') {
                return param3Raw;
            }
            return 'total';
        })();
        const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
        let rayCount = (param4Raw === '') ? 51 : Math.floor(Number(param4Raw));
        let taCrossEvalCacheKey = '';
        let taCrossEvalCacheEnabled = false;
        let taCrossEvalCacheEvalXKeyApprox = '';
        let taCrossEvalCacheRunId = '';

        if (param4Raw === '') {
            try {
                const meritFast = (typeof globalThis !== 'undefined' && (globalThis as any).__cooptMeritFastMode)
                    ? (globalThis as any).__cooptMeritFastMode
                    : null;
                taCrossEvalCacheEnabled = meritFast?.enabled === true && meritFast?.taCrossEvalCache !== false;
                taCrossEvalCacheEvalXKeyApprox = String((globalThis as any).__cooptEvalXKeyApproxTa || '').trim();
                taCrossEvalCacheRunId = String((globalThis as any).__cooptTaEvalRunId || '').trim();
            } catch (_) {
                // ignore and keep default rayCount
            }
        }

        if (!Number.isFinite(rayCount) || rayCount < 3) rayCount = 51;
        if (rayCount > 5000) rayCount = 5000;

        const objRow = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;

        const imageSurfaceIndex = (() => {
            for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                const row = opticalSystemData[i];
                if (row && typeof row === 'object') {
                    const ot = String(row['object type'] || row.objectType || row.object || '').trim().toLowerCase();
                    if (ot === 'image') return i;
                }
            }
            return Math.max(0, opticalSystemData.length - 1);
        })();

        const fieldSetting = toFieldSettingFromObjectRow(objRow, objectIndex0, opticalSystemData, wavelength);
        const fieldKey = fieldSettingCacheKey(fieldSetting);

        const cfgKey = (operand?.configId !== undefined && operand?.configId !== null)
            ? String(operand.configId)
            : 'active';

        if (taCrossEvalCacheEnabled && taCrossEvalCacheEvalXKeyApprox && taCrossEvalCacheRunId) {
            taCrossEvalCacheKey = [
                'ta-fast-cross',
                taCrossEvalCacheRunId,
                cfgKey,
                String(wavelength),
                String(objectIndex0),
                String(imageSurfaceIndex),
                String(rayCount),
                fieldKey,
                taCrossEvalCacheEvalXKeyApprox
            ].join('|');
        }

        const taCacheKey = [
            'ta-rms',
            cfgKey,
            String(wavelength),
            String(objectIndex0),
            String(imageSurfaceIndex),
            String(rayCount),
            fieldKey,
            String(opticalSystemData.length)
        ].join('|');

        let results: any = null;
        try {
            if (taCrossEvalCacheKey) {
                const crossCached = getTaFastCrossEvalCache(taCrossEvalCacheKey);
                if (crossCached) {
                    results = crossCached;
                }
            }

            const cached = this._runtimeCache ? this._runtimeCache.get(taCacheKey) : null;
            if (!results && cached) {
                results = cached;
            } else if (!results) {
                results = calculateTransverseAberration(
                    opticalSystemData,
                    imageSurfaceIndex,
                    [fieldSetting],
                    wavelength,
                    rayCount,
                    { lightweight: true }
                ) as any;
                if (this._runtimeCache) this._runtimeCache.set(taCacheKey, results);
                if (taCrossEvalCacheKey) setTaFastCrossEvalCache(taCrossEvalCacheKey, results);
            }
        } catch (err) {
            console.warn('⚠️ TA_RMS_UM: transverse aberration calculation failed', err);
            return 0;
        }

        const collectStats = (series: any[]) => {
            let sumSq = 0;
            let count = 0;
            if (!Array.isArray(series)) return { sumSq, count };
            for (let i = 0; i < series.length; i++) {
                const item = series[i];
                const pts = item?.points;
                if (!Array.isArray(pts)) continue;
                for (let j = 0; j < pts.length; j++) {
                    const t = toFiniteNumber(pts[j]?.transverseAberration, NaN);
                    if (!Number.isFinite(t)) continue;
                    sumSq += t * t;
                    count++;
                }
            }
            return { sumSq, count };
        };

        const meridionalStats = collectStats(results?.meridionalData);
        const sagittalStats = collectStats(results?.sagittalData);

        // SELECT VALUES BASED ON COMPONENT PARAMETER
        let sumSq = 0;
        let count = 0;
        let effectiveComponent = component;
        if (component === 'meridional') {
            sumSq = meridionalStats.sumSq;
            count = meridionalStats.count;
            if (count === 0 && sagittalStats.count > 0) {
                sumSq = sagittalStats.sumSq;
                count = sagittalStats.count;
                effectiveComponent = 'sagittal-fallback';
            }
        } else if (component === 'sagittal') {
            sumSq = sagittalStats.sumSq;
            count = sagittalStats.count;
            if (count === 0 && meridionalStats.count > 0) {
                sumSq = meridionalStats.sumSq;
                count = meridionalStats.count;
                effectiveComponent = 'meridional-fallback';
            }
        } else {
            // 'total' or default: combine both
            sumSq = meridionalStats.sumSq + sagittalStats.sumSq;
            count = meridionalStats.count + sagittalStats.count;
        }

        if (count <= 0) {
            if (shouldEmitOptimizationWarning('ta-rms-no-data')) {
                console.warn('⚠️ TA_RMS_UM: no transverse aberration data points', {
                    component,
                    meridionalCount: meridionalStats.count,
                    sagittalCount: sagittalStats.count
                });
            }
            // Return NaN so optimizer can treat it as invalid-current penalty,
            // instead of a misleading constant zero landscape.
            return Number.NaN;
        }

        if (effectiveComponent !== component) {
            if (shouldEmitOptimizationWarning('ta-rms-fallback')) {
                console.warn('⚠️ TA_RMS_UM: requested component had no data, using fallback', {
                    requested: component,
                    used: effectiveComponent,
                    rayCount,
                    wavelength,
                    objectIndex0
                });
            }
        }

        const rmsMm = Math.sqrt(sumSq / count);
        const resultUm = rmsMm * 1000;
        return resultUm;
    }

    calculateSpotSizeUm(operand: any, opticalSystemData: any[], options: any = {}): number {
        const getLastRayTraceFailureForThisEval = () => {
            try {
                if (typeof window === 'undefined') return null;
                const f = w.__lastRayTraceFailure;
                if (!f || typeof f !== 'object') return null;
                const ts = Number(f.evaluationTimestamp);
                if (!Number.isFinite(ts)) return null;
                const now = Date.now();
                if (now - ts > 5000) return null;
                return f;
            } catch {
                return null;
            }
        };

        const stampSpotDebug = (partial: any) => {
            try {
                if (typeof window === 'undefined') return;
                if (!w.__cooptLastSpotSizeDebug) {
                    w.__cooptLastSpotSizeDebug = {};
                }
                Object.assign(w.__cooptLastSpotSizeDebug, partial);
            } catch (_) {}
        };

        try {
            stampSpotDebug({
                ok: false,
                reason: 'started',
                at: new Date().toISOString(),
                operand: operand.operand,
                configId: operand.configId,
                param1: operand.param1,
                param2: operand.param2,
                param3: operand.param3,
                param4: operand.param4,
                impl: null,
                pattern: options.pattern,
                useUiDefaults: options.useUiDefaults,
                useUiTables: options.useUiTables,
                targetSurfaceIndex: null,
                rayCountRequested: null,
                rayStartsGenerated: null,
                hits: null,
                wavelength: null,
                fastModeEnabled: null,
                apertureLimitMm: null,
                retryRayCount: null,
                retryApertureLimitMm: null,
                retryHits: null,
                earlyAbortReason: null,
                resultUm: null
            });
        } catch (_) {}

        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                stampSpotDebug({ ok: false, reason: 'no-optical-data', resultUm: 1e9 });
                return 1e9;
            }

            const useUiDefaults = (options.useUiDefaults !== undefined) ? options.useUiDefaults : true;

            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId, {
                preferConfigTables: !useUiDefaults
            });
            const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
            let wavelength: number;
            try {
                wavelength = (param1Raw === '')
                    ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                    : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
            } catch (err) {
                stampSpotDebug({ ok: false, reason: 'wavelength-error', resultUm: 1e9 });
                return 1e9;
            }

            const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
            const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
            const objectIndex0 = objectIndex1 - 1;

            const param3Raw = (operand.param3 !== undefined && operand.param3 !== null) ? String(operand.param3).trim().toLowerCase() : '';
            const metric = (param3Raw === 'diameter' || param3Raw === 'dia') ? 'diameter' : 'rms';

            // param5: Target surface number (1-based), empty = image surface
            const param5Raw = (operand.param5 !== undefined && operand.param5 !== null) ? String(operand.param5).trim() : '';
            let targetSurfaceNumber1: number | null = null;
            if (param5Raw !== '') {
                const parsed = Math.floor(Number(param5Raw));
                if (Number.isFinite(parsed) && parsed > 0) {
                    targetSurfaceNumber1 = parsed;
                }
            }

            const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
            const defaultRayCount = options.pattern === 'annular' ? 101 : 501;
            let rayCount = (param4Raw === '') ? defaultRayCount : Math.floor(Number(param4Raw));
            if (!Number.isFinite(rayCount) || rayCount < 1) rayCount = defaultRayCount;
            if (rayCount > 5000) rayCount = 5000;

            const useUiTables = (options.useUiTables !== undefined) ? options.useUiTables : useUiDefaults;

            const meritFast = (typeof globalThis !== 'undefined' && w.__cooptMeritFastMode) || null;
            const fastModeEnabled = !!(meritFast && typeof meritFast === 'object');

            const rayCountOverride = options.rayCountOverride;
            if (Number.isFinite(rayCountOverride) && rayCountOverride > 0) {
                rayCount = Math.floor(rayCountOverride);
            }

            const imageSurfaceIndex = (() => {
                for (let i = opticalSystemData.length - 1; i >= 0; i--) {
                    const row = opticalSystemData[i];
                    if (row && typeof row === 'object') {
                        const ot = String(row['object type'] || row.objectType || row.object || '').trim().toLowerCase();
                        if (ot === 'image') return i;
                    }
                }
                return opticalSystemData.length - 1;
            })();

            stampSpotDebug({ wavelength, fastModeEnabled, imageSurfaceIndex });

            const objRow = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;
            try {
                if (typeof window !== 'undefined' && w.__cooptLastSpotSizeDebug && typeof w.__cooptLastSpotSizeDebug === 'object') {
                    const src0 = Array.isArray(sourceRows) ? sourceRows[0] : null;
                    const primary = Array.isArray(sourceRows)
                        ? (sourceRows.find((r: any) => r && r.primary && String(r.primary).toLowerCase().includes('primary')) || sourceRows[0])
                        : null;
                    w.__cooptLastSpotSizeDebug.objectRowSummary = objRow ? {
                        id: objRow.id,
                        position: objRow.position,
                        x: objRow.x,
                        y: objRow.y,
                        z: objRow.z,
                        angle: objRow.angle,
                        xHeightAngle: objRow.xHeightAngle,
                        yHeightAngle: objRow.yHeightAngle,
                        objectX: objRow['object x'],
                        objectY: objRow['object y']
                    } : null;
                    w.__cooptLastSpotSizeDebug.sourceRow0Summary = src0 ? { wavelength: src0.wavelength, primary: src0.primary } : null;
                    w.__cooptLastSpotSizeDebug.primarySourceRowSummary = primary ? { wavelength: primary.wavelength, primary: primary.primary } : null;
                }
            } catch (_) {}
            if (!objRow || typeof objRow !== 'object') {
                stampSpotDebug({ ok: false, reason: 'no-object-row', resultUm: 1e9 });
                return 1e9;
            }

            const fieldSetting = toFieldSettingFromObjectRow(objRow, objectIndex0, opticalSystemData, wavelength);

            // Always use spot-diagram path, but control UI settings usage
            stampSpotDebug({ impl: 'spot-diagram', useUiDefaults });

            const isOperandActiveConfig = (() => {
                try {
                    const systemConfig = tryLoadSystemConfigurations() || {};
                    const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                        ? String(systemConfig.activeConfigId)
                        : '';
                    const operandConfigId = (operand.configId !== undefined && operand.configId !== null)
                        ? String(operand.configId)
                        : '';
                    return activeConfigId && operandConfigId && activeConfigId === operandConfigId;
                } catch {
                    return false;
                }
            })();

            const isCurrentOperand = !operand.configId || String(operand.configId).trim() === '';

            const hasOptOverride = (() => {
                try {
                    if (typeof globalThis === 'undefined') return false;
                    const g = globalThis as any;
                    return Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0;
                } catch {
                    return false;
                }
            })();
            const forceOpticalSystemData = !!(options.forceOpticalSystemData || (hasOptOverride && !useUiDefaults));
            const useUiTablesEffective = !forceOpticalSystemData && (useUiTables || (!useUiDefaults && (isOperandActiveConfig || isCurrentOperand)));

            const getUiTableRowsForSpot = () => {
                if (useUiTablesEffective && (isOperandActiveConfig || isCurrentOperand)) {
                    try {
                        const tblOpt = getTableOpticalSystem();
                        const tblObj = getTableObject();
                        const tblSrc = getTableSource();
                        const optData = (tblOpt && typeof tblOpt.getData === 'function') ? tblOpt.getData()
                            : (Array.isArray(tblOpt) ? tblOpt : null);
                        const objData = (tblObj && typeof tblObj.getData === 'function') ? tblObj.getData()
                            : (Array.isArray(tblObj) ? tblObj : null);
                        const srcData = (tblSrc && typeof tblSrc.getData === 'function') ? tblSrc.getData()
                            : (Array.isArray(tblSrc) ? tblSrc : null);
                        if (Array.isArray(optData) && optData.length > 0) {
                            return {
                                optical: optData,
                                object: Array.isArray(objData) ? objData : [],
                                source: Array.isArray(srcData) ? srcData : []
                            };
                        }
                    } catch (_) {}
                }
                return null;
            };

            const uiTableRows = getUiTableRowsForSpot();

            const uiObjectSourceFallback = (() => {
                if (!uiTableRows && !useUiDefaults && (isOperandActiveConfig || isCurrentOperand)) {
                    try {
                        const objTbl = getTableObject();
                        const srcTbl = getTableSource();
                        const objData = (objTbl && typeof objTbl.getData === 'function') ? objTbl.getData()
                            : (Array.isArray(objTbl) ? objTbl : null);
                        const srcData = (srcTbl && typeof srcTbl.getData === 'function') ? srcTbl.getData()
                            : (Array.isArray(srcTbl) ? srcTbl : null);
                        if (Array.isArray(objData) || Array.isArray(srcData)) {
                            return {
                                object: Array.isArray(objData) ? objData : [],
                                source: Array.isArray(srcData) ? srcData : []
                            };
                        }
                    } catch (_) {}
                }
                return null;
            })();

            const uiOpticalFallback = (() => {
                if (!uiTableRows && !useUiDefaults && (isOperandActiveConfig || isCurrentOperand)) {
                    try {
                        const tbl = getTableOpticalSystem();
                        if (tbl && typeof tbl.getData === 'function') {
                            const data = tbl.getData();
                            return Array.isArray(data) ? data : null;
                        }
                        return Array.isArray(tbl) ? tbl : null;
                    } catch (_) { return null; }
                }
                return null;
            })();

            const overrideOpticalRows = (() => {
                try {
                    if (!forceOpticalSystemData) return null;
                    if (typeof globalThis === 'undefined') return null;
                    const g = globalThis as any;
                    return Array.isArray(g.__cooptOpticalSystemRowsOverride) ? g.__cooptOpticalSystemRowsOverride : null;
                } catch {
                    return null;
                }
            })();

            const spotOpticalRows = uiTableRows
                ? uiTableRows.optical
                : (overrideOpticalRows || (Array.isArray(uiOpticalFallback) ? uiOpticalFallback : opticalSystemData));
            const spotObjectRowsForOperand = uiTableRows ? uiTableRows.object : (uiObjectSourceFallback?.object || objectRows);
            const spotSourceRowsForOperand = uiTableRows ? uiTableRows.source : (uiObjectSourceFallback?.source || sourceRows);

            try {
                const first3 = Array.isArray(spotOpticalRows)
                    ? spotOpticalRows.slice(0, 3).map((r: any) => ({
                        type: r['object type'] || r.objectType,
                        thickness: r.thickness,
                        radius: r.radius,
                        semiDiameter: r['semi diameter']
                    }))
                    : null;
                const last3 = Array.isArray(spotOpticalRows)
                    ? spotOpticalRows.slice(-3).map((r: any) => ({
                        type: r['object type'] || r.objectType,
                        thickness: r.thickness,
                        radius: r.radius,
                        semiDiameter: r['semi diameter']
                    }))
                    : null;
                stampSpotDebug({
                    spotOpticalRowsLength: Array.isArray(spotOpticalRows) ? spotOpticalRows.length : null,
                    spotOpticalRowsSource: uiTableRows
                        ? 'uiTableRows.optical'
                        : (uiOpticalFallback ? 'uiOpticalFallback' : 'opticalSystemData'),
                    spotObjectRowsSource: uiTableRows
                        ? 'uiTableRows.object'
                        : (uiObjectSourceFallback ? 'uiObjectSourceFallback' : 'objectRows'),
                    spotSourceRowsSource: uiTableRows
                        ? 'uiTableRows.source'
                        : (uiObjectSourceFallback ? 'uiObjectSourceFallback' : 'sourceRows'),
                    spotOpticalRowsPreview: { first3, last3 }
                });
            } catch (_) {}

            let obj2 = Array.isArray(spotObjectRowsForOperand) ? spotObjectRowsForOperand[objectIndex0] : null;
            if (!obj2 || typeof obj2 !== 'object') {
                const fallbackObj = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;
                if (fallbackObj && typeof fallbackObj === 'object') {
                    obj2 = fallbackObj;
                }
            }
            if (!obj2 || typeof obj2 !== 'object') {
                stampSpotDebug({ ok: false, reason: 'no-object-row-ui', resultUm: 1e9 });
                return 1e9;
            }

            try {
                stampSpotDebug({
                    objectRowUsedSummary: obj2 ? {
                        id: obj2.id,
                        position: obj2.position,
                        x: obj2.x,
                        y: obj2.y,
                        z: obj2.z,
                        angle: obj2.angle,
                        xHeightAngle: obj2.xHeightAngle,
                        yHeightAngle: obj2.yHeightAngle,
                        objectX: obj2['object x'],
                        objectY: obj2['object y']
                    } : null
                });
            } catch (_) {}

            const lastSpotSettings = (() => {
                if (!useUiDefaults) return {};
                try {
                    return loadLastSpotSettings();
                } catch {
                    return {};
                }
            })();

            const forceSpotDiagramPrimary = !options.pattern || options.pattern === 'current';

            const resolveSurfaceIndexFromSurfaceId = (surfaceIdRaw: any, rows: any[]): number | null => {
                try {
                    const sid = Math.floor(Number(surfaceIdRaw));
                    if (!Number.isFinite(sid) || sid <= 0 || !Array.isArray(rows) || rows.length === 0) return null;

                    const opts = generateSurfaceOptions(rows);
                    const hit = Array.isArray(opts)
                        ? opts.find((o: any) => Number(o?.value) === sid || Number(o?.surfaceId) === sid)
                        : null;
                    if (hit && Number.isInteger(hit.rowIndex) && hit.rowIndex >= 0 && hit.rowIndex < rows.length) {
                        return hit.rowIndex;
                    }

                    // Backward-compatible fallback: older data may store row-based 1-origin numbers.
                    const idx = sid - 1;
                    if (idx >= 0 && idx < rows.length) return idx;
                } catch (_) {}
                return null;
            };

            const uiSurfaceIndex = (() => {
                // If param5 is specified, use it as the target surface (1-based to 0-based)
                if (targetSurfaceNumber1 !== null) {
                    const resolved = resolveSurfaceIndexFromSurfaceId(targetSurfaceNumber1, spotOpticalRows);
                    if (resolved !== null) {
                        return resolved;
                    }
                }
                // Otherwise, use UI settings only if useUiDefaults is true
                if (!useUiDefaults) return null;
                
                const idx = Number(lastSpotSettings.surfaceIndex);
                if (Number.isFinite(idx) && idx >= 0) return idx;
                const sel = document.getElementById('surface-number-select') as HTMLSelectElement | null;
                if (sel && sel.value) {
                    const resolved = resolveSurfaceIndexFromSurfaceId(sel.value, spotOpticalRows);
                    if (resolved !== null) return resolved;
                }
                return null;
            })();

            const targetSurfaceIndex = uiSurfaceIndex ?? imageSurfaceIndex;

            stampSpotDebug({ targetSurfaceIndex, uiSurfaceIndex });

            const pattern = (() => {
                if (options.pattern && options.pattern !== 'current') return options.pattern;
                
                // Only read from UI if useUiDefaults is true
                if (!useUiDefaults) return 'annular';

                const gridBtn = document.getElementById('grid-pattern-btn');
                const annularBtn = document.getElementById('annular-pattern-btn');
                if (gridBtn && annularBtn) {
                    if (gridBtn.classList.contains('active')) return 'grid';
                    if (annularBtn.classList.contains('active')) return 'annular';
                }

                try {
                    const p = getRayEmissionPattern();
                    if (p === 'grid' || p === 'annular') return p;
                } catch (_) {}

                return 'annular';
            })();

            stampSpotDebug({ pattern });

            const effectiveAnnularRingCount = (() => {
                if (options.annularRingCount !== undefined && options.annularRingCount !== null) {
                    return Math.max(1, Math.floor(Number(options.annularRingCount)));
                }

                // Requirements default: annular uses 10 rings (matches inspector/spec note).
                // Rectangle/grid ignores ring count, so this mainly affects annular operands.
                if (!useUiDefaults) return 10;

                const ringCount = Number(lastSpotSettings.ringCount);
                if (Number.isFinite(ringCount) && ringCount > 0) return Math.floor(ringCount);

                const sel = document.getElementById('ring-count-select') as HTMLSelectElement | null;
                if (sel && sel.value) {
                    const v = Number(sel.value);
                    if (Number.isFinite(v) && v > 0) return Math.floor(v);
                }

                return 3;
            })();

            const surfaceNumber1 = targetSurfaceIndex + 1;

            try {
                const attemptPatterns = (() => {
                    const primary = (pattern === 'grid' || pattern === 'annular') ? pattern : 'annular';
                    const alternate = primary === 'annular' ? 'grid' : 'annular';
                    return [primary, alternate];
                })();

                for (let attemptIndex = 0; attemptIndex < attemptPatterns.length; attemptIndex++) {
                    const patternAttempt = attemptPatterns[attemptIndex];
                    const spotResult = generateSpotDiagram(
                        spotOpticalRows,
                        spotSourceRowsForOperand,
                        [obj2],
                        surfaceNumber1,
                        rayCount,
                        effectiveAnnularRingCount,
                        {
                            physicalVignetting: true,
                            pattern: patternAttempt
                        }
                    );

                    const hits = (spotResult && Array.isArray(spotResult.spotData) && spotResult.spotData.length > 0)
                        ? (spotResult.spotData[0]?.spotPoints || [])
                        : [];
                    if (!Array.isArray(hits) || hits.length <= 0) {
                        stampSpotDebug({
                            ok: false,
                            reason: attemptIndex === 0 ? 'spot-diagram-no-rays' : 'spot-diagram-no-rays-after-retry',
                            hits: 0,
                            resultUm: 1e9,
                            patternAttempt,
                            attemptIndex
                        });
                        continue;
                    }

                    const exactChief = this.resolveExactChiefSpotPoint(
                        spotOpticalRows,
                        obj2,
                        wavelength,
                        targetSurfaceIndex,
                    );
                    // Fix: spot-diagram.ts saves as 'isChiefRay', not 'isChief'
                    let chief = exactChief
                        ? { x: exactChief.x, y: exactChief.y }
                        : (hits.find((h: any) => h.isChiefRay) || null);
                    if (!chief) {
                        const cx = hits.reduce((sum: number, h: any) => sum + h.x, 0) / hits.length;
                        const cy = hits.reduce((sum: number, h: any) => sum + h.y, 0) / hits.length;
                        let bestIdx = 0;
                        let bestDist = Infinity;
                        for (let i = 0; i < hits.length; i++) {
                            const h = hits[i];
                            const d = Math.hypot(h.x - cx, h.y - cy);
                            if (d < bestDist) {
                                bestDist = d;
                                bestIdx = i;
                            }
                        }
                        chief = hits[bestIdx] || hits[0];
                    }

                    let maxRUm = 0;
                    let sumX2 = 0;
                    let sumY2 = 0;
                    let n = 0;
                    for (const h of hits) {
                        const dxUm = (h.x - chief.x) * 1000;
                        const dyUm = (h.y - chief.y) * 1000;
                        const rUm = Math.hypot(dxUm, dyUm);
                        if (rUm > maxRUm) maxRUm = rUm;
                        sumX2 += dxUm * dxUm;
                        sumY2 += dyUm * dyUm;
                        n++;
                    }

                    if (n <= 0) {
                        stampSpotDebug({
                            ok: false,
                            reason: attemptIndex === 0 ? 'no-valid-hits' : 'no-valid-hits-after-retry',
                            hits: 0,
                            resultUm: 1e9,
                            patternAttempt,
                            attemptIndex
                        });
                        continue;
                    }

                    const rmsX = Math.sqrt(sumX2 / n);
                    const rmsY = Math.sqrt(sumY2 / n);
                    const rmsTotal = Math.sqrt(rmsX * rmsX + rmsY * rmsY);
                    const diameter = 2 * maxRUm;

                    const valueUm = (metric === 'diameter') ? diameter : rmsTotal;

                    stampSpotDebug({
                        ok: true,
                        reason: (attemptIndex === 0) ? 'ok' : 'ok-after-pattern-retry',
                        hits: hits.length,
                        resultUm: valueUm,
                        patternAttempt,
                        attemptIndex
                    });

                    return valueUm;
                }

                stampSpotDebug({ ok: false, reason: 'spot-diagram-no-rays-all-patterns', hits: 0, resultUm: 1e9 });
                return 1e9;
            } catch (err) {
                stampSpotDebug({
                    ok: false,
                    reason: 'spot-diagram-exception',
                    hits: 0,
                    resultUm: 1e9,
                    errorMessage: String((err && (err as any).message !== undefined) ? (err as any).message : err),
                    errorStack: (err && (err as any).stack) ? String((err as any).stack) : ''
                });
                return 1e9;
            }
        } catch (err) {
            stampSpotDebug({
                ok: false,
                reason: 'exception',
                hits: 0,
                legacyFallbackHits: null,
                rayStartsGenerated: null,
                lastRayTraceFailure: null,
                errorMessage: String((err && (err as any).message !== undefined) ? (err as any).message : err),
                errorStack: (err && (err as any).stack) ? String((err as any).stack) : ''
            });
            return 1e9;
        } finally {
            try {
                if (typeof window !== 'undefined' && w.__cooptLastSpotSizeDebug && typeof w.__cooptLastSpotSizeDebug === 'object') {
                    const r = String(w.__cooptLastSpotSizeDebug.reason ?? '');
                    const ok = w.__cooptLastSpotSizeDebug.ok;
                    if (r === 'started' && ok === false) {
                        w.__cooptLastSpotSizeDebug.reason = 'early-return-without-stamp';
                        w.__cooptLastSpotSizeDebug.ok = false;
                        w.__cooptLastSpotSizeDebug.resultUm = w.__cooptLastSpotSizeDebug.resultUm ?? 1e9;
                        w.__cooptLastSpotSizeDebug.earlyReturnStage = w.__cooptLastSpotSizeDebug.spotDiagStage ?? null;
                        w.__cooptLastSpotSizeDebug.lastRayTraceFailure = w.__cooptLastSpotSizeDebug.lastRayTraceFailure ?? getLastRayTraceFailureForThisEval?.();
                    }
                }
            } catch (_) {}
        }
    }

    getSurfaceIndexBySurfaceId(opticalSystemData: any[], surfaceId1Based: any): number {
        const sNum = Number.isFinite(Number(surfaceId1Based)) ? Math.floor(Number(surfaceId1Based)) : NaN;
        if (!Number.isFinite(sNum) || sNum < 0) return -1;

        const byId = Array.isArray(opticalSystemData)
            ? opticalSystemData.findIndex(r => r && Number(r.id) === sNum)
            : -1;
        if (byId >= 0) return byId;

        if (Array.isArray(opticalSystemData)) {
            const idx1 = sNum;
            if (idx1 >= 0 && idx1 < opticalSystemData.length) return idx1;
            const idx0 = sNum - 1;
            if (idx0 >= 0 && idx0 < opticalSystemData.length) return idx0;
        }

        return -1;
    }

    getSemidiaFromSurfaceRow(surfaceRow: any): number {
        if (!surfaceRow) return Infinity;
        const v = surfaceRow.semidia ?? surfaceRow['Semi Diameter'] ?? surfaceRow['semi diameter'];
        const n = Number(v);
        return (Number.isFinite(n) && n > 0) ? n : Infinity;
    }

    isInfiniteConjugateFromObjectRow(opticalSystemData: any[]): boolean {
        const t = opticalSystemData?.[0]?.thickness;
        if (t === Infinity) return true;
        const s = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
        return (s === 'INF' || s === 'INFINITY');
    }

    normalizeDir(x: number, y: number, z: number): { x: number; y: number; z: number } {
        const nx = Number(x);
        const ny = Number(y);
        const nz = Number(z);
        const L = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!Number.isFinite(L) || L <= 0) return { x: 0, y: 0, z: 1 };
        return { x: nx / L, y: ny / L, z: nz / L };
    }

    traceRayToSurfaceIndex(opticalSystemData: any[], ray0: any, surfaceIndex: number): any {
        const p = traceRay(opticalSystemData, ray0, 1.0, null, undefined) as any;
        if (!p || !Array.isArray(p)) return null;
        const hit = p[surfaceIndex + 1];
        if (!hit) return null;
        return hit;
    }

    resolveExactChiefSpotPoint(opticalSystemData: any[], objectRow: any, wavelength: number, targetSurfaceIndex: number): { x: number; y: number } | null {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
            if (!objectRow || typeof objectRow !== 'object') return null;
            if (!Number.isFinite(wavelength) || wavelength <= 0) return null;
            if (!Number.isInteger(targetSurfaceIndex) || targetSurfaceIndex < 0 || targetSurfaceIndex >= opticalSystemData.length) return null;

            const rayStarts = generateRayStartPointsForObject(
                objectRow,
                opticalSystemData,
                1,
                null,
                {
                    pattern: 'annular',
                    annularRingCount: 1,
                    wavelengthUm: wavelength,
                    aimThroughStop: true,
                    useChiefRayAnalysis: true,
                    allowStopBasedOriginSolve: true,
                    originSolveTraceBackend: 'rust',
                    strictChiefDirectionSolve: true,
                    targetSurfaceIndex,
                    imageHeightValidationTraceBackend: 'rust',
                }
            ) as any;

            const chiefOrigin = rayStarts?.expectedChiefOrigin ?? rayStarts?.[0]?.startP ?? null;
            const chiefDir = rayStarts?.expectedChiefDir ?? rayStarts?.[0]?.dir ?? null;
            if (!chiefOrigin || !chiefDir) return null;

            const hitGlobal = traceRayHitPoint(
                opticalSystemData,
                {
                    pos: {
                        x: Number(chiefOrigin.x),
                        y: Number(chiefOrigin.y),
                        z: Number(chiefOrigin.z),
                    },
                    dir: {
                        x: Number(chiefDir.x),
                        y: Number(chiefDir.y),
                        z: Number(chiefDir.z),
                    },
                    wavelength,
                },
                1.0,
                targetSurfaceIndex,
                {
                    useRustWasm: true,
                    requireRustWasm: false,
                    allowNonStrict: true,
                }
            ) as any;
            if (!hitGlobal) return null;

            const surfaceInfo = calculateSurfaceOrigins(opticalSystemData)?.[targetSurfaceIndex] || null;
            const hitLocal = surfaceInfo ? transformPointToLocal(hitGlobal, surfaceInfo) : hitGlobal;
            const x = Number(hitLocal?.x);
            const y = Number(hitLocal?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return { x, y };
        } catch {
            return null;
        }
    }

    solveCrossRayToStopEdgeY(opticalSystemData: any[], stopIndex: number, stopRadius: number, wavelength: number): any {
        const isInfinite = this.isInfiniteConjugateFromObjectRow(opticalSystemData);
        const objectRow = opticalSystemData && opticalSystemData[0];
        const renderDist = (objectRow && typeof objectRow.objectRenderDistance === 'number') ? objectRow.objectRenderDistance : 0;
        const zStart = isInfinite ? -Math.abs(renderDist) : 0;
        const targetY = stopRadius;

        const evalFunc = (u: number) => {
            const uNum = Number(u);
            if (!Number.isFinite(uNum)) return { ok: false, blocked: true, value: Infinity };

            let ray0: any;
            if (isInfinite) {
                ray0 = {
                    pos: { x: 0, y: uNum, z: zStart },
                    dir: { x: 0, y: 0, z: 1 },
                    wavelength
                };
            } else {
                ray0 = {
                    pos: { x: 0, y: 0, z: zStart },
                    dir: this.normalizeDir(0, uNum, 1),
                    wavelength
                };
            }

            const hit = this.traceRayToSurfaceIndex(opticalSystemData, ray0, stopIndex);
            if (!hit) {
                return { ok: false, blocked: true, value: Infinity, ray0 };
            }
            const yStop = Number(hit.y);
            if (!Number.isFinite(yStop)) {
                return { ok: false, blocked: true, value: Infinity, ray0 };
            }
            return { ok: true, blocked: false, value: yStop - targetY, yStop, ray0 };
        };

        const f0 = evalFunc(0);
        if (!f0.ok && !f0.ray0) return null;

        let lo = 0;
        let hi = isInfinite ? Math.max(1e-6, stopRadius) : 0.05;

        let flo = f0.ok ? f0.value : -Infinity;
        let fhiObj = evalFunc(hi);
        let tries = 0;

        while (tries < 40) {
            if (fhiObj.ok) {
                if (fhiObj.value >= 0) break;
            } else if (fhiObj.blocked) {
                break;
            }
            hi *= 2;
            fhiObj = evalFunc(hi);
            tries++;
        }

        if (!(fhiObj.ok && fhiObj.value >= 0) && !fhiObj.blocked) {
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
                if (fm.value >= 0) {
                    hi = mid;
                    fhiObj = fm;
                } else {
                    lo = mid;
                    flo = fm.value;
                }
            } else {
                hi = mid;
            }
        }

        return bestRay0;
    }

    calculateClearanceVsSemidia(operand: any, opticalSystemData: any[]): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;

        const surfaceId = Number.isFinite(Number(operand?.param1)) ? Math.floor(Number(operand.param1)) : NaN;
        if (!Number.isFinite(surfaceId)) return 0;

        const { source: sourceRows } = this.getConfigTablesByConfigId(operand.configId);
        const wlRow = (operand?.param2 !== undefined && operand?.param2 !== null && String(operand.param2).trim() !== '')
            ? Number(operand.param2)
            : NaN;
        const wavelength = Number.isFinite(wlRow)
            ? this.getWavelengthFromSourceRows(sourceRows, wlRow)
            : this.getPrimaryWavelengthFromSourceRows(sourceRows);

        const marginRaw = Number(operand?.param3);
        const margin = Number.isFinite(marginRaw) ? marginRaw : 0;

        const surfIndex = this.getSurfaceIndexBySurfaceId(opticalSystemData, surfaceId);
        if (surfIndex < 0) return 0;

        const semidia = this.getSemidiaFromSurfaceRow(opticalSystemData[surfIndex]);
        if (!Number.isFinite(semidia) || semidia === Infinity) return 0;

        const stopIndex = findStopSurfaceIndex(opticalSystemData);
        if (stopIndex < 0) return 0;
        const stopRadius = this.getSemidiaFromSurfaceRow(opticalSystemData[stopIndex]);
        if (!Number.isFinite(stopRadius) || stopRadius === Infinity) return 0;

        const cfgKey = operand?.configId ? String(operand.configId) : 'active';
        const cacheKey = `clrh-real:${cfgKey}:wl=${wavelength}`;

        let cached = this._runtimeCache ? this._runtimeCache.get(cacheKey) : null;
        if (!cached) {
            const ray0 = this.solveCrossRayToStopEdgeY(opticalSystemData, stopIndex, stopRadius, wavelength);
            if (!ray0) return 0;

            const fullPath = traceRay(opticalSystemData, ray0, 1.0, null, null);
            cached = { ray0, fullPath };
            if (this._runtimeCache) this._runtimeCache.set(cacheKey, cached);
        }

        const fullPath = cached.fullPath;
        if (!fullPath || !Array.isArray(fullPath)) {
            return 1e6;
        }

        const hit = fullPath[surfIndex + 1];
        if (!hit) {
            return 1e6;
        }
        const rayY = Math.abs(Number(hit.y));
        if (!Number.isFinite(rayY)) return 1e6;

        const violation = rayY + margin - semidia;
        return violation > 0 ? violation : 0;
    }

    getConfigTablesByConfigId(configId: any, options: { preferConfigTables?: boolean } = {}): { source: any[]; object: any[] } {
        try {
            const systemConfig = tryLoadSystemConfigurations();
            const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                ? String(systemConfig.activeConfigId)
                : '';

            const isConfigSwitching = (() => {
                try {
                    return typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
                } catch {
                    return false;
                }
            })();

            const preferConfigTables = !!options.preferConfigTables;

            let targetConfigId = configId;
            if (!targetConfigId) {
                targetConfigId = activeConfigId;
            }
            const targetIdStr = (targetConfigId !== undefined && targetConfigId !== null) ? String(targetConfigId) : '';

            if (activeConfigId && targetIdStr && targetIdStr === activeConfigId) {
                // During config switching, Tabulator tables can be mid-update; avoid reading live tables.
                // Use the persisted snapshot instead to prevent mixing rows across configs.
                if (isConfigSwitching) {
                    const cfg = systemConfig?.configurations?.find((c: any) => String(c.id) === String(targetIdStr)) || null;
                    return {
                        source: getSourceRows({}),
                        object: Array.isArray(cfg?.object)
                            ? cfg.object
                            : ((typeof window !== 'undefined' && w.getObjectRows)
                                ? w.getObjectRows()
                                : (w.tableObject ? w.tableObject.getData() : []))
                    };
                }

                return {
                    source: getSourceRows({}),
                    object: (typeof window !== 'undefined' && w.getObjectRows)
                        ? w.getObjectRows()
                        : (w.tableObject ? w.tableObject.getData() : [])
                };
            }

            const config = systemConfig?.configurations?.find((c: any) => String(c.id) === String(targetIdStr));
            if (!config) {
                return {
                    source: getSourceRows({}),
                    object: (typeof window !== 'undefined' && w.getObjectRows) ? w.getObjectRows() : (w.tableObject ? w.tableObject.getData() : [])
                };
            }
            return {
                source: Array.isArray(config.source) ? config.source : getSourceRows({}),
                object: Array.isArray(config.object)
                    ? config.object
                    : ((typeof window !== 'undefined' && w.getObjectRows) ? w.getObjectRows() : (w.tableObject ? w.tableObject.getData() : []))
            };
        } catch {
            return {
                source: getSourceRows({}),
                object: (typeof window !== 'undefined' && w.getObjectRows) ? w.getObjectRows() : (w.tableObject ? w.tableObject.getData() : [])
            };
        }
    }

    getWavelengthFromSourceRows(sourceRows: any[], sourceIndex1Based: any): number {
        const idx = Number.isFinite(Number(sourceIndex1Based)) ? Math.floor(Number(sourceIndex1Based)) : 1;
        const index0 = Math.max(0, idx - 1);
        const row = Array.isArray(sourceRows) ? sourceRows[index0] : null;
        const wl = row ? Number(row.wavelength) : NaN;
        return (Number.isFinite(wl) && wl > 0) ? wl : 0.5875618;
    }

    getPrimaryWavelengthFromSourceRows(sourceRows: any[]): number {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5875618;
        const isPrimaryRow = (r: any): boolean => {
            if (!r || typeof r !== 'object') return false;
            const flags = [
                r?.primary,
                r?.Primary,
                r?.['Primary Wavelength'],
                r?.isPrimary,
                r?.primaryWavelength,
                r?.primary_flag
            ];
            return flags.some((f: any) => {
                if (f === true) return true;
                if (f === 1) return true;
                const s = String(f ?? '').trim().toLowerCase();
                return s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'primary' || s === 'primary wavelength' || s.includes('primary');
            });
        };
        const primaryRow = sourceRows.find((r: any) => isPrimaryRow(r));
        const wl = primaryRow ? Number(primaryRow.wavelength ?? primaryRow.Wavelength) : NaN;
        if (Number.isFinite(wl) && wl > 0) return wl;

        try {
            if (typeof window !== 'undefined' && typeof w.getPrimaryWavelength === 'function') {
                const byApi = Number(w.getPrimaryWavelength());
                if (Number.isFinite(byApi) && byApi > 0) return byApi;
            }
        } catch (_) {}

        const dLine = 0.5875618;
        let bestWl = NaN;
        let bestDiff = Infinity;
        for (const row of sourceRows) {
            const candidate = Number(row?.wavelength ?? row?.Wavelength);
            if (!Number.isFinite(candidate) || candidate <= 0) continue;
            const diff = Math.abs(candidate - dLine);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestWl = candidate;
            }
        }
        return (Number.isFinite(bestWl) && bestWl > 0) ? bestWl : dLine;
    }

    getSystemWavelengthFromOperandOrPrimary(operand: any, sourceRows: any[]): number {
        const raw = (operand && operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        if (raw === '') {
            return this.getPrimaryWavelengthFromSourceRows(sourceRows);
        }

        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
            return this.getPrimaryWavelengthFromSourceRows(sourceRows);
        }

        const s = raw.toLowerCase();
        const isNonIntegerLiteral = (s.includes('.') || s.includes('e')) && Math.abs(n - Math.round(n)) > 1e-12;
        const looksLikeWavelengthUm = (n < 1) || isNonIntegerLiteral;
        if (looksLikeWavelengthUm) return n;

        const idx1 = Math.floor(n);
        if (idx1 > 0) return this.getWavelengthFromSourceRows(sourceRows, idx1);
        return this.getPrimaryWavelengthFromSourceRows(sourceRows);
    }

    safeFiniteNumberOrZero(v: any): number {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    computeTotalSystemLengthMm(opticalSystemData: any[]): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;
        let total = 0;
        for (const row of opticalSystemData) {
            const tRaw = row ? row.thickness : undefined;
            if (tRaw === undefined || tRaw === null) continue;
            const s = String(tRaw).trim().toUpperCase();
            if (s === 'INF' || s === 'INFINITY') continue;
            const t = Number(tRaw);
            if (Number.isFinite(t)) total += t;
        }
        return total;
    }

    computeObjectDistanceMm(opticalSystemData: any[]): number {
        const tRaw = opticalSystemData?.[0]?.thickness;
        if (tRaw === undefined || tRaw === null) return 0;
        const s = String(tRaw).trim().toUpperCase();
        if (s === 'INF' || s === 'INFINITY') return 0;
        const t = Number(tRaw);
        return Number.isFinite(t) ? t : 0;
    }

    getParaxialAxisSelectionForOperand(operand: any, key: string): '' | 'X' | 'Y' {
        if (key === 'EFL') return normalizeParaxialAxisSelection(operand?.param3);
        if (key === 'EFFL') return normalizeParaxialAxisSelection(operand?.param4);
        if (key === 'FL' || key === 'BFL' || key === 'IMD') return normalizeParaxialAxisSelection(operand?.param2);
        return '';
    }

    getPrimarySystemMetricsCached(operand: any, opticalSystemData: any[]): any {
        const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
        const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
        const cfgKey = operand?.configId ? String(operand.configId) : 'active';
        const param2 = operand?.param2 ? String(operand.param2) : '';
        const axis = this.getParaxialAxisSelectionForOperand(operand, String(operand?.operand ?? '').trim());
        const cacheKey = `primary-metrics:${cfgKey}:wl=${wavelength}:p2=${param2}:axis=${axis}`;

        const cached = this._runtimeCache ? this._runtimeCache.get(cacheKey) : null;
        if (cached) return cached;

        const paraxial = calculateParaxialData(opticalSystemData, wavelength);
        const meridian = getParaxialMeridianFromAxis(axis);

        const fl = this.safeFiniteNumberOrZero(readParaxialMeridianScalar(paraxial?.focalLength, axis));

        const bfl = this.safeFiniteNumberOrZero(readParaxialMeridianScalar(paraxial?.backFocalLength, axis));

        const imd = this.safeFiniteNumberOrZero(readParaxialMeridianScalar(paraxial?.imageDistance, axis));
        const finalAlpha = Number(paraxial?.finalAlpha);

        const eflTrace = calculateFullSystemParaxialTrace(opticalSystemData, wavelength, meridian) as any;
        const efl = (eflTrace && Number.isFinite(eflTrace.finalAlpha) && Math.abs(eflTrace.finalAlpha) > 1e-12)
            ? (1.0 / eflTrace.finalAlpha)
            : 0;

        const totalLength = this.computeTotalSystemLengthMm(opticalSystemData);
        const objd = this.computeObjectDistanceMm(opticalSystemData);

        const exitPupilDetails = paraxial?.exitPupilDetails;
        const newSpecPupils = paraxial?.newSpecPupils;
        const exitPupil = newSpecPupils?.exitPupil;
        const entrancePupil = newSpecPupils?.entrancePupil;

        const expd = this.safeFiniteNumberOrZero((exitPupilDetails as any)?.diameter ?? (exitPupil as any)?.diameter ?? paraxial?.exitPupilDiameter);
        const exPosOrigin = this.safeFiniteNumberOrZero((exitPupilDetails as any)?.position ?? (exitPupil as any)?.position);
        const exppFromImage = (Number.isFinite(exPosOrigin) && Number.isFinite(imd)) ? (exPosOrigin - imd) : 0;

        const betaExpRaw = (typeof (exitPupil as any)?.betaExp === 'number') ? (exitPupil as any).betaExp
            : (typeof (exitPupilDetails as any)?.betaExp === 'number') ? (exitPupilDetails as any).betaExp
            : (typeof (exitPupilDetails as any)?.magnification === 'number') ? (exitPupilDetails as any).magnification
            : (typeof exitPupil?.magnification === 'number') ? exitPupil.magnification
            : NaN;
        const betaExp = this.safeFiniteNumberOrZero(betaExpRaw);

        const enpd = this.safeFiniteNumberOrZero(entrancePupil?.diameter ?? paraxial?.entrancePupilDiameter);
        const enpp = this.safeFiniteNumberOrZero(entrancePupil?.position);
        const enpm = this.safeFiniteNumberOrZero(entrancePupil?.magnification);

        let pmag = 0;
        if (objd > 0 && Number.isFinite(finalAlpha) && Math.abs(finalAlpha) > 1e-12) {
            const initialAlpha = -1.0 / objd;
            pmag = initialAlpha / finalAlpha;
        }

        let fnoWrk = 0;
        if (Number.isFinite(exPosOrigin) && Number.isFinite(imd) && expd > 0) {
            fnoWrk = (-exPosOrigin + imd) / expd;
        }

        let fnoObj = 0;
        if (Math.abs(pmag) > 1e-12 && Number.isFinite(fnoWrk)) {
            fnoObj = Math.abs(fnoWrk / pmag);
        }

        let fnoImg = 0;
        if (fl > 0 && enpd > 0) {
            fnoImg = fl / enpd;
        }

        let naImg = 0;
        let naObj = 0;
        if (Number.isFinite(fnoWrk) && Math.abs(fnoWrk) > 1e-12) {
            naImg = 1.0 / (2.0 * fnoWrk);
            if (Number.isFinite(pmag)) {
                naObj = Math.abs(naImg * pmag);
            }
        }

        const metrics = {
            FL: this.safeFiniteNumberOrZero(fl),
            EFL: this.safeFiniteNumberOrZero(efl),
            BFL: this.safeFiniteNumberOrZero(bfl),
            IMD: this.safeFiniteNumberOrZero(imd),
            OBJD: this.safeFiniteNumberOrZero(objd),
            TSL: this.safeFiniteNumberOrZero(totalLength),
            BEXP: this.safeFiniteNumberOrZero(betaExp),
            EXPD: this.safeFiniteNumberOrZero(expd),
            EXPP: this.safeFiniteNumberOrZero(exppFromImage),
            ENPD: this.safeFiniteNumberOrZero(enpd),
            ENPP: this.safeFiniteNumberOrZero(enpp),
            ENPM: this.safeFiniteNumberOrZero(enpm),
            PMAG: this.safeFiniteNumberOrZero(pmag),
            FNO_OBJ: this.safeFiniteNumberOrZero(fnoObj),
            FNO_IMG: this.safeFiniteNumberOrZero(fnoImg),
            FNO_WRK: this.safeFiniteNumberOrZero(fnoWrk),
            NA_OBJ: this.safeFiniteNumberOrZero(naObj),
            NA_IMG: this.safeFiniteNumberOrZero(naImg),
        };

        if (this._runtimeCache) this._runtimeCache.set(cacheKey, metrics);
        return metrics;
    }

    calculatePrimarySystemMetric(operand: any, opticalSystemData: any[], key: string): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;
        
        if (key === 'EFL') {
            const rawScope = (() => {
                const param4 = String(operand?.param4 ?? '').trim();
                if (param4) return param4;
                return String(operand?.param2 ?? '').trim();
            })();
            const scope = this.resolveMeritScopeSelection(rawScope, opticalSystemData, operand?.configId);
            if (scope.kind === 'block' || scope.kind === 'zoom') {
                const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
                const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
                const axis = this.getParaxialAxisSelectionForOperand(operand, key);
                return this._calculateEFLForSurfaceRange(
                    opticalSystemData,
                    scope.startSurf,
                    scope.endSurf,
                    wavelength,
                    axis
                );
            }
        }

        if (key === 'EFFL') {
            const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
            const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
            const axis = this.getParaxialAxisSelectionForOperand(operand, key);
            const startSurf = parseInt(operand?.param2, 10) || 1;
            const endSurf = parseInt(operand?.param3, 10) || (opticalSystemData.length - 2);
            return this._calculateEFLForSurfaceRange(opticalSystemData, startSurf, endSurf, wavelength, axis);
        }
        
        const metrics = this.getPrimarySystemMetricsCached(operand, opticalSystemData);
        return this.safeFiniteNumberOrZero(metrics ? metrics[key] : 0);
    }

    calculateDoubletBendingK(operand: any): number {
        const rawSelection = String(operand?.param1 ?? '').trim();
        if (!rawSelection) return 0;

        try {
            const sys = tryLoadSystemConfigurations();
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
            const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null)
                ? String(sys.activeConfigId).trim()
                : '';
            const hint = (operand?.configId === undefined || operand?.configId === null)
                ? ''
                : String(operand.configId).trim();

            let cfg = null;
            if (hint) {
                cfg = configs.find((c: any) => c && String(c.id).trim() === hint)
                    || configs.find((c: any) => c && String(c.name).trim() === hint)
                    || null;
            }
            if (!cfg && activeId) {
                cfg = configs.find((c: any) => c && String(c.id).trim() === activeId) || null;
            }
            if (!cfg) cfg = configs[0] || null;

            const blockId = this._convertLabelToBlockId(rawSelection, operand?.configId);
            const blocks = Array.isArray(cfg?.blocks) ? cfg.blocks : [];
            const block = blocks.find((entry: any) => entry && String(entry.blockId ?? '').trim() === String(blockId).trim()) || null;
            if (!block || String(block?.blockType ?? '').trim() !== 'Doublet') return 0;
            return this.safeFiniteNumberOrZero(getDoubletBendingCurrentK(block));
        } catch (err) {
            console.error('[DBLT_K] Error calculating doublet bending K:', err);
            return 0;
        }
    }

    calculateEFLForBlock(operand: any, opticalSystemData: any[], blockLabel: string): number {
        console.log(`[EFL Block] Calculating EFL for block "${blockLabel}"`);
        
        const blockInfo = this._getBlockSurfaceRange(blockLabel, operand.configId);
        if (!blockInfo) {
            console.warn(`[EFL Block] Could not find block "${blockLabel}"`);
            return 0;
        }
        
        console.log(`[EFL Block] Block "${blockLabel}" → surfaces ${blockInfo.startSurf} to ${blockInfo.endSurf}`);
        
        // Use EFFL-style calculation: extract surfaces and calculate EFL
        const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
        const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
        
        return this._calculateEFLForSurfaceRange(
            opticalSystemData,
            blockInfo.startSurf,
            blockInfo.endSurf,
            wavelength
        );
    }

    _getSurfaceCountFromBlockType(block: any): number {
        const blockType = String(block?.blockType || '').trim();
        switch (blockType) {
            case 'ObjectPlane':
            case 'ObjectSurface':
                return 1;
            case 'Lens':
            case 'PositiveLens':
                return 2;
            case 'Paraxial':
                return 1;
            case 'Doublet':
                return 3;
            case 'Gap':
            case 'AirGap':
            case 'CoordTrans':
                return 0;
            case 'Stop':
                return 1;
            case 'SingleSurface':
            case 'ImageSurface':
                return 1;
            default:
                if (Array.isArray(block?.surfaces)) {
                    return block.surfaces.length;
                }
                console.warn(`[Merit Debug] Unknown blockType: ${blockType}, assuming 1 surface`);
                return 1;
        }
    }

    _getBlockSurfaceRange(blockLabel: string, configId: any): { startSurf: number; endSurf: number } | null {
        try {
            const sys = tryLoadSystemConfigurations();
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
            
            let cfg = null;
            if (configId !== undefined && configId !== null) {
                const hint = String(configId).trim();
                cfg = configs.find((c: any) => c && String(c.id) === hint) || null;
            }
            if (!cfg) {
                const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';
                cfg = configs.find((c: any) => c && String(c.id) === activeId) || configs[0] || null;
            }
            
            const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
            
            // Find the block
            const labelUpper = blockLabel.toUpperCase();
            let targetBlock = null;
            for (const block of blocks) {
                const blockId = String(block?.blockId || '').trim();
                const name = String(block?.name || '').trim();
                const type = String(block?.type || '').trim();
                const blockType = String(block?.blockType || '').trim();
                
                if (blockId.toUpperCase() === labelUpper ||
                    name.toUpperCase() === labelUpper ||
                    `${type}-${blockId}`.toUpperCase() === labelUpper) {
                    targetBlock = block;
                    break;
                }
            }
            
            if (!targetBlock) {
                return null;
            }
            
            // Calculate surface range by counting surfaces in blocks before this one
            let currentSurf = 0; // Start at 0 (Object surface is at index 0)
            for (const block of blocks) {
                const surfCount = this._getSurfaceCountFromBlockType(block);
                if (block === targetBlock) {
                    // Found it! Return the range
                    const startSurf = currentSurf;
                    const endSurf = currentSurf + surfCount - 1;
                    return { startSurf, endSurf };
                }
                currentSurf += surfCount;
            }
            
            return null;
        } catch (err) {
            console.error('[EFL] Error getting block surface range:', err);
            return null;
        }
    }

    _getZoomGroupSurfaceRange(opticalSystemData: any[], zoomGroupLabel: string, configId: any): { startSurf: number; endSurf: number } | null {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

            const sys = tryLoadSystemConfigurations();
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];

            let cfg = null;
            if (configId !== undefined && configId !== null) {
                const hint = String(configId).trim();
                cfg = configs.find((c: any) => c && String(c.id) === hint) || null;
            }
            if (!cfg) {
                const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';
                cfg = configs.find((c: any) => c && String(c.id) === activeId) || configs[0] || null;
            }

            const target = String(zoomGroupLabel ?? '').trim().toUpperCase();
            if (!target) return null;

            const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
            if (!Array.isArray(blocks) || blocks.length === 0) return null;

            const zoomGroupBlockIds = new Set<string>();
            for (const block of blocks) {
                const blockParams = (block?.parameters && typeof block.parameters === 'object') ? block.parameters : null;
                const zoomGroup = String(blockParams?.zoomGroup ?? '').trim().toUpperCase();
                const blockId = String(block?.blockId ?? '').trim();
                if (!blockId || !zoomGroup || zoomGroup !== target) continue;
                if (this._getSurfaceCountFromBlockType(block) <= 0) continue;
                zoomGroupBlockIds.add(blockId);
            }

            if (zoomGroupBlockIds.size === 0) return null;

            let startSurf = Number.POSITIVE_INFINITY;
            let endSurf = Number.NEGATIVE_INFINITY;

            for (const row of opticalSystemData) {
                if (!row || isGapOpticalRow(row) || isCoordTransOpticalRow(row)) continue;

                const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
                if (objectType === 'object' || objectType === 'image') continue;

                const blockId = String(row._blockId ?? '').trim();
                if (!blockId || !zoomGroupBlockIds.has(blockId)) continue;

                const blockType = String(row._blockType ?? row.blockType ?? '').trim().toLowerCase();
                const surfaceRole = String(row._surfaceRole ?? row.surfaceRole ?? '').trim().toLowerCase();
                if ((blockType === 'paraxial' || blockType === 'thinlens') && surfaceRole === 'back') continue;

                const surfaceId = Number(row.id);
                if (!Number.isFinite(surfaceId)) continue;

                startSurf = Math.min(startSurf, surfaceId);
                endSurf = Math.max(endSurf, surfaceId);
            }

            if (!Number.isFinite(startSurf) || !Number.isFinite(endSurf)) return null;
            return { startSurf, endSurf };
        } catch (err) {
            console.error('[PP] Error getting zoom-group surface range:', err);
            return null;
        }
    }

    _getBlockSurfaceIdSet(opticalSystemData: any[], blockLabel: string, configId: any): Set<number> | null {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

            const sys = tryLoadSystemConfigurations();
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];

            let cfg = null;
            if (configId !== undefined && configId !== null) {
                const hint = String(configId).trim();
                cfg = configs.find((c: any) => c && String(c.id) === hint) || null;
            }
            if (!cfg) {
                const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';
                cfg = configs.find((c: any) => c && String(c.id) === activeId) || configs[0] || null;
            }

            const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
            const targetLabel = String(blockLabel ?? '').trim().toUpperCase();
            if (!targetLabel || !Array.isArray(blocks) || blocks.length === 0) return null;

            const matchingBlockIds = new Set<string>();
            for (const block of blocks) {
                const blockId = String(block?.blockId ?? '').trim();
                const name = String(block?.name ?? '').trim();
                const type = String(block?.type ?? '').trim();
                if (!blockId || this._getSurfaceCountFromBlockType(block) <= 0) continue;
                if (
                    blockId.toUpperCase() === targetLabel
                    || name.toUpperCase() === targetLabel
                    || `${type}-${blockId}`.toUpperCase() === targetLabel
                ) {
                    matchingBlockIds.add(blockId);
                }
            }

            if (matchingBlockIds.size === 0) return null;

            const surfaceIds = new Set<number>();
            for (const row of opticalSystemData) {
                if (!row || isGapOpticalRow(row) || isCoordTransOpticalRow(row)) continue;

                const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
                if (objectType === 'object' || objectType === 'image') continue;

                const blockId = String(row._blockId ?? '').trim();
                if (!blockId || !matchingBlockIds.has(blockId)) continue;

                const blockType = String(row._blockType ?? row.blockType ?? '').trim().toLowerCase();
                const surfaceRole = String(row._surfaceRole ?? row.surfaceRole ?? '').trim().toLowerCase();
                if ((blockType === 'paraxial' || blockType === 'thinlens') && surfaceRole === 'back') continue;

                const surfaceId = Number(row.id);
                if (!Number.isFinite(surfaceId)) continue;
                surfaceIds.add(surfaceId);
            }

            return surfaceIds.size > 0 ? surfaceIds : null;
        } catch (err) {
            console.error('[Merit Scope] Error getting block surface ids:', err);
            return null;
        }
    }

    _getZoomGroupSurfaceIdSet(opticalSystemData: any[], zoomGroupLabel: string, configId: any): Set<number> | null {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

            const sys = tryLoadSystemConfigurations();
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];

            let cfg = null;
            if (configId !== undefined && configId !== null) {
                const hint = String(configId).trim();
                cfg = configs.find((c: any) => c && String(c.id) === hint) || null;
            }
            if (!cfg) {
                const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';
                cfg = configs.find((c: any) => c && String(c.id) === activeId) || configs[0] || null;
            }

            const target = String(zoomGroupLabel ?? '').trim().toUpperCase();
            if (!target) return null;

            const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
            if (!Array.isArray(blocks) || blocks.length === 0) return null;

            const zoomGroupBlockIds = new Set<string>();
            for (const block of blocks) {
                const blockParams = (block?.parameters && typeof block.parameters === 'object') ? block.parameters : null;
                const zoomGroup = String(blockParams?.zoomGroup ?? '').trim().toUpperCase();
                const blockId = String(block?.blockId ?? '').trim();
                if (!blockId || !zoomGroup || zoomGroup !== target) continue;
                if (this._getSurfaceCountFromBlockType(block) <= 0) continue;
                zoomGroupBlockIds.add(blockId);
            }

            if (zoomGroupBlockIds.size === 0) return null;

            const surfaceIds = new Set<number>();
            for (const row of opticalSystemData) {
                if (!row || isGapOpticalRow(row) || isCoordTransOpticalRow(row)) continue;

                const objectType = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
                if (objectType === 'object' || objectType === 'image') continue;

                const blockId = String(row._blockId ?? '').trim();
                if (!blockId || !zoomGroupBlockIds.has(blockId)) continue;

                const blockType = String(row._blockType ?? row.blockType ?? '').trim().toLowerCase();
                const surfaceRole = String(row._surfaceRole ?? row.surfaceRole ?? '').trim().toLowerCase();
                if ((blockType === 'paraxial' || blockType === 'thinlens') && surfaceRole === 'back') continue;

                const surfaceId = Number(row.id);
                if (!Number.isFinite(surfaceId)) continue;
                surfaceIds.add(surfaceId);
            }

            return surfaceIds.size > 0 ? surfaceIds : null;
        } catch (err) {
            console.error('[Merit Scope] Error getting zoom-group surface ids:', err);
            return null;
        }
    }

    _calculateEFLForSurfaceRange(opticalSystemData: any[], startSurf: number, endSurf: number, wavelength: number, axis: '' | 'X' | 'Y' = ''): number {
        try {
            const rangeData = this._buildIsolatedSurfaceRangeSystem(opticalSystemData, startSurf, endSurf);
            if (!rangeData) return 0;
            
            // Calculate paraxial trace for this isolated system
            const meridian = getParaxialMeridianFromAxis(axis);
            const eflTrace = calculateFullSystemParaxialTrace(rangeData, wavelength, meridian) as any;
            const efl = (eflTrace && Number.isFinite(eflTrace.finalAlpha) && Math.abs(eflTrace.finalAlpha) > 1e-12)
                ? (1.0 / eflTrace.finalAlpha)
                : 0;
            return this.safeFiniteNumberOrZero(efl);
        } catch (err) {
            console.error('[EFL Range] Error calculating EFL:', err);
            return 0;
        }
    }

    _buildIsolatedSystemFromLensSurfaces(lensSurfaces: any[], label: string): any[] | null {
        if (!Array.isArray(lensSurfaces) || lensSurfaces.length === 0) return null;

        return [
            {
                'object type': 'Object',
                'thickness': Infinity,
                'radius': Infinity,
                'comment': `Virtual Object for ${label}`
            },
            ...lensSurfaces,
            {
                'object type': 'Image',
                'thickness': 0,
                'radius': Infinity,
                'comment': `Virtual Image for ${label}`
            }
        ];
    }

    _buildIsolatedSurfaceRangeSystem(opticalSystemData: any[], startSurf: number, endSurf: number): any[] | null {
        const normalizedRange = this._expandPrincipalPointSurfaceRange(opticalSystemData, startSurf, endSurf);
        if (!normalizedRange) return null;

        return this._buildSubsystemBySurfaceIds(
            opticalSystemData,
            normalizedRange.startSurf,
            normalizedRange.endSurf
        );
    }

    _calculatePrincipalPointsForSurfaceRange(opticalSystemData: any[], startSurf: number, endSurf: number, wavelength: number): any | null {
        try {
            const normalizedRange = this._expandPrincipalPointSurfaceRange(opticalSystemData, startSurf, endSurf);
            if (!normalizedRange) return null;

            const rangeData = this._buildSubsystemBySurfaceIds(
                opticalSystemData,
                normalizedRange.startSurf,
                normalizedRange.endSurf
            );
            if (!rangeData) return null;
            return calculatePrincipalPointPositions(rangeData, wavelength);
        } catch (err) {
            console.error('[PP Range] Error calculating principal points:', err);
            return null;
        }
    }

    _expandPrincipalPointSurfaceRange(opticalSystemData: any[], startSurf: number, endSurf: number): { startSurf: number; endSurf: number } | null {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

        const normalizedStart = Number.isFinite(Number(startSurf)) ? Number(startSurf) : 1;
        let normalizedEnd = Number.isFinite(Number(endSurf)) ? Number(endSurf) : normalizedStart;
        if (normalizedEnd < normalizedStart) return null;

        const endRow = opticalSystemData.find((row) => Number(row?.id) === normalizedEnd);
        const endBlockId = String(endRow?._blockId ?? '').trim();
        const endBlockType = String(endRow?._blockType ?? endRow?.blockType ?? '').trim().toLowerCase();

        if ((endBlockType === 'paraxial' || endBlockType === 'thinlens') && endBlockId) {
            for (const row of opticalSystemData) {
                if (!row || isGapOpticalRow(row) || isCoordTransOpticalRow(row)) continue;

                const blockId = String(row._blockId ?? '').trim();
                if (blockId !== endBlockId) continue;

                const blockType = String(row._blockType ?? row.blockType ?? '').trim().toLowerCase();
                const surfaceRole = String(row._surfaceRole ?? row.surfaceRole ?? '').trim().toLowerCase();
                if ((blockType === 'paraxial' || blockType === 'thinlens') && surfaceRole === 'back') {
                    const backSurfaceId = Number(row.id);
                    if (Number.isFinite(backSurfaceId)) {
                        normalizedEnd = Math.max(normalizedEnd, backSurfaceId);
                    }
                    break;
                }
            }
        }

        return { startSurf: normalizedStart, endSurf: normalizedEnd };
    }

    _buildSubsystemBySurfaceIds(opticalSystemData: any[], startSurf: number, endSurf: number): any[] | null {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;

        const normalizedStart = Number.isFinite(Number(startSurf)) ? Number(startSurf) : 1;
        const normalizedEnd = Number.isFinite(Number(endSurf)) ? Number(endSurf) : (opticalSystemData.length - 2);
        if (normalizedEnd < normalizedStart) return null;

        const subSystemData: any[] = [];
        const objectSurfaceIdNum = Number(opticalSystemData[0]?.id);
        const objectSurfaceId = Number.isFinite(objectSurfaceIdNum) ? objectSurfaceIdNum : 1;

        if (normalizedStart === objectSurfaceId) {
            subSystemData.push(opticalSystemData[0]);
        } else {
            subSystemData.push({
                surface: 0,
                'object type': 'Object',
                thickness: Infinity,
                radius: Infinity,
                comment: 'Virtual Object'
            });
        }

        for (let i = 1; i < opticalSystemData.length - 1; i++) {
            const surface = opticalSystemData[i];
            const surfaceIdNum = Number(surface?.id);
            if (!Number.isFinite(surfaceIdNum)) continue;
            if (surfaceIdNum >= normalizedStart && surfaceIdNum <= normalizedEnd) {
                subSystemData.push({ ...surface, id: surfaceIdNum });
            }
        }

        if (subSystemData.length <= 1) return null;

        subSystemData.push({
            surface: subSystemData.length,
            'object type': 'Image',
            thickness: 0,
            radius: Infinity,
            comment: 'Image'
        });

        return subSystemData;
    }

    calculatePrincipalPointMetric(operand: any, opticalSystemData: any[], metricKey: 'PP1' | 'PP2'): number {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length < 3) return 0;

            const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
            const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
            const modeRaw = String(operand?.param4 ?? '').trim().toUpperCase();
            const param2Raw = String(operand?.param2 ?? '').trim();

            let startSurf = parseInt(operand?.param2, 10) || 1;
            let endSurf = parseInt(operand?.param3, 10) || (opticalSystemData.length - 2);

            const wantsZoomGroup = modeRaw === 'ZG' || (!!param2Raw && !Number.isFinite(Number(param2Raw)));
            if (wantsZoomGroup) {
                const range = this._getZoomGroupSurfaceRange(opticalSystemData, param2Raw, operand?.configId);
                if (!range) {
                    console.warn(`[PP] Could not find zoom group "${param2Raw}"`);
                    return 0;
                }
                startSurf = range.startSurf;
                endSurf = range.endSurf;
            }

            const principalPoints = this._calculatePrincipalPointsForSurfaceRange(
                opticalSystemData,
                startSurf,
                endSurf,
                wavelength
            );

            if (!principalPoints) return 0;

            const value = metricKey === 'PP1'
                ? principalPoints.frontPrincipalFromFirstSurfaceMm
                : principalPoints.rearPrincipalFromLastSurfaceMm;
            return this.safeFiniteNumberOrZero(value);
        } catch (err) {
            console.error(`[PP] Error calculating ${metricKey}:`, err);
            return 0;
        }
    }

    _convertLabelToBlockId(label: string, configId: any): string {
        try {
            // Get blocks from config
            const sys = tryLoadSystemConfigurations();
            
            const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
            const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';
            
            const hint = (configId === undefined || configId === null) ? '' : String(configId).trim();
            let cfg = null;
            if (hint) {
                cfg = configs.find((c: any) => c && String(c.id) === hint) || null;
            }
            if (!cfg && activeId) {
                cfg = configs.find((c: any) => c && String(c.id) === activeId) || null;
            }
            if (!cfg) cfg = configs[0] || null;
            
            const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
            
            // Try to find block by label
            const labelUpper = label.toUpperCase();
            for (const block of blocks) {
                const blockId = String(block?.blockId || '').trim();
                const name = String(block?.name || '').trim();
                const type = String(block?.type || '').trim();
                
                // Check various possible label formats
                if (blockId.toUpperCase() === labelUpper) return blockId;
                if (name.toUpperCase() === labelUpper) return blockId;
                if (`${type}-${blockId}`.toUpperCase() === labelUpper) return blockId;
            }
            
            // If not found, return the original label (might already be a blockId)
            console.warn(`[EFL] Could not find blockId for label "${label}"`);
            return label;
        } catch (err) {
            console.error('[EFL] Error converting label to blockId:', err);
            return label;
        }
    }

    _filterOpticalDataByBlockIds(opticalSystemData: any[], param2Raw: string): any[] {
        console.log('[EFL Filter] ========================================');
        console.log('[EFL Filter] _filterOpticalDataByBlockIds called!');
        console.log('[EFL Filter] param2Raw:', param2Raw);
        console.log('[EFL Filter] opticalSystemData.length:', opticalSystemData?.length);
        console.log('[EFL Filter] ========================================');
        
        try {
            // First, log the structure of first few surfaces to understand the data
            console.log('[EFL Filter] ========== Optical System Structure ==========');
            for (let i = 0; i < Math.min(3, opticalSystemData.length); i++) {
                const row = opticalSystemData[i];
                const keys = Object.keys(row || {});
                console.log(`[EFL Filter] Surface ${i} - All keys:`, keys);
                console.log(`[EFL Filter] Surface ${i} - Sample values:`, {
                    type: row?.type,
                    surfaceType: row?.surfaceType,
                    blockId: row?.blockId,
                    block: row?.block,
                    comment: row?.comment,
                    radius: row?.radius
                });
            }
            console.log('[EFL Filter] ===================================================');
            
            // Parse comma-separated block IDs (case-insensitive)
            const blockIds = param2Raw.split(',')
                .map(s => s.trim().toUpperCase())
                .filter(s => s.length > 0);
            
            if (blockIds.length === 0) return opticalSystemData;

            console.log(`[EFL Filter] Looking for blocks: ${blockIds.join(', ')}`);

            // Find all surfaces that belong to the specified blocks
            const filtered: any[] = [];
            
            // Always include Object surface (first surface)
            if (opticalSystemData.length > 0) {
                filtered.push({ ...opticalSystemData[0] });
            }

            for (let i = 1; i < opticalSystemData.length; i++) {
                const row = opticalSystemData[i];
                const blockId = row?.blockId ? String(row.blockId).trim().toUpperCase() : '';
                
                // Log every surface
                if (i <= 10) {  // Log first 10 surfaces in detail
                    console.log(`[EFL Filter] Surface ${i}: type=${row?.type}, blockId="${blockId}"`);
                }

                // Include surfaces that belong to specified blocks
                if (blockId && blockIds.includes(blockId)) {
                    filtered.push({ ...row });
                    console.log(`[EFL Filter] ✅ Included surface ${i} (blockId=${blockId})`);
                }
                // Also include Image surface
                else if (row?.type === 'Image' || i === opticalSystemData.length - 1) {
                    filtered.push({ ...row });
                    console.log(`[EFL Filter] ✅ Included Image surface ${i}`);
                }
            }

            console.log(`[EFL Filter] Result: ${filtered.length} surfaces from ${opticalSystemData.length} total`);
            console.log(`[EFL Filter] Filtered surfaces:`, filtered.map((r, i) => `${i}:${r?.type || 'unknown'}`).join(', '));
            
            // Need at least Object and Image surfaces
            if (filtered.length < 2) {
                console.warn(`[EFL Filter] Too few surfaces (${filtered.length}), using full system`);
                return opticalSystemData;
            }

            return filtered;
        } catch (err) {
            console.error('[EFL Filter] Error filtering optical data:', err);
            return opticalSystemData;
        }
    }

    calculateSeidelTotal(operand: any, opticalSystemData: any[], totalKey: string): number {
        if (!opticalSystemData || opticalSystemData.length < 2) return 0;

        const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

        const modeRaw = (operand?.param2 !== undefined && operand?.param2 !== null) ? String(operand.param2).trim() : '';
        const mode = modeRaw === '1' ? 1 : 0;
        const isAfocal = mode === 1;
        return this._calculateSeidelTotalSingleMode(
            operand, opticalSystemData, totalKey, sourceRows, objectRows, isAfocal
        );
    }

    _calculateSeidelTotalSingleMode(operand: any, opticalSystemData: any[], totalKey: string, sourceRows: any[], objectRows: any[], isAfocal: boolean): number {
        const scope = this.resolveMeritScopeSelection(operand?.param3, opticalSystemData, operand?.configId);
        const s1 = scope.kind === 'surface' ? scope.surface : 0;
        const selectedSurfaceIds = scope.kind === 'block'
            ? this._getBlockSurfaceIdSet(opticalSystemData, scope.value, operand?.configId)
            : scope.kind === 'zoom'
                ? this._getZoomGroupSurfaceIdSet(opticalSystemData, scope.value, operand?.configId)
                : null;

        const refFLRaw = (operand && operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
        const refFLNum = (refFLRaw === '') ? 0 : Number(refFLRaw);
        const referenceFocalLengthAfocal = (Number.isFinite(refFLNum) && refFLNum !== 0) ? refFLNum : undefined;
        const referenceFocalLengthOverrideImaging = (Number.isFinite(refFLNum) && refFLNum !== 0) ? refFLNum : 0;

        const primaryWavelength = this.getPrimaryWavelengthFromSourceRows(sourceRows);

        const param1Raw = (operand && operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        const selectedWavelength = (param1Raw === '')
            ? primaryWavelength
            : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const baseWavelength = (totalKey === 'LCA' || totalKey === 'TCA') ? primaryWavelength : selectedWavelength;
        const scopedOpticalSystemData = opticalSystemData;

        const cfgKey = operand.configId ? String(operand.configId) : 'active';
        const scopeKey = scope.kind === 'surface'
            ? `surface:${s1}`
            : scope.kind === 'block'
                ? `block:${scope.value}`
                : scope.kind === 'zoom'
                    ? `zoom:${scope.value}`
                    : 'total';
        const cacheKey = `seidel:${cfgKey}:mode=${isAfocal ? 'afocal' : 'imaging'}:wl=${baseWavelength}:scope=${scopeKey}:refFL=${(isAfocal ? (referenceFocalLengthAfocal ?? 'auto') : (referenceFocalLengthOverrideImaging === 0 ? 'auto' : referenceFocalLengthOverrideImaging))}:key=${totalKey}`;
        if (this._runtimeCache && this._runtimeCache.has(cacheKey)) {
            return this._runtimeCache.get(cacheKey);
        }

        try {
            let seidel: any;

            if (isAfocal) {
                let stopIndex = scopedOpticalSystemData.findIndex((row: any) => row && (row['object type'] === 'Stop' || row.object === 'Stop'));
                if (stopIndex === -1) {
                    const fallback = findStopSurfaceIndex ? findStopSurfaceIndex(scopedOpticalSystemData) : -1;
                    stopIndex = (fallback >= 0) ? fallback : 1;
                }

                seidel = calculateAfocalSeidelCoefficientsIntegrated(
                    scopedOpticalSystemData,
                    baseWavelength,
                    stopIndex,
                    objectRows,
                    referenceFocalLengthAfocal ?? 100
                );
            } else {
                seidel = calculateSeidelCoefficients(
                    scopedOpticalSystemData,
                    baseWavelength,
                    objectRows as any,
                    { referenceFocalLengthOverride: referenceFocalLengthOverrideImaging }
                );
            }

            let v = NaN;
            if (scope.kind === 'total') {
                v = seidel?.totals ? Number(seidel.totals[totalKey]) : NaN;
            } else {
                const coeffs = seidel?.surfaceCoefficients;
                if (scope.kind === 'surface') {
                    const c = Array.isArray(coeffs)
                        ? (
                            coeffs.find((sc: any) => sc && Number(scopedOpticalSystemData?.[Number(sc.surfaceIndex)]?.id) === Number(s1))
                            || coeffs.find((sc: any) => sc && Number(sc.surfaceIndex) === Number(s1))
                        )
                        : null;
                    v = c ? Number(c[totalKey]) : NaN;
                } else if ((scope.kind === 'block' || scope.kind === 'zoom') && Array.isArray(coeffs) && selectedSurfaceIds && selectedSurfaceIds.size > 0) {
                    let sum = 0;
                    let matched = false;
                    for (const coeff of coeffs) {
                        if (!coeff) continue;
                        const surfaceIndex = Number(coeff.surfaceIndex);
                        const surfaceId = Number(scopedOpticalSystemData?.[surfaceIndex]?.id);
                        const isSelected = (Number.isFinite(surfaceId) && selectedSurfaceIds.has(surfaceId))
                            || (Number.isFinite(surfaceIndex) && selectedSurfaceIds.has(surfaceIndex));
                        if (!isSelected) continue;
                        const value = Number(coeff[totalKey]);
                        if (!Number.isFinite(value)) continue;
                        sum += value;
                        matched = true;
                    }
                    v = matched ? sum : NaN;
                }
            }

            const value = Number.isFinite(v) ? v : 0;

            if (this._runtimeCache) this._runtimeCache.set(cacheKey, value);
            return value;
        } catch (e) {
            console.warn('⚠️ Seidel total evaluation failed:', e);
            if (this._runtimeCache) this._runtimeCache.set(cacheKey, 0);
            return 0;
        }
    }

    getOpticalSystemDataByConfigId(configId: any): any[] {
        try {
            // Prefer cache for NON-active configs when it's valid.
            // This aligns Requirements (spot size, etc) with the same expanded rows used by Analysis.
            // We still avoid cache for the active config during switching to prevent mid-update reads.
            // IMPORTANT: During optimization, always bypass cache so every config reflects the current
            // block state mutated by the optimizer (non-active configs otherwise return stale rows).
            const useCache = (() => {
                try {
                    if (typeof globalThis === 'undefined') return true;
                    const isOptimizerRunning = !!w.__cooptOptimizerIsRunning;
                    if (isOptimizerRunning) {
                        return false;
                    }
                    const isEvaluatingRequirements = !!w.__COOPT_EVALUATING_REQUIREMENTS;
                    if (isEvaluatingRequirements) {
                        return false;
                    }
                } catch (_) {}
                return true;
            })();
            
            if (useCache) {
                try {
                    if (typeof window !== 'undefined' && w.__cooptOpticalSystemByConfigId) {
                        const cfgId = (configId !== undefined && configId !== null) ? String(configId).trim() : '';
                        if (cfgId) {
                            const cached = w.__cooptOpticalSystemByConfigId[cfgId];
                            // Validate cache: must have reasonable surface count and a usable object thickness.
                            if (Array.isArray(cached) && cached.length >= 5) {
                                const t0 = cached[0]?.thickness;
                                const ts = (t0 === undefined || t0 === null) ? '' : String(t0).trim().toUpperCase();
                                // Accept finite thickness or explicit INF (both are meaningful).
                                if (t0 === Infinity || ts === 'INF' || ts === 'INFINITY' || ts !== '') {
                                    return cached;
                                }
                            }
                        }
                    }
                } catch (_) {}
            }

            let systemConfig: any = null;
            let memSystemConfig: any = null;
            let lsSystemConfig: any = null;
            try {
                if (typeof window !== 'undefined' && w.__cooptSystemConfig) {
                    memSystemConfig = w.__cooptSystemConfig;
                }
            } catch (_) {}
            try {
                lsSystemConfig = tryLoadSystemConfigurations();
            } catch (_) {}

            if (memSystemConfig && lsSystemConfig) {
                const memActive = (memSystemConfig.activeConfigId !== undefined && memSystemConfig.activeConfigId !== null)
                    ? String(memSystemConfig.activeConfigId)
                    : '';
                const lsActive = (lsSystemConfig.activeConfigId !== undefined && lsSystemConfig.activeConfigId !== null)
                    ? String(lsSystemConfig.activeConfigId)
                    : '';
                systemConfig = (memActive && lsActive && memActive !== lsActive) ? lsSystemConfig : memSystemConfig;
            } else {
                systemConfig = memSystemConfig || lsSystemConfig;
            }

            const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                ? String(systemConfig.activeConfigId)
                : '';

            const wantsCurrent = (configId === undefined || configId === null || String(configId).trim() === '');
            const targetConfigId = wantsCurrent ? activeConfigId : configId;

            const targetIdStr = (targetConfigId !== undefined && targetConfigId !== null) ? String(targetConfigId) : '';
            const runtimeCacheKey = `optical-system-data:${targetIdStr || activeConfigId || 'active'}`;

            if (this._runtimeCache && this._runtimeCache.has(runtimeCacheKey)) {
                const cachedRows = this._runtimeCache.get(runtimeCacheKey);
                if (Array.isArray(cachedRows)) {
                    return cachedRows;
                }
            }

            const config = systemConfig?.configurations?.find((c: any) => String(c.id) === String(targetIdStr));

            const isActiveConfig = activeConfigId && targetIdStr && targetIdStr === activeConfigId;

            const isConfigSwitching = (() => {
                try {
                    return typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
                } catch {
                    return false;
                }
            })();

            if ((isActiveConfig || wantsCurrent) && !isConfigSwitching) {
                const hasBlocksForActive = Array.isArray(config?.blocks);
                if (!hasBlocksForActive) {
                    const rows = getOpticalSystemRows({});
                    if (this._runtimeCache && Array.isArray(rows)) this._runtimeCache.set(runtimeCacheKey, rows);
                    return rows;
                }
            }

            // If we are switching configs, avoid reading the UI tables even for the active config.
            // Use the persisted config rows (or blocks expansion) for a consistent snapshot.
            if ((isActiveConfig || wantsCurrent) && isConfigSwitching && config) {
                const hasBlocksForActive = Array.isArray(config?.blocks) && config.blocks.length > 0;
                if (!hasBlocksForActive) {
                    const persisted = Array.isArray(config.opticalSystem) ? config.opticalSystem : null;
                    if (persisted && persisted.length > 0) {
                        if (this._runtimeCache) this._runtimeCache.set(runtimeCacheKey, persisted);
                        return persisted;
                    }
                }
            }

            if (!config) {
                console.warn(`Config ID ${targetIdStr} が見つかりません。現在のテーブルデータを使用します。`);
                const rows = getOpticalSystemRows({});
                if (this._runtimeCache && Array.isArray(rows)) this._runtimeCache.set(runtimeCacheKey, rows);
                return rows;
            }

            let overrideBlocks: any = null;
            try {
                const ov = (typeof window !== 'undefined') ? w.__cooptBlocksOverride : null;
                if (ov && typeof ov === 'object') {
                    const key = String(targetConfigId);
                    const b = ov[key];
                    if (Array.isArray(b)) overrideBlocks = b;
                }
            } catch (_) {}

            const hasBlocks = Array.isArray(overrideBlocks || config.blocks);
            const scenarios = Array.isArray(config.scenarios) ? config.scenarios : null;

            let scenarioId: any = null;
            try {
                const ov = (typeof window !== 'undefined') ? w.__cooptScenarioOverride : null;
                if (ov && typeof ov === 'object') {
                    const key = String(targetConfigId);
                    if (ov[key]) scenarioId = String(ov[key]);
                }
            } catch (_) {}

            if (!scenarioId && config.activeScenarioId) {
                scenarioId = String(config.activeScenarioId);
            }

            if (hasBlocks) {
                let blocksToExpand = overrideBlocks || config.blocks;

                if (scenarioId && scenarios) {
                    const scn = scenarios.find((s: any) => s && String(s.id) === String(scenarioId));
                    const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : null;
                    blocksToExpand = applyOverridesToBlocks(blocksToExpand, overrides);
                }

                const expanded = expandBlocksToOpticalSystemRows(blocksToExpand);
                if (expanded && Array.isArray(expanded.rows)) {
                    try {
                        const rows = expanded.rows;
                        if (rows.length > 0) {
                            const hasObjectSurface = Array.isArray(config?.blocks) && config.blocks.some((b: any) => {
                                const bt = String(b?.blockType ?? '').trim();
                                return bt === 'ObjectSurface' || bt === 'ObjectPlane';
                            });
                            if (hasObjectSurface) {
                                return expanded.rows;
                            }

                            let preferredThickness: any = undefined;

                            const persistedThickness = config?.opticalSystem?.[0]?.thickness;
                            if (persistedThickness !== undefined && persistedThickness !== null && String(persistedThickness).trim() !== '') {
                                preferredThickness = persistedThickness;
                            } else if (systemConfig && String(systemConfig.activeConfigId) === String(targetConfigId)) {
                                const tableRows = (() => {
                                    try {
                                        const rows = tryLoadPersistedOpticalSystemTableData();
                                        return Array.isArray(rows) ? rows : null;
                                    } catch {
                                        return null;
                                    }
                                })();
                                const tableThickness = tableRows?.[0]?.thickness;
                                if (tableThickness !== undefined && tableThickness !== null && String(tableThickness).trim() !== '') {
                                    preferredThickness = tableThickness;
                                }
                            }

                            if (preferredThickness !== undefined) {
                                rows[0] = { ...rows[0], thickness: preferredThickness };
                            }
                        }
                    } catch (e) {
                        console.warn('⚠️ Failed to preserve Object thickness for merit evaluation:', e);
                    }

                    try {
                        const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && w.__RAYTRACE_DEBUG);
                        if (RAYTRACE_DEBUG) {
                            console.log(`📊 Config "${config.name}" (ID: ${targetIdStr}) blocks expanded${scenarioId ? ` (scenario: ${scenarioId})` : ''}`);
                        }
                    } catch (_) {}
                    if (this._runtimeCache) this._runtimeCache.set(runtimeCacheKey, expanded.rows);
                    return expanded.rows;
                }
            }

            console.log(`📊 Config "${config.name}" (ID: ${targetIdStr}) の光学系データを使用`);
            const rows = config.opticalSystem || [];
            if (this._runtimeCache && Array.isArray(rows)) this._runtimeCache.set(runtimeCacheKey, rows);
            return rows;

        } catch (error) {
            console.error('光学系データ取得エラー:', error);
            return getOpticalSystemRows({});
        }
    }

    calculateEFFL(operand: any, opticalSystemData: any[]): number {
        if (!opticalSystemData || opticalSystemData.length === 0) {
            console.warn('EFFL計算: 光学系データがありません');
            return 0;
        }

        const startSurf = parseInt(operand.param2) || 1;
        const endSurf = parseInt(operand.param3) || (opticalSystemData.length - 2);

        const sourceRows = this.getConfigTablesByConfigId(operand.configId).source;
        const param1Raw = (operand && operand.param1 !== undefined && operand.param1 !== null)
            ? String(operand.param1).trim()
            : '';
        const wavelength = (param1Raw === '')
            ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
            : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const subSystemData = this._buildSubsystemBySurfaceIds(opticalSystemData, startSurf, endSurf);
        if (!subSystemData) {
            console.warn(`❌ EFFL計算失敗: 面${startSurf}〜${endSurf}, subsystem build failed`);
            return 0;
        }

        const paraxialResult = calculateFullSystemParaxialTrace(subSystemData, wavelength) as any;

        if (!paraxialResult || Math.abs(paraxialResult.finalAlpha) < 1e-10) {
            console.warn(`❌ EFFL計算失敗: 面${startSurf}〜${endSurf}, 波長${wavelength}μm`);
            return 0;
        }

        const efl = 1.0 / paraxialResult.finalAlpha;
        return efl;
    }

    getData(): any[] {
        return this.operands;
    }

    updateParameterHeaders(rowData: any): void {
        const operand = rowData.operand;
        const definition = OPERAND_DEFINITIONS[operand];

        console.log('🔄 Updating parameter headers for operand:', operand, definition);

        if (!operand || !definition || !definition.parameters) {
            const paramFields = ['param1', 'param2', 'param3', 'param4'];
            paramFields.forEach((field: string) => {
                const column = this.table.getColumn(field);
                if (column) {
                    const headerElement = column.getElement().querySelector('.tabulator-col-title');
                    if (headerElement) {
                        headerElement.textContent = '-';
                        console.log(`  ✓ Set ${field} header to: -`);
                    }
                }
            });
            return;
        }

        const paramFields = ['param1', 'param2', 'param3', 'param4'];

        paramFields.forEach((field: string) => {
            const column = this.table.getColumn(field);
            if (!column) return;

            const headerElement = column.getElement().querySelector('.tabulator-col-title');
            if (!headerElement) return;

            const paramDef = Array.isArray(definition.parameters)
                ? definition.parameters.find((p: any) => p && p.key === field)
                : null;

            if (paramDef && paramDef.label) {
                headerElement.textContent = paramDef.label;
                console.log(`  ✓ Set ${field} header to: ${paramDef.label}`);
            } else {
                headerElement.textContent = '-';
                console.log(`  ✓ Set ${field} header to: -`);
            }
        });
    }

    resetParameterHeaders(): void {
        const defaultTitles: Record<string, string> = {
            param1: '-',
            param2: '-',
            param3: '-',
            param4: '-'
        };

        Object.entries(defaultTitles).forEach(([field, title]: [string, string]) => {
            const column = this.table.getColumn(field);
            if (column) {
                const headerElement = column.getElement().querySelector('.tabulator-col-title');
                if (headerElement) {
                    headerElement.textContent = title;
                }
            }
        });
    }

    setData(data: any[]): void {
        if (!Array.isArray(data)) {
            console.warn('Merit Function setData: 無効なデータ形式');
            return;
        }

        const { operands, droppedInvalidEffl } = this.normalizeMeritOperands(data);
        this.operands = operands;
        this.updateRowNumbers();

        if (droppedInvalidEffl.length > 0) {
            console.warn('⚠️ Merit Function: dropped invalid EFFL operands that reference non-existent surfaces:', droppedInvalidEffl.map((operand: any) => ({
                id: operand?.id,
                configId: operand?.configId,
                range: `${operand?.param2}-${operand?.param3}`
            })));
        }

        if (this.table) {
            this.table.setData(this.operands);
        }
    }

    loadFromStorage(): void {
        try {
            const data = loadMeritFunctionTableData();
            if (Array.isArray(data) && data.length > 0) {
                const { operands, droppedInvalidEffl } = this.normalizeMeritOperands(data);
                this.operands = operands;
                if (droppedInvalidEffl.length > 0) {
                    console.warn('⚠️ Merit Function: removed invalid EFFL operands from storage:', droppedInvalidEffl.map((operand: any) => ({
                        id: operand?.id,
                        configId: operand?.configId,
                        range: `${operand?.param2}-${operand?.param3}`
                    })));
                    saveMeritFunctionTableData(this.operands as any);
                }
            }
        } catch (error) {
            console.error('❌ Merit Function ローカルストレージ読み込みエラー:', error);
        }
    }

    saveToStorage(): void {
        try {
            saveMeritFunctionTableData(this.operands as any);
            console.log('✅ Merit Function データをローカルストレージに保存しました:', this.operands.length, '件');
        } catch (error) {
            console.error('❌ Merit Function ローカルストレージ保存エラー:', error);
        }
    }

    getConfigurationList(): Record<string, string> {
        try {
            const systemConfig = tryLoadSystemConfigurations();
            if (!systemConfig || !systemConfig.configurations) {
                console.log('📋 Configuration リスト: デフォルト (Current のみ)');
                return { "": 'Current' };
            }

            const activeConfig = systemConfig.configurations.find((c: any) => c.id === systemConfig.activeConfigId);
            const activeConfigName = activeConfig ? activeConfig.name : '';

            const configList: Record<string, string> = { "": `Current (${activeConfigName})` };
            systemConfig.configurations.forEach((config: any) => {
                configList[String(config.id)] = config.name;
            });

            console.log('📋 Configuration リスト:', configList);
            return configList;
        } catch (error) {
            console.error('Configuration リスト取得エラー:', error);
            return { "": 'Current' };
        }
    }

    getBlockAndZoomGroupOptions(configId: any): Record<string, string> {
        try {
            const systemConfig = tryLoadSystemConfigurations();
            const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];

            let config = null;
            if (configId !== undefined && configId !== null && String(configId).trim() !== '') {
                const configIdStr = String(configId).trim();
                config = configs.find((item: any) => item && String(item.id) === configIdStr) || null;
            }
            if (!config) {
                const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                    ? String(systemConfig.activeConfigId)
                    : '';
                config = configs.find((item: any) => item && String(item.id) === activeConfigId) || configs[0] || null;
            }

            const blocks = Array.isArray(config?.blocks) ? config.blocks : [];
            const options: Record<string, string> = {};
            const zoomGroups = new Set<string>();

            for (const block of blocks) {
                if (this._getSurfaceCountFromBlockType(block) <= 0) continue;

                const blockId = String(block?.blockId ?? '').trim();
                const blockName = String(block?.name ?? '').trim();
                if (blockId) {
                    options[`BLK:${blockId}`] = blockName ? `${blockId} (${blockName})` : `${blockId} (Block)`;
                }

                const zoomGroup = String(block?.parameters?.zoomGroup ?? '').trim().toUpperCase();
                if (zoomGroup) zoomGroups.add(zoomGroup);
            }

            for (const zoomGroup of zoomGroups) {
                options[`ZG:${zoomGroup}`] = `${zoomGroup} (Zoom Group)`;
            }

            return options;
        } catch (error) {
            console.warn('[Merit Scope] Failed to build block/zoom options:', error);
            return {};
        }
    }

    getMeritScopeOptions(rowData: any): Record<string, string> {
        const options: Record<string, string> = { '0': '0 (Total)' };

        try {
            const opticalSystemData = this.getOpticalSystemDataByConfigId(rowData?.configId);
            if (Array.isArray(opticalSystemData) && opticalSystemData.length > 0) {
                for (let i = 1; i < opticalSystemData.length; i++) {
                    const row = opticalSystemData[i];
                    const surfaceId = Number(row?.id);
                    if (!Number.isFinite(surfaceId)) continue;

                    const objectType = String(row?.['object type'] ?? row?.objectType ?? row?.object ?? '').trim();
                    const comment = String(row?.comment ?? '').trim();
                    const suffix = objectType ? ` ${objectType}` : (comment ? ` ${comment}` : '');
                    options[String(surfaceId)] = `${surfaceId} (Surface ${surfaceId}${suffix ? `: ${suffix}` : ''})`;
                }
            }
        } catch (error) {
            console.warn('[Merit Scope] Failed to build surface options:', error);
        }

        Object.assign(options, this.getBlockAndZoomGroupOptions(rowData?.configId));
        return options;
    }

    formatMeritScopeValue(rowData: any, value: any): string {
        const raw = String(value ?? '0').trim();
        const options = this.getMeritScopeOptions(rowData);
        return options[raw] || raw || '0 (Total)';
    }

    resolveMeritScopeSelection(rawValue: any, opticalSystemData: any[], configId: any): any {
        const value = String(rawValue ?? '0').trim();
        if (!value || value === '0' || value.toUpperCase() === 'ALL') {
            return { kind: 'total', value: '0' };
        }

        if (/^\d+$/.test(value)) {
            return { kind: 'surface', value, surface: Math.max(0, Math.floor(Number(value))) };
        }

        if (value.toUpperCase().startsWith('BLK:')) {
            const blockValue = value.slice(4).trim();
            const range = this._getBlockSurfaceRange(blockValue, configId);
            if (range) return { kind: 'block', value: blockValue, ...range };
        }

        if (value.toUpperCase().startsWith('ZG:')) {
            const zoomValue = value.slice(3).trim().toUpperCase();
            const range = this._getZoomGroupSurfaceRange(opticalSystemData, zoomValue, configId);
            if (range) return { kind: 'zoom', value: zoomValue, ...range };
        }

        const blockRange = this._getBlockSurfaceRange(value, configId);
        if (blockRange) {
            return { kind: 'block', value, ...blockRange };
        }

        const zoomRange = this._getZoomGroupSurfaceRange(opticalSystemData, value, configId);
        if (zoomRange) {
            return { kind: 'zoom', value: value.toUpperCase(), ...zoomRange };
        }

        return { kind: 'total', value: '0' };
    }

    getSurfaceList(rowData: any): any {
        const operandType = rowData?.operand || '';
        const isSpotSizeOperand = operandType.startsWith('SPOT_SIZE');
        
        if (!isSpotSizeOperand) {
            return {};
        }

        try {
            const opticalSystemData = this.getOpticalSystemDataByConfigId(rowData?.configId);
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                return { '': '(Image)' };
            }

            const surfaceList: any = { '': '(Image)' };
            
            for (let i = 0; i < opticalSystemData.length; i++) {
                const row = opticalSystemData[i];
                if (!row) continue;
                
                const surfaceNumber = i;
                const objectType = String(row['object type'] || row.objectType || row.object || '').trim();
                const comment = String(row.comment || '').trim();
                
                let label = `S${surfaceNumber}`;
                if (objectType) {
                    label += ` (${objectType})`;
                } else if (comment) {
                    label += ` (${comment})`
                }
                
                surfaceList[String(surfaceNumber + 1)] = label;
            }
            
            return surfaceList;
        } catch (err) {
            console.warn('Surface list generation error:', err);
            return { '': '(Image)' };
        }
    }

    getConfigName(configId: any): string {
        if (!configId && configId !== 0) {
            try {
                const systemConfig = tryLoadSystemConfigurations();
                if (systemConfig && systemConfig.configurations) {
                    const activeConfig = systemConfig.configurations.find((c: any) => c.id === systemConfig.activeConfigId);
                    if (activeConfig) {
                        return `Current (${activeConfig.name})`;
                    }
                }
            } catch (e) {
                console.warn('Active config名取得エラー:', e);
            }
            return 'Current';
        }

        try {
            const systemConfig = tryLoadSystemConfigurations();
            if (!systemConfig || !systemConfig.configurations) {
                return 'Current';
            }

            const config = systemConfig.configurations.find((c: any) => String(c.id) === String(configId));
            return config ? config.name : 'Current';
        } catch (error) {
            console.error('Config 名取得エラー:', error);
            return 'Current';
        }
    }
}

const __cooptInitMeritFunctionEditor = (): boolean => {
    try {
        if (typeof window === 'undefined') return false;

        const container = document.getElementById('table-merit-function');
        if (w.meritFunctionEditor) {
            if (container) {
                // Re-initialize the table for React remount / delayed container mount.
                w.meritFunctionEditor.table = null;
                w.meritFunctionEditor.initializeTable();
            }
            w.meritFunctionEditor.initializeEventListeners();
            return true;
        }
        
        w.meritFunctionEditor = new MeritFunctionEditor();

        try {
            if (!w.__cooptLastSpotSizeDebug) {
                w.__cooptLastSpotSizeDebug = {
                    ok: false,
                    reason: 'not-evaluated',
                    targetSurfaceIndex: null,
                    rayCountRequested: null,
                    rayStartsGenerated: null,
                    legacyFallbackHits: null,
                    wavelength: null,
                    fastModeEnabled: null,
                    lastRayTraceFailure: null
                };
            }
        } catch (_) {}
        return true;
    } catch (error) {
        console.error('❌ Merit Function Editor初期化エラー:', error);
        return false;
    }
};

// Expose initializer for React fallback (GitHub Pages can miss auto-init timing).
try {
    if (typeof window !== 'undefined') {
        (window as any).__cooptInitMeritFunctionEditor = __cooptInitMeritFunctionEditor;
    }
} catch (_) {}

const __cooptScheduleMeritFunctionInit = (): void => {
    if (__cooptInitMeritFunctionEditor()) return;

    if (typeof window !== 'undefined') {
        if (w.__cooptReactMounted) {
            setTimeout(() => __cooptInitMeritFunctionEditor(), 50);
        } else {
            window.addEventListener('coopt:react-mounted', () => {
                setTimeout(() => __cooptInitMeritFunctionEditor(), 100);
            }, { once: true });
        }

        let retryCount = 0;
        const maxRetries = 20;
        const retryInterval = setInterval(() => {
            retryCount++;
            if (__cooptInitMeritFunctionEditor() || retryCount >= maxRetries) {
                clearInterval(retryInterval);
            }
        }, 100);
    }
};

if (typeof document !== 'undefined' && document?.addEventListener) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            __cooptScheduleMeritFunctionInit();
        });
    } else {
        __cooptScheduleMeritFunctionInit();
    }
}

export { MeritFunctionEditor, OPERAND_DEFINITIONS };

try {
    if (typeof globalThis !== 'undefined') {
        w.__cooptSummarizeSpotSizeDebug = function __cooptSummarizeSpotSizeDebug() {
            const byId = w.__cooptSpotSizeDebugByReqRowId;
            if (!byId || typeof byId !== 'object') return {};
            const out: any = {};
            for (const [k, v] of Object.entries(byId)) {
                if (!v || typeof v !== 'object') continue;
                out[k] = {
                    ok: (v as any).ok,
                    reason: (v as any).reason,
                    configId: (v as any).configId,
                    reqRowIndex: (v as any).reqRowIndex,
                    reqOp: (v as any).reqOp,
                    objectIndex0: (v as any).objectIndex0,
                    hits: (v as any).hits,
                    resultUm: (v as any).resultUm,
                    spotDiagFailureAnySummary: (v as any).spotDiagFailureAnySummary,
                    targetSurfaceIndex: (v as any).targetSurfaceIndex,
                    uiSurfaceIdUsed: (v as any).uiSurfaceIdUsed,
                    uiSurfaceIndexResolved: (v as any).uiSurfaceIndexResolved,
                    imageSurfaceIndex: (v as any).imageSurfaceIndex,
                    opticalSystemSurfaceCount: (v as any).opticalSystemSurfaceCount,
                    targetRowObjectType: (v as any).targetRowObjectType,
                    targetRowSurfType: (v as any).targetRowSurfType,
                    settingsSurfaceIdUsed: (v as any).settingsSurfaceIdUsed,
                    settingsRowIndexUsed: (v as any).settingsRowIndexUsed,
                    objectRowKeys: (v as any).objectRowKeys,
                    objectRowSummary: (v as any).objectRowSummary,
                    error: (v as any).error
                };
            }
            return out;
        };

        w.__cooptPrintSpotSizeDebugTable = function __cooptPrintSpotSizeDebugTable() {
            const o = w.__cooptSummarizeSpotSizeDebug ? w.__cooptSummarizeSpotSizeDebug() : {};
            const rows = Object.entries(o).map(([reqRowId, v]: [string, any]) => ({
                reqRowId,
                ok: v.ok,
                reason: v.reason,
                configId: v.configId,
                reqRowIndex: v.reqRowIndex,
                objectIndex0: v.objectIndex0,
                hits: v.hits,
                resultUm: v.resultUm,
                targetSurfaceIndex: v.targetSurfaceIndex,
                uiSurfaceIdUsed: v.uiSurfaceIdUsed,
                opticalSystemSurfaceCount: v.opticalSystemSurfaceCount,
                targetRowObjectType: v.targetRowObjectType,
                targetRowSurfType: v.targetRowSurfType,
                objectKeysN: Array.isArray(v.objectRowKeys) ? v.objectRowKeys.length : null,
                objectSummary: v.objectRowSummary,
                error: v.error
            }));
            try { console.table(rows); } catch (_) { /* ignore */ }
            return rows;
        };
    }
} catch (_) {}
