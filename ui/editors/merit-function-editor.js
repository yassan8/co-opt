/**
 * System Evaluation Editor
 * Zemax/CODE V スタイルのメリット関数エディタ (Tabulator版)
 */

import { OPERAND_DEFINITIONS, InspectorManager } from './merit-function-inspector.js';
import { calculateFullSystemParaxialTrace, calculateParaxialData, findStopSurfaceIndex } from '../../raytracing/core/ray-paraxial.js';
import { traceRay, traceRayHitPoint, calculateSurfaceOrigins, transformPointToLocal } from '../../raytracing/core/ray-tracing.js';
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../../utils/data-utils.js';
import { calculateSeidelCoefficients } from '../../evaluation/aberrations/seidel-coefficients.js';
import { calculateAfocalSeidelCoefficientsIntegrated } from '../../evaluation/aberrations/seidel-coefficients-afocal.js';
import { generateSpotDiagram, generateSurfaceOptions } from '../../evaluation/spot-diagram.js';
import { createOPDCalculator, WavefrontAberrationAnalyzer } from '../../evaluation/wavefront/wavefront.js';
import { expandBlocksToOpticalSystemRows } from '../../data/block-schema.js';
import { generateRayStartPointsForObject, setRayEmissionPattern, getRayEmissionPattern } from '../../optical/ray-renderer.js';
import { calculateLongitudinalAberration } from '../../evaluation/aberrations/longitudinal-aberration.js';
import { getTableOpticalSystem, getTableObject, getTableSource } from '../../core/app-config.js';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(v) {
    try {
        return JSON.parse(JSON.stringify(v));
    } catch {
        return null;
    }
}

function parseZernikeUnit(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return 'waves';
    if (s === 'waves' || s === 'wave' || s === 'w' || s === 'lambda' || s === 'λ') return 'waves';
    if (s === 'um' || s === 'µm' || s === 'micron' || s === 'microns') return 'um';
    return 'waves';
}

function readCoeff(container, noll) {
    if (!container) return null;
    const k = String(noll);
    try {
        if (Array.isArray(container)) {
            const v = container[noll];
            const num = Number(v);
            return Number.isFinite(num) ? num : null;
        }
        const v = container[k];
        const num = Number(v);
        return Number.isFinite(num) ? num : null;
    } catch {
        return null;
    }
}

function toFiniteNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function isInfiniteSystemFromRows(opticalSystemRows) {
    const t = opticalSystemRows?.[0]?.thickness;
    return t === 'INF' || t === 'Infinity' || t === Infinity;
}

function toFieldSettingFromObjectRow(objRow, index0, isInfiniteSystem) {
    const pos = String(objRow?.position ?? objRow?.Position ?? objRow?.type ?? '').toLowerCase();
    const xVal = toFiniteNumber(objRow?.xHeightAngle, 0);
    const yVal = toFiniteNumber(objRow?.yHeightAngle, 0);

    const isAngleMode = pos === 'angle' || pos === 'field angle' || pos === 'angles';
    const isHeightMode = pos === 'rectangle' || pos === 'height' || pos === 'point';

    let fieldAngle = { x: 0, y: 0 };
    let xHeight = 0;
    let yHeight = 0;
    let type = objRow?.position ?? objRow?.type ?? '';

    if (isAngleMode) {
        fieldAngle = { x: xVal, y: yVal };
        type = 'Angle';
    } else if (isHeightMode) {
        xHeight = xVal;
        yHeight = yVal;
        type = 'Rectangle';
    } else {
        // Fallback: infer from system type.
        if (isInfiniteSystem) {
            fieldAngle = { x: xVal, y: yVal };
            type = 'Angle';
        } else {
            xHeight = xVal;
            yHeight = yVal;
            type = 'Rectangle';
        }
    }

    return {
        id: objRow?.id || index0 + 1,
        type,
        fieldAngle,
        xHeight,
        yHeight,
        objectIndex: index0
    };
}

function sampleUnitDiskPoints({ rings = 4, spokes = 12 } = {}) {
    const pts = [{ x: 0, y: 0 }];
    const rr = Math.max(1, Math.floor(rings));
    const ss = Math.max(4, Math.floor(spokes));

    for (let i = 1; i <= rr; i++) {
        const r = i / rr;
        const m = ss * i;
        for (let k = 0; k < m; k++) {
            const th = (2 * Math.PI * k) / m;
            pts.push({ x: r * Math.cos(th), y: r * Math.sin(th) });
        }
    }
    return pts;
}

function computeZernikeFitLive({ opticalSystemData, wavelengthUm, fieldSetting, zernikeMaxNoll = 15, samplingSize = 32 }) {
    if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
    if (!Number.isFinite(wavelengthUm) || wavelengthUm <= 0) return null;
    if (!fieldSetting || typeof fieldSetting !== 'object') return null;
    const opdCalculator = createOPDCalculator(opticalSystemData, wavelengthUm);
    const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);

    try {
        opdCalculator.setReferenceRay(fieldSetting);
    } catch (_) {
        // If reference ray setup fails, return null.
        return null;
    }

    // **CRITICAL: Use SAME sampling method as OPD Analysis**
    // OPD uses rectangular grid (gridSize × gridSize) with circular mask
    // This ensures IDENTICAL Zernike coefficients between OPD display and Requirements
    const gridSize = samplingSize;
    const pupilRange = 1.0; // Same as OPD Analysis
    
    const pupilCoordinates = [];
    const opds = [];
    
    // Generate rectangular grid with circular mask (same as eva-wavefront.js line 5984)
    for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
            const pupilX = (i / (gridSize - 1)) * 2 * pupilRange - pupilRange;
            const pupilY = (j / (gridSize - 1)) * 2 * pupilRange - pupilRange;
            
            // Check if point is within circular pupil range
            const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
            if (pupilRadius <= pupilRange) {
                let opd = NaN;
                try {
                    // Use reference-sphere OPD (same as OPD Analysis)
                    opd = opdCalculator.calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, false, { fastMarginalRay: true });
                } catch (_) {
                    opd = NaN;
                }
                if (Number.isFinite(opd)) {
                    pupilCoordinates.push({ x: pupilX, y: pupilY, r: pupilRadius });
                    opds.push(opd);
                }
            }
        }
    }

    if (pupilCoordinates.length < 6) {
        try {
            if (typeof window !== 'undefined') {
                window.__cooptLastZernikeLiveDebug = {
                    ok: false,
                    reason: 'insufficient-valid-opd-samples',
                    wavelengthUm,
                    zernikeMaxNoll,
                    fieldSetting,
                    validCount: pupilCoordinates.length
                };
            }
        } catch (_) {}
        return null;
    }

    const wavefrontMap = {
        pupilCoordinates,
        opds
    };

    try {
        const fit = analyzer.fitZernikePolynomials(wavefrontMap, zernikeMaxNoll);
        try {
            if (typeof window !== 'undefined') {
                window.__cooptLastZernikeLiveDebug = {
                    ok: true,
                    wavelengthUm,
                    zernikeMaxNoll,
                    fieldSetting,
                    validSamples: sampled.pupilCoordinates.length,
                    maxNoll: fit?.maxNoll ?? null
                };
            }
        } catch (_) {}
        return fit;
    } catch (_) {
        try {
            if (typeof window !== 'undefined') {
                window.__cooptLastZernikeLiveDebug = {
                    ok: false,
                    reason: 'fit-failed',
                    wavelengthUm,
                    zernikeMaxNoll,
                    fieldSetting,
                    validSamples: sampled.pupilCoordinates.length
                };
            }
        } catch (_) {}
        return null;
    }
}

function fieldSettingCacheKey(fieldSetting) {
    if (!fieldSetting || typeof fieldSetting !== 'object') return 'field:invalid';
    const type = String(fieldSetting.type ?? '').trim();
    const fa = fieldSetting.fieldAngle && typeof fieldSetting.fieldAngle === 'object' ? fieldSetting.fieldAngle : { x: 0, y: 0 };
    const ax = toFiniteNumber(fa.x, 0);
    const ay = toFiniteNumber(fa.y, 0);
    const xh = toFiniteNumber(fieldSetting.xHeight, 0);
    const yh = toFiniteNumber(fieldSetting.yHeight, 0);
    const oi = Number.isFinite(Number(fieldSetting.objectIndex)) ? Math.floor(Number(fieldSetting.objectIndex)) : 0;
    return `type=${type}:oi=${oi}:ax=${ax}:ay=${ay}:xh=${xh}:yh=${yh}`;
}

function parseOverrideKey(variableId) {
    const s = String(variableId ?? '');
    const dot = s.indexOf('.');
    if (dot <= 0) return null;
    const blockId = s.slice(0, dot);
    const key = s.slice(dot + 1);
    if (!blockId || !key) return null;
    return { blockId, key };
}

function applyOverridesToBlocks(blocks, overrides) {
    const cloned = cloneJson(blocks);
    if (!Array.isArray(cloned)) return Array.isArray(blocks) ? blocks : [];
    if (!isPlainObject(overrides)) return cloned;

    const byId = new Map();
    for (const b of cloned) {
        const id = isPlainObject(b) ? String(b.blockId ?? '') : '';
        if (id) byId.set(id, b);
    }

    for (const [varId, rawVal] of Object.entries(overrides)) {
        const parsed = parseOverrideKey(varId);
        if (!parsed) continue;
        const blk = byId.get(String(parsed.blockId));
        if (!blk || !isPlainObject(blk.parameters)) continue;
        const n = Number(rawVal);
        blk.parameters[parsed.key] = Number.isFinite(n) ? n : rawVal;
    }

    return cloned;
}

class MeritFunctionEditor {
    constructor() {
        this.operands = [];
        this.table = null;
        this.totalMeritValue = document.getElementById('total-merit-value');
        this.inspector = new InspectorManager();
        this._runtimeCache = null;
        
        this.loadFromStorage();
        this.initializeTable();
        this.initializeEventListeners();
    }
    
    initializeTable() {
        const operandKeys = (() => {
            try {
                const keys = InspectorManager.getAvailableOperands?.();
                return Array.isArray(keys) ? keys : Object.keys(OPERAND_DEFINITIONS);
            } catch (_) {
                return Object.keys(OPERAND_DEFINITIONS);
            }
        })();

        // Tabulatorカラム定義
        const columns = [
            { title: "Num", field: "id", width: 80, hozAlign: "center", headerSort: true },
            { 
                title: "Evaluation Function", 
                field: "operand", 
                width: 180, 
                editor: "list",
                editorParams: {
                    values: operandKeys.reduce((acc, key) => {
                        acc[key] = OPERAND_DEFINITIONS[key].name;
                        return acc;
                    }, {})
                },
                formatter: (cell) => {
                    const value = cell.getValue();
                    return OPERAND_DEFINITIONS[value]?.name || value;
                },
                cellEdited: (cell) => this.onOperandChange(cell)
            },
            { 
                title: "Config", 
                field: "configId", 
                width: 120, 
                editor: "list",
                editorParams: (cell) => {
                    const configList = this.getConfigurationList();
                    console.log('🔧 Config dropdown opening with values:', configList);
                    return {
                        values: configList
                    };
                },
                formatter: (cell) => {
                    const configId = cell.getValue();
                    if (configId === null || configId === undefined) {
                        return '';
                    }
                    return this.getConfigName(configId) || 'Current';
                },
                hozAlign: "center"
            },
            { title: "-", field: "param1", width: 100, editor: "input", hozAlign: "center" },
            { title: "-", field: "param2", width: 100, editor: "input", hozAlign: "center" },
            { title: "-", field: "param3", width: 100, editor: "input", hozAlign: "center" },
            { title: "-", field: "param4", width: 100, editor: "input", hozAlign: "center" },
            { 
                title: "Target", 
                field: "target", 
                width: 100, 
                editor: "input",
                hozAlign: "center" 
            },
            { 
                title: "Weight", 
                field: "weight", 
                width: 100, 
                editor: "input",
                hozAlign: "center" 
            },
            { 
                title: "Result", 
                field: "value", 
                width: 100, 
                hozAlign: "center",
                formatter: (cell) => {
                    const val = cell.getValue();
                    return val !== null && val !== undefined ? val.toFixed(6) : '-';
                },
                cssClass: "value-cell"
            },
            { 
                title: "Impact", 
                field: "contribution", 
                width: 120, 
                hozAlign: "center",
                formatter: (cell) => {
                    const val = cell.getValue();
                    return val !== null && val !== undefined ? val.toFixed(2) + '%' : '-';
                },
                cssClass: "contribution-cell"
            }
        ];

        // Tabulator初期化
        this.table = new Tabulator("#table-merit-function", {
            data: this.operands,
            columns: columns,
            layout: "fitColumns",
            height: "400px",
            selectable: true
        });
        
        // 行クリック時に選択状態を1つだけにする（Optical Systemと同様）
        this.table.on("rowClick", (e, row) => {
            try {
                // すべての選択を解除
                this.table.deselectRow();
                // クリックした行のみ選択
                row.select();
            } catch (error) {
                console.warn("Row click error:", error);
            }
        });
        
        // 行選択時にインスペクターを表示し、パラメータカラムヘッダーを更新
        this.table.on("rowSelected", (row) => {
            this.inspector.show(row.getData());
            this.updateParameterHeaders(row.getData());
        });
        
        // 行選択解除時にインスペクターを非表示し、パラメータカラムヘッダーをデフォルトに戻す
        this.table.on("rowDeselected", () => {
            this.inspector.hide();
            this.resetParameterHeaders();
        });
        
        // セル編集時に自動保存
        this.table.on("cellEdited", (cell) => {
            this.saveToStorage();
        });
    }

    initializeEventListeners() {
        document.getElementById('add-operand-btn').addEventListener('click', () => this.addOperand());
        document.getElementById('delete-operand-btn').addEventListener('click', () => this.deleteOperand());
        document.getElementById('calculate-merit-btn').addEventListener('click', (e) => {
            // Tabulatorの再描画やフォーカス移動でページが上下にズレることがあるため、スクロール位置を保持する
            const scrollY = (typeof window !== 'undefined' && typeof window.scrollY === 'number') ? window.scrollY : null;
            const activeEl = (typeof document !== 'undefined') ? document.activeElement : null;

            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

            this.calculateMerit();

            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    try {
                        if (scrollY !== null && typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
                            window.scrollTo(0, scrollY);
                        }
                        if (activeEl && typeof activeEl.focus === 'function') {
                            try {
                                activeEl.focus({ preventScroll: true });
                            } catch {
                                activeEl.focus();
                            }
                        }
                    } catch {
                        // noop
                    }
                });
            }
        });
    }

    onOperandChange(cell) {
        const operand = cell.getValue();
        const definition = OPERAND_DEFINITIONS[operand];
        
        if (definition) {
            console.log(`オペランド変更: ${operand} - ${definition.description}`);
        }
    }

    addOperand(operandType = null, params = {}) {
        // デフォルトはアクティブなConfiguration
        let defaultConfigId = "";
        try {
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
            if (systemConfig && systemConfig.activeConfigId) {
                defaultConfigId = String(systemConfig.activeConfigId);
            }
        } catch (error) {
            console.warn('Active config ID取得エラー:', error);
        }
        
        const newOperand = {
            id: this.operands.length + 1,
            operand: operandType,  // nullを許可
            configId: params.configId ? String(params.configId) : null,
            param1: params.param1 || "",
            param2: params.param2 || "",
            param3: params.param3 || "",
            param4: params.param4 || "",
            target: params.target || "",
            weight: params.weight || "",
            value: null,
            contribution: null
        };

        // 選択行を取得
        const selectedRows = this.table.getSelectedRows();
        
        if (selectedRows.length > 0) {
            // 選択行がある場合、最初の選択行の次の位置に挿入
            const selectedRow = selectedRows[0];
            const selectedIndex = this.operands.findIndex(op => op.id === selectedRow.getData().id);
            
            if (selectedIndex !== -1) {
                // 配列に挿入
                this.operands.splice(selectedIndex + 1, 0, newOperand);
                this.updateRowNumbers();
                
                // テーブルに挿入（選択行の下）
                this.table.addRow(newOperand, false, selectedRow);
            } else {
                // 見つからない場合は末尾に追加
                this.operands.push(newOperand);
                this.updateRowNumbers();
                this.table.addRow(newOperand);
            }
        } else {
            // 選択行がない場合は末尾に追加
            this.operands.push(newOperand);
            this.updateRowNumbers();
            this.table.addRow(newOperand);
        }
        
        this.saveToStorage();
    }

    deleteOperand() {
        const selectedRows = this.table.getSelectedRows();
        
        if (selectedRows.length === 0) {
            alert('削除する行を選択してください');
            return;
        }

        selectedRows.forEach(row => {
            const index = this.operands.findIndex(op => op.id === row.getData().id);
            if (index !== -1) {
                this.operands.splice(index, 1);
            }
        });

        this.updateRowNumbers();
        this.table.setData(this.operands);
        this.saveToStorage();
    }

    updateRowNumbers() {
        this.operands.forEach((op, index) => {
            op.id = index + 1;
        });
    }

    calculateMerit() {
        console.log('🧮 Merit Function計算中...');

        // 1回の計算実行内で重い計算（Seidel等）を使い回す
        this._runtimeCache = new Map();
        
        let totalMerit = 0;
        const values = [];

        // 各オペランドの値を計算
        this.operands.forEach(op => {
            // 実際の光学計算に置き換える
            const calculatedValue = this.calculateOperandValue(op);

            const targetRaw = Number(op.target);
            const weightRaw = Number(op.weight);
            const target = Number.isFinite(targetRaw) ? targetRaw : 0;
            const weight = Number.isFinite(weightRaw) ? weightRaw : 1;

            const error = calculatedValue - target;
            const weightedError = error * error * weight;
            
            op.value = calculatedValue;
            values.push(weightedError);
            totalMerit += weightedError;
        });

        // 寄与率を計算
        this.operands.forEach((op, index) => {
            op.contribution = totalMerit > 0 ? (values[index] / totalMerit) * 100 : 0;
        });

        this.table.setData(this.operands);
        this.totalMeritValue.textContent = totalMerit.toFixed(6);
        this.saveToStorage();
        
        console.log('✅ Merit Function計算完了:', totalMerit);

        // 使い回しキャッシュを破棄
        this._runtimeCache = null;
    }

    /**
     * UIを更新せず、総Merit値のみを返す（最適化ループ向け）。
     * @returns {number}
     */
    calculateMeritValueOnly() {
        // 1回の計算実行内で重い計算（Seidel等）を使い回す
        this._runtimeCache = new Map();

        try {
            let totalMerit = 0;

            for (const op of this.operands) {
                if (!op || !op.operand) continue;

                const calculatedValue = this.calculateOperandValue(op);

                const targetRaw = Number(op.target);
                const weightRaw = Number(op.weight);
                const target = Number.isFinite(targetRaw) ? targetRaw : 0;
                const weight = Number.isFinite(weightRaw) ? weightRaw : 1;

                const error = calculatedValue - target;
                const weightedError = error * error * weight;
                totalMerit += weightedError;
            }

            return totalMerit;
        } finally {
            // 使い回しキャッシュを破棄
            this._runtimeCache = null;
        }
    }

    /**
     * UIを更新せず、各オペランドの内訳（value/target/error/term/impact%）を返す。
     * DLS/LM 等で残差ベクトル r(x) を構成する用途を想定。
     *
     * 定義:
     *   error = value - target
     *   term  = error^2 * weight
     *   impactPct = 100 * term / sum(term)
     *   weightedResidual = sqrt(weight) * error  (weight >= 0 のとき)
     *
     * @returns {{ total: number, terms: Array<{ id:any, operand:any, configId:any, value:number, target:number, weight:number, error:number, term:number, impactPct:number, weightedResidual:number, sqrtWeight:number }> }}
     */
    calculateMeritBreakdownOnly() {
        // 1回の計算実行内で重い計算（Seidel等）を使い回す
        this._runtimeCache = new Map();

        try {
            /** @type {Array<{ id:any, operand:any, configId:any, value:number, target:number, weight:number, error:number, term:number, impactPct:number, weightedResidual:number, sqrtWeight:number }>} */
            const terms = [];

            let total = 0;

            for (const op of this.operands) {
                if (!op || !op.operand) continue;

                const value = this.calculateOperandValue(op);

                const targetRaw = Number(op.target);
                const weightRaw = Number(op.weight);
                const target = Number.isFinite(targetRaw) ? targetRaw : 0;
                const weight = Number.isFinite(weightRaw) ? weightRaw : 1;

                const error = value - target;
                const term = error * error * weight;
                total += term;

                const sqrtWeight = (weight >= 0) ? Math.sqrt(weight) : NaN;
                const weightedResidual = Number.isFinite(sqrtWeight) ? (sqrtWeight * error) : NaN;

                terms.push({
                    id: op.id,
                    operand: op.operand,
                    configId: op.configId,
                    value,
                    target,
                    weight,
                    error,
                    term,
                    impactPct: 0,
                    weightedResidual,
                    sqrtWeight
                });
            }

            const denom = total;
            if (Number.isFinite(denom) && denom > 0) {
                for (const t of terms) {
                    t.impactPct = (t.term / denom) * 100;
                }
            } else {
                for (const t of terms) {
                    t.impactPct = 0;
                }
            }

            return { total, terms };
        } finally {
            // 使い回しキャッシュを破棄
            this._runtimeCache = null;
        }
    }

    calculateOperandValue(operand) {
        // Get optical system data for operand's config (respects scenarios for each config)
        const opticalSystemData = this.getOpticalSystemDataByConfigId(operand.configId);

        // Spot Size operands can mirror the Spot Diagram algorithm and settings.
        // However, the Spot Diagram *tables* are always the active configuration.
        // So when evaluating a non-active config, we must NOT read live UI tables.
        const isOperandActiveConfig = (() => {
            try {
                const opCfg = (operand && operand.configId !== undefined && operand.configId !== null)
                    ? String(operand.configId).trim()
                    : '';
                // Blank means "Current" (active)
                if (!opCfg) return true;
                const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
                if (!raw) return false;
                const sys = JSON.parse(raw);
                const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId)
                    : '';
                return !!activeId && opCfg === activeId;
            } catch (_) {
                return false;
            }
        })();

        // Distinguish "Current" vs explicit config selection.
        // Only "Current" is allowed to read live UI tables.
        const isCurrentOperand = (() => {
            try {
                const opCfg = (operand && operand.configId !== undefined && operand.configId !== null)
                    ? String(operand.configId).trim()
                    : '';
                return opCfg === '';
            } catch (_) {
                return true;
            }
        })();
        
        const meritFast = (() => {
            try {
                const m = (typeof globalThis !== 'undefined') ? globalThis.__cooptMeritFastMode : null;
                return (m && typeof m === 'object' && m.enabled) ? m : null;
            } catch {
                return null;
            }
        })();

        switch (operand.operand) {
            case 'FL':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'FL');
            case 'EFL':
                return this.calculateEFLWithBlockSelection(operand, opticalSystemData);
            case 'BFL':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'BFL');
            case 'IMD':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'IMD');
            case 'OBJD':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'OBJD');
            case 'TSL':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'TSL');
            case 'BEXP':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'BEXP');
            case 'EXPD':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'EXPD');
            case 'EXPP':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'EXPP');
            case 'ENPD':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'ENPD');
            case 'ENPP':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'ENPP');
            case 'ENPM':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'ENPM');
            case 'PMAG':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'PMAG');
            case 'FNO_OBJ':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'FNO_OBJ');
            case 'FNO_IMG':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'FNO_IMG');
            case 'FNO_WRK':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'FNO_WRK');
            case 'NA_OBJ':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'NA_OBJ');
            case 'NA_IMG':
                return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'NA_IMG');
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
            // Deprecated / non-functional operands: keep deterministic to avoid broken merit evaluation.
            // They are also hidden from the UI operand dropdown.
            case 'REAY':
            case 'RSCE':
            case 'TRAC':
            case 'DIST':
                return 0;
            case 'CLRH':
                return this.calculateClearanceVsSemidia(operand, opticalSystemData);
            case 'SPOT_SIZE_ANNULAR':
                // Spot Diagram-aligned spot size, forced to Annular.
                return this.calculateSpotSizeUm(operand, opticalSystemData, {
                    pattern: 'annular',
                    annularRingCount: meritFast ? meritFast.spotAnnularRingCount : 10,
                    rayCountOverride: meritFast ? meritFast.spotRayCount : null,
                    // IMPORTANT: when running under a fast-mode object, missing flags must NOT
                    // silently flip semantics. Default to semantic-aligned behavior.
                    useUiDefaults: meritFast ? (meritFast.spotUseUiDefaults !== false) : true,
                    // Allow live UI tables whenever the operand targets the active config.
                    // (Config dropdown may explicitly name the active config, e.g. 'Wide'.)
                    useUiTables: meritFast ? (meritFast.spotUseUiTables === true) : isOperandActiveConfig
                });
            case 'SPOT_SIZE_RECT':
                // "Rectangle" in UI corresponds to grid sampling in ray-renderer.
                // Spot Diagram-aligned spot size, forced to Rectangle/Grid.
                return this.calculateSpotSizeUm(operand, opticalSystemData, {
                    pattern: 'grid',
                    rayCountOverride: meritFast ? meritFast.spotRayCount : null,
                    useUiDefaults: meritFast ? (meritFast.spotUseUiDefaults !== false) : true,
                    // Allow live UI tables whenever the operand targets the active config.
                    useUiTables: meritFast ? (meritFast.spotUseUiTables === true) : isOperandActiveConfig
                });
            case 'SPOT_SIZE_CURRENT':
                // Backward compatibility: this operand was removed from the UI.
                // Migrate its behavior to Annular to keep older saved Requirements functional.
                return this.calculateSpotSizeUm(operand, opticalSystemData, {
                    pattern: 'annular',
                    annularRingCount: meritFast ? meritFast.spotAnnularRingCount : 10,
                    rayCountOverride: meritFast ? meritFast.spotRayCount : null,
                    useUiDefaults: meritFast ? (meritFast.spotUseUiDefaults !== false) : true,
                    // Allow live UI tables whenever the operand targets the active config.
                    useUiTables: meritFast ? (meritFast.spotUseUiTables === true) : isOperandActiveConfig
                });
            case 'LA_RMS_UM':
                return this.calculateLongitudinalAberrationRmsUm(operand, opticalSystemData);
            case 'ZERN_COEFF': {
                const FAIL = 1e9;
                
                // New parameter order: λ idx, Object idx, Unit, Sampling, n (Noll)
                const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand?.configId);
                
                // param1: λ idx (1-based, blank=Primary)
                const wavelength = this.getSystemWavelengthFromOperandOrPrimary({ param1: operand?.param1 }, sourceRows);
                
                // param2: Object idx (1-based, default 1)
                const fieldIdx1 = Number.isFinite(Number(operand?.param2)) ? Math.max(1, Math.floor(Number(operand.param2))) : 1;
                const objRow = Array.isArray(objectRows) ? objectRows[Math.max(0, Math.min(objectRows.length - 1, fieldIdx1 - 1))] : null;
                const isInf = isInfiniteSystemFromRows(opticalSystemData);
                const fieldSetting = toFieldSettingFromObjectRow(objRow || {}, fieldIdx1 - 1, isInf);
                
                // param3: Unit (waves or um)
                const unit = parseZernikeUnit(operand?.param3);
                
                // param4: Sampling (grid size, default 32)
                const samplingSize = Number.isFinite(Number(operand?.param4)) && Number(operand.param4) > 0 
                    ? Math.floor(Number(operand.param4)) 
                    : 32;
                
                // param5: n (Noll) - coefficient index
                const param5Value = operand?.param5;
                const nollRaw = param5Value !== undefined && param5Value !== null && String(param5Value).trim() !== '' 
                    ? Number(param5Value) 
                    : 0;  // Default to 0 (RMS) if not specified
                
                if (!Number.isFinite(nollRaw)) return FAIL;
                const noll = Math.floor(nollRaw);
                if (noll < 0) return FAIL;

                // CRITICAL: Use EXACT SAME wavefrontMap as OPD Analysis if available
                // This ensures 100% identical Zernike coefficients
                const useExistingOPDMap = (typeof window !== 'undefined' && window.__lastWavefrontMap?.zernike);
                
                let zernike = null;
                let coeffWaves = null;
                let coeffUm = null;
                
                if (useExistingOPDMap) {
                    // Use the SAME wavefrontMap that OPD Analysis calculated
                    const existingMap = window.__lastWavefrontMap;
                    console.log('[ZERN_COEFF] Using existing OPD wavefrontMap:');
                    console.log('[ZERN_COEFF]   - pupilCoordinates count:', existingMap?.pupilCoordinates?.length);
                    console.log('[ZERN_COEFF]   - raw.opds count:', existingMap?.raw?.opds?.length);
                    console.log('[ZERN_COEFF]   - zernike.maxNoll:', existingMap?.zernike?.maxNoll);
                    console.log('[ZERN_COEFF]   - gridSizeRequested:', existingMap?.gridSizeRequested);
                    console.log('[ZERN_COEFF]   - Sample coefficients (OSA indexed):');
                    const coeffs = existingMap?.zernike?.coefficientsWaves;
                    if (coeffs) {
                        for (let i = 0; i <= 10; i++) {
                            console.log(`[ZERN_COEFF]     OSA ${i}:`, coeffs[i]);
                        }
                    }
                    
                    zernike = existingMap.zernike;
                    coeffWaves = zernike?.coefficientsWaves || null;
                    coeffUm = zernike?.coefficientsMicrons || null;
                } else {
                    // Fallback: compute our own Zernike fit
                    const cfgKey = operand?.configId ? String(operand.configId) : 'active';
                    const maxNollRequested = 37;
                    const cacheKey = `zernike-opd:${cfgKey}:wl=${wavelength}:max=${maxNollRequested}:grid=${samplingSize}:${fieldSettingCacheKey(fieldSetting)}`;
                    zernike = (() => {
                        const cached = this._runtimeCache ? this._runtimeCache.get(cacheKey) : null;
                        if (cached) return cached;
                        const fit = computeZernikeFitLive({ opticalSystemData, wavelengthUm: wavelength, fieldSetting, zernikeMaxNoll: maxNollRequested, samplingSize });
                        if (fit && this._runtimeCache) this._runtimeCache.set(cacheKey, fit);
                        return fit;
                    })();
                    if (!zernike) return FAIL;
                    
                    coeffWaves = zernike?.coefficientsWaves || null;
                    coeffUm = zernike?.coefficientsMicrons || null;
                }
                
                if (!zernike) return FAIL;

                const readCoeff = (container, osaIndex) => {
                    if (!container || typeof container !== 'object') return null;
                    const v = container[osaIndex];
                    return (v !== undefined && v !== null && Number.isFinite(Number(v))) ? Number(v) : null;
                };

                const nollToOSA = (nollIndex) => {
                    if (nollIndex === 0) return -1;
                    const jj = Math.floor(Number(nollIndex));
                    if (!Number.isFinite(jj) || jj < 1) return -1;
                    
                    // Noll → (n,m) conversion (from eva-wavefront.js nollToNM_deprecated)
                    let n = 0;
                    while (((n + 1) * (n + 2)) / 2 < jj) n++;
                    const j0 = (n * (n + 1)) / 2 + 1;
                    const k = jj - j0; // 0..n
                    const m = -n + 2 * k;
                    
                    // (n,m) → OSA index
                    const osaIndex = (n * (n + 2) + m) / 2;
                    return Math.floor(osaIndex);
                };

                const maxNoll = Number(zernike?.maxNoll);
                const termMax = Number.isFinite(maxNoll) ? Math.max(1, Math.floor(maxNoll)) : null;

                const getCoeffInUnit = (nollIndex) => {
                    const osaIndex = nollToOSA(nollIndex);
                    if (osaIndex < 0) return null;
                    
                    if (unit === 'um') {
                        const direct = readCoeff(coeffUm, osaIndex);
                        if (direct !== null) return direct;
                        const w = readCoeff(coeffWaves, osaIndex);
                        if (w === null) return null;
                        if (!(Number.isFinite(wavelength) && wavelength > 0)) return null;
                        return w * wavelength;
                    }
                    return readCoeff(coeffWaves, osaIndex);
                };

                if (noll === 0) {
                    let sumSq = 0;
                    if (termMax !== null) {
                        for (let j = 4; j <= termMax; j++) {
                            const c = getCoeffInUnit(j);
                            if (c === null) continue;
                            sumSq += c * c;
                        }
                        return Number.isFinite(sumSq) ? Math.sqrt(sumSq) : FAIL;
                    }
                    const container = (unit === 'um' && coeffUm) ? coeffUm : coeffWaves;
                    if (!container || typeof container !== 'object') return FAIL;
                    for (const [k, v] of Object.entries(container)) {
                        const j = Number(k);
                        if (!Number.isFinite(j) || j < 4) continue;
                        const c = getCoeffInUnit(Math.floor(j));
                        if (c === null) continue;
                        sumSq += c * c;
                    }
                    return Number.isFinite(sumSq) ? Math.sqrt(sumSq) : FAIL;
                }

                const c = getCoeffInUnit(noll);
                return (c === null) ? FAIL : c;
            }
            default:
                return 0;
        }
    }

    calculateEFLWithBlockSelection(operand, opticalSystemData) {
        // Default: full system EFL (System Data definition)
        const selRaw = (operand && operand.param2 !== undefined && operand.param2 !== null)
            ? String(operand.param2).trim()
            : '';
        if (!selRaw || /^all$/i.test(selRaw) || /^full$/i.test(selRaw)) {
            return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'EFL');
        }

        if (!Array.isArray(opticalSystemData) || opticalSystemData.length < 3) {
            return 0;
        }

        // Requires block provenance on rows.
        const hasProvenance = (() => {
            try {
                return opticalSystemData.some(r => r && typeof r === 'object' && r._blockId !== undefined && r._blockId !== null && String(r._blockId).trim() !== '');
            } catch (_) {
                return false;
            }
        })();
        if (!hasProvenance) {
            // Fallback: can't slice by blocks, so return full system EFL.
            return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'EFL');
        }

        const tokens = selRaw.split(/[,\s]+/).map(s => String(s).trim()).filter(Boolean);
        if (tokens.length === 0) {
            return this.calculatePrimarySystemMetric(operand, opticalSystemData, 'EFL');
        }
        const selectedIds = new Set(tokens);

        // Build a subsystem by extracting the selected block surfaces in system order.
        const picked = [];
        for (let i = 1; i < opticalSystemData.length - 1; i++) {
            const row = opticalSystemData[i];
            if (!row || typeof row !== 'object') continue;
            const bid = String(row._blockId ?? '').trim();
            if (!bid) continue;
            if (!selectedIds.has(bid)) continue;
            picked.push({ ...row });
        }

        if (picked.length === 0) {
            return 0;
        }

        // Avoid carrying a thickness that jumps into a non-selected block.
        try {
            picked[picked.length - 1] = { ...picked[picked.length - 1], thickness: 0 };
        } catch (_) {}

        const objectRowBase = (opticalSystemData[0] && typeof opticalSystemData[0] === 'object')
            ? { ...opticalSystemData[0] }
            : { 'object type': 'Object', thickness: 'INF', comment: 'Object' };
        // Subsystem EFL definition: evaluate as if object at infinity.
        const objectRow = { ...objectRowBase, thickness: 'INF' };
        const imageRow = { 'object type': 'Image', thickness: 0, comment: 'Image' };
        const subsystem = [objectRow, ...picked, imageRow];

        const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
        const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);

        const trace = calculateFullSystemParaxialTrace(subsystem, wavelength);
        const alpha = Number(trace?.finalAlpha);
        if (!Number.isFinite(alpha) || Math.abs(alpha) <= 1e-12) return 0;
        return 1.0 / alpha;
    }

    calculateLongitudinalAberrationRmsUm(operand, opticalSystemData) {
        try {
            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 1e9;

            const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
            const wavelength = this.getSystemWavelengthFromOperandOrPrimary({ param1: operand?.param1 }, sourceRows);
            if (!Number.isFinite(wavelength) || wavelength <= 0) return 1e9;

            let imageSurfaceIndex = -1;
            for (let i = 0; i < opticalSystemData.length; i++) {
                const t = opticalSystemData[i]?.surfType;
                if (t && String(t).toLowerCase() === 'image') {
                    imageSurfaceIndex = i;
                    break;
                }
            }
            if (imageSurfaceIndex < 0) imageSurfaceIndex = opticalSystemData.length - 1;
            if (imageSurfaceIndex < 0) return 1e9;

            const rayCount = 51;

            const aberr = calculateLongitudinalAberration(
                opticalSystemData,
                imageSurfaceIndex,
                [wavelength],
                rayCount,
                { silent: true }
            );

            const points = aberr?.meridionalData?.[0]?.points;
            if (!Array.isArray(points) || points.length < 2) return 1e9;

            const pts = points
                .map(p => ({
                    r: Number(p?.pupilCoordinate),
                    L: Number(p?.longitudinalAberration)
                }))
                .filter(p => Number.isFinite(p.r) && Number.isFinite(p.L))
                .sort((a, b) => a.r - b.r);

            if (pts.length < 2) return 1e9;

            // Area-weighted mean and RMS about mean over pupil: weight is 2r dr.
            const r0 = pts[0].r;
            const rN = pts[pts.length - 1].r;
            const denom = (rN * rN) - (r0 * r0);
            if (!(denom > 0)) return 1e9;

            let sumL = 0;
            let sumL2 = 0;
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i];
                const b = pts[i + 1];
                const w = (b.r * b.r) - (a.r * a.r);
                if (!(w > 0)) continue;
                const avgL = 0.5 * (a.L + b.L);
                const avgL2 = 0.5 * ((a.L * a.L) + (b.L * b.L));
                sumL += avgL * w;
                sumL2 += avgL2 * w;
            }

            const meanL = sumL / denom;
            const meanL2 = sumL2 / denom;
            const variance = meanL2 - (meanL * meanL);
            const rmsMm = Math.sqrt(Math.max(0, variance));
            const rmsUm = rmsMm * 1000;

            return Number.isFinite(rmsUm) ? rmsUm : 1e9;
        } catch (_) {
            return 1e9;
        }
    }

    calculateSpotSizeUm(operand, opticalSystemData, options = null) {
        const __spotDebugState = {};
        const stampSpotDebug = (patch) => {
            try {
                if (typeof window === 'undefined') return;
                const next = Object.assign(__spotDebugState, patch || {});
                window.__cooptLastSpotSizeDebug = next;

                // Keep per-operand snapshots so we can inspect the failing requirement later
                // even if another evaluation overwrites the global debug object.
                try {
                    const key = `operand:${String(next.operand ?? '')}|cfg:${String(next.configId ?? '')}`
                        + `|p1:${String(next.param1 ?? '')}|p2:${String(next.param2 ?? '')}`
                        + `|p3:${String(next.param3 ?? '')}|p4:${String(next.param4 ?? '')}`;
                    const byKey = (window.__cooptSpotSizeDebugByKey && typeof window.__cooptSpotSizeDebugByKey === 'object')
                        ? window.__cooptSpotSizeDebugByKey
                        : {};
                    byKey[key] = next;
                    window.__cooptSpotSizeDebugByKey = byKey;

                    if (next && next.fastModeEnabled === true) {
                        const fastByKey = (window.__cooptSpotSizeDebugFastByKey && typeof window.__cooptSpotSizeDebugFastByKey === 'object')
                            ? window.__cooptSpotSizeDebugFastByKey
                            : {};
                        fastByKey[key] = next;
                        window.__cooptSpotSizeDebugFastByKey = fastByKey;
                    }
                } catch (_) {}

                // Keep a separate snapshot for fast-mode (optimizer) evaluations so it isn't
                // overwritten by later UI-triggered spot evaluations.
                if (next && next.fastModeEnabled === true) {
                    window.__cooptLastSpotSizeDebugFast = next;
                }
            } catch (_) {}
        };

        try {
            const spotEvalStartAt = Date.now();
            const getLastRayTraceFailureForThisEval = () => {
                try {
                    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
                    const f = g ? (g.__cooptLastRayTraceFailure ?? null) : null;
                    if (!f || typeof f !== 'object') return null;
                    const at = Number(f.at);
                    if (!Number.isFinite(at)) return null;
                    // Accept only failures that happened at/after this spot evaluation started.
                    // (This avoids showing stale failures from previous traces.)
                    return at >= spotEvalStartAt ? f : null;
                } catch {
                    return null;
                }
            };

            stampSpotDebug({
                ok: false,
                reason: 'started',
                at: spotEvalStartAt,
                operand: operand?.operand ?? null,
                configId: (operand && operand.configId !== undefined && operand.configId !== null) ? String(operand.configId) : '',
                param1: operand?.param1 ?? null,
                param2: operand?.param2 ?? null,
                param3: operand?.param3 ?? null,
                param4: operand?.param4 ?? null,
                impl: null,
                pattern: options && typeof options === 'object' ? (options.pattern ?? null) : null,
                useUiDefaults: null,
                useUiTables: null,
                isOperandActiveConfig: null,
                activeConfigId: null,
                targetSurfaceIndex: null,
                rayCountRequested: null,
                rayStartsGenerated: null,
                hits: null,
                legacyFallbackHits: null,
                wavelength: null,
                fastModeEnabled: null,
                apertureLimitMm: null,
                retryRayCount: null,
                retryApertureLimitMm: null,
                retryRayStartsGenerated: null,
                retryHits: null,
                earlyAbortReason: null,
                earlyAbortAttempted: null,
                earlyAbortHits: null,
                earlyAbortHitRate: null,
                failPenaltyUm: null,
                failPenaltyKind: null,
                failPenaltyRatio: null,
                lastRayTraceFailure: null,
                resultUm: null
            });

            if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) {
                stampSpotDebug({ reason: 'no-optical-system' });
                return 1e9;
            }

            const pattern = options && typeof options === 'object' ? String(options.pattern ?? '').trim().toLowerCase() : '';
            const useUiDefaults = !!(options && typeof options === 'object' && options.useUiDefaults);
            const useUiTables = (options && typeof options === 'object' && options.useUiTables !== undefined)
                ? !!options.useUiTables
                : useUiDefaults;
            const annularRingCountOverride = (options && typeof options === 'object' && options.annularRingCount !== undefined)
                ? Number(options.annularRingCount)
                : null;
            const rayCountOverride = (options && typeof options === 'object' && options.rayCountOverride !== undefined)
                ? Number(options.rayCountOverride)
                : null;

            stampSpotDebug({ pattern, useUiDefaults, useUiTables });

            try {
                // When called from System Requirements, operand carries metadata about the row.
                stampSpotDebug({
                    reqRowId: operand?.__reqRowId ?? null,
                    reqRowIndex: operand?.__reqRowIndex ?? null,
                    reqOp: operand?.__reqOp ?? null,
                    reqTarget: operand?.__reqTarget ?? null,
                    reqTol: operand?.__reqTol ?? null,
                    reqWeight: operand?.__reqWeight ?? null,
                    reqEnabled: operand?.__reqEnabled ?? null
                });
            } catch (_) {}

            const isOperandActiveConfig = (() => {
                try {
                    const opCfg = (operand && operand.configId !== undefined && operand.configId !== null)
                        ? String(operand.configId).trim()
                        : '';
                    if (!opCfg) return true;
                    if (typeof localStorage === 'undefined') return false;
                    const raw = localStorage.getItem('systemConfigurations');
                    if (!raw) return false;
                    const sys = JSON.parse(raw);
                    const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                        ? String(sys.activeConfigId)
                        : '';
                    return !!activeId && opCfg === activeId;
                } catch {
                    return false;
                }
            })();

            try {
                const activeConfigId = (() => {
                    try {
                        if (typeof localStorage === 'undefined') return '';
                        const raw = localStorage.getItem('systemConfigurations');
                        if (!raw) return '';
                        const sys = JSON.parse(raw);
                        return (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                            ? String(sys.activeConfigId).trim()
                            : '';
                    } catch (_) {
                        return '';
                    }
                })();
                stampSpotDebug({ isOperandActiveConfig, activeConfigId });
            } catch (_) {}

            const lastSpotSettings = (() => {
                if (!useUiDefaults) return null;
                try {
                    if (typeof localStorage === 'undefined') return null;

                    const getActiveConfigId = () => {
                        try {
                            const sysRaw = localStorage.getItem('systemConfigurations');
                            if (!sysRaw) return '';
                            const sys = JSON.parse(sysRaw);
                            return (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                                ? String(sys.activeConfigId).trim()
                                : '';
                        } catch (_) {
                            return '';
                        }
                    };

                    const loadPerConfig = (cfgId) => {
                        try {
                            if (!cfgId) return null;
                            // CRITICAL: Prefer in-memory cache (updated immediately after CB insertion)
                            // over localStorage (may have stale data during the same evaluation cycle).
                            const memCache = (typeof window !== 'undefined') ? window.__cooptSpotDiagramSettingsByConfigId : null;
                            if (memCache && typeof memCache === 'object') {
                                const s = memCache[String(cfgId)];
                                if (s && typeof s === 'object') return s;
                            }
                            const rawMap = localStorage.getItem('spotDiagramSettingsByConfigId');
                            if (!rawMap) return null;
                            const map = JSON.parse(rawMap) || {};
                            const s = map && typeof map === 'object' ? map[String(cfgId)] : null;
                            return (s && typeof s === 'object') ? s : null;
                        } catch (_) {
                            return null;
                        }
                    };

                    const raw = localStorage.getItem('lastSpotDiagramSettings');
                    if (!raw) return null;
                    const parsed = JSON.parse(raw);
                    const settingsCfg = (parsed && parsed.configId !== undefined && parsed.configId !== null)
                        ? String(parsed.configId).trim()
                        : '';
                    const operandCfg = (operand && operand.configId !== undefined && operand.configId !== null)
                        ? String(operand.configId).trim()
                        : '';

                    const activeId = getActiveConfigId();

                    if (!operandCfg) {
                        const ok = (!settingsCfg) || (activeId && settingsCfg === activeId);
                        if (ok) return parsed;

                        // Fallback: per-config settings for the active config.
                        return activeId ? loadPerConfig(activeId) : null;
                    }

                    // For non-active configs, prefer per-config settings.
                    const per = loadPerConfig(operandCfg);
                    if (per) return per;

                    // Legacy fallback: lastSpotDiagramSettings may still match.
                    if (settingsCfg && settingsCfg === operandCfg) return parsed;

                    // If last settings were stored as "Current" (configId empty), allow them when
                    // the operand targets the currently active config.
                    if (!settingsCfg && activeId && activeId === operandCfg) return parsed;

                    return null;
                } catch (_) {
                    return null;
                }
            })();

            const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand?.configId);

            const operandCfgId = (() => {
                try {
                    const v = (operand && operand.configId !== undefined && operand.configId !== null)
                        ? String(operand.configId).trim()
                        : '';
                    return v;
                } catch {
                    return '';
                }
            })();

            const getUiTableRowsForSpot = () => {
                try {
                    if (!useUiTables) return { optical: null, object: null, source: null };
                    const tableOpt = getTableOpticalSystem?.();
                    const tableObj = getTableObject?.();
                    const tableSrc = getTableSource?.();

                    const optRows = getOpticalSystemRows?.(tableOpt);
                    const objRows = getObjectRows?.(tableObj);
                    const srcRows = getSourceRows?.(tableSrc);

                    return {
                        optical: Array.isArray(optRows) && optRows.length > 0 ? optRows : null,
                        object: Array.isArray(objRows) && objRows.length > 0 ? objRows : null,
                        source: Array.isArray(srcRows) && srcRows.length > 0 ? srcRows : null
                    };
                } catch (_) {
                    return { optical: null, object: null, source: null };
                }
            };

            // Cache for Spot Size: store/reuse last-known live tables per configId.
            // This allows evaluating a non-active config without requiring it to be currently active.
            const SPOT_TABLES_CACHE_KEY = 'spotSizeTablesByConfigId';
            const loadSpotTablesCache = (cfgId) => {
                try {
                    if (!cfgId || typeof localStorage === 'undefined') return null;
                    const raw = localStorage.getItem(SPOT_TABLES_CACHE_KEY);
                    if (!raw) return null;
                    const map = JSON.parse(raw) || {};
                    const entry = map && typeof map === 'object' ? map[String(cfgId)] : null;
                    if (!entry || typeof entry !== 'object') return null;
                    const optical = Array.isArray(entry.optical) && entry.optical.length > 0 ? entry.optical : null;
                    const object = Array.isArray(entry.object) && entry.object.length > 0 ? entry.object : null;
                    const source = Array.isArray(entry.source) && entry.source.length > 0 ? entry.source : null;
                    if (!optical && !object && !source) return null;
                    return { optical, object, source, updatedAt: entry.updatedAt };
                } catch (_) {
                    return null;
                }
            };
            const saveSpotTablesCache = (cfgId, tables) => {
                try {
                    if (!cfgId || typeof localStorage === 'undefined') return;
                    if (!tables || typeof tables !== 'object') return;
                    const optical = Array.isArray(tables.optical) ? tables.optical : null;
                    const object = Array.isArray(tables.object) ? tables.object : null;
                    const source = Array.isArray(tables.source) ? tables.source : null;
                    if (!optical && !object && !source) return;
                    const raw = localStorage.getItem(SPOT_TABLES_CACHE_KEY);
                    const map = raw ? (JSON.parse(raw) || {}) : {};
                    map[String(cfgId)] = {
                        optical,
                        object,
                        source,
                        updatedAt: Date.now()
                    };
                    localStorage.setItem(SPOT_TABLES_CACHE_KEY, JSON.stringify(map));
                } catch (_) {
                    // ignore
                }
            };

            // Spot Diagram always uses the primary wavelength. To match it, SPOT_SIZE_CURRENT uses primary as well.
            // (Other spot operands can still use param1-based wavelength selection.)
            const forceSpotDiagramPrimary = useUiDefaults && (pattern === 'current' || pattern === '');
            const wlFromSettings = Number(lastSpotSettings?.primaryWavelengthUm);
            const wavelength = forceSpotDiagramPrimary
                ? (Number.isFinite(wlFromSettings) && wlFromSettings > 0 ? wlFromSettings : this.getPrimaryWavelengthFromSourceRows(sourceRows))
                : this.getSystemWavelengthFromOperandOrPrimary({ param1: operand?.param1 }, sourceRows);

            stampSpotDebug({ wavelength });

            const fieldIdx1 = Number.isFinite(Number(operand?.param2)) ? Math.floor(Number(operand.param2)) : 1;
            const objCount = Array.isArray(objectRows) ? objectRows.length : 0;
            const fieldIndex0 = (objCount > 0)
                ? Math.max(0, Math.min(objCount - 1, fieldIdx1 - 1))
                : 0;
            let obj = (objCount > 0) ? objectRows[fieldIndex0] : null;
            if (!obj) {
                // Fallback: if non-active config lacks object rows, use active config's UI object rows.
                // This avoids false FAIL when per-config object tables are missing or stale.
                try {
                    if (!isOperandActiveConfig) {
                        const activeObjRows = (typeof window !== 'undefined' && typeof window.getObjectRows === 'function')
                            ? window.getObjectRows()
                            : (window.tableObject ? window.tableObject.getData() : []);
                        const activeCount = Array.isArray(activeObjRows) ? activeObjRows.length : 0;
                        const activeIdx0 = (activeCount > 0)
                            ? Math.max(0, Math.min(activeCount - 1, fieldIdx1 - 1))
                            : 0;
                        const activeObj = (activeCount > 0) ? activeObjRows[activeIdx0] : null;
                        if (activeObj) {
                            obj = activeObj;
                            stampSpotDebug({ reason: 'fallback-active-object-rows', objectRowsLength: objCount, fieldIndex0, activeObjectRowsLength: activeCount, activeFieldIndex0: activeIdx0 });
                        }
                    }
                } catch (_) {}
            }
            if (!obj) {
                stampSpotDebug({ reason: 'no-object-row', objectRowsLength: objCount, fieldIndex0 });
                return 1e9;
            }

            const metricRaw = (operand?.param3 === undefined || operand?.param3 === null) ? '' : String(operand.param3);
            const metricNorm0 = metricRaw.trim().toLowerCase();
            const metricNorm = metricNorm0.replace(/[^a-z0-9]/g, '');
            const metric = (!metricNorm0 || metricNorm === '')
                ? 'rms'
                : (
                    metricNorm === 'rms' ||
                    metricNorm === 'rmstotal' ||
                    metricNorm === 'rmsxy' ||
                    metricNorm === 'r'
                )
                    ? 'rms'
                    : (
                        metricNorm === 'diameter' ||
                        metricNorm === 'dia' ||
                        metricNorm === 'diam' ||
                        metricNorm === 'd'
                    )
                        ? 'diameter'
                        : metricNorm0;

            const raysRaw = Number(operand?.param4);
            const rayCountFromOperand = Number.isFinite(raysRaw) ? Math.max(1, Math.min(5000, Math.floor(raysRaw))) : null;
            const rayCountFromUi = (() => {
                if (!useUiDefaults) return null;
                try {
                    if (typeof document === 'undefined') return null;
                    const fromSettings = Number(lastSpotSettings?.rayCount);
                    if (Number.isFinite(fromSettings) && fromSettings > 0) {
                        return Math.max(1, Math.min(5000, Math.floor(fromSettings)));
                    }
                    const el = document.getElementById('ray-count-input');
                    if (!el || el.value === undefined || el.value === null) return null;
                    const parsed = parseInt(String(el.value), 10);
                    return Number.isInteger(parsed) && parsed > 0 ? Math.max(1, Math.min(5000, parsed)) : null;
                } catch (_) {
                    return null;
                }
            })();
            // IMPORTANT: If the operand explicitly specifies ray count (param4), honor it.
            // Optimizer fast-mode may provide a rayCountOverride for speed, but it must NOT
            // silently change the meaning of a saved Requirement.
            const rayCount = (rayCountFromOperand !== null)
                ? rayCountFromOperand
                : ((Number.isFinite(rayCountOverride) && rayCountOverride > 0)
                    ? Math.max(1, Math.min(5000, Math.floor(rayCountOverride)))
                    : (rayCountFromUi !== null ? rayCountFromUi : 501));

            const fastModeEnabled = !!(typeof globalThis !== 'undefined' && globalThis.__cooptMeritFastMode && globalThis.__cooptMeritFastMode.enabled);
            stampSpotDebug({ fastModeEnabled, rayCountRequested: rayCount });

            const isImageRow = (row) => {
                if (!row || typeof row !== 'object') return false;
                const t1 = String(row['object type'] ?? '').trim();
                const t2 = String(row.object ?? '').trim();
                const st = String(row.surfType ?? '').trim().toLowerCase();
                if (t1 === 'Image' || t2 === 'Image') return true;
                return st === 'image' || st.includes('image');
            };

            const isObjectRow = (row) => {
                if (!row || typeof row !== 'object') return false;
                const t1 = String(row['object type'] ?? '').trim();
                const t2 = String(row.object ?? '').trim();
                const st = String(row.surfType ?? '').trim().toLowerCase();
                if (t1 === 'Object' || t2 === 'Object') return true;
                return st === 'object';
            };

            const isCoordinateBreakRow = (row) => {
                if (!row || typeof row !== 'object') return false;
                const st = String(row.surfType ?? row.type ?? row['object type'] ?? row.object ?? row.surfaceType ?? '')
                    .trim()
                    .toLowerCase();
                if (!st) return false;
                return (
                    st === 'cb' ||
                    st === 'coordtrans' ||
                    st === 'coord trans' ||
                    st === 'coordinate transform' ||
                    st.includes('coord trans') ||
                    st.includes('coordinate transform')
                );
            };

            let imageSurfaceIndex = -1;
            for (let i = 0; i < opticalSystemData.length; i++) {
                if (isImageRow(opticalSystemData[i])) {
                    imageSurfaceIndex = i;
                    break;
                }
            }
            if (imageSurfaceIndex < 0) imageSurfaceIndex = opticalSystemData.length - 1;
            if (imageSurfaceIndex < 0) return 1e9;

            const uiSurfaceIndex = (() => {
                if (!useUiDefaults) return null;
                try {
                    if (typeof document === 'undefined') return null;
                    const fromSettings = Number(lastSpotSettings?.surfaceIndex);
                    if (Number.isInteger(fromSettings) && fromSettings >= 0 && fromSettings < opticalSystemData.length) {
                        if (!isObjectRow(opticalSystemData[fromSettings]) && !isCoordinateBreakRow(opticalSystemData[fromSettings])) {
                            return fromSettings;
                        }
                    }
                    // Only the active config's UI has a meaningful surface-number-select.
                    if (!isOperandActiveConfig) return null;
                    const el = document.getElementById('surface-number-select');
                    if (!el || el.value === undefined || el.value === null) return null;
                    // Note: this select uses 0-indexed surface indices as option values.
                    const idx = parseInt(String(el.value), 10);
                    if (!Number.isInteger(idx) || idx < 0 || idx >= opticalSystemData.length) return null;

                    if (isObjectRow(opticalSystemData[idx])) return null;
                    if (isCoordinateBreakRow(opticalSystemData[idx])) return null;

                    return idx;
                } catch (_) {
                    return null;
                }
            })();

            const targetSurfaceIndex = (uiSurfaceIndex !== null) ? uiSurfaceIndex : imageSurfaceIndex;
            const surfaceInfos = calculateSurfaceOrigins(opticalSystemData);
            const surfaceInfo = surfaceInfos?.[targetSurfaceIndex] || null;

            stampSpotDebug({ targetSurfaceIndex });

            const desiredPattern = (pattern === 'annular' || pattern === 'grid') ? pattern : '';
            const prevPattern = desiredPattern ? getRayEmissionPattern() : null;
            if (desiredPattern) {
                try { setRayEmissionPattern(desiredPattern); } catch (_) {}
            }

            const annularRingCountFromUi = (() => {
                if (!useUiDefaults) return null;
                try {
                    if (typeof document === 'undefined') return null;
                    const fromSettings = Number(lastSpotSettings?.ringCount);
                    if (Number.isFinite(fromSettings) && fromSettings > 0) {
                        return Math.floor(fromSettings);
                    }
                    const el = document.getElementById('ring-count-select');
                    if (!el || el.value === undefined || el.value === null) return null;
                    const parsed = parseInt(String(el.value), 10);
                    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
                } catch (_) {
                    return null;
                }
            })();

            // If we are not forcing the pattern, honor the current Spot Diagram UI/global pattern.
            // Prefer live UI state for the active config; fall back to global getter; lastly stored settings.
            // Ring count only matters for annular patterns.
            const currentPattern = (() => {
                try {
                    if (useUiDefaults && isOperandActiveConfig && typeof document !== 'undefined') {
                        const gridBtn = document.getElementById('grid-pattern-btn');
                        const annBtn = document.getElementById('annular-pattern-btn');
                        if (gridBtn && gridBtn.classList && gridBtn.classList.contains('active')) return 'grid';
                        if (annBtn && annBtn.classList && annBtn.classList.contains('active')) return 'annular';
                    }
                } catch (_) {}
                try {
                    const gp = String(getRayEmissionPattern() || '').trim().toLowerCase();
                    if (gp) return gp;
                } catch (_) {}
                const fromSettings = lastSpotSettings?.pattern;
                if (typeof fromSettings === 'string' && fromSettings.trim() !== '') {
                    return fromSettings.trim().toLowerCase();
                }
                return '';
            })();
            const effectiveAnnularRingCount = (() => {
                const base = Number.isFinite(annularRingCountOverride) ? annularRingCountOverride : (annularRingCountFromUi !== null ? annularRingCountFromUi : null);
                if (base !== null) return base;
                // Keep legacy default (3) when unspecified.
                return 3;
            })();

            // Spot size operands are intended to match the Spot Diagram UI exactly.
            // Use the same implementation path (eva-spot-diagram.generateSpotDiagram) for their spot point generation.
            // This avoids subtle mismatches (ray start generation, filtering, chief-ray flagging, etc.).
            if (useUiDefaults && (pattern === 'current' || pattern === '' || pattern === 'annular' || pattern === 'grid')) {
                stampSpotDebug({ impl: 'spot-diagram' });
                try { stampSpotDebug({ spotDiagStage: 'entered' }); } catch (_) {}
                stampSpotDebug({
                    fastModeEnabled,
                    rayCountRequested: rayCount,
                    lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                });

                // For spot-size operands, match Spot Diagram's config selection behavior:
                // - Active config: prefer live UI tables (immediate updates)
                // - Non-active config: USE ACTIVE CONFIG'S OPTICAL ROWS (CB insertion is shared)
                //   (CB insertion adds rows to active config's UI table only; Design Intent blocks
                //    are not yet synchronized, so non-active config's blocks expansion is stale)
                const uiRows = getUiTableRowsForSpot();
                
                // CRITICAL FIX: Non-active configs should use active config's optical rows
                // because CB insertion updates the active config's UI table immediately,
                // but the Design Intent blocks are not updated until saveSystemConfigurations.
                // Using blocks expansion for non-active configs returns stale data (no CB).
                const useUiTablesEffective = !!(useUiTables && isOperandActiveConfig);
                try { stampSpotDebug({ useUiTablesEffective }); } catch (_) {}

                // Use active config's optical rows for all configs (CB insertion shared)
                const spotOpticalRows = (useUiTablesEffective && uiRows.optical)
                    ? uiRows.optical
                    : opticalSystemData;
                const spotObjectRows = (useUiTablesEffective && uiRows.object)
                    ? uiRows.object
                    : objectRows;
                const spotSourceRows = (useUiTablesEffective && uiRows.source)
                    ? uiRows.source
                    : sourceRows;

                // Update cache whenever we successfully read live UI rows for an explicit config.
                if (useUiTablesEffective && operandCfgId) {
                    saveSpotTablesCache(operandCfgId, {
                        optical: uiRows.optical,
                        object: uiRows.object,
                        source: uiRows.source
                    });
                }

                // Respect operand wavelength selection (param1 = λ idx, 1-based, blank=Primary).
                // Spot Diagram UI itself traces the Primary wavelength, so we emulate "select wavelength"
                // by marking the selected source row as Primary (and optionally narrowing to that row).
                const spotSourceRowsForOperand = (() => {
                    try {
                        if (!Array.isArray(spotSourceRows) || spotSourceRows.length === 0) return [];
                        if (forceSpotDiagramPrimary) return spotSourceRows;

                        const raw = (operand && operand.param1 !== undefined && operand.param1 !== null)
                            ? String(operand.param1).trim()
                            : '';
                        const idx1 = raw === '' ? 0 : Number(raw);
                        if (!(Number.isFinite(idx1) && idx1 > 0)) return spotSourceRows;
                        const i0 = Math.max(0, Math.min(spotSourceRows.length - 1, Math.floor(idx1) - 1));

                        // Prefer a single-wavelength list so the generator's "primary" is unambiguous.
                        const chosen = spotSourceRows[i0];
                        const wl = Number(chosen?.wavelength);
                        if (!(Number.isFinite(wl) && wl > 0)) return spotSourceRows;

                        const row = { ...(chosen && typeof chosen === 'object' ? chosen : {}) };
                        row.wavelength = wl;
                        row.primary = 'Primary Wavelength';
                        return [row];
                    } catch (_) {
                        return spotSourceRows;
                    }
                })();

                const objCount2 = Array.isArray(spotObjectRows) ? spotObjectRows.length : 0;
                const fieldIndex0ForSpot = (objCount2 > 0)
                    ? Math.max(0, Math.min(objCount2 - 1, fieldIdx1 - 1))
                    : 0;
                const obj2 = (objCount2 > 0)
                    ? spotObjectRows[fieldIndex0ForSpot]
                    : null;
                if (!obj2) {
                    stampSpotDebug({
                        ok: false,
                        reason: 'no-object-row-for-spot-diagram',
                        objectRowsLength: objCount2,
                        fieldIndex0: fieldIndex0ForSpot,
                        fieldIdx1
                    });
                    return 1e9;
                }

                // Capture a compact “object prototype” snapshot for debugging.
                try {
                    if (obj2 && typeof obj2 === 'object') {
                        const keys = Object.keys(obj2);
                        const summary = {};
                        const pick = [
                            'id', 'name', 'object', 'objectType', 'type',
                            'height', 'fieldHeight', 'fieldAngle',
                            // Compact object schema used by some tables
                            'xHeightAngle', 'yHeightAngle', 'position', 'angle',
                            'x', 'y', 'z',
                            'dirX', 'dirY', 'dirZ',
                            'angle', 'theta', 'phi',
                            'aperture', 'pupil',
                            'wavelength', 'primary'
                        ];
                        for (const k of pick) {
                            if (Object.prototype.hasOwnProperty.call(obj2, k)) summary[k] = obj2[k];
                        }
                        // Add a couple of derived hints for quick inspection.
                        try {
                            if (Object.prototype.hasOwnProperty.call(obj2, 'position')) {
                                const p = obj2.position;
                                summary.__positionType = (p === null) ? 'null' : Array.isArray(p) ? 'array' : typeof p;
                                if (Array.isArray(p)) summary.__positionArray = p.slice(0, 4);
                                if (p && typeof p === 'object' && !Array.isArray(p)) {
                                    summary.__positionObjKeys = Object.keys(p).slice(0, 20);
                                }
                            }
                        } catch (_) {}
                        stampSpotDebug({
                            objectRowKeys: keys.slice(0, 60),
                            objectRowSummary: summary
                        });
                    }
                } catch (_) {}

                // Recompute target surface index against the rows we're actually using.
                // Important: if there's no explicit Image row, fall back to the last *non-CB* surface.
                // Otherwise a CB insertion at the end can accidentally become the default target.
                const findLastNonSpecialSurfaceIndex = (rows) => {
                    try {
                        if (!Array.isArray(rows) || rows.length === 0) return -1;
                        for (let i = rows.length - 1; i >= 0; i--) {
                            const r = rows[i];
                            if (isObjectRow(r) || isCoordinateBreakRow(r)) continue;
                            return i;
                        }
                        return -1;
                    } catch (_) {
                        return -1;
                    }
                };

                let imgIdx2 = -1;
                for (let i = 0; i < spotOpticalRows.length; i++) {
                    if (isImageRow(spotOpticalRows[i])) { imgIdx2 = i; break; }
                }
                const imgIdx2Source = (imgIdx2 >= 0) ? 'image-row' : 'last-non-special';
                if (imgIdx2 < 0) imgIdx2 = findLastNonSpecialSurfaceIndex(spotOpticalRows);
                if (imgIdx2 >= 0 && (isObjectRow(spotOpticalRows[imgIdx2]) || isCoordinateBreakRow(spotOpticalRows[imgIdx2]))) {
                    imgIdx2 = findLastNonSpecialSurfaceIndex(spotOpticalRows.slice(0, imgIdx2));
                }
                if (imgIdx2 < 0) {
                    stampSpotDebug({ ok: false, reason: 'no-valid-default-target-surface' });
                    return 1e9;
                }
                try { stampSpotDebug({ imageSurfaceIndexSource: imgIdx2Source }); } catch (_) {}

                const uiSurfaceSelection2 = (() => {
                    // Spot size operands are intended to match the Spot Diagram UI.
                    // So even during Requirements evaluation, honor the Spot Diagram surface selection
                    // (UI selection for active config, otherwise lastSpotSettings/per-config settings).

                    let opts = [];
                    try { opts = generateSurfaceOptions(spotOpticalRows || []); } catch (_) { opts = []; }

                    // NOTE:
                    // - Spot Diagram's surface select uses option.value = (rowIndex + 1)
                    //   (a 1-based row index into opticalSystemRows, a.k.a. surfaceNumber).
                    // - We ALSO carry `surfaceId` metadata (Design Intent numbering that counts CB).
                    //   Older saved settings may store this `surfaceId`.
                    const resolveSelectValueToRowIndex = (val) => {
                        try {
                            const n = Number(val);
                            if (!Number.isFinite(n)) return null;
                            const match = opts.find(o => Number(o?.value) === Number(n));
                            return (match && Number.isInteger(match.rowIndex)) ? match.rowIndex : null;
                        } catch (_) {
                            return null;
                        }
                    };

                    const resolveSurfaceIdToRowIndex = (sid) => {
                        try {
                            const n = Number(sid);
                            if (!Number.isFinite(n)) return null;
                            // Prefer explicit surfaceId metadata when present.
                            const bySid = opts.find(o => Number(o?.surfaceId) === Number(n));
                            if (bySid && Number.isInteger(bySid.rowIndex)) return bySid.rowIndex;
                            // Backward fallback: some builds stored surfaceId in option.value.
                            const byVal = opts.find(o => Number(o?.value) === Number(n));
                            return (byVal && Number.isInteger(byVal.rowIndex)) ? byVal.rowIndex : null;
                        } catch (_) {
                            return null;
                        }
                    };

                    const resolveRowIndexToSurfaceId = (rowIndex) => {
                        try {
                            const idx = Number(rowIndex);
                            if (!Number.isInteger(idx)) return null;
                            const match = opts.find(o => Number.isInteger(o?.rowIndex) && Number(o.rowIndex) === idx);
                            const sid = match ? Number(match.surfaceId ?? null) : null;
                            return Number.isFinite(sid) && sid > 0 ? sid : null;
                        } catch (_) {
                            return null;
                        }
                    };

                    let uiSurfaceIdUsed = null;

                    const makeResult = (rowIndex, surfaceId) => {
                        if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= spotOpticalRows.length) return null;
                        if (isObjectRow(spotOpticalRows[rowIndex]) || isCoordinateBreakRow(spotOpticalRows[rowIndex])) return null;
                        const sid = (Number.isFinite(Number(surfaceId)) && Number(surfaceId) > 0)
                            ? Number(surfaceId)
                            : resolveRowIndexToSurfaceId(rowIndex);
                        return { rowIndex, surfaceId: (Number.isFinite(sid) && sid > 0) ? sid : null };
                    };

                    // For the active configuration, honor the current UI surface selection FIRST
                    // (unless we are evaluating System Requirements, which should not depend
                    // on potentially stale UI selection after CB insertion).
                    const isRequirementsEval = !!(typeof globalThis !== 'undefined' && globalThis.__COOPT_EVALUATING_REQUIREMENTS);
                    if (isOperandActiveConfig && !isRequirementsEval) {
                        try {
                            if (typeof document !== 'undefined') {
                                const el = document.getElementById('surface-number-select');
                                if (el && el.value !== undefined && el.value !== null) {
                                    // Prefer rowId-based resolution (stable across CB insert/delete).
                                    try {
                                        const optEl = (el.selectedIndex >= 0 && el.options) ? el.options[el.selectedIndex] : null;
                                        const rid = optEl && optEl.dataset && optEl.dataset.rowId ? String(optEl.dataset.rowId) : '';
                                        if (rid) {
                                            const m = opts.find(o => o && o.rowId !== null && o.rowId !== undefined && String(o.rowId) === rid);
                                            if (m && Number.isInteger(m.rowIndex)) {
                                                uiSurfaceIdUsed = Number(m.value);
                                                const res = makeResult(Number(m.rowIndex), Number(m.value));
                                                if (res) {
                                                    try { stampSpotDebug({ uiSurfaceIdUsed, uiSurfaceRowIdUsed: rid }); } catch (_) {}
                                                    return res;
                                                }
                                            }
                                        }
                                    } catch (_) {}

                                    // Next best: rowSig-based resolution (stable-ish across insert/delete).
                                    try {
                                        const optEl = (el.selectedIndex >= 0 && el.options) ? el.options[el.selectedIndex] : null;
                                        const sig = optEl && optEl.dataset && optEl.dataset.rowSig ? String(optEl.dataset.rowSig) : '';
                                        if (sig) {
                                            const m = opts.find(o => o && o.rowSig !== null && o.rowSig !== undefined && String(o.rowSig) === sig);
                                            if (m && Number.isInteger(m.rowIndex)) {
                                                uiSurfaceIdUsed = Number(m.value);
                                                const res = makeResult(Number(m.rowIndex), Number(m.value));
                                                if (res) {
                                                    try { stampSpotDebug({ uiSurfaceIdUsed, uiSurfaceRowSigUsed: sig }); } catch (_) {}
                                                    return res;
                                                }
                                            }
                                        }
                                    } catch (_) {}

                                    // surface-number-select holds Surf id (not raw row index).
                                    // surface-number-select holds option.value (surfaceNumber = rowIndex + 1).
                                    const selVal = parseInt(String(el.value), 10);
                                    if (Number.isInteger(selVal) && selVal > 0) {
                                        uiSurfaceIdUsed = selVal;
                                        const idx = resolveSelectValueToRowIndex(selVal);
                                        const res = makeResult(idx, selVal);
                                        if (res) {
                                            try { stampSpotDebug({ uiSurfaceIdUsed }); } catch (_) {}
                                            return res;
                                        }
                                    }
                                }
                            }
                        } catch (_) {}
                    }

                    // Use per-config Spot Diagram settings when available.
                    // Fall back to active config settings only if per-config settings are missing.
                    let effectiveSettings = lastSpotSettings;
                    try {
                        if (!isOperandActiveConfig && operandCfgId) {
                            const systemConfig = (() => {
                                let memSys = null;
                                let lsSys = null;
                                try {
                                    if (typeof window !== 'undefined' && window.__cooptSystemConfig) {
                                        memSys = window.__cooptSystemConfig;
                                    }
                                } catch (_) {}
                                try {
                                    if (typeof localStorage !== 'undefined') {
                                        lsSys = JSON.parse(localStorage.getItem('systemConfigurations'));
                                    }
                                } catch (_) {}
                                if (memSys && lsSys) {
                                    const memActive = (memSys.activeConfigId !== undefined && memSys.activeConfigId !== null)
                                        ? String(memSys.activeConfigId)
                                        : '';
                                    const lsActive = (lsSys.activeConfigId !== undefined && lsSys.activeConfigId !== null)
                                        ? String(lsSys.activeConfigId)
                                        : '';
                                    return (memActive && lsActive && memActive !== lsActive) ? lsSys : memSys;
                                }
                                return memSys || lsSys;
                            })();
                            const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                                ? String(systemConfig.activeConfigId)
                                : '';

                            const memCache = (typeof window !== 'undefined') ? window.__cooptSpotDiagramSettingsByConfigId : null;
                            let allSettings = null;
                            if (memCache && typeof memCache === 'object') {
                                allSettings = memCache;
                            } else if (typeof localStorage !== 'undefined') {
                                try { allSettings = JSON.parse(localStorage.getItem('spotDiagramSettingsByConfigId') || '{}'); } catch { allSettings = {}; }
                            }

                            // Prefer operand's config settings.
                            if (allSettings && typeof allSettings === 'object' && allSettings[operandCfgId]) {
                                effectiveSettings = allSettings[operandCfgId];
                            } else if (activeConfigId && allSettings && typeof allSettings === 'object' && allSettings[activeConfigId]) {
                                // Fallback to active config settings if per-config missing.
                                effectiveSettings = allSettings[activeConfigId];
                            }
                        }
                    } catch (_) {}

                    const fromSettingsSurfaceId = effectiveSettings?.surfaceId;
                    const fromSettingsRowIdx = Number(effectiveSettings?.surfaceRowIndex ?? effectiveSettings?.surfaceIndex);
                    let resolvedFromSettings = (fromSettingsSurfaceId !== undefined && fromSettingsSurfaceId !== null)
                        ? resolveSurfaceIdToRowIndex(fromSettingsSurfaceId)
                        : (Number.isInteger(fromSettingsRowIdx) ? fromSettingsRowIdx : null);
                    
                    // If surfaceId resolution failed (e.g., CB insertion changed numbering),
                    // fall back to the explicit Image surface to prevent evaluating at CB-1.
                    if (resolvedFromSettings === null && (fromSettingsSurfaceId !== undefined && fromSettingsSurfaceId !== null)) {
                        try {
                            for (let i = 0; i < spotOpticalRows.length; i++) {
                                if (isImageRow(spotOpticalRows[i])) {
                                    resolvedFromSettings = i;
                                    try { stampSpotDebug({ surfaceIdResolutionFailed: true, fallbackToImageRow: i }); } catch (_) {}
                                    break;
                                }
                            }
                        } catch (_) {}
                    }
                    
                    const res2 = makeResult(resolvedFromSettings, fromSettingsSurfaceId);
                    if (res2) {
                        try {
                            stampSpotDebug({
                                uiSurfaceIdUsed: uiSurfaceIdUsed,
                                settingsSurfaceIdUsed: (fromSettingsSurfaceId !== undefined && fromSettingsSurfaceId !== null) ? String(fromSettingsSurfaceId) : null,
                                settingsRowIndexUsed: Number.isInteger(fromSettingsRowIdx) ? fromSettingsRowIdx : null,
                                usedConfigSpecificSettings: !isOperandActiveConfig && operandCfgId && effectiveSettings !== lastSpotSettings
                            });
                            const dbg = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_DEBUG_REQUIREMENTS : false;
                            if (dbg) {
                                console.log(`🧪 [ReqDebug] spot cfg=${String(operandCfgId || '')} active=${isOperandActiveConfig} surfaceId=${fromSettingsSurfaceId} rowIdx=${fromSettingsRowIdx} resolved=${res2.rowIndex}`);
                            }
                        } catch (_) {}
                        return res2;
                    }
                    return null;
                })();

                const targetSurfaceIdx2 = (uiSurfaceSelection2 !== null) ? uiSurfaceSelection2.rowIndex : imgIdx2;
                // Spot Diagram implementation uses 1-based index into opticalSystemRows.
                const surfaceNumber1 = targetSurfaceIdx2 + 1;

                // Record the effective target surface for the spot-diagram implementation.
                // (This differs from the legacy ray-trace branch's targetSurfaceIndex.)
                try {
                    const tr = (Array.isArray(spotOpticalRows) && Number.isInteger(targetSurfaceIdx2)) ? spotOpticalRows[targetSurfaceIdx2] : null;
                    const trObjType = tr && typeof tr === 'object' ? (tr['object type'] ?? tr.objectType ?? tr.object ?? null) : null;
                    const trSurfType = tr && typeof tr === 'object' ? (tr.surfType ?? tr['surf type'] ?? tr.type ?? null) : null;
                    stampSpotDebug({
                        targetSurfaceIndex: targetSurfaceIdx2,
                        imageSurfaceIndex: imgIdx2,
                        uiSurfaceIndexResolved: uiSurfaceSelection2 ? uiSurfaceSelection2.rowIndex : null,
                        // Surf-id (CB-invariant) used by the Spot Diagram UI, for reference.
                        targetSurfaceIdUsed: uiSurfaceSelection2 && Number.isFinite(Number(uiSurfaceSelection2.surfaceId)) ? Number(uiSurfaceSelection2.surfaceId) : null,
                        opticalSystemSurfaceCount: Array.isArray(spotOpticalRows) ? spotOpticalRows.length : null,
                        objectIndex0: fieldIndex0ForSpot,
                        targetRowObjectType: trObjType !== null ? String(trObjType) : null,
                        targetRowSurfType: trSurfType !== null ? String(trSurfType) : null
                    });
                } catch (_) {}

                const prevPattern0 = (() => {
                    try { return String(getRayEmissionPattern() || '').trim().toLowerCase(); } catch (_) { return ''; }
                })();

                // Best-effort: mirror the Spot Diagram's active pattern before generating.
                // (Spot Diagram uses window.getRayEmissionPattern / window.rayEmissionPattern.)
                try {
                    const forced = (pattern === 'annular' || pattern === 'grid')
                        ? pattern
                        : ((currentPattern === 'grid' || currentPattern === 'annular') ? currentPattern : 'annular');
                    if (forced) setRayEmissionPattern(forced);
                    try { stampSpotDebug({ spotDiagPatternForced: forced }); } catch (_) {}
                } catch (_) {}

                let spot;
                try {
                    try {
                        try { stampSpotDebug({ spotDiagStage: 'before-generate' }); } catch (_) {}
                        spot = generateSpotDiagram(
                            spotOpticalRows,
                            Array.isArray(spotSourceRowsForOperand) ? spotSourceRowsForOperand : [],
                            [obj2],
                            surfaceNumber1,
                            rayCount,
                            // Ring count is used for annular sampling.
                            // (For grid sampling it is ignored by the generator.)
                            effectiveAnnularRingCount,
                            // Match Spot Diagram UI behavior: do NOT shrink pupil to "make rays pass".
                            { physicalVignetting: true }
                        );

                        try { stampSpotDebug({ spotDiagStage: 'after-generate' }); } catch (_) {}

                        try {
                            stampSpotDebug({
                                spotDiagInputs: {
                                    surfaceNumber: surfaceNumber1,
                                    rayCount,
                                    ringCount: effectiveAnnularRingCount,
                                    physicalVignetting: true
                                }
                            });
                        } catch (_) {}

                        // Surface-level diagnostics (pupil-scale / aimThroughStop retries) for debugging.
                        try {
                            const d0 = spot?.spotData?.[0]?.diagnostics?.retry;
                            if (d0 && typeof d0 === 'object') {
                                stampSpotDebug({
                                    spotDiagRetry: {
                                        aimThroughStopUsed: d0.aimThroughStopUsed,
                                        pupilScaleUsed: d0.pupilScaleUsed,
                                        pupilScaleTried: d0.pupilScaleTried
                                    }
                                });
                            }
                        } catch (_) {}
                    } catch (err) {
                        // Requirements should not crash when a configuration/object is fully vignetted.
                        // Convert generator errors into a large penalty value so the row can be marked NG.
                        const msg = String(err?.message ?? err ?? '');
                        const noRays = msg.includes('成功した光線数: 0') || msg.includes('No rays reached') || msg.includes('no rays reached');

                        // Always capture a compact summary of the latest Spot Diagram failure object.
                        // This must not depend on later best-effort parsing.
                        const spotFailureAnySummary = (() => {
                            try {
                                const fAny = (typeof globalThis !== 'undefined') ? globalThis.__cooptLastSpotDiagramFailure : null;
                                if (!fAny || typeof fAny !== 'object') return null;
                                const o0 = Array.isArray(fAny.objects) ? fAny.objects[0] : null;
                                const retry0 = o0?.retry;
                                const tried0 = retry0?.pupilScaleTried;
                                const triedMeta = Array.isArray(tried0)
                                    ? (() => {
                                        try {
                                            const meta = {
                                                total: tried0.length,
                                                anyAimThroughStopFalse: tried0.some(x => x?.aimThroughStop === false),
                                                anyAimThroughStopTrue: tried0.some(x => x?.aimThroughStop === true),
                                                anyDisableAngleOptTrue: tried0.some(x => x?.disableAngleObjectPositionOptimizationRequested === true),
                                                anyDisableAngleOptFalse: tried0.some(x => x?.disableAngleObjectPositionOptimizationRequested === false),
                                                anyAllowOriginSolveTrue: tried0.some(x => x?.allowStopBasedOriginSolveRequested === true),
                                                anyAllowOriginSolveFalse: tried0.some(x => x?.allowStopBasedOriginSolveRequested === false),
                                                okCount: tried0.reduce((acc, x) => acc + (Number(x?.ok) > 0 ? 1 : 0), 0),
                                            };
                                            return meta;
                                        } catch (_) {
                                            return { total: tried0.length };
                                        }
                                    })()
                                    : null;

                                const triedSample = Array.isArray(tried0)
                                    ? (() => {
                                        const n = tried0.length;
                                        const pickIdx = new Set();
                                        const push = (i) => {
                                            const ii = Math.max(0, Math.min(n - 1, Math.floor(i)));
                                            pickIdx.add(ii);
                                        };
                                        // Sample across the table: first 4, middle 4, last 4
                                        for (let i = 0; i < Math.min(4, n); i++) push(i);
                                        const mid = Math.floor((n - 1) / 2);
                                        for (let i = 0; i < 4; i++) push(mid - 1 - i);
                                        for (let i = 0; i < Math.min(4, n); i++) push(n - 1 - i);
                                        const idx = Array.from(pickIdx).sort((a, b) => a - b).slice(0, 16);
                                        return idx.map(i => {
                                            const t = tried0[i];
                                            return {
                                                i,
                                                pupilScale: t?.pupilScale ?? null,
                                                aimThroughStop: t?.aimThroughStop ?? null,
                                                ok: t?.ok ?? null,
                                                topKind: t?.topKind ?? null,
                                                topSurface: t?.topSurface ?? null,
                                                firstRayStartP: t?.firstRayStartP ?? null,
                                                firstRayDir: t?.firstRayDir ?? null,
                                                emissionOrigin: t?.emissionOrigin ?? null,
                                                stopIndex: t?.stopIndex ?? null,
                                                stopZ: t?.stopZ ?? null,
                                                stopRadius: t?.stopRadius ?? null,
                                                stopCenter: t?.stopCenter ?? null,
                                                allowStopBasedOriginSolveRequested: t?.allowStopBasedOriginSolveRequested ?? null,
                                                disableAngleObjectPositionOptimizationRequested: t?.disableAngleObjectPositionOptimizationRequested ?? null,
                                            };
                                        });
                                    })()
                                    : null;

                                const blockerSurfaceRowSummary = (() => {
                                    try {
                                        const sn = Number(o0?.exampleSummary?.surfaceNumber);
                                        if (!Number.isFinite(sn) || sn < 1) return null;
                                        const rows = o0?.topSurfaceRowSummaries;
                                        if (!Array.isArray(rows)) return null;
                                        const hit = rows.find(r => Number(r?.surfaceNumber) === sn) || null;
                                        return hit?.row ?? null;
                                    } catch (_) {
                                        return null;
                                    }
                                })();
                                return {
                                    surfaceNumber: Number.isFinite(Number(fAny.surfaceNumber)) ? Number(fAny.surfaceNumber) : null,
                                    totalRays: Number.isFinite(Number(fAny.totalRays)) ? Number(fAny.totalRays) : null,
                                    totalSuccessfulRays: Number.isFinite(Number(fAny.totalSuccessfulRays)) ? Number(fAny.totalSuccessfulRays) : null,
                                    object0: o0 ? {
                                        objectId: o0.objectId ?? null,
                                        objectType: o0.objectType ?? null,
                                        topKinds: o0.topKinds ?? null,
                                        topSurfaces: o0.topSurfaces ?? null,
                                        exampleSummary: o0.exampleSummary ?? null,
                                        blockerSurfaceRowSummary,
                                        topSurfaceRowSummariesSample: Array.isArray(o0.topSurfaceRowSummaries)
                                            ? o0.topSurfaceRowSummaries.slice(0, 4)
                                            : null,
                                        retry: retry0 ? {
                                            aimThroughStopUsed: retry0.aimThroughStopUsed ?? null,
                                            pupilScaleUsed: retry0.pupilScaleUsed ?? null,
                                        } : null,
                                        triedCount: Array.isArray(tried0) ? tried0.length : null,
                                        triedMeta,
                                        triedSample
                                    } : null
                                };
                            } catch (_) {
                                return null;
                            }
                        })();

                        // Always stamp a minimal terminal reason first.
                        // (Diagnostic extraction below is best-effort and must not suppress stamping.)
                        try {
                            stampSpotDebug({
                                ok: false,
                                reason: noRays ? 'no-rays-reached' : 'exception',
                                hits: 0,
                                error: msg,
                                spotDiagStage: 'caught-error',
                                spotDiagFailureAnySummary: spotFailureAnySummary,
                                lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                            });
                        } catch (_) {}

                        // Convenience alias for console inspection.
                        // Note: do not rely on this for logic; it's debug-only.
                        try {
                            if (typeof globalThis !== 'undefined') {
                                globalThis.__cooptLastSpotDiagFailureAnySummary = spotFailureAnySummary;
                            }
                        } catch (_) {}

                        try {
                            let totalRays = null;
                            try {
                                const mTotal = /-\s*総光線数:\s*(\d+)/.exec(msg);
                                if (mTotal) totalRays = Number(mTotal[1]);
                            } catch (_) {}
                            let surfaceNum = null;
                            try {
                                const mSurf = /Failed to generate spot data for Surf\s*(\d+)/.exec(msg);
                                if (mSurf) surfaceNum = Number(mSurf[1]);
                            } catch (_) {}

                            let spotFailure = null;
                            try {
                                const f = (typeof globalThis !== 'undefined') ? globalThis.__cooptLastSpotDiagramFailure : null;
                                if (f && typeof f === 'object') {
                                    const sn = Number(f.surfaceNumber);
                                    // Error message reports "Surf ${surfaceNumber - 1}" (display id),
                                    // while __cooptLastSpotDiagramFailure stores the 1-based surfaceNumber.
                                    // Accept either exact match or off-by-one.
                                    const matches = !Number.isFinite(surfaceNum)
                                        || sn === surfaceNum
                                        || sn === (surfaceNum + 1)
                                        || (sn - 1) === surfaceNum;
                                    if (matches) spotFailure = f;
                                }
                            } catch (_) {}

                            const spotRetry = (() => {
                                try {
                                    const r0 = spotFailure?.objects?.[0]?.retry;
                                    if (!r0 || typeof r0 !== 'object') return null;
                                    return {
                                        aimThroughStopUsed: r0.aimThroughStopUsed,
                                        pupilScaleUsed: r0.pupilScaleUsed,
                                        pupilScaleTried: r0.pupilScaleTried
                                    };
                                } catch (_) {
                                    return null;
                                }
                            })();

                            const spotRetryAttemptSample = (() => {
                                try {
                                    const tried = spotFailure?.objects?.[0]?.retry?.pupilScaleTried;
                                    if (!Array.isArray(tried) || tried.length === 0) return null;
                                    const sample = tried.slice(0, 10).map(t => ({
                                        pupilScale: t?.pupilScale ?? null,
                                        aimThroughStop: t?.aimThroughStop ?? null,
                                        ok: t?.ok ?? null,
                                        raysGenerated: t?.raysGenerated ?? null,
                                        topKind: t?.topKind ?? null,
                                        topSurface: t?.topSurface ?? null,
                                        allowStopBasedOriginSolveRequested: t?.allowStopBasedOriginSolveRequested ?? null,
                                        disableAngleObjectPositionOptimizationRequested: t?.disableAngleObjectPositionOptimizationRequested ?? null,
                                        firstRayStartP: t?.firstRayStartP ?? null,
                                        firstRayDir: t?.firstRayDir ?? null,
                                        emissionOrigin: t?.emissionOrigin ?? null,
                                        stopIndex: t?.stopIndex ?? null,
                                        stopZ: t?.stopZ ?? null,
                                        stopRadius: t?.stopRadius ?? null,
                                    }));
                                    return { count: tried.length, sample };
                                } catch (_) {
                                    return null;
                                }
                            })();
                            stampSpotDebug({
                                totalRays,
                                spotDiagFailure: spotFailure,
                                spotDiagRetry: spotRetry,
                                spotDiagRetryAttemptSample,
                                spotDiagFailureAnySummary: spotFailureAnySummary,
                                lastRayTraceFailure: getLastRayTraceFailureForThisEval(),
                                spotDiagStage: 'caught-error'
                            });
                        } catch (_) {}
                        return 1e9;
                    }
                } finally {
                    // Restore previous pattern if it was set.
                    try {
                        if (prevPattern0) setRayEmissionPattern(prevPattern0);
                    } catch (_) {}
                }

                const spotDataArr = (spot && typeof spot === 'object' && Array.isArray(spot.spotData)) ? spot.spotData : null;
                const spotPoints = (spotDataArr && spotDataArr[0] && Array.isArray(spotDataArr[0].spotPoints)) ? spotDataArr[0].spotPoints : null;
                try { stampSpotDebug({ spotDiagStage: 'after-spot-points-extract' }); } catch (_) {}
                if (!spotPoints || spotPoints.length === 0) {
                    stampSpotDebug({ ok: false, reason: 'no-spot-points', hits: 0 });
                    return 1e9;
                }

                let chiefPt = spotPoints.find(p => p && p.isChiefRay) || null;
                const chiefFound = !!chiefPt;
                if (!chiefPt) {
                    // Spot Diagram fallback behavior: centroid-closest.
                    const cx = spotPoints.reduce((sum, p) => sum + Number(p?.x || 0), 0) / spotPoints.length;
                    const cy = spotPoints.reduce((sum, p) => sum + Number(p?.y || 0), 0) / spotPoints.length;
                    let bestIdx = 0;
                    let bestDist = Infinity;
                    for (let i = 0; i < spotPoints.length; i++) {
                        const p = spotPoints[i];
                        const x = Number(p?.x);
                        const y = Number(p?.y);
                        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                        const d = Math.hypot(x - cx, y - cy);
                        if (d < bestDist) {
                            bestDist = d;
                            bestIdx = i;
                        }
                    }
                    chiefPt = spotPoints[bestIdx] || spotPoints[0];
                }

                const chiefX = Number(chiefPt?.x);
                const chiefY = Number(chiefPt?.y);
                if (!Number.isFinite(chiefX) || !Number.isFinite(chiefY)) {
                    stampSpotDebug({ ok: false, reason: 'invalid-chief-point', hits: spotPoints.length });
                    return 1e9;
                }

                let maxRUm = 0;
                let sumX2 = 0;
                let sumY2 = 0;
                let n = 0;
                for (const p of spotPoints) {
                    const x = Number(p?.x);
                    const y = Number(p?.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    const dxUm = (x - chiefX) * 1000;
                    const dyUm = (y - chiefY) * 1000;
                    const rUm = Math.hypot(dxUm, dyUm);
                    if (rUm > maxRUm) maxRUm = rUm;
                    sumX2 += dxUm * dxUm;
                    sumY2 += dyUm * dyUm;
                    n++;
                }

                if (n <= 0) {
                    stampSpotDebug({ ok: false, reason: 'no-finite-spot-points', hits: 0 });
                    return 1e9;
                }
                const rmsX = Math.sqrt(sumX2 / n);
                const rmsY = Math.sqrt(sumY2 / n);
                const rmsTotal = Math.sqrt(rmsX * rmsX + rmsY * rmsY);
                const diameter = 2 * maxRUm;

                // Debug signature for SD vs Requirements comparison.
                try {
                    const sample = spotPoints.slice(0, 8).map(p => ({
                        x: Number(p?.x),
                        y: Number(p?.y),
                        isChiefRay: !!p?.isChiefRay
                    }));
                    stampSpotDebug({
                        spotDiagMetrics: {
                            chiefSelection: chiefFound ? 'flagged-chief' : 'centroid-closest',
                            chiefXmm: chiefX,
                            chiefYmm: chiefY,
                            n,
                            rmsXUm: rmsX,
                            rmsYUm: rmsY,
                            rmsTotalUm: rmsTotal,
                            diameterUm: diameter,
                            maxRUm,
                        },
                        spotDiagPointSample: sample
                    });
                } catch (_) {}

                const valueUm = (metric === 'diameter') ? diameter : rmsTotal;
                try { stampSpotDebug({ spotDiagStage: 'success' }); } catch (_) {}
                stampSpotDebug({ ok: true, reason: 'ok', hits: n, resultUm: valueUm, lastRayTraceFailure: getLastRayTraceFailureForThisEval() });
                return valueUm;
            }

            stampSpotDebug({ impl: 'ray-trace' });

            let rayStarts;
            let apertureLimitMm = null;
            try {
                // Fast merit evaluation should avoid sampling near the physical aperture limit,
                // otherwise many rays can vignette and Spot ends up with 0 hits (→ 1e9).
                // Mirror Spot Diagram's conservative heuristic: effectiveRadius = 0.5 * min semidia.
                apertureLimitMm = (() => {
                    try {
                        if (!fastModeEnabled) return null;
                        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return null;
                        const maxIdx = Math.max(0, Math.min(opticalSystemData.length - 1, targetSurfaceIndex));

                        let minSemidia = Infinity;
                        for (let si = 0; si <= maxIdx; si++) {
                            const row = opticalSystemData[si];
                            if (!row || typeof row !== 'object') continue;
                            const t1 = String(row['object type'] ?? '').trim();
                            const t2 = String(row.object ?? '').trim();
                            if (t1 === 'Object' || t2 === 'Object') continue;
                            const st = String(row.surfType ?? '').trim().toLowerCase();
                            if (st === 'cb' || st === 'coordinate transform' || st === 'coord trans') continue;

                            const sd = Number(row.semidia);
                            if (Number.isFinite(sd) && sd > 0 && sd < minSemidia) {
                                minSemidia = sd;
                            }
                        }
                        if (!Number.isFinite(minSemidia) || minSemidia <= 0) return null;
                        // Add a small safety margin to avoid borderline vignetting from numerical jitter.
                        return 0.5 * minSemidia * 0.99;
                    } catch {
                        return null;
                    }
                })();

                stampSpotDebug({ apertureLimitMm });

                rayStarts = generateRayStartPointsForObject(
                    obj,
                    opticalSystemData,
                    rayCount,
                    apertureLimitMm,
                    // NOTE: ray-renderer expects 0-based surface indices for targetSurfaceIndex.
                    {
                        annularRingCount: (desiredPattern === 'annular' || (!desiredPattern && currentPattern === 'annular'))
                            ? effectiveAnnularRingCount
                            : effectiveAnnularRingCount,
                        targetSurfaceIndex,
                        useChiefRayAnalysis: true,
                        chiefRaySolveMode: fastModeEnabled ? 'fast' : 'legacy',
                        wavelengthUm: wavelength
                    }
                );
            } finally {
                if (desiredPattern && prevPattern) {
                    try { setRayEmissionPattern(prevPattern); } catch (_) {}
                }
            }

            if (!Array.isArray(rayStarts) || rayStarts.length === 0) {
                stampSpotDebug({ reason: 'no-ray-starts', rayStartsGenerated: Array.isArray(rayStarts) ? rayStarts.length : 0 });
                return 1e9;
            }

            if (fastModeEnabled) {
                try { globalThis.__cooptLastRayTraceFailure = undefined; } catch (_) {}
            }

            try {
                if (typeof window !== 'undefined') {
                    // Merge (do not overwrite) so earlier stamps like apertureLimitMm survive.
                    stampSpotDebug({
                        ok: true,
                        reason: 'ok',
                        targetSurfaceIndex,
                        rayCountRequested: rayCount,
                        rayStartsGenerated: Array.isArray(rayStarts) ? rayStarts.length : 0,
                        legacyFallbackHits: 0,
                        wavelength,
                        fastModeEnabled,
                        lastRayTraceFailure: null
                    });
                }
            } catch (_) {}

            /** @type {{x:number,y:number,isChief:boolean}[]} */
            const collectHits = (starts, maxRays) => {
                /** @type {{x:number,y:number,isChief:boolean}[]} */
                const out = [];
                let legacyHits = 0;
                let attempted = 0;
                let earlyAbort = null;

                const fastCfg = (() => {
                    try {
                        if (!fastModeEnabled) return null;
                        const m = (typeof globalThis !== 'undefined') ? globalThis.__cooptMeritFastMode : null;
                        return (m && typeof m === 'object') ? m : null;
                    } catch (_) {
                        return null;
                    }
                })();

                const earlyAbortEnabled = fastModeEnabled && (fastCfg ? (fastCfg.spotEarlyAbortEnabled !== false) : true);
                const earlyAbortMinAttempt = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortMinAttempt);
                    if (Number.isFinite(v) && v > 0) return Math.max(5, Math.floor(v));
                    return 20;
                })();
                const earlyAbortMinHitRate = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortMinHitRate);
                    if (Number.isFinite(v) && v > 0 && v < 1) return v;
                    return 0.20;
                })();
                const earlyAbortMaxHits = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortMaxHits);
                    if (Number.isFinite(v) && v >= 0) return Math.floor(v);
                    return 8;
                })();

                const earlyAbortMaxAttempt = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortMaxAttempt);
                    if (Number.isFinite(v) && v > 0) return Math.max(earlyAbortMinAttempt, Math.floor(v));
                    return 30;
                })();

                const missStreakMin = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortMissStreakMin);
                    if (Number.isFinite(v) && v > 0) return Math.max(5, Math.floor(v));
                    return 15;
                })();

                const blockStreakMin = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortBlockStreakMin);
                    if (Number.isFinite(v) && v > 0) return Math.max(3, Math.floor(v));
                    return 10;
                })();

                const streakMaxHits = (() => {
                    const v = Number(fastCfg?.spotEarlyAbortStreakMaxHits);
                    if (Number.isFinite(v) && v >= 0) return Math.floor(v);
                    return 12;
                })();

                const computeFailPenaltyForFastAbort = () => {
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
                    return { um: 5e4, kind: 'LOW_HIT_RATE', ratio: null };
                };

                const limit = Math.max(0, Math.floor(Number.isFinite(maxRays) ? maxRays : 0));
                let consecutiveMiss = 0;
                let consecutiveBlock = 0;
                let blockCount = 0;
                for (let i = 0; i < starts.length && i < limit; i++) {
                    const rs = starts[i];
                    const sp = rs?.startP;
                    const dir = rs?.dir;
                    if (!sp || !dir) continue;
                    const ray0 = { pos: { x: sp.x, y: sp.y, z: sp.z }, dir: { x: dir.x, y: dir.y, z: dir.z }, wavelength };
                    let hitGlobal = traceRayHitPoint(opticalSystemData, ray0, 1.0, targetSurfaceIndex);
                    if (!hitGlobal) {
                        // Robustness fallback: keep legacy behavior if the fast path fails.
                        // (Some ray-tracing paths may terminate early or have unusual surface indexing assumptions.)
                        const path = traceRay(opticalSystemData, ray0, 1.0, null, targetSurfaceIndex);
                        hitGlobal = path?.[targetSurfaceIndex] || null;
                        if (hitGlobal) legacyHits++;
                    }

                    attempted++;

                    if (!hitGlobal) {
                        consecutiveMiss++;
                        if (earlyAbortEnabled) {
                            try {
                                const f = getLastRayTraceFailureForThisEval();
                                if (f && typeof f === 'object' && String(f.kind || '') === 'PHYSICAL_APERTURE_BLOCK') {
                                    blockCount++;
                                    consecutiveBlock++;
                                } else {
                                    consecutiveBlock = 0;
                                }
                            } catch (_) {}

                            // Streak-based abort triggers (faster than hit-rate-only when early samples look OK).
                            if (attempted >= earlyAbortMinAttempt) {
                                const hitsNow0 = out.length;
                                if (consecutiveMiss >= missStreakMin && hitsNow0 <= streakMaxHits) {
                                    const fp = computeFailPenaltyForFastAbort();
                                    earlyAbort = {
                                        reason: 'miss-streak',
                                        attempted,
                                        hits: hitsNow0,
                                        hitRate: attempted > 0 ? (hitsNow0 / attempted) : 0,
                                        consecutiveMiss,
                                        consecutiveBlock,
                                        blockCount,
                                        thresholdMinAttempt: earlyAbortMinAttempt,
                                        thresholdMinHitRate: earlyAbortMinHitRate,
                                        thresholdMaxHits: earlyAbortMaxHits,
                                        thresholdMaxAttempt: earlyAbortMaxAttempt,
                                        thresholdMissStreakMin: missStreakMin,
                                        thresholdBlockStreakMin: blockStreakMin,
                                        thresholdStreakMaxHits: streakMaxHits,
                                        failPenaltyUm: fp.um,
                                        failPenaltyKind: fp.kind,
                                        failPenaltyRatio: fp.ratio
                                    };
                                    break;
                                }
                                if (consecutiveBlock >= blockStreakMin) {
                                    const fp = computeFailPenaltyForFastAbort();
                                    earlyAbort = {
                                        reason: 'aperture-block-streak',
                                        attempted,
                                        hits: hitsNow0,
                                        hitRate: attempted > 0 ? (hitsNow0 / attempted) : 0,
                                        consecutiveMiss,
                                        consecutiveBlock,
                                        blockCount,
                                        thresholdMinAttempt: earlyAbortMinAttempt,
                                        thresholdMinHitRate: earlyAbortMinHitRate,
                                        thresholdMaxHits: earlyAbortMaxHits,
                                        thresholdMaxAttempt: earlyAbortMaxAttempt,
                                        thresholdMissStreakMin: missStreakMin,
                                        thresholdBlockStreakMin: blockStreakMin,
                                        thresholdStreakMaxHits: streakMaxHits,
                                        failPenaltyUm: fp.um,
                                        failPenaltyKind: fp.kind,
                                        failPenaltyRatio: fp.ratio
                                    };
                                    break;
                                }

                                // Hard cap: if we've traced many rays and still have too few hits, abort.
                                if (attempted >= earlyAbortMaxAttempt && hitsNow0 <= streakMaxHits) {
                                    const hitRate0 = attempted > 0 ? (hitsNow0 / attempted) : 0;
                                    // Only treat this as a failure if the hit rate is actually low.
                                    // Otherwise this is just a sampling cap (good rays, just few samples).
                                    const isFailure = hitRate0 < earlyAbortMinHitRate;
                                    const fp = isFailure ? computeFailPenaltyForFastAbort() : null;
                                    earlyAbort = {
                                        reason: isFailure ? 'max-attempt-cap' : 'sample-cap',
                                        attempted,
                                        hits: hitsNow0,
                                        hitRate: hitRate0,
                                        consecutiveMiss,
                                        consecutiveBlock,
                                        blockCount,
                                        thresholdMinAttempt: earlyAbortMinAttempt,
                                        thresholdMinHitRate: earlyAbortMinHitRate,
                                        thresholdMaxHits: earlyAbortMaxHits,
                                        thresholdMaxAttempt: earlyAbortMaxAttempt,
                                        thresholdMissStreakMin: missStreakMin,
                                        thresholdBlockStreakMin: blockStreakMin,
                                        thresholdStreakMaxHits: streakMaxHits,
                                        failPenaltyUm: fp ? fp.um : null,
                                        failPenaltyKind: fp ? fp.kind : null,
                                        failPenaltyRatio: fp ? fp.ratio : null
                                    };
                                    break;
                                }
                            }
                        }
                        continue;
                    }

                    // Hit
                    consecutiveMiss = 0;
                    consecutiveBlock = 0;
                    const hitLocal = surfaceInfo ? transformPointToLocal(hitGlobal, surfaceInfo) : hitGlobal;
                    const x = Number(hitLocal?.x);
                    const y = Number(hitLocal?.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    const isChief = rs?.isChief === true || (rs?.isChief === undefined && i === 0);
                    out.push({ x, y, isChief });

                    // Early-abort when vignetting makes hit rate extremely low.
                    // This speeds up optimization runs in cases like PHYSICAL_APERTURE_BLOCK dominating.
                    if (earlyAbortEnabled && attempted >= Math.min(limit, earlyAbortMinAttempt)) {
                        const hitsNow = out.length;
                        const hitRate = attempted > 0 ? (hitsNow / attempted) : 0;
                        // Include hitRate=0 (all rays vignetted) as an early-abort case.
                        if (hitsNow <= earlyAbortMaxHits && hitRate < earlyAbortMinHitRate) {
                            const fp = computeFailPenaltyForFastAbort();
                            earlyAbort = {
                                reason: 'low-hit-rate',
                                attempted,
                                hits: hitsNow,
                                hitRate,
                                thresholdMinAttempt: earlyAbortMinAttempt,
                                thresholdMinHitRate: earlyAbortMinHitRate,
                                thresholdMaxHits: earlyAbortMaxHits,
                                thresholdMaxAttempt: earlyAbortMaxAttempt,
                                thresholdMissStreakMin: missStreakMin,
                                thresholdBlockStreakMin: blockStreakMin,
                                thresholdStreakMaxHits: streakMaxHits,
                                failPenaltyUm: fp.um,
                                failPenaltyKind: fp.kind,
                                failPenaltyRatio: fp.ratio
                            };
                            break;
                        }

                        // Same hard cap check after hits too.
                        if (attempted >= earlyAbortMaxAttempt && hitsNow <= streakMaxHits) {
                            // Only treat as failure when hit rate is actually low.
                            const isFailure = hitRate < earlyAbortMinHitRate;
                            const fp = isFailure ? computeFailPenaltyForFastAbort() : null;
                            earlyAbort = {
                                reason: isFailure ? 'max-attempt-cap' : 'sample-cap',
                                attempted,
                                hits: hitsNow,
                                hitRate,
                                consecutiveMiss,
                                consecutiveBlock,
                                blockCount,
                                thresholdMinAttempt: earlyAbortMinAttempt,
                                thresholdMinHitRate: earlyAbortMinHitRate,
                                thresholdMaxHits: earlyAbortMaxHits,
                                thresholdMaxAttempt: earlyAbortMaxAttempt,
                                thresholdMissStreakMin: missStreakMin,
                                thresholdBlockStreakMin: blockStreakMin,
                                thresholdStreakMaxHits: streakMaxHits,
                                failPenaltyUm: fp ? fp.um : null,
                                failPenaltyKind: fp ? fp.kind : null,
                                failPenaltyRatio: fp ? fp.ratio : null
                            };
                            break;
                        }
                    }
                }
                return { hits: out, legacyFallbackHits: legacyHits, attempted, earlyAbort };
            };

            let { hits, legacyFallbackHits, attempted, earlyAbort } = collectHits(rayStarts, rayCount);

            // Requirements mode robustness: if CB/tilt causes 0 hits, retry with a smaller emission pupil.
            // This is deterministic and only enabled during Requirements evaluation (not during optimization).
            const isRequirementsEval = (() => {
                try { return !!globalThis.__COOPT_EVALUATING_REQUIREMENTS; } catch (_) { return false; }
            })();
            if (!fastModeEnabled && isRequirementsEval && hits.length === 0) {
                const retryScales = [0.7, 0.5, 0.35, 0.25, 0.18, 0.12];
                let best = null;
                for (const s of retryScales) {
                    try {
                        const retryStarts = generateRayStartPointsForObject(
                            obj,
                            opticalSystemData,
                            rayCount,
                            apertureLimitMm,
                            {
                                annularRingCount: (desiredPattern === 'annular' || (!desiredPattern && currentPattern === 'annular'))
                                    ? effectiveAnnularRingCount
                                    : effectiveAnnularRingCount,
                                targetSurfaceIndex,
                                useChiefRayAnalysis: true,
                                chiefRaySolveMode: fastModeEnabled ? 'fast' : 'legacy',
                                wavelengthUm: wavelength,
                                pupilScale: s
                            }
                        );
                        if (!Array.isArray(retryStarts) || retryStarts.length === 0) continue;
                        const r = collectHits(retryStarts, rayCount);
                        const hn = Array.isArray(r.hits) ? r.hits.length : 0;
                        const bn = best && Array.isArray(best.hits) ? best.hits.length : 0;
                        if (!best || hn > bn) {
                            best = { scale: s, ...r };
                        }
                        if (hn > 0) break;
                    } catch (_) {
                        // ignore and continue
                    }
                }
                if (best && Array.isArray(best.hits) && best.hits.length > 0) {
                    hits = best.hits;
                    legacyFallbackHits = best.legacyFallbackHits;
                    attempted = best.attempted;
                    earlyAbort = null;
                    try {
                        stampSpotDebug({
                            retryPupilScaleAttempted: true,
                            retryPupilScaleUsed: best.scale,
                            retryHits: best.hits.length,
                            lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                        });
                    } catch (_) {}
                } else {
                    try {
                        stampSpotDebug({
                            retryPupilScaleAttempted: true,
                            retryPupilScaleUsed: null,
                            retryHits: 0,
                            lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                        });
                    } catch (_) {}
                }
            }

            // If we hit a sampling cap (not a failure), keep debug fields but do not penalize.
            if (fastModeEnabled && earlyAbort && (earlyAbort.failPenaltyUm === null || earlyAbort.failPenaltyUm === undefined)) {
                try {
                    stampSpotDebug({
                        earlyAbortAttempted: attempted,
                        earlyAbortHits: earlyAbort.hits,
                        earlyAbortHitRate: earlyAbort.hitRate,
                        earlyAbortReason: earlyAbort.reason,
                        lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                    });
                } catch (_) {}
            }

            if (fastModeEnabled && earlyAbort && earlyAbort.failPenaltyUm !== undefined && earlyAbort.failPenaltyUm !== null) {
                // If we failed due to physical aperture blocking with 0 hits, try a deterministic
                // tighter-aperture retry to recover some rays and keep the objective continuous.
                // (This is only for fast-mode and only for the worst case where we have no data.)
                if (hits.length === 0 && String(earlyAbort.failPenaltyKind || '') === 'PHYSICAL_APERTURE_BLOCK') {
                    const baseLim = (() => {
                        if (Number.isFinite(Number(apertureLimitMm)) && Number(apertureLimitMm) > 0) return Number(apertureLimitMm);
                        const f = getLastRayTraceFailureForThisEval();
                        const lim = Number(f?.apertureLimitMm ?? f?.details?.apertureLimitMm);
                        return (Number.isFinite(lim) && lim > 0) ? lim : null;
                    })();

                    const doRetry = (factor) => {
                        try {
                            if (!(baseLim && Number.isFinite(baseLim) && baseLim > 0)) return null;
                            const lim2 = baseLim * factor;
                            if (!(Number.isFinite(lim2) && lim2 > 0)) return null;

                            const retryRayCount = Math.max(10, Math.min(rayCount, 61));
                            const prevPattern2 = desiredPattern ? getRayEmissionPattern() : null;
                            if (desiredPattern) {
                                try { setRayEmissionPattern(desiredPattern); } catch (_) {}
                            }
                            let retryStarts;
                            try {
                                retryStarts = generateRayStartPointsForObject(
                                    obj,
                                    opticalSystemData,
                                    retryRayCount,
                                    lim2,
                                    {
                                        annularRingCount: (desiredPattern === 'annular' || (!desiredPattern && currentPattern === 'annular'))
                                            ? effectiveAnnularRingCount
                                            : effectiveAnnularRingCount,
                                        targetSurfaceIndex,
                                        useChiefRayAnalysis: true,
                                        chiefRaySolveMode: fastModeEnabled ? 'fast' : 'legacy',
                                        wavelengthUm: wavelength
                                    }
                                );
                            } finally {
                                if (desiredPattern && prevPattern2) {
                                    try { setRayEmissionPattern(prevPattern2); } catch (_) {}
                                }
                            }
                            if (!Array.isArray(retryStarts) || retryStarts.length === 0) return null;
                            const r2 = collectHits(retryStarts, retryRayCount);
                            return {
                                factor,
                                lim2,
                                retryRayCount,
                                retryStartsGenerated: retryStarts.length,
                                ...r2
                            };
                        } catch (_) {
                            return null;
                        }
                    };

                    const attempts = [0.7, 0.5, 0.35]
                        .map(f => doRetry(f))
                        .filter(x => x && typeof x === 'object');

                    // Pick best attempt by hit count.
                    let best = null;
                    for (const a of attempts) {
                        const hn = Array.isArray(a.hits) ? a.hits.length : 0;
                        const bn = best && Array.isArray(best.hits) ? best.hits.length : 0;
                        if (!best || hn > bn) best = a;
                    }

                    // Always stamp retry outcome for observability.
                    try {
                        stampSpotDebug({
                            retryTightApertureAttempted: true,
                            retryTightApertureFactors: attempts.map(a => a.factor),
                            retryRayCount: best ? best.retryRayCount : null,
                            retryApertureLimitMm: best ? best.lim2 : null,
                            retryRayStartsGenerated: best ? best.retryStartsGenerated : null,
                            retryHits: best && Array.isArray(best.hits) ? best.hits.length : 0,
                            retryEarlyAbortReason: best && best.earlyAbort ? best.earlyAbort.reason : null,
                            retryEarlyAbortHitRate: best && best.earlyAbort ? best.earlyAbort.hitRate : null,
                            lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                        });
                    } catch (_) {}

                    if (best && Array.isArray(best.hits) && best.hits.length > 0) {
                        hits = best.hits;
                        legacyFallbackHits = best.legacyFallbackHits;
                        attempted = best.attempted;
                        // Do not keep the previous early-abort penalty; proceed to compute spot size.
                        earlyAbort = null;
                    }
                }

                // If we still have an early-abort penalty, return it.
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
            }

            if (hits.length === 0) {
                // NOTE: Intentionally do NOT retry with a tighter aperture during optimization.
                // The previous fast-mode fallback would shrink the ray-start aperture when all rays vignette,
                // which changes evaluation conditions mid-optimization and can cause unstable behavior.
                // We instead rely on the bounded `no-ray-hits` penalty below.
                if (fastModeEnabled) {
                    try { stampSpotDebug({ retryTightApertureDisabled: true }); } catch (_) {}
                }

                if (hits.length === 0) {
                try {
                    if (typeof window !== 'undefined') {
                        // Merge (do not overwrite) so earlier stamps like apertureLimitMm survive.
                        stampSpotDebug({
                            ok: false,
                            reason: 'no-ray-hits',
                            targetSurfaceIndex,
                            rayCountRequested: rayCount,
                            rayStartsGenerated: Array.isArray(rayStarts) ? rayStarts.length : 0,
                            legacyFallbackHits,
                            wavelength,
                            fastModeEnabled,
                            lastRayTraceFailure: getLastRayTraceFailureForThisEval()
                        });
                    }
                } catch (_) {}
                // Fast-mode: avoid saturating the optimizer with a 1e9 value.
                // Use a bounded penalty that still strongly discourages vignetting.
                if (fastModeEnabled) {
                    const failPenalty = (() => {
                        try {
                            const f = getLastRayTraceFailureForThisEval();
                            if (f && typeof f === 'object' && String(f.kind || '') === 'PHYSICAL_APERTURE_BLOCK') {
                                const hitR = Number((f.hitRadiusMm ?? f.details?.hitRadiusMm));
                                const limR = Number((f.apertureLimitMm ?? f.details?.apertureLimitMm));
                                if (Number.isFinite(hitR) && Number.isFinite(limR) && limR > 0) {
                                    const ratio = Math.max(1, hitR / limR);
                                    // Keep within a sane numeric range for LM (do not overwhelm other residuals).
                                    // Typical spot targets are ~10..100um, so keep this in the ~1e4..1e5 band.
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
                if (typeof window !== 'undefined' && window.__cooptLastSpotSizeDebug) {
                    window.__cooptLastSpotSizeDebug.ok = true;
                    window.__cooptLastSpotSizeDebug.reason = 'ok';
                    window.__cooptLastSpotSizeDebug.legacyFallbackHits = legacyFallbackHits;
                    window.__cooptLastSpotSizeDebug.hits = hits.length;
                    window.__cooptLastSpotSizeDebug.lastRayTraceFailure = getLastRayTraceFailureForThisEval();
                    if (fastModeEnabled) {
                        window.__cooptLastSpotSizeDebugFast = window.__cooptLastSpotSizeDebug;
                    }
                }
            } catch (_) {}
            let chief = hits.find(h => h.isChief) || null;
            if (!chief) {
                // Spot Diagram fallback: if no chief is flagged, use centroid-closest as chief.
                const cx = hits.reduce((sum, h) => sum + h.x, 0) / hits.length;
                const cy = hits.reduce((sum, h) => sum + h.y, 0) / hits.length;
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
                errorMessage: String((err && err.message !== undefined) ? err.message : err),
                errorStack: (err && err.stack) ? String(err.stack) : ''
            });
            return 1e9;
        } finally {
            // If we returned early without stamping a terminal reason,
            // mark it explicitly so Requirements debug doesn't get stuck at "started".
            try {
                if (typeof window !== 'undefined' && window.__cooptLastSpotSizeDebug && typeof window.__cooptLastSpotSizeDebug === 'object') {
                    const r = String(window.__cooptLastSpotSizeDebug.reason ?? '');
                    const ok = window.__cooptLastSpotSizeDebug.ok;
                    if (r === 'started' && ok === false) {
                        window.__cooptLastSpotSizeDebug.reason = 'early-return-without-stamp';
                        window.__cooptLastSpotSizeDebug.ok = false;
                        window.__cooptLastSpotSizeDebug.resultUm = window.__cooptLastSpotSizeDebug.resultUm ?? 1e9;
                        window.__cooptLastSpotSizeDebug.earlyReturnStage = window.__cooptLastSpotSizeDebug.spotDiagStage ?? null;
                        window.__cooptLastSpotSizeDebug.lastRayTraceFailure = window.__cooptLastSpotSizeDebug.lastRayTraceFailure ?? getLastRayTraceFailureForThisEval?.();
                    }
                }
            } catch (_) {}
        }
    }

    getSurfaceIndexBySurfaceId(opticalSystemData, surfaceId1Based) {
        const sNum = Number.isFinite(Number(surfaceId1Based)) ? Math.floor(Number(surfaceId1Based)) : NaN;
        if (!Number.isFinite(sNum) || sNum < 0) return -1;

        const byId = Array.isArray(opticalSystemData)
            ? opticalSystemData.findIndex(r => r && Number(r.id) === sNum)
            : -1;
        if (byId >= 0) return byId;

        // Fallback: treat as array index (1-based typical UI, but allow 0-based too)
        if (Array.isArray(opticalSystemData)) {
            const idx1 = sNum; // if user passes 0-based index, this matches; if 1-based id, likely already found above
            if (idx1 >= 0 && idx1 < opticalSystemData.length) return idx1;
            const idx0 = sNum - 1;
            if (idx0 >= 0 && idx0 < opticalSystemData.length) return idx0;
        }

        return -1;
    }

    getSemidiaFromSurfaceRow(surfaceRow) {
        if (!surfaceRow) return Infinity;
        const v = surfaceRow.semidia ?? surfaceRow['Semi Diameter'] ?? surfaceRow['semi diameter'];
        const n = Number(v);
        return (Number.isFinite(n) && n > 0) ? n : Infinity;
    }

    isInfiniteConjugateFromObjectRow(opticalSystemData) {
        const t = opticalSystemData?.[0]?.thickness;
        if (t === Infinity) return true;
        const s = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
        return (s === 'INF' || s === 'INFINITY');
    }

    normalizeDir(x, y, z) {
        const nx = Number(x);
        const ny = Number(y);
        const nz = Number(z);
        const L = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!Number.isFinite(L) || L <= 0) return { x: 0, y: 0, z: 1 };
        return { x: nx / L, y: ny / L, z: nz / L };
    }

    traceRayToSurfaceIndex(opticalSystemData, ray0, surfaceIndex) {
        const p = traceRay(opticalSystemData, ray0, 1.0, null, surfaceIndex);
        if (!p || !Array.isArray(p)) return null;
        const hit = p[surfaceIndex + 1];
        if (!hit) return null;
        return hit;
    }

    solveCrossRayToStopEdgeY(opticalSystemData, stopIndex, stopRadius, wavelength) {
        const isInfinite = this.isInfiniteConjugateFromObjectRow(opticalSystemData);
        const zStart = isInfinite ? -25 : 0;
        const targetY = stopRadius;

        const evalFunc = (u) => {
            const uNum = Number(u);
            if (!Number.isFinite(uNum)) return { ok: false, blocked: true, value: Infinity };

            let ray0;
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

        // f(0) は通常 negative（0 - targetY）なので、正側へブラケット
        const f0 = evalFunc(0);
        if (!f0.ok && !f0.ray0) return null;

        let lo = 0;
        let hi = isInfinite ? Math.max(1e-6, stopRadius) : 0.05; // finite は角度パラメータなので小さめから

        let flo = f0.ok ? f0.value : -Infinity;
        let fhiObj = evalFunc(hi);
        let tries = 0;

        // hi を拡大して符号反転（または blocked=overshoot 相当）を見つける
        while (tries < 40) {
            if (fhiObj.ok) {
                if (fhiObj.value >= 0) break;
            } else if (fhiObj.blocked) {
                // blocked は「大きすぎる」側として扱い、ブラケット成立
                break;
            }
            hi *= 2;
            fhiObj = evalFunc(hi);
            tries++;
        }

        // ブラケット不成立
        if (!(fhiObj.ok && fhiObj.value >= 0) && !fhiObj.blocked) {
            return null;
        }

        // 二分探索
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
                // blocked => hi 側に寄せる
                hi = mid;
            }
        }

        return bestRay0;
    }

    calculateClearanceVsSemidia(operand, opticalSystemData) {
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
            // 光線が途中でブロックされた等
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

    /**
     * ConfigIdに対応するSource/Objectデータを取得（無ければ現在のテーブルを使用）
     */
    getConfigTablesByConfigId(configId) {
        try {
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
            const activeConfigId = (systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null)
                ? String(systemConfig.activeConfigId)
                : '';

            let targetConfigId = configId;
            if (!targetConfigId) {
                targetConfigId = activeConfigId;
            }
            const targetIdStr = (targetConfigId !== undefined && targetConfigId !== null) ? String(targetConfigId) : '';

            // For the active config, prefer the *live UI tables* (so Requirements update immediately
            // even if the user hasn't saved the configuration snapshot back into systemConfigurations).
            if (activeConfigId && targetIdStr && targetIdStr === activeConfigId) {
                return {
                    source: getSourceRows(),
                    object: (typeof window !== 'undefined' && window.getObjectRows)
                        ? window.getObjectRows()
                        : (window.tableObject ? window.tableObject.getData() : [])
                };
            }

            const config = systemConfig?.configurations?.find(c => String(c.id) === String(targetIdStr));
            if (!config) {
                return {
                    source: getSourceRows(),
                    object: (typeof window !== 'undefined' && window.getObjectRows) ? window.getObjectRows() : (window.tableObject ? window.tableObject.getData() : [])
                };
            }
            return {
                source: Array.isArray(config.source) ? config.source : getSourceRows(),
                object: Array.isArray(config.object) ? config.object : ((typeof window !== 'undefined' && window.getObjectRows) ? window.getObjectRows() : (window.tableObject ? window.tableObject.getData() : []))
            };
        } catch {
            return {
                source: getSourceRows(),
                object: (typeof window !== 'undefined' && window.getObjectRows) ? window.getObjectRows() : (window.tableObject ? window.tableObject.getData() : [])
            };
        }
    }

    getWavelengthFromSourceRows(sourceRows, sourceIndex1Based) {
        const idx = Number.isFinite(Number(sourceIndex1Based)) ? Math.floor(Number(sourceIndex1Based)) : 1;
        const index0 = Math.max(0, idx - 1);
        const row = Array.isArray(sourceRows) ? sourceRows[index0] : null;
        const wl = row ? Number(row.wavelength) : NaN;
        return (Number.isFinite(wl) && wl > 0) ? wl : 0.5875618;
    }

    getPrimaryWavelengthFromSourceRows(sourceRows) {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5875618;
        const primaryRow = sourceRows.find(r => r && r.primary && String(r.primary).toLowerCase().includes('primary'));
        const wl = primaryRow ? Number(primaryRow.wavelength) : NaN;
        if (Number.isFinite(wl) && wl > 0) return wl;
        // フォールバック: 1行目
        const wl0 = Number(sourceRows[0]?.wavelength);
        return (Number.isFinite(wl0) && wl0 > 0) ? wl0 : 0.5875618;
    }

    getSystemWavelengthFromOperandOrPrimary(operand, sourceRows) {
        const raw = (operand && operand.param1 !== undefined && operand.param1 !== null) ? String(operand.param1).trim() : '';
        if (raw === '') return this.getPrimaryWavelengthFromSourceRows(sourceRows);

        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return this.getPrimaryWavelengthFromSourceRows(sourceRows);

        // Backward compatible behavior: most operands historically used "λ idx" (Source row number).
        // In practice, users often type the wavelength value itself (e.g. 0.4861, 0.5876, 0.6563).
        // If we treat 0.4861 as an index, Math.floor() -> 0, and we incorrectly fall back to Primary.
        // Heuristic:
        // - n < 1 : almost certainly wavelength in µm
        // - non-integer with '.' or 'e' : treat as wavelength in µm
        const s = raw.toLowerCase();
        const isNonIntegerLiteral = (s.includes('.') || s.includes('e')) && Math.abs(n - Math.round(n)) > 1e-12;
        const looksLikeWavelengthUm = (n < 1) || isNonIntegerLiteral;
        if (looksLikeWavelengthUm) return n;

        const idx1 = Math.floor(n);
        if (idx1 > 0) return this.getWavelengthFromSourceRows(sourceRows, idx1);
        return this.getPrimaryWavelengthFromSourceRows(sourceRows);
    }

    safeFiniteNumberOrZero(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    computeTotalSystemLengthMm(opticalSystemData) {
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

    computeObjectDistanceMm(opticalSystemData) {
        const tRaw = opticalSystemData?.[0]?.thickness;
        if (tRaw === undefined || tRaw === null) return 0;
        const s = String(tRaw).trim().toUpperCase();
        if (s === 'INF' || s === 'INFINITY') return 0;
        const t = Number(tRaw);
        return Number.isFinite(t) ? t : 0;
    }

    getPrimarySystemMetricsCached(operand, opticalSystemData) {
        const { source: sourceRows } = this.getConfigTablesByConfigId(operand?.configId);
        const wavelength = this.getSystemWavelengthFromOperandOrPrimary(operand, sourceRows);
        const cfgKey = operand?.configId ? String(operand.configId) : 'active';
        const cacheKey = `primary-metrics:${cfgKey}:wl=${wavelength}`;

        const cached = this._runtimeCache ? this._runtimeCache.get(cacheKey) : null;
        if (cached) return cached;

        const paraxial = calculateParaxialData(opticalSystemData, wavelength);

        const fl = this.safeFiniteNumberOrZero(paraxial?.focalLength);
        const bfl = this.safeFiniteNumberOrZero(paraxial?.backFocalLength);
        const imd = this.safeFiniteNumberOrZero(paraxial?.imageDistance);
        const finalAlpha = Number(paraxial?.finalAlpha);

        // EFL (System Data): EFL = 1 / alpha(final) with h[1]=1
        const eflTrace = calculateFullSystemParaxialTrace(opticalSystemData, wavelength);
        const efl = (eflTrace && Number.isFinite(eflTrace.finalAlpha) && Math.abs(eflTrace.finalAlpha) > 1e-12)
            ? (1.0 / eflTrace.finalAlpha)
            : 0;

        const totalLength = this.computeTotalSystemLengthMm(opticalSystemData);
        const objd = this.computeObjectDistanceMm(opticalSystemData);

        const exitPupilDetails = paraxial?.exitPupilDetails;
        const newSpecPupils = paraxial?.newSpecPupils;
        const exitPupil = newSpecPupils?.exitPupil;
        const entrancePupil = newSpecPupils?.entrancePupil;

        // Prefer new method details if available
        const expd = this.safeFiniteNumberOrZero(exitPupilDetails?.diameter ?? exitPupil?.diameter ?? paraxial?.exitPupilDiameter);
        const exPosOrigin = this.safeFiniteNumberOrZero(exitPupilDetails?.position ?? exitPupil?.position);
        const exppFromImage = (Number.isFinite(exPosOrigin) && Number.isFinite(imd)) ? (exPosOrigin - imd) : 0;

        // βexp: prefer explicit betaExp, else magnification
        const betaExpRaw = (typeof exitPupil?.betaExp === 'number') ? exitPupil.betaExp
            : (typeof exitPupilDetails?.betaExp === 'number') ? exitPupilDetails.betaExp
            : (typeof exitPupilDetails?.magnification === 'number') ? exitPupilDetails.magnification
            : (typeof exitPupil?.magnification === 'number') ? exitPupil.magnification
            : NaN;
        const betaExp = this.safeFiniteNumberOrZero(betaExpRaw);

        const enpd = this.safeFiniteNumberOrZero(entrancePupil?.diameter ?? paraxial?.entrancePupilDiameter);
        const enpp = this.safeFiniteNumberOrZero(entrancePupil?.position);
        const enpm = this.safeFiniteNumberOrZero(entrancePupil?.magnification);

        // Paraxial magnification (finite object): beta = alpha[1]/alpha[final], alpha[1] = -1/objd (h[1]=1, n=1)
        let pmag = 0;
        if (objd > 0 && Number.isFinite(finalAlpha) && Math.abs(finalAlpha) > 1e-12) {
            const initialAlpha = -1.0 / objd;
            pmag = initialAlpha / finalAlpha;
        }

        // Working F#: (-ExP + id) / ExPD (using origin position)
        let fnoWrk = 0;
        if (Number.isFinite(exPosOrigin) && Number.isFinite(imd) && expd > 0) {
            fnoWrk = (-exPosOrigin + imd) / expd;
        }

        // Object Space F# = abs(F#work / beta) if beta != 0
        let fnoObj = 0;
        if (Math.abs(pmag) > 1e-12 && Number.isFinite(fnoWrk)) {
            fnoObj = Math.abs(fnoWrk / pmag);
        }

        // Image Space F# = f' / EnPD (System Data uses FL)
        let fnoImg = 0;
        if (fl > 0 && enpd > 0) {
            fnoImg = fl / enpd;
        }

        // NAimg = 1/(2*F#work), NAobj = abs(NAimg * beta)
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

    calculatePrimarySystemMetric(operand, opticalSystemData, key) {
        if (!Array.isArray(opticalSystemData) || opticalSystemData.length === 0) return 0;
        const metrics = this.getPrimarySystemMetricsCached(operand, opticalSystemData);
        return this.safeFiniteNumberOrZero(metrics ? metrics[key] : 0);
    }

    /**
     * Seidel係数合計（I/II/III/IV/V/LCA/TCA）を評価値として返す
     * - param1(λ): Sourceテーブルの行番号（1始まり）
     * - 3rd係数: 指定波長で計算
     * - LCA/TCA: Primary波長に対する差（selected - primary）
     */
    calculateSeidelTotal(operand, opticalSystemData, totalKey) {
        if (!opticalSystemData || opticalSystemData.length < 2) return 0;

        const { source: sourceRows, object: objectRows } = this.getConfigTablesByConfigId(operand.configId);
        
        // Parse Mode parameter: accept single value (0 or 1) or comma-separated list (e.g., "0,1")
        const modeRaw = (operand?.param2 !== undefined && operand?.param2 !== null) ? String(operand.param2).trim() : '';
        const modeList = (() => {
            if (modeRaw === '') return [0];
            if (modeRaw.includes(',')) {
                // Parse comma-separated list
                return modeRaw.split(',')
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => n === 0 || n === 1);
            }
            const single = parseInt(modeRaw, 10);
            return (single === 0 || single === 1) ? [single] : [0];
        })();
        
        // If list contains multiple modes, compute RMS over all modes
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
        
        // Single mode: use existing logic
        const mode = modeList[0] || 0;
        const isAfocal = mode === 1;
        return this._calculateSeidelTotalSingleMode(
            operand, opticalSystemData, totalKey, sourceRows, objectRows, isAfocal
        );
    }
    
    _calculateSeidelTotalSingleMode(operand, opticalSystemData, totalKey, sourceRows, objectRows, isAfocal) {
        // S1 (Context3): 0 => total, else surface
        const s1Num = Number.isFinite(Number(operand?.param3)) ? Math.floor(Number(operand.param3)) : 0;
        const s1 = (Number.isFinite(s1Num) && s1Num > 0) ? s1Num : 0;

        // Reference Focal Length (Context4)
        // - blank => Auto
        // - 0 => Auto
        // Imaging: Auto means use calculated FL (ignore textbox)
        // Afocal: Auto means default unit scale (see afocal module)
        const refFLRaw = (operand && operand.param4 !== undefined && operand.param4 !== null) ? String(operand.param4).trim() : '';
        const refFLNum = (refFLRaw === '') ? 0 : Number(refFLRaw);
        const referenceFocalLengthAfocal = (Number.isFinite(refFLNum) && refFLNum !== 0) ? refFLNum : undefined;
        const referenceFocalLengthOverrideImaging = (Number.isFinite(refFLNum) && refFLNum !== 0) ? refFLNum : 0;

        const primaryWavelength = this.getPrimaryWavelengthFromSourceRows(sourceRows);
        const sourceIndex = parseInt(operand.param1) || 1;
        const selectedWavelength = this.getWavelengthFromSourceRows(sourceRows, sourceIndex);

        // LCA/TCA は System Data の波長設定を使用（operand param1 では指定しない）
        const baseWavelength = (totalKey === 'LCA' || totalKey === 'TCA') ? primaryWavelength : selectedWavelength;

        // キャッシュキー（同一run内）
        const cfgKey = operand.configId ? String(operand.configId) : 'active';
        const cacheKey = `seidel:${cfgKey}:mode=${isAfocal ? 'afocal' : 'imaging'}:wl=${baseWavelength}:s1=${s1}:refFL=${(isAfocal ? (referenceFocalLengthAfocal ?? 'auto') : (referenceFocalLengthOverrideImaging === 0 ? 'auto' : referenceFocalLengthOverrideImaging))}:key=${totalKey}`;
        if (this._runtimeCache && this._runtimeCache.has(cacheKey)) {
            return this._runtimeCache.get(cacheKey);
        }

        try {
            let seidel;

            if (isAfocal) {
                // Stop index (0-based). fallback to 1 like existing afocal handler.
                let stopIndex = opticalSystemData.findIndex(row => row && (row['object type'] === 'Stop' || row.object === 'Stop'));
                if (stopIndex === -1) {
                    const fallback = findStopSurfaceIndex ? findStopSurfaceIndex(opticalSystemData) : -1;
                    stopIndex = (fallback >= 0) ? fallback : 1;
                }

                seidel = calculateAfocalSeidelCoefficientsIntegrated(
                    opticalSystemData,
                    baseWavelength,
                    stopIndex,
                    objectRows,
                    referenceFocalLengthAfocal
                );
            } else {
                // Imaging: match System Data (no chromaticOverrides)
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
                        // Prefer matching by Surf id shown in System Data (row.id)
                        coeffs.find(sc => sc && Number(opticalSystemData?.[Number(sc.surfaceIndex)]?.id) === Number(s1))
                        // Fallback: treat S1 as surfaceIndex (array index)
                        || coeffs.find(sc => sc && Number(sc.surfaceIndex) === Number(s1))
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
    /**
     * ConfigIdに対応する光学系データを取得
     * @param {string} configId - Configuration ID（空文字列の場合は現在のアクティブなConfig）
     * @returns {Array} 光学系データ
     */
    getOpticalSystemDataByConfigId(configId) {
        try {
            // CRITICAL: Prefer in-memory cache (updated immediately after CB insertion)
            // over systemConfig.opticalSystem (may be stale during the same evaluation cycle).
            try {
                if (typeof window !== 'undefined' && window.__cooptOpticalSystemByConfigId) {
                    const cfgId = (configId !== undefined && configId !== null) ? String(configId).trim() : '';
                    if (cfgId) {
                        const cached = window.__cooptOpticalSystemByConfigId[cfgId];
                        if (Array.isArray(cached) && cached.length > 0) {
                            return cached;
                        }
                    }
                }
            } catch (_) {}
            
            // CRITICAL: Prefer in-memory systemConfig only if it matches localStorage.
            // This avoids stale activeConfigId after UI config switches.
            let systemConfig = null;
            let memSystemConfig = null;
            let lsSystemConfig = null;
            try {
                if (typeof window !== 'undefined' && window.__cooptSystemConfig) {
                    memSystemConfig = window.__cooptSystemConfig;
                }
            } catch (_) {}
            try {
                lsSystemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
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
            
            // IMPORTANT: distinguish "Current" (blank configId) from an explicit config selection.
            // If configId is blank, we evaluate against the live UI tables for the active config.
            // If configId is explicitly provided (even if it equals activeConfigId), we evaluate
            // against the stored config snapshot/blocks to keep Requirements deterministic.
            const wantsCurrent = (configId === undefined || configId === null || String(configId).trim() === '');
            const targetConfigId = wantsCurrent ? activeConfigId : configId;

            const targetIdStr = (targetConfigId !== undefined && targetConfigId !== null) ? String(targetConfigId) : '';

            // 対応するConfigurationを検索
            const config = systemConfig?.configurations?.find(c => String(c.id) === String(targetIdStr));
            
            // CRITICAL FIX for CB insertion:
            // When target config is active OR when evaluating non-active configs,
            // use the live UI table (which reflects CB insertion immediately).
            // For non-active configs, also apply their scenario overrides.
            const isActiveConfig = activeConfigId && targetIdStr && targetIdStr === activeConfigId;
            
            if (isActiveConfig || wantsCurrent) {
                // Active config: use live UI table directly
                const hasBlocksForActive = Array.isArray(config?.blocks);
                if (!hasBlocksForActive) return getOpticalSystemRows();
                // If has blocks, continue to expansion below (for consistency with Design Intent)
            }
            
            if (!config) {
                console.warn(`Config ID ${targetIdStr} が見つかりません。現在のテーブルデータを使用します。`);
                return getOpticalSystemRows();
            }
            
            // Original logic for active config or when blocks are available
            // Blocks canonical: if blocks exist, optionally apply scenario overrides and expand on the fly.
            // Optional non-persistent override hook (for Suggest/tests):
            // window.__cooptBlocksOverride = { [configId]: blocksArray }
            let overrideBlocks = null;
            try {
                const ov = (typeof window !== 'undefined') ? window.__cooptBlocksOverride : null;
                if (ov && typeof ov === 'object') {
                    const key = String(targetConfigId);
                    const b = ov[key];
                    if (Array.isArray(b)) overrideBlocks = b;
                }
            } catch (_) {
                // ignore
            }

            const hasBlocks = Array.isArray(overrideBlocks || config.blocks);
            const scenarios = Array.isArray(config.scenarios) ? config.scenarios : null;

            // Optional override hook for optimizers/tests (do NOT persist):
            // window.__cooptScenarioOverride = { [configId]: scenarioId }
            let scenarioId = null;
            try {
                const ov = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : null;
                if (ov && typeof ov === 'object') {
                    const key = String(targetConfigId);
                    if (ov[key]) scenarioId = String(ov[key]);
                }
            } catch (_) {
                // ignore
            }

            if (!scenarioId && config.activeScenarioId) {
                scenarioId = String(config.activeScenarioId);
            }

            if (hasBlocks) {
                let blocksToExpand = overrideBlocks || config.blocks;

                if (scenarioId && scenarios) {
                    const scn = scenarios.find(s => s && String(s.id) === String(scenarioId));
                    const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : null;
                    blocksToExpand = applyOverridesToBlocks(blocksToExpand, overrides);
                }

                const expanded = expandBlocksToOpticalSystemRows(blocksToExpand);
                if (expanded && Array.isArray(expanded.rows)) {
                    // NOTE: Legacy per-surface semidia is preserved via block-schema.js's
                    // provenance-based mechanism (__captureBlockApertureFromLegacyRows).
                    // Do NOT use index-based copying here, as CB surface insertion shifts indices
                    // and causes incorrect semidia to be applied.

                    // Preserve Object thickness to keep evaluation consistent with the UI table.
                    // Blocks expansion currently creates a default Object row (thickness may be 100).
                    // Prefer config.opticalSystem[0].thickness (persisted), else for the active config
                    // fall back to OpticalSystemTableData[0].thickness (UI table snapshot).
                    try {
                        const rows = expanded.rows;
                        if (rows.length > 0) {
                            const hasObjectSurface = Array.isArray(config?.blocks) && config.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectSurface');
                            if (hasObjectSurface) return expanded.rows;

                            let preferredThickness = undefined;

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
                        const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
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
            return getOpticalSystemRows();
        }
    }
    
    /**
     * EFFL (Effective Focal Length) を計算
     * @param {Object} operand - オペランドデータ
     * @param {Array} opticalSystemData - 光学系データ
     * @returns {number} 焦点距離 (mm)
     */
    calculateEFFL(operand, opticalSystemData) {
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
        
        // param1: Sourceテーブルの行番号 (1から始まる、デフォルト1=d-line)
        // param2: 開始面のSurface番号（id値） (デフォルト1)
        // param3: 終了面のSurface番号（id値） (デフォルト最終面の1つ前)
        
        const sourceIndex = parseInt(operand.param1) || 1;
        const startSurf = parseInt(operand.param2) || 1;
        const endSurf = parseInt(operand.param3) || (opticalSystemData.length - 2);
        
        // Sourceテーブルから波長を取得（operand.configId がある場合はそのConfigのSourceを優先）
        const sourceRows = this.getConfigTablesByConfigId(operand.configId).source;
        let wavelength = 0.5875618; // デフォルトはd-line
        
        if (sourceRows && sourceRows.length > 0) {
            // sourceIndexは1から始まる（表示用）ので、配列インデックスは-1
            const sourceRow = sourceRows[sourceIndex - 1];
            if (sourceRow && sourceRow.wavelength) {
                wavelength = parseFloat(sourceRow.wavelength);
                console.log(`📡 Source${sourceIndex}の波長を使用: ${wavelength} μm`);
            } else {
                console.warn(`⚠️ Source${sourceIndex}が見つかりません。デフォルト波長を使用: ${wavelength} μm`);
            }
        } else {
            console.warn('⚠️ Sourceテーブルが空です。デフォルト波長を使用: ${wavelength} μm');
        }
        
        console.log('📊 面範囲:', {
            startSurf,
            endSurf,
            sourceIndex,
            wavelength,
            totalSurfaces: opticalSystemData.length
        });
        
        // 指定範囲の面を抽出
        let subSystemData = [];
        
        // Object面を追加（開始idがObject面のidと同じ場合）
        const objectSurfaceIdNum = Number(opticalSystemData[0]?.id);
        const objectSurfaceId = Number.isFinite(objectSurfaceIdNum) ? objectSurfaceIdNum : 1;
        if (startSurf === objectSurfaceId) {
            subSystemData.push(opticalSystemData[0]); // Object面
            console.log(`✓ Object面追加（id=${objectSurfaceId}）:`, opticalSystemData[0]);
        } else {
            // 中間から開始する場合は、仮想Object面を作成
            const virtualObject = {
                surface: 0,
                "object type": "Object",
                thickness: Infinity,
                comment: "Virtual Object"
            };
            subSystemData.push(virtualObject);
            console.log(`✓ 仮想Object面追加（開始id=${startSurf}）`);
        }
        
        // 指定範囲の面を追加（Surface番号: startSurf～endSurf）
        // param2, param3は面のSurface番号（idフィールドの値）を指定
        for (let i = 1; i < opticalSystemData.length - 1; i++) {
            const surface = opticalSystemData[i];
            const surfaceIdNum = Number(surface?.id);
            if (!Number.isFinite(surfaceIdNum)) continue;
            if (surfaceIdNum >= startSurf && surfaceIdNum <= endSurf) {
                subSystemData.push({ ...surface, id: surfaceIdNum });
                console.log(`✓ 面${i}追加（id=${surfaceIdNum}）:`, surface);
            }
        }
        
        // Image面を追加
        const imageSurface = {
            surface: subSystemData.length,
            "object type": "Image",
            thickness: 0,
            comment: "Image"
        };
        subSystemData.push(imageSurface);
        console.log('✓ Image面追加');
        
        console.log('📋 サブシステムデータ:', subSystemData);
        
        // EFL計算: System Dataと同じ方法を使用
        // calculateFullSystemParaxialTraceを使用して h[1] / α[IMG-1] で計算
        const paraxialResult = calculateFullSystemParaxialTrace(subSystemData, wavelength);
        
        console.log('🎯 近軸追跡結果:', paraxialResult);
        
        if (!paraxialResult || Math.abs(paraxialResult.finalAlpha) < 1e-10) {
            console.warn(`❌ EFFL計算失敗: 面${startSurf}〜${endSurf}, 波長${wavelength}μm`);
            return 0;
        }
        
        // EFL = h[1] / α[IMG-1], h[1] = 1.0 なので EFL = 1.0 / α[IMG-1]
        const efl = 1.0 / paraxialResult.finalAlpha;
        
        console.log(`✅ EFFL計算: 面${startSurf}〜${endSurf}, 波長${wavelength}μm = ${efl.toFixed(6)} mm`);
        return efl;
    }
    
    /**
     * データを取得（Save用）
     * @returns {Array} オペランドデータ配列
     */
    getData() {
        return this.operands;
    }
    
    /**
     * 選択行のEvaluation Functionに基づいてパラメータカラムヘッダーを更新
     */
    updateParameterHeaders(rowData) {
        const operand = rowData.operand;
        const definition = OPERAND_DEFINITIONS[operand];
        
        console.log('🔄 Updating parameter headers for operand:', operand, definition);
        
        // operandがnullまたは定義されていない場合は全て「-」にする
        if (!operand || !definition || !definition.parameters) {
            const paramFields = ['param1', 'param2', 'param3', 'param4'];
            paramFields.forEach((field) => {
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
        
        // パラメータカラムのヘッダーは parameters の順ではなく key でマッピングする
        // （例: LCA/TCA は param2 のみを使う、など）
        const paramFields = ['param1', 'param2', 'param3', 'param4'];

        paramFields.forEach((field) => {
            const column = this.table.getColumn(field);
            if (!column) return;

            const headerElement = column.getElement().querySelector('.tabulator-col-title');
            if (!headerElement) return;

            const paramDef = Array.isArray(definition.parameters)
                ? definition.parameters.find(p => p && p.key === field)
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
    
    /**
     * パラメータカラムヘッダーをデフォルトに戻す
     */
    resetParameterHeaders() {
        const defaultTitles = {
            param1: '-',
            param2: '-',
            param3: '-',
            param4: '-'
        };
        
        Object.entries(defaultTitles).forEach(([field, title]) => {
            const column = this.table.getColumn(field);
            if (column) {
                const headerElement = column.getElement().querySelector('.tabulator-col-title');
                if (headerElement) {
                    headerElement.textContent = title;
                }
            }
        });
    }
    
    /**
     * データを設定（Load用）
     * @param {Array} data - オペランドデータ配列
     */
    setData(data) {
        if (!Array.isArray(data)) {
            console.warn('Merit Function setData: 無効なデータ形式');
            return;
        }

        // Remove deprecated helper operands (requested to be deleted).
        const dropDeprecated = (op) => {
            const name = String(op?.operand ?? '').trim();
            return name === 'ZERN_WL_UM' || name === 'ZERN_FIT_TERMS';
        };

        this.operands = data.filter(op => !dropDeprecated(op));
        this.updateRowNumbers();
        
        if (this.table) {
            this.table.setData(this.operands);
        }
        
        console.log('✅ Merit Function データを読み込みました:', this.operands.length, '件');
    }
    
    /**
     * ローカルストレージから読み込み
     */
    loadFromStorage() {
        try {
            const savedData = localStorage.getItem('meritFunctionData');
            if (savedData) {
                const data = JSON.parse(savedData);

                // Remove deprecated helper operands (requested to be deleted).
                const dropDeprecated = (op) => {
                    const name = String(op?.operand ?? '').trim();
                    return name === 'ZERN_WL_UM' || name === 'ZERN_FIT_TERMS';
                };
                const sanitized = Array.isArray(data) ? data.filter(op => !dropDeprecated(op)) : [];
                
                // 既存データでconfigIdがない場合、アクティブなConfigにマイグレーション
                let activeConfigId = "";
                try {
                    const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
                    if (systemConfig && systemConfig.activeConfigId) {
                        activeConfigId = String(systemConfig.activeConfigId);
                    }
                } catch (e) {
                    console.warn('Active config ID取得エラー:', e);
                }
                
                this.operands = sanitized.map(operand => {
                    // configIdを文字列に統一（undefinedまたはnullの場合はアクティブなConfigを設定）
                    if (operand.configId === undefined || operand.configId === null) {
                        return { ...operand, configId: activeConfigId };
                    }
                    // 既存の数値IDを文字列に変換
                    return { ...operand, configId: String(operand.configId) };
                });
                

            }
        } catch (error) {
            console.error('❌ Merit Function ローカルストレージ読み込みエラー:', error);
        }
    }
    
    /**
     * ローカルストレージに保存
     */
    saveToStorage() {
        try {
            localStorage.setItem('meritFunctionData', JSON.stringify(this.operands));
            console.log('✅ Merit Function データをローカルストレージに保存しました:', this.operands.length, '件');
        } catch (error) {
            console.error('❌ Merit Function ローカルストレージ保存エラー:', error);
        }
    }
    
    /**
     * Configuration リストを取得（ドロップダウン用）
     */
    getConfigurationList() {
        try {
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
            if (!systemConfig || !systemConfig.configurations) {
                console.log('📋 Configuration リスト: デフォルト (Current のみ)');
                return { "": 'Current' };
            }
            
            // アクティブなConfigの名前を取得
            const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
            const activeConfigName = activeConfig ? activeConfig.name : '';
            
            const configList = { "": `Current (${activeConfigName})` };
            systemConfig.configurations.forEach(config => {
                configList[String(config.id)] = config.name;
            });
            
            console.log('📋 Configuration リスト:', configList);
            return configList;
        } catch (error) {
            console.error('Configuration リスト取得エラー:', error);
            return { "": 'Current' };
        }
    }
    
    /**
     * Config ID から Config 名を取得
     */
    getConfigName(configId) {
        if (!configId && configId !== 0) {
            // 空文字列の場合、現在のアクティブなConfig名を取得
            try {
                const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
                if (systemConfig && systemConfig.configurations) {
                    const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
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
            const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
            if (!systemConfig || !systemConfig.configurations) {
                return 'Current';
            }
            
            const config = systemConfig.configurations.find(c => String(c.id) === String(configId));
            return config ? config.name : 'Current';
        } catch (error) {
            console.error('Config 名取得エラー:', error);
            return 'Current';
        }
    }
}

// DOMContentLoaded時に初期化
document.addEventListener('DOMContentLoaded', () => {
    try {
        window.meritFunctionEditor = new MeritFunctionEditor();


        try {
            if (typeof window !== 'undefined' && !window.__cooptLastSpotSizeDebug) {
                window.__cooptLastSpotSizeDebug = {
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
    } catch (error) {
        console.error('❌ Merit Function Editor初期化エラー:', error);
    }
});

export { MeritFunctionEditor, OPERAND_DEFINITIONS };

// Developer helper: summarize spot-size debug entries without dumping huge objects.
// Usage in console: `__cooptSummarizeSpotSizeDebug()`
try {
    if (typeof globalThis !== 'undefined') {
        globalThis.__cooptSummarizeSpotSizeDebug = function __cooptSummarizeSpotSizeDebug() {
            const byId = globalThis.__cooptSpotSizeDebugByReqRowId;
            if (!byId || typeof byId !== 'object') return {};
            const out = {};
            for (const [k, v] of Object.entries(byId)) {
                if (!v || typeof v !== 'object') continue;
                out[k] = {
                    ok: v.ok,
                    reason: v.reason,
                    configId: v.configId,
                    reqRowIndex: v.reqRowIndex,
                    reqOp: v.reqOp,
                    objectIndex0: v.objectIndex0,
                    hits: v.hits,
                    resultUm: v.resultUm,
                    spotDiagFailureAnySummary: v.spotDiagFailureAnySummary,
                    targetSurfaceIndex: v.targetSurfaceIndex,
                    uiSurfaceIdUsed: v.uiSurfaceIdUsed,
                    uiSurfaceIndexResolved: v.uiSurfaceIndexResolved,
                    imageSurfaceIndex: v.imageSurfaceIndex,
                    opticalSystemSurfaceCount: v.opticalSystemSurfaceCount,
                    targetRowObjectType: v.targetRowObjectType,
                    targetRowSurfType: v.targetRowSurfType,
                    settingsSurfaceIdUsed: v.settingsSurfaceIdUsed,
                    settingsRowIndexUsed: v.settingsRowIndexUsed,
                    objectRowKeys: v.objectRowKeys,
                    objectRowSummary: v.objectRowSummary,
                    error: v.error
                };
            }
            return out;
        };

        globalThis.__cooptPrintSpotSizeDebugTable = function __cooptPrintSpotSizeDebugTable() {
            const o = globalThis.__cooptSummarizeSpotSizeDebug ? globalThis.__cooptSummarizeSpotSizeDebug() : {};
            const rows = Object.entries(o).map(([reqRowId, v]) => ({
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
