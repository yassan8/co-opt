// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

// merit-function-editor.ts
import { OPERAND_DEFINITIONS, InspectorManager } from './merit-function-inspector.js';
import {
    calculateFullSystemParaxialTrace,
    calculateParaxialData,
    findStopSurfaceIndex
} from '../../compat/ray-paraxial.js';
import {
    traceRay,
    traceRayHitPoint,
    calculateSurfaceOrigins,
    transformPointToLocal
} from '../../compat/ray-tracing.js';
import {
    getOpticalSystemRows,
    getObjectRows,
    getSourceRows
} from '../../compat/data-utils.js';
import { calculateSeidelCoefficients } from '../../compat/seidel-coefficients.js';
import { calculateAfocalSeidelCoefficientsIntegrated } from '../../evaluation/aberrations/seidel-coefficients-afocal.js';
import { generateSpotDiagram, generateSurfaceOptions } from '../../evaluation/spot-diagram.js';
import { createOPDCalculator, WavefrontAberrationAnalyzer } from '../../evaluation/wavefront/wavefront.js';
import { expandBlocksToOpticalSystemRows } from '../../data/block-schema.js';
import { generateRayStartPointsForObject, setRayEmissionPattern, getRayEmissionPattern } from '../../optical/ray-renderer.js';
import { calculateLongitudinalAberration } from '../../evaluation/aberrations/longitudinal-aberration.js';
import { getTableOpticalSystem, getTableObject, getTableSource } from '../../core/app-config.js';

function isPlainObject(value: any): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.prototype.toString.call(value) === '[object Object]'
    );
}

function cloneJson(v: any): any {
    try {
        return JSON.parse(JSON.stringify(v));
    } catch {
        return v;
    }
}

function parseZernikeUnit(raw: any): string {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (s === 'um' || s === 'µm' || s === 'μm' || s === 'micron' || s === 'microns') {
        return 'um';
    }
    return 'waves';
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

function toFieldSettingFromObjectRow(objRow: any, index0: number, isInfiniteSystem: boolean): any {
    if (!objRow || typeof objRow !== 'object') return { angleX: 0, angleY: 0 };
    const Hx = toFiniteNumber(objRow.Hx, 0);
    const Hy = toFiniteNumber(objRow.Hy, 0);

    if (isInfiniteSystem) {
        return { angleX: Hx, angleY: Hy, objectIndex: index0 };
    } else {
        return { fieldX: Hx, fieldY: Hy, objectIndex: index0 };
    }
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

        const opdCalc = createOPDCalculator({
            opticalSystemData,
            imageSurfaceIndex,
            wavelengthUm,
            fieldSetting
        });

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
                const opd = opdCalc.calculateOPD(pt.nx, pt.ny, 0);
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

        const analyzer = new WavefrontAberrationAnalyzer(
            validPoints.map(p => ({ x: p.nx, y: p.ny, opd: opdValues[validPoints.indexOf(p)] }))
        );

        const fit = analyzer.fitZernikePolynomials({ maxNoll: zernikeMaxNoll }) as any;

        if (!fit || !fit.coefficients) {
            console.warn('⚠️ computeZernikeFitLive: Zernike fit failed');
            return null;
        }

        return fit;
    } catch (error) {
        console.error('⚠️ computeZernikeFitLive error:', error);
        return null;
    }
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

        const block = cloned.find((b: any) => b && String(b.id) === String(blockId));
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

    initializeTable(): void {
        const container = document.getElementById('table-merit-function');
        if (!container) {
            console.error('❌ Merit Function テーブルコンテナが見つかりません');
            this.table = this.createNoopTable();
            return;
        }

        try {
            this.table = new w.Tabulator(container, {
                data: this.operands,
                layout: "fitColumns",
                height: "100%",
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
                        width: 80,
                        editor: "input",
                        cellEdited: (cell: any) => {
                            this.saveToStorage();
                        }
                    },
                    {
                        title: "-",
                        field: "param3",
                        width: 80,
                        editor: "input",
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

            console.log('✅ Merit Function テーブルを初期化しました');
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
            addBtn.addEventListener('click', () => {
                this.addOperand();
            });
        }

        const deleteBtn = document.getElementById('delete-operand-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                this.deleteOperand();
            });
        }

        const calculateBtn = document.getElementById('calculate-merit-btn');
        if (calculateBtn) {
            calculateBtn.addEventListener('click', () => {
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
                    const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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

        console.log('🔍 Merit Function 計算開始');

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
                const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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
            case 'EFL':
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
                return this.calculateSpotSizeUm(operand, opticalSystemData, { pattern: 'annular' });
            case 'SPOT_SIZE_RECT':
                return this.calculateSpotSizeUm(operand, opticalSystemData, { pattern: 'grid' });
            case 'SPOT_SIZE_CURRENT':
                return this.calculateSpotSizeUm(operand, opticalSystemData, { pattern: 'annular' });

            case 'LA_RMS_UM':
                return this.calculateLongitudinalAberrationRmsUm(operand, opticalSystemData);

            case 'ZERN_COEFF': {
                const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

                const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
                const wavelength = (param1Raw === '')
                    ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
                    : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

                const param2Raw = (operand.param2 !== undefined && operand.param2 !== null) ? String(operand.param2).trim() : '';
                const objectIndex1 = (param2Raw === '') ? 1 : Math.max(1, Math.floor(Number(param2Raw)));
                const objectIndex0 = objectIndex1 - 1;
                const objRow = Array.isArray(objectRows) ? objectRows[objectIndex0] : null;

                const unit = parseZernikeUnit(operand.param3);

                const param4Raw = (operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
                const sampling = (param4Raw === '') ? 32 : Math.max(8, Math.floor(Number(param4Raw)));

                const param5Raw = (operand.param5 !== undefined && operand.param5 !== null) ? String(operand.param5).trim() : '';
                const nollIndex = (param5Raw === '') ? 0 : Math.floor(Number(param5Raw));

                if (!objRow || typeof objRow !== 'object') {
                    console.warn('⚠️ ZERN_COEFF: object row not found');
                    return 1e9;
                }

                const isInfiniteSystem = isInfiniteSystemFromRows(opticalSystemData);
                const fieldSetting = toFieldSettingFromObjectRow(objRow, objectIndex0, isInfiniteSystem);

                const existingZernike = (() => {
                    try {
                        if (typeof window === 'undefined') return null;
                        const wfMap = w.__lastWavefrontMap;
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

    calculateLongitudinalAberrationRmsUm(operand: any, opticalSystemData: any[]): number {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;

        const { source: sourceRows } = this.getConfigTablesByConfigId(operand.configId);

        const param1Raw = (operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        const wavelength = (param1Raw === '')
            ? this.getPrimaryWavelengthFromSourceRows(sourceRows)
            : this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const results = calculateLongitudinalAberration(opticalSystemData, wavelength) as any;

        if (!results || !Array.isArray(results.data) || results.data.length === 0) {
            console.warn('⚠️ LA_RMS_UM: longitudinal aberration calculation failed');
            return 0;
        }

        const data = results.data;
        const N = data.length;

        let sumWeightedL = 0;
        let sumWeightedL2 = 0;
        let sumWeight = 0;

        for (let i = 0; i < N; i++) {
            const d = data[i];
            const r = toFiniteNumber(d.pupilRadius, 0);
            const L = toFiniteNumber(d.longitudinalAberration, 0);

            if (i === 0) {
                continue;
            }

            const rPrev = (i > 0) ? toFiniteNumber(data[i - 1].pupilRadius, 0) : 0;
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

        try {
            if (typeof globalThis !== 'undefined') {
                const g = globalThis as any;
                if (!g.__cooptLARmsDebugCount) g.__cooptLARmsDebugCount = 0;
                g.__cooptLARmsDebugCount++;
                if (g.__cooptLARmsDebugCount <= 3 || g.__cooptLARmsDebugCount % 50 === 0) {
                    console.log(`📊 LA_RMS_UM (#${g.__cooptLARmsDebugCount}):`, {
                        wavelength,
                        N,
                        meanL: meanL.toFixed(6),
                        rmsL: rmsL.toFixed(6),
                        rmsUm: rmsUm.toFixed(6)
                    });
                }
            }
        } catch (_) {}

        return rmsUm;
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

            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

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
            let rayCount = (param4Raw === '') ? 501 : Math.floor(Number(param4Raw));
            if (!Number.isFinite(rayCount) || rayCount < 1) rayCount = 501;
            if (rayCount > 5000) rayCount = 5000;

            const useUiDefaults = (options.useUiDefaults !== undefined) ? options.useUiDefaults : true;
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
            if (!objRow || typeof objRow !== 'object') {
                stampSpotDebug({ ok: false, reason: 'no-object-row', resultUm: 1e9 });
                return 1e9;
            }

            const isInfiniteSystem = isInfiniteSystemFromRows(opticalSystemData);
            const fieldSetting = toFieldSettingFromObjectRow(objRow, objectIndex0, isInfiniteSystem);

            if (useUiDefaults) {
                stampSpotDebug({ impl: 'spot-diagram' });

                const isOperandActiveConfig = (() => {
                    try {
                        const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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

                const getUiTableRowsForSpot = () => {
                    if (useUiTables && (isOperandActiveConfig || isCurrentOperand)) {
                        return {
                            optical: getTableOpticalSystem(),
                            object: getTableObject(),
                            source: getTableSource()
                        };
                    }
                    return null;
                };

                const uiTableRows = getUiTableRowsForSpot();

                const spotOpticalRows = uiTableRows ? uiTableRows.optical : opticalSystemData;
                const spotObjectRowsForOperand = uiTableRows ? uiTableRows.object : objectRows;
                const spotSourceRowsForOperand = uiTableRows ? uiTableRows.source : sourceRows;

                const obj2 = Array.isArray(spotObjectRowsForOperand) ? spotObjectRowsForOperand[objectIndex0] : null;
                if (!obj2 || typeof obj2 !== 'object') {
                    stampSpotDebug({ ok: false, reason: 'no-object-row-ui', resultUm: 1e9 });
                    return 1e9;
                }

                const lastSpotSettings = (() => {
                    try {
                        const raw = localStorage.getItem('lastSpotSettings');
                        return raw ? JSON.parse(raw) : {};
                    } catch {
                        return {};
                    }
                })();

                const forceSpotDiagramPrimary = !options.pattern || options.pattern === 'current';

                const uiSurfaceIndex = (() => {
                    const idx = Number(lastSpotSettings.surfaceIndex);
                    if (Number.isFinite(idx) && idx >= 0) return idx;
                    const sel = document.getElementById('surface-number-select') as HTMLSelectElement | null;
                    if (sel && sel.value) {
                        const v = Number(sel.value);
                        if (Number.isFinite(v) && v >= 0) return v;
                    }
                    return null;
                })();

                const targetSurfaceIndex = uiSurfaceIndex ?? imageSurfaceIndex;

                stampSpotDebug({ targetSurfaceIndex, uiSurfaceIndex });

                const pattern = (() => {
                    if (options.pattern && options.pattern !== 'current') return options.pattern;

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
                    const spotResult = generateSpotDiagram(
                        spotOpticalRows,
                        spotSourceRowsForOperand,
                        [obj2],
                        surfaceNumber1,
                        rayCount,
                        effectiveAnnularRingCount,
                        { physicalVignetting: true }
                    );

                    if (!spotResult || !Array.isArray(spotResult.spotData) || spotResult.spotData.length === 0) {
                        stampSpotDebug({ ok: false, reason: 'spot-diagram-no-rays', hits: 0, resultUm: 1e9 });
                        return 1e9;
                    }

                    const hits = spotResult.spotData[0]?.spotPoints || [];

                    let chief = hits.find((h: any) => h.isChief) || null;
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
                        stampSpotDebug({ ok: false, reason: 'no-valid-hits', hits: 0, resultUm: 1e9 });
                        return 1e9;
                    }

                    const rmsX = Math.sqrt(sumX2 / n);
                    const rmsY = Math.sqrt(sumY2 / n);
                    const rmsTotal = Math.sqrt(rmsX * rmsX + rmsY * rmsY);
                    const diameter = 2 * maxRUm;

                    const valueUm = (metric === 'diameter') ? diameter : rmsTotal;

                    stampSpotDebug({ ok: true, reason: 'ok', hits: hits.length, resultUm: valueUm });

                    return valueUm;
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
            }

            stampSpotDebug({ impl: 'legacy-ray-trace' });

            const apertureLimitMm = (() => {
                if (!fastModeEnabled) return null;

                let minSemidia = Infinity;
                for (const row of opticalSystemData) {
                    if (!row || typeof row !== 'object') continue;
                    const sd = toFiniteNumber(row.semidia || row['Semi Diameter'] || row['semi diameter'], Infinity);
                    if (Number.isFinite(sd) && sd > 0 && sd < minSemidia) {
                        minSemidia = sd;
                    }
                }

                if (!Number.isFinite(minSemidia) || minSemidia === Infinity) return null;

                return 0.5 * minSemidia * 0.99;
            })();

            if (apertureLimitMm !== null) {
                stampSpotDebug({ apertureLimitMm });
            }

            const rayStarts = generateRayStartPointsForObject(
                objRow,
                opticalSystemData,
                rayCount,
                apertureLimitMm ?? undefined,
                {
                    annularRingCount: options.annularRingCount || 3,
                    targetSurfaceIndex: imageSurfaceIndex,
                    useChiefRayAnalysis: true,
                    chiefRaySolveMode: fastModeEnabled ? 'fast' : 'legacy',
                    wavelengthUm: wavelength
                }
            );

            if (!rayStarts || !Array.isArray(rayStarts) || rayStarts.length === 0) {
                stampSpotDebug({ ok: false, reason: 'no-ray-starts', rayStartsGenerated: 0, resultUm: 1e9 });
                return 1e9;
            }

            stampSpotDebug({ rayStartsGenerated: rayStarts.length });

            const collectHits = (starts: any[], maxRays: number): any => {
                const hits: any[] = [];
                let legacyFallbackHits = 0;
                let attempted = 0;

                let consecutiveMiss = 0;
                let consecutiveBlock = 0;

                const earlyAbortMinAttempt = 20;
                const earlyAbortMinHitRate = 0.20;
                const earlyAbortMaxHits = 8;
                const earlyAbortMaxAttempt = 30;
                const earlyAbortMissStreakMin = 15;
                const earlyAbortBlockStreakMin = 10;
                const earlyAbortStreakMaxHits = 12;

                for (let i = 0; i < starts.length && attempted < maxRays; i++) {
                    const start = starts[i];
                    attempted++;

                    let hit: any = traceRayHitPoint(opticalSystemData, start, 1.0, undefined);
                    if (!hit) {
                        legacyFallbackHits++;
                        const fullPath = traceRay(opticalSystemData, start, 1.0, null, undefined);
                        hit = (fullPath && Array.isArray(fullPath)) ? fullPath[imageSurfaceIndex + 1] : null;
                    }

                    if (hit && typeof hit === 'object' && Number.isFinite((hit as any).x) && Number.isFinite((hit as any).y)) {
                        hits.push({
                            x: (hit as any).x,
                            y: (hit as any).y,
                            isChief: start.isChief || false
                        });
                        consecutiveMiss = 0;
                        consecutiveBlock = 0;
                    } else {
                        consecutiveMiss++;

                        const f = getLastRayTraceFailureForThisEval();
                        const kind = f && typeof f === 'object' ? String(f.kind || '') : '';
                        if (kind === 'PHYSICAL_APERTURE_BLOCK') {
                            consecutiveBlock++;
                        } else {
                            consecutiveBlock = 0;
                        }
                    }

                    if (fastModeEnabled) {
                        const hitRate = attempted > 0 ? hits.length / attempted : 0;

                        if (consecutiveMiss >= earlyAbortMissStreakMin && hits.length <= earlyAbortStreakMaxHits) {
                            return {
                                hits,
                                legacyFallbackHits,
                                attempted,
                                earlyAbort: { reason: 'MISS_STREAK', hits: hits.length, hitRate, failPenaltyUm: null, failPenaltyKind: null, failPenaltyRatio: null }
                            };
                        }

                        if (consecutiveBlock >= earlyAbortBlockStreakMin) {
                            const f = getLastRayTraceFailureForThisEval();
                            const d = (f && typeof f === 'object' && f.details && typeof f.details === 'object') ? f.details : null;
                            const hitR = Number((d ? d.hitRadiusMm : null));
                            const limR = apertureLimitMm;
                            let failPenalty = 5e4;
                            let failPenaltyRatio = null;
                            if (Number.isFinite(hitR) && Number.isFinite(limR) && limR && limR > 0) {
                                const ratio = Math.max(1, hitR / limR);
                                failPenalty = Math.min(2e5, Math.max(1e4, 1e4 * ratio));
                                failPenaltyRatio = ratio;
                            }
                            return {
                                hits,
                                legacyFallbackHits,
                                attempted,
                                earlyAbort: {
                                    reason: 'PHYSICAL_APERTURE_BLOCK',
                                    hits: hits.length,
                                    hitRate,
                                    failPenaltyUm: failPenalty,
                                    failPenaltyKind: 'PHYSICAL_APERTURE_BLOCK',
                                    failPenaltyRatio
                                }
                            };
                        }

                        if (hitRate < earlyAbortMinHitRate && hits.length <= earlyAbortMaxHits && attempted >= earlyAbortMinAttempt) {
                            return {
                                hits,
                                legacyFallbackHits,
                                attempted,
                                earlyAbort: { reason: 'LOW_HIT_RATE', hits: hits.length, hitRate, failPenaltyUm: 5e4, failPenaltyKind: 'LOW_HIT_RATE', failPenaltyRatio: null }
                            };
                        }

                        if (attempted >= earlyAbortMaxAttempt && hits.length <= earlyAbortStreakMaxHits && hitRate < earlyAbortMinHitRate) {
                            return {
                                hits,
                                legacyFallbackHits,
                                attempted,
                                earlyAbort: { reason: 'MAX_ATTEMPT', hits: hits.length, hitRate, failPenaltyUm: 5e4, failPenaltyKind: 'LOW_HIT_RATE', failPenaltyRatio: null }
                            };
                        }
                    }
                }

                return { hits, legacyFallbackHits, attempted, earlyAbort: null };
            };

            const { hits, legacyFallbackHits, attempted, earlyAbort } = collectHits(rayStarts, rayCount);

            if (fastModeEnabled && earlyAbort && earlyAbort.failPenaltyUm !== undefined && earlyAbort.failPenaltyUm !== null) {
                try {
                    const f = getLastRayTraceFailureForThisEval();
                    const d = (f && typeof f === 'object' && f.details && typeof f.details === 'object') ? f.details : null;
                    stampSpotDebug({
                        ok: false,
                        reason: 'early-abort-low-hit-rate',
                        hits: hits.length,
                        rayCountRequested: rayCount,
                        rayStartsGenerated: Array.isArray(rayStarts) ? rayStarts.length : 0,
                        earlyAbortAttempted: attempted,
                        earlyAbortHits: earlyAbort.hits,
                        earlyAbortHitRate: earlyAbort.hitRate,
                        earlyAbortReason: earlyAbort.reason,
                        failPenaltyUm: earlyAbort.failPenaltyUm,
                        failPenaltyKind: earlyAbort.failPenaltyKind,
                        failPenaltyRatio: earlyAbort.failPenaltyRatio,
                        lastRayTraceFailure: f,
                        blockSurfaceIndex: d ? Number(d.surfaceIndex) : null,
                        blockSurfaceNumber: d ? Number(d.surfaceNumber) : null,
                        blockHitRadiusMm: d ? Number(d.hitRadiusMm) : null,
                        blockApertureLimitMm: d ? Number(d.apertureLimitMm) : null,
                        blockSemidia: d ? d.semidia : null,
                        blockAperture: d ? d.aperture : null
                    });
                } catch (_) {}
                return Number(earlyAbort.failPenaltyUm);
            }

            if (hits.length === 0) {
                if (fastModeEnabled) {
                    try { stampSpotDebug({ retryTightApertureDisabled: true }); } catch (_) {}
                }

                if (hits.length === 0) {
                    try {
                        if (typeof window !== 'undefined') {
                            stampSpotDebug({
                                ok: false,
                                reason: 'no-ray-hits',
                                targetSurfaceIndex: imageSurfaceIndex,
                                rayCountRequested: rayCount,
                                rayStartsGenerated: Array.isArray(rayStarts) ? rayStarts.length : 0,
                                legacyFallbackHits,
                                wavelength,
                                fastModeEnabled,
                                lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                            });
                        }
                    } catch (_) {}

                    if (fastModeEnabled) {
                        const failPenalty = (() => {
                            try {
                                const f = getLastRayTraceFailureForThisEval();
                                if (f && typeof f === 'object' && String(f.kind || '') === 'PHYSICAL_APERTURE_BLOCK') {
                                    const hitR = Number((f.hitRadiusMm ?? f.details?.hitRadiusMm));
                                    const limR = Number((f.apertureLimitMm ?? f.details?.apertureLimitMm));
                                    if (Number.isFinite(hitR) && Number.isFinite(limR) && limR > 0) {
                                        const ratio = Math.max(1, hitR / limR);
                                        const um = Math.min(2e5, Math.max(1e4, 1e4 * ratio));
                                        return { um, kind: 'PHYSICAL_APERTURE_BLOCK', ratio };
                                    }
                                }
                            } catch (_) {}
                            return { um: 5e4, kind: 'NO_RAY_HITS', ratio: null };
                        })();
                        try { stampSpotDebug({ failPenaltyUm: failPenalty.um, failPenaltyKind: failPenalty.kind, failPenaltyRatio: failPenalty.ratio }); } catch (_) {}
                        return failPenalty.um;
                    }
                    return 1e9;
                }
            }

            try {
                if (typeof window !== 'undefined' && w.__cooptLastSpotSizeDebug) {
                    w.__cooptLastSpotSizeDebug.ok = true;
                    w.__cooptLastSpotSizeDebug.reason = 'ok';
                    w.__cooptLastSpotSizeDebug.legacyFallbackHits = legacyFallbackHits;
                    w.__cooptLastSpotSizeDebug.hits = hits.length;
                    w.__cooptLastSpotSizeDebug.lastRayTraceFailure = getLastRayTraceFailureForThisEval();
                    if (fastModeEnabled) {
                        w.__cooptLastSpotSizeDebugFast = w.__cooptLastSpotSizeDebug;
                    }
                }
            } catch (_) {}

            let chief = hits.find((h: any) => h.isChief) || null;
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

            if (n <= 0) return 1e9;
            const rmsX = Math.sqrt(sumX2 / n);
            const rmsY = Math.sqrt(sumY2 / n);
            const rmsTotal = Math.sqrt(rmsX * rmsX + rmsY * rmsY);
            const diameter = 2 * maxRUm;

            const valueUm = (metric === 'diameter') ? diameter : rmsTotal;
            try { stampSpotDebug({ resultUm: valueUm }); } catch (_) {}
            return valueUm;
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

    getConfigTablesByConfigId(configId: any): { source: any[]; object: any[] } {
        try {
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
            const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                ? String(systemConfig.activeConfigId)
                : '';

            let targetConfigId = configId;
            if (!targetConfigId) {
                targetConfigId = activeConfigId;
            }
            const targetIdStr = (targetConfigId !== undefined && targetConfigId !== null) ? String(targetConfigId) : '';

            if (activeConfigId && targetIdStr && targetIdStr === activeConfigId) {
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
                object: Array.isArray(config.object) ? config.object : ((typeof window !== 'undefined' && w.getObjectRows) ? w.getObjectRows() : (w.tableObject ? w.tableObject.getData() : []))
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
        const primaryRow = sourceRows.find((r: any) => r && r.primary && String(r.primary).toLowerCase().includes('primary'));
        const wl = primaryRow ? Number(primaryRow.wavelength) : NaN;
        if (Number.isFinite(wl) && wl > 0) return wl;
        const wl0 = Number(sourceRows[0]?.wavelength);
        return (Number.isFinite(wl0) && wl0 > 0) ? wl0 : 0.5875618;
    }

    getSystemWavelengthFromOperandOrPrimary(operand: any, sourceRows: any[]): number {
        const raw = (operand && operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        if (raw === '') return this.getPrimaryWavelengthFromSourceRows(sourceRows);

        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return this.getPrimaryWavelengthFromSourceRows(sourceRows);

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

    getPrimarySystemMetricsCached(operand: any, opticalSystemData: any[]): any {
        const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
        const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
        const cfgKey = operand?.configId ? String(operand.configId) : 'active';
        const cacheKey = `primary-metrics:${cfgKey}:wl=${wavelength}`;

        const cached = this._runtimeCache ? this._runtimeCache.get(cacheKey) : null;
        if (cached) return cached;

        const paraxial = calculateParaxialData(opticalSystemData, wavelength);

        const fl = this.safeFiniteNumberOrZero(paraxial?.focalLength);

        let bfl = paraxial?.backFocalLength;
        if (bfl && typeof bfl === 'object' && 'tangential' in bfl) {
            bfl = bfl.tangential;
        }
        bfl = this.safeFiniteNumberOrZero(bfl);

        const imd = this.safeFiniteNumberOrZero(paraxial?.imageDistance);
        const finalAlpha = Number(paraxial?.finalAlpha);

        const eflTrace = calculateFullSystemParaxialTrace(opticalSystemData, wavelength) as any;
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
        const metrics = this.getPrimarySystemMetricsCached(operand, opticalSystemData);
        return this.safeFiniteNumberOrZero(metrics ? metrics[key] : 0);
    }

    calculateSeidelTotal(operand: any, opticalSystemData: any[], totalKey: string): number {
        if (!opticalSystemData || opticalSystemData.length < 2) return 0;

        const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);

        const modeRaw = (operand?.param2 !== undefined && operand?.param2 !== null) ? String(operand.param2).trim() : '';
        const modeList = (() => {
            if (modeRaw === '') return [0];
            if (modeRaw.includes(',')) {
                return modeRaw.split(',')
                    .map((s: string) => parseInt(s.trim(), 10))
                    .filter((n: number) => n === 0 || n === 1);
            }
            const single = parseInt(modeRaw, 10);
            return (single === 0 || single === 1) ? [single] : [0];
        })();

        if (modeList.length > 1) {
            let sumSq = 0;
            for (const mode of modeList) {
                const isAfocal = mode === 1;
                const value = this._calculateSeidelTotalSingleMode(
                    operand, opticalSystemData, totalKey, sourceRows, objectRows, isAfocal
                );
                sumSq += value * value;
            }
            return Math.sqrt(sumSq);
        }

        const mode = modeList[0] || 0;
        const isAfocal = mode === 1;
        return this._calculateSeidelTotalSingleMode(
            operand, opticalSystemData, totalKey, sourceRows, objectRows, isAfocal
        );
    }

    _calculateSeidelTotalSingleMode(operand: any, opticalSystemData: any[], totalKey: string, sourceRows: any[], objectRows: any[], isAfocal: boolean): number {
        const s1Num = Number.isFinite(Number(operand?.param3)) ? Math.floor(Number(operand.param3)) : 0;
        const s1 = (Number.isFinite(s1Num) && s1Num > 0) ? s1Num : 0;

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

        const cfgKey = operand.configId ? String(operand.configId) : 'active';
        const cacheKey = `seidel:${cfgKey}:mode=${isAfocal ? 'afocal' : 'imaging'}:wl=${baseWavelength}:s1=${s1}:refFL=${(isAfocal ? (referenceFocalLengthAfocal ?? 'auto') : (referenceFocalLengthOverrideImaging === 0 ? 'auto' : referenceFocalLengthOverrideImaging))}:key=${totalKey}`;
        if (this._runtimeCache && this._runtimeCache.has(cacheKey)) {
            return this._runtimeCache.get(cacheKey);
        }

        try {
            let seidel: any;

            if (isAfocal) {
                let stopIndex = opticalSystemData.findIndex((row: any) => row && (row['object type'] === 'Stop' || row.object === 'Stop'));
                if (stopIndex === -1) {
                    const fallback = findStopSurfaceIndex ? findStopSurfaceIndex(opticalSystemData) : -1;
                    stopIndex = (fallback >= 0) ? fallback : 1;
                }

                seidel = calculateAfocalSeidelCoefficientsIntegrated(
                    opticalSystemData,
                    baseWavelength,
                    stopIndex,
                    objectRows,
                    referenceFocalLengthAfocal ?? 100
                );
            } else {
                seidel = calculateSeidelCoefficients(
                    opticalSystemData,
                    baseWavelength,
                    objectRows,
                    { referenceFocalLengthOverride: referenceFocalLengthOverrideImaging }
                );
            }

            let v = NaN;
            if (s1 === 0) {
                v = seidel?.totals ? Number(seidel.totals[totalKey]) : NaN;
            } else {
                const coeffs = seidel?.surfaceCoefficients;
                const c = Array.isArray(coeffs)
                    ? (
                        coeffs.find((sc: any) => sc && Number(opticalSystemData?.[Number(sc.surfaceIndex)]?.id) === Number(s1))
                        || coeffs.find((sc: any) => sc && Number(sc.surfaceIndex) === Number(s1))
                    )
                    : null;
                v = c ? Number(c[totalKey]) : NaN;
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
            try {
                if (typeof window !== 'undefined' && w.__cooptOpticalSystemByConfigId) {
                    const cfgId = (configId !== undefined && configId !== null) ? String(configId).trim() : '';
                    if (cfgId) {
                        const cached = w.__cooptOpticalSystemByConfigId[cfgId];
                        if (Array.isArray(cached) && cached.length > 0) {
                            return cached;
                        }
                    }
                }
            } catch (_) {}

            let systemConfig: any = null;
            let memSystemConfig: any = null;
            let lsSystemConfig: any = null;
            try {
                if (typeof window !== 'undefined' && w.__cooptSystemConfig) {
                    memSystemConfig = w.__cooptSystemConfig;
                }
            } catch (_) {}
            try {
                lsSystemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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

            const config = systemConfig?.configurations?.find((c: any) => String(c.id) === String(targetIdStr));

            const isActiveConfig = activeConfigId && targetIdStr && targetIdStr === activeConfigId;

            if (isActiveConfig || wantsCurrent) {
                const hasBlocksForActive = Array.isArray(config?.blocks);
                if (!hasBlocksForActive) return getOpticalSystemRows({});
            }

            if (!config) {
                console.warn(`Config ID ${targetIdStr} が見つかりません。現在のテーブルデータを使用します。`);
                return getOpticalSystemRows({});
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
                            if (hasObjectSurface) return expanded.rows;

                            let preferredThickness: any = undefined;

                            const persistedThickness = config?.opticalSystem?.[0]?.thickness;
                            if (persistedThickness !== undefined && persistedThickness !== null && String(persistedThickness).trim() !== '') {
                                preferredThickness = persistedThickness;
                            } else if (systemConfig && String(systemConfig.activeConfigId) === String(targetConfigId)) {
                                const tableRows = (() => {
                                    try {
                                        const raw = localStorage.getItem('OpticalSystemTableData');
                                        const parsed = raw ? JSON.parse(raw) : null;
                                        return Array.isArray(parsed) ? parsed : null;
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
                    return expanded.rows;
                }
            }

            console.log(`📊 Config "${config.name}" (ID: ${targetIdStr}) の光学系データを使用`);
            return config.opticalSystem || [];

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

        console.log('🔍 EFFL計算開始:', {
            param1: operand.param1,
            param2: operand.param2,
            param3: operand.param3,
            dataLength: opticalSystemData.length
        });

        const sourceIndex = parseInt(operand.param1) || 1;
        const startSurf = parseInt(operand.param2) || 1;
        const endSurf = parseInt(operand.param3) || (opticalSystemData.length - 2);

        const sourceRows = this.getConfigTablesByConfigId(operand.configId).source;
        let wavelength = 0.5875618;

        if (sourceRows && sourceRows.length > 0) {
            const sourceRow = sourceRows[sourceIndex - 1];
            if (sourceRow && sourceRow.wavelength) {
                wavelength = parseFloat(sourceRow.wavelength);
                console.log(`📡 Source${sourceIndex}の波長を使用: ${wavelength} μm`);
            } else {
                console.warn(`⚠️ Source${sourceIndex}が見つかりません。デフォルト波長を使用: ${wavelength} μm`);
            }
        } else {
            console.warn(`⚠️ Sourceテーブルが空です。デフォルト波長を使用: ${wavelength} μm`);
        }

        console.log('📊 面範囲:', {
            startSurf,
            endSurf,
            sourceIndex,
            wavelength,
            totalSurfaces: opticalSystemData.length
        });

        let subSystemData: any[] = [];

        const objectSurfaceIdNum = Number(opticalSystemData[0]?.id);
        const objectSurfaceId = Number.isFinite(objectSurfaceIdNum) ? objectSurfaceIdNum : 1;
        if (startSurf === objectSurfaceId) {
            subSystemData.push(opticalSystemData[0]);
            console.log(`✓ Object面追加（id=${objectSurfaceId}）:`, opticalSystemData[0]);
        } else {
            const virtualObject = {
                surface: 0,
                "object type": "Object",
                thickness: Infinity,
                comment: "Virtual Object"
            };
            subSystemData.push(virtualObject);
            console.log(`✓ 仮想Object面追加（開始id=${startSurf}）`);
        }

        for (let i = 1; i < opticalSystemData.length - 1; i++) {
            const surface = opticalSystemData[i];
            const surfaceIdNum = Number(surface?.id);
            if (!Number.isFinite(surfaceIdNum)) continue;
            if (surfaceIdNum >= startSurf && surfaceIdNum <= endSurf) {
                subSystemData.push({ ...surface, id: surfaceIdNum });
                console.log(`✓ 面${i}追加（id=${surfaceIdNum}）:`, surface);
            }
        }

        const imageSurface = {
            surface: subSystemData.length,
            "object type": "Image",
            thickness: 0,
            comment: "Image"
        };
        subSystemData.push(imageSurface);
        console.log('✓ Image面追加');

        console.log('📋 サブシステムデータ:', subSystemData);

        const paraxialResult = calculateFullSystemParaxialTrace(subSystemData, wavelength) as any;

        console.log('🎯 近軸追跡結果:', paraxialResult);

        if (!paraxialResult || Math.abs(paraxialResult.finalAlpha) < 1e-10) {
            console.warn(`❌ EFFL計算失敗: 面${startSurf}〜${endSurf}, 波長${wavelength}μm`);
            return 0;
        }

        const efl = 1.0 / paraxialResult.finalAlpha;

        console.log(`✅ EFFL計算: 面${startSurf}〜${endSurf}, 波長${wavelength}μm = ${efl.toFixed(6)} mm`);
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

        const dropDeprecated = (op: any) => {
            const name = String(op?.operand ?? '').trim();
            return name === 'ZERN_WL_UM' || name === 'ZERN_FIT_TERMS';
        };

        this.operands = data.filter((op: any) => !dropDeprecated(op));
        this.updateRowNumbers();

        if (this.table) {
            this.table.setData(this.operands);
        }

        console.log('✅ Merit Function データを読み込みました:', this.operands.length, '件');
    }

    loadFromStorage(): void {
        try {
            const savedData = localStorage.getItem('meritFunctionData');
            if (savedData) {
                const data = JSON.parse(savedData);

                const dropDeprecated = (op: any) => {
                    const name = String(op?.operand ?? '').trim();
                    return name === 'ZERN_WL_UM' || name === 'ZERN_FIT_TERMS';
                };
                const sanitized = Array.isArray(data) ? data.filter((op: any) => !dropDeprecated(op)) : [];

                let activeConfigId = "";
                try {
                    const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
                    if (systemConfig && systemConfig.activeConfigId) {
                        activeConfigId = String(systemConfig.activeConfigId);
                    }
                } catch (e) {
                    console.warn('Active config ID取得エラー:', e);
                }

                this.operands = sanitized.map((operand: any) => {
                    if (operand.configId === undefined || operand.configId === null) {
                        return { ...operand, configId: activeConfigId };
                    }
                    return { ...operand, configId: String(operand.configId) };
                });
            }
        } catch (error) {
            console.error('❌ Merit Function ローカルストレージ読み込みエラー:', error);
        }
    }

    saveToStorage(): void {
        try {
            localStorage.setItem('meritFunctionData', JSON.stringify(this.operands));
            console.log('✅ Merit Function データをローカルストレージに保存しました:', this.operands.length, '件');
        } catch (error) {
            console.error('❌ Merit Function ローカルストレージ保存エラー:', error);
        }
    }

    getConfigurationList(): Record<string, string> {
        try {
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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

    getConfigName(configId: any): string {
        if (!configId && configId !== 0) {
            try {
                const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
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
        if (w.meritFunctionEditor) return true;
        const container = document.getElementById('table-merit-function');
        if (!container) return false;
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

document.addEventListener('DOMContentLoaded', () => {
    if (__cooptInitMeritFunctionEditor()) return;
    if (typeof window !== 'undefined') {
        window.addEventListener('coopt:react-mounted', () => {
            __cooptInitMeritFunctionEditor();
        }, { once: true });
        setTimeout(() => {
            __cooptInitMeritFunctionEditor();
        }, 0);
    }
});

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
