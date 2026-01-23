
/**
 * AI Context Serializer
 * Converts the current optical system state into a token-efficient JSON format for the LLM.
 */

import { getOpticalSystemRows, getObjectRows, getSourceRows } from './utils/data-utils.js';
import { calculateSeidelCoefficients } from './evaluation/aberrations/seidel-coefficients.js';
import { calculateParaxialData } from './ray-paraxial.js';

function loadSystemConfigurationsRaw() {
    try {
        const json = localStorage.getItem('systemConfigurations');
        if (!json) return null;
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function getActiveConfigRef(systemConfig) {
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return null;
    const activeId = systemConfig.activeConfigId;
    return systemConfig.configurations.find(c => c && String(c.id) === String(activeId))
        || systemConfig.configurations[0]
        || null;
}

/**
 * Get the full system context for the AI
 * @returns {Promise<Object>} The context object
 */
export async function getSystemContext() {
    const sys = (typeof localStorage !== 'undefined') ? loadSystemConfigurationsRaw() : null;
    const activeCfg = sys ? getActiveConfigRef(sys) : null;

    const systemRequirements = (sys && Array.isArray(sys.systemRequirements)) ? sys.systemRequirements : [];
    const meritFunction = (sys && Array.isArray(sys.meritFunction)) ? sys.meritFunction : [];

    // Prefer config snapshot rows (especially when Design Intent / scenarios are used).
    const opticalRows = (activeCfg && Array.isArray(activeCfg.opticalSystem) && activeCfg.opticalSystem.length)
        ? activeCfg.opticalSystem
        : getOpticalSystemRows();
    const objectRows = (activeCfg && Array.isArray(activeCfg.object) && activeCfg.object.length)
        ? activeCfg.object
        : getObjectRows();
    // Source is global (shared across configurations).
    const sourceRows = getSourceRows();

    const toNumberOrNull = (v) => {
        if (v === '' || v === null || v === undefined) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    const toStringOrNull = (v) => {
        const s = (v === null || v === undefined) ? '' : String(v);
        const t = s.trim();
        return t === '' ? null : t;
    };

    // Basic System Definition
    // co-opt UI uses Surf 0..N-1. Provide both 0-based and 1-based indices to avoid confusion.
    const systemDef = opticalRows.map((row, surfIndex0) => {
        const type = toStringOrNull(
            row?.type ??
            row?.['object type'] ??
            row?.object ??
            row?._blockType ??
            row?.surfType
        );

        const rawMaterial = toStringOrNull(row?.material ?? row?.glass);
        const material = rawMaterial ?? 'AIR';

        const radiusNum = toNumberOrNull(row?.radius);
        const radiusRaw = radiusNum === null ? toStringOrNull(row?.radius) : null;

        // Optical system table uses `semidia` as the field name.
        const semidiaNum = toNumberOrNull(row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.semi_diameter);

        return {
            surf: surfIndex0,
            surf1: surfIndex0 + 1,
            type,
            radius: radiusNum,
            radiusRaw,
            thickness: toNumberOrNull(row?.thickness),
            material,
            isAir: material === 'AIR',
            semidia: semidiaNum,
            conic: toNumberOrNull(row?.conic) ?? 0,
            isImage: type ? type.toLowerCase().includes('image') : false,
            isObject: type ? type.toLowerCase().includes('object') : false
        };
    });

    // Calculate Performance Metrics
    const truncate = (s, maxLen = 1200) => {
        const t = (s === null || s === undefined) ? '' : String(s);
        return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
    };

    const formatError = (e) => {
        const name = (e && e.name) ? String(e.name) : 'Error';
        const message = (e && e.message) ? String(e.message) : String(e || 'Unknown error');
        const stack = e && e.stack ? String(e.stack) : null;
        return {
            name,
            message: truncate(message, 600),
            stack: stack ? truncate(stack, 1600) : null
        };
    };

    const preflightIssues = (() => {
        const issues = [];
        const rows = Array.isArray(opticalRows) ? opticalRows : [];
        const sources = Array.isArray(sourceRows) ? sourceRows : [];
        const objects = Array.isArray(objectRows) ? objectRows : [];

        if (rows.length === 0) issues.push({ kind: 'fatal', code: 'NO_SURFACES', message: 'optical system has 0 surfaces' });
        if (sources.length === 0) issues.push({ kind: 'warn', code: 'NO_SOURCES', message: 'source table is empty' });
        if (objects.length === 0) issues.push({ kind: 'warn', code: 'NO_OBJECTS', message: 'object table is empty' });

        // Light numeric sanity checks (do not over-assume; just flag obvious cases)
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i] || {};
            const thickness = toNumberOrNull(r.thickness);
            if (thickness !== null && thickness < 0) {
                issues.push({ kind: 'warn', code: 'NEGATIVE_THICKNESS', surf: i, message: `negative thickness at surf ${i}` });
                break;
            }
        }

        // Stop semidia often matters for ray validity
        const stopIndex = rows.findIndex(r => String(r?.type ?? '').toLowerCase().includes('stop'));
        if (stopIndex >= 0) {
            const semidia = toNumberOrNull(rows[stopIndex]?.semidia ?? rows[stopIndex]?.semiDiameter ?? rows[stopIndex]?.semiDia);
            if (semidia === null) issues.push({ kind: 'warn', code: 'STOP_SEMIDIA_NULL', surf: stopIndex, message: 'stop surface semidia is null/non-numeric' });
        }

        return issues;
    })();

    const diagnostics = {
        version: 1,
        timestamp: new Date().toISOString(),
        inputs: {
            surfaceCount: Array.isArray(opticalRows) ? opticalRows.length : 0,
            sourceCount: Array.isArray(sourceRows) ? sourceRows.length : 0,
            objectCount: Array.isArray(objectRows) ? objectRows.length : 0,
        },
        preflightIssues,
        steps: []
    };

    const primaryWavelengthUm = (() => {
        const rows = Array.isArray(sourceRows) ? sourceRows : [];

        const isPrimary = (v) => {
            const s = (v === null || v === undefined) ? '' : String(v).trim().toLowerCase();
            return s === 'true' || s === 'yes' || s === '1' || s === 'primary';
        };

        for (const r of rows) {
            if (r && (isPrimary(r.primary) || r.isPrimary === true)) {
                const w = toNumberOrNull(r.wavelength);
                if (w !== null && w > 0) return w;
            }
        }
        for (const r of rows) {
            const w = toNumberOrNull(r?.wavelength);
            if (w !== null && w > 0) return w;
        }
        return 0.5875618;
    })();

    diagnostics.inputs.primaryWavelengthUm = primaryWavelengthUm;

    let performance = {};
    let paraxial = null;
    let seidel = null;

    try {
        paraxial = calculateParaxialData(opticalRows, sourceRows, objectRows);
        diagnostics.steps.push({ step: 'paraxial', ok: true });
    } catch (e) {
        diagnostics.steps.push({ step: 'paraxial', ok: false, error: formatError(e) });
    }

    try {
        seidel = calculateSeidelCoefficients(opticalRows, primaryWavelengthUm, objectRows);
        diagnostics.steps.push({ step: 'seidel', ok: true });
    } catch (e) {
        diagnostics.steps.push({ step: 'seidel', ok: false, error: formatError(e) });
    }

    const anyFailure = diagnostics.steps.some(s => s && s.ok === false);
    if (anyFailure) {
        console.warn('AI Context: Failed to calculate performance metrics', diagnostics);
        performance = {
            error: 'Calculation failed',
            diagnostics
        };
    } else {
        performance = {
            focalLength: paraxial?.focalLength ?? null,
            fNumber: paraxial?.fNumber ?? null,
            magnification: paraxial?.magnification ?? null,
            seidel: {
                spherical: seidel?.sumS1 ?? null,
                coma: seidel?.sumS2 ?? null,
                astigmatism: seidel?.sumS3 ?? null,
                fieldCurvature: seidel?.sumS4 ?? null,
                distortion: seidel?.sumS5 ?? null,
                lca: seidel?.sumLch ?? null,
                tca: seidel?.sumTch ?? null
            },
            diagnostics
        };
    }

    const runtimeDiagnostics = (() => {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        if (!g) return null;

        const out = {};

        try {
            const wfMeta = g.__lastWavefrontMeta || null;
            const wfMap = g.__lastWavefrontMap || null;

            if (wfMeta || wfMap) {
                const wfError = wfMap && wfMap.error ? {
                    message: truncate(wfMap.error.message || wfMap.error || 'Wavefront error', 600),
                    code: wfMap.error.code || null,
                    details: wfMap.error
                } : null;

                const wfStats = wfMap && wfMap.statistics ? {
                    // Keep token-light: only common scalar stats if present
                    opdMicrons: wfMap.statistics.opdMicrons ? {
                        rms: toNumberOrNull(wfMap.statistics.opdMicrons.rms),
                        peakToPeak: toNumberOrNull(wfMap.statistics.opdMicrons.peakToPeak)
                    } : null,
                    rawOpdMicrons: wfMap.statistics.raw?.opdMicrons ? {
                        rms: toNumberOrNull(wfMap.statistics.raw.opdMicrons.rms),
                        peakToPeak: toNumberOrNull(wfMap.statistics.raw.opdMicrons.peakToPeak)
                    } : null
                } : null;

                out.wavefront = {
                    meta: wfMeta ? {
                        source: wfMeta.source ?? null,
                        gridSize: wfMeta.gridSize ?? null,
                        wavelength: wfMeta.wavelength ?? null,
                        fieldSetting: wfMeta.fieldSetting ?? null,
                    } : null,
                    hasError: !!wfError,
                    error: wfError,
                    statistics: wfStats
                };
            }

            const analyzer = g.lastWavefrontAnalyzer || null;
            const opdCalc = analyzer?.opdCalculator || null;
            const lastRay = (typeof opdCalc?.getLastRayCalculation === 'function')
                ? opdCalc.getLastRayCalculation()
                : (opdCalc?.lastRayCalculation ?? null);

            if (lastRay) {
                out.opdLastRay = {
                    success: lastRay.success ?? null,
                    error: lastRay.error ?? null,
                    fieldKey: lastRay.fieldKey ?? null,
                    pupilCoord: lastRay.pupilCoord ?? null,
                    stopHit: lastRay.stopHit ?? null,
                };
            }
        } catch (_) {
            // Keep serializer resilient; runtime diagnostics are optional.
        }

        try {
            const psfError = g.lastPsfError || null;
            if (psfError) {
                out.psfError = {
                    at: psfError.at ?? null,
                    code: psfError.code ?? null,
                    message: truncate(psfError.message ?? psfError.rawMessage ?? 'PSF error', 700),
                    hint: truncate(psfError.hint ?? '', 300) || null,
                    wavelength: psfError.wavelength ?? null,
                    gridSize: psfError.gridSize ?? null,
                    objectIndex: psfError.objectIndex ?? null,
                    debugMode: psfError.debugMode ?? null,
                };
            }

            const psfResult = g.lastPsfResult || null;
            if (psfResult) {
                const metrics = psfResult.metrics || psfResult.characteristics || null;
                out.psfLastResult = {
                    wavelength: psfResult.wavelength ?? g.lastPsfWavelength ?? null,
                    gridSize: psfResult.gridSize ?? g.lastPsfGridSize ?? null,
                    calculationTime: psfResult.calculationTime ?? null,
                    hasMetrics: !!metrics,
                    metricKeys: metrics ? Object.keys(metrics).slice(0, 30) : [],
                };
            }
        } catch (_) {
            // optional
        }

        // Fallback: PSF might have been computed in a popup window (shared localStorage)
        try {
            if (typeof localStorage !== 'undefined') {
                // Fallback: Wavefront/OPD might be rendered via popup or other window context
                try {
                    const wfSnapJson = localStorage.getItem('lastWavefrontSnapshot');
                    if (wfSnapJson) {
                        const snap = JSON.parse(wfSnapJson);
                        if (snap && typeof snap === 'object') {
                            if (!out.wavefront && snap.wavefront && typeof snap.wavefront === 'object') {
                                const w = snap.wavefront;
                                out.wavefront = {
                                    meta: w.meta ?? null,
                                    hasError: !!w.hasError,
                                    error: w.error ?? null,
                                    statistics: w.statistics ?? null,
                                    from: snap.from ?? 'localStorage:lastWavefrontSnapshot'
                                };
                            }
                            if (!out.opdLastRay && snap.opdLastRay && typeof snap.opdLastRay === 'object') {
                                out.opdLastRay = {
                                    success: snap.opdLastRay.success ?? null,
                                    error: snap.opdLastRay.error ?? null,
                                    fieldKey: snap.opdLastRay.fieldKey ?? null,
                                    pupilCoord: snap.opdLastRay.pupilCoord ?? null,
                                    stopHit: snap.opdLastRay.stopHit ?? null,
                                    from: snap.from ?? 'localStorage:lastWavefrontSnapshot'
                                };
                            }
                        }
                    }
                } catch (_) {
                    // optional
                }

                if (!out.psfLastResult) {
                    const metaJson = localStorage.getItem('lastPsfMeta');
                    if (metaJson) {
                        const meta = JSON.parse(metaJson);
                        if (meta && typeof meta === 'object') {
                            out.psfLastResult = {
                                wavelength: meta.wavelength ?? null,
                                gridSize: meta.gridSize ?? null,
                                calculationTime: meta.calculationTime ?? null,
                                hasMetrics: !!meta.hasMetrics,
                                metricKeys: Array.isArray(meta.metricKeys) ? meta.metricKeys.slice(0, 30) : [],
                                psfMethod: meta.psfMethod ?? null,
                                performanceMode: meta.performanceMode ?? null,
                                zernikeFitSamplingSize: meta.zernikeFitSamplingSize ?? null,
                                objectIndex: meta.objectIndex ?? null,
                                psfSummary: meta.psfSummary ?? null,
                                at: meta.at ?? null,
                                from: 'localStorage:lastPsfMeta'
                            };
                        }
                    }
                }

                if (!out.psfError) {
                    const errJson = localStorage.getItem('lastPsfError');
                    if (errJson) {
                        const err = JSON.parse(errJson);
                        if (err && typeof err === 'object') {
                            out.psfError = {
                                at: err.at ?? null,
                                code: err.code ?? null,
                                message: truncate(err.message ?? err.rawMessage ?? 'PSF error', 700),
                                hint: truncate(err.hint ?? '', 300) || null,
                                wavelength: err.wavelength ?? null,
                                gridSize: err.gridSize ?? null,
                                objectIndex: err.objectIndex ?? null,
                                debugMode: err.debugMode ?? null,
                                from: 'localStorage:lastPsfError'
                            };
                        }
                    }
                }
            }
        } catch (_) {
            // optional
        }

        // PSF current UI settings (available even before running PSF)
        try {
            const d = (typeof document !== 'undefined') ? document : null;
            if (d) {
                const psfObjectSelect = d.getElementById('psf-object-select');
                const samplingSelect = d.getElementById('psf-sampling-select');
                const zernikeSamplingSelect = d.getElementById('psf-zernike-sampling-select');
                const performanceSelect = d.getElementById('psf-performance-select');
                const wasmStatusEl = d.getElementById('psf-wasm-status');

                out.psfUI = {
                    objectIndex: psfObjectSelect?.value ?? null,
                    samplingSize: samplingSelect?.value ?? null,
                    zernikeFitSamplingSize: zernikeSamplingSelect?.value ?? null,
                    performanceMode: performanceSelect?.value ?? null,
                    wasmStatusText: wasmStatusEl?.textContent ? truncate(wasmStatusEl.textContent, 200) : null,
                };
            }
        } catch (_) {
            // optional
        }

        try {
            const lastEdit = g.__lastSurfaceEdit || null;
            if (lastEdit) {
                const row = lastEdit.row || {};
                out.lastUserSurfaceEdit = {
                    field: lastEdit.field ?? null,
                    oldValue: lastEdit.oldValue ?? null,
                    newValue: lastEdit.newValue ?? null,
                    rowSummary: {
                        type: toStringOrNull(row?.type ?? row?.surfType),
                        radius: toStringOrNull(row?.radius),
                        thickness: toStringOrNull(row?.thickness),
                        material: toStringOrNull(row?.material ?? row?.glass),
                        semidia: toStringOrNull(row?.semidia ?? row?.semiDiameter)
                    }
                };
            }
        } catch (_) {
            // optional
        }

        return Object.keys(out).length ? out : null;
    })();

    const targets = (() => {
        const reqs = Array.isArray(systemRequirements) ? systemRequirements : [];

        const compactReqs = reqs
            .filter(r => r && typeof r === 'object')
            .filter(r => (r.enabled === undefined || r.enabled === null) ? true : !!r.enabled)
            .slice(0, 60)
            .map(r => ({
                id: r.id ?? null,
                enabled: (r.enabled === undefined || r.enabled === null) ? true : !!r.enabled,
                operand: r.operand ?? null,
                op: r.op ?? null,
                tol: toNumberOrNull(r.tol),
                target: toNumberOrNull(r.target),
                weight: toNumberOrNull(r.weight) ?? 1,
                configId: (r.configId === undefined || r.configId === null) ? null : String(r.configId),
                rationale: toStringOrNull(r.rationale),
                // If UI has already evaluated, these might be present.
                current: toNumberOrNull(r.current),
                status: toStringOrNull(r.status)
            }));

        const compactMerit = (Array.isArray(meritFunction) ? meritFunction : [])
            .filter(t => t && typeof t === 'object')
            .slice(0, 40)
            .map(t => ({
                id: t.id ?? null,
                operand: t.operand ?? null,
                target: toNumberOrNull(t.target),
                weight: toNumberOrNull(t.weight),
                configId: (t.configId === undefined || t.configId === null) ? null : String(t.configId),
            }));

        return {
            requirements: {
                count: reqs.length,
                enabledCount: compactReqs.length,
                rows: compactReqs
            },
            meritFunction: {
                count: Array.isArray(meritFunction) ? meritFunction.length : 0,
                preview: compactMerit
            }
        };
    })();

    const normalizedPerformance = (() => {
        const safeDiv = (a, b) => {
            const x = Number(a);
            const y = Number(b);
            if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
            return x / y;
        };

        const fl = performance?.focalLength;
        const fno = performance?.fNumber;

        const reqRows = targets?.requirements?.rows;
        const flTarget = Array.isArray(reqRows)
            ? (reqRows.find(r => String(r?.operand || '').trim() === 'FL')?.target ?? null)
            : null;
        const fnoTarget = Array.isArray(reqRows)
            ? (
                reqRows.find(r => String(r?.operand || '').trim() === 'FNO_WRK')?.target ??
                reqRows.find(r => String(r?.operand || '').trim() === 'FNO_IMG')?.target ??
                reqRows.find(r => String(r?.operand || '').trim() === 'FNO_OBJ')?.target ??
                null
            )
            : null;

        const flRatio = (flTarget !== null) ? safeDiv(fl, flTarget) : null;
        const fnoRatio = (fnoTarget !== null) ? safeDiv(fno, fnoTarget) : null;

        const toPercentError = (ratio) => {
            if (ratio === null) return null;
            return (ratio - 1) * 100;
        };

        return {
            focalLength: {
                current: (typeof fl === 'number') ? fl : null,
                target: (typeof flTarget === 'number') ? flTarget : null,
                ratioToTarget: flRatio,
                percentError: toPercentError(flRatio)
            },
            fNumber: {
                current: (typeof fno === 'number') ? fno : null,
                target: (typeof fnoTarget === 'number') ? fnoTarget : null,
                ratioToTarget: fnoRatio,
                percentError: toPercentError(fnoRatio)
            }
        };
    })();

    return {
        meta: {
            surfIndexing: '0-based',
            surfaceCount: systemDef.length,
            activeConfig: activeCfg ? {
                id: activeCfg.id ?? null,
                name: activeCfg.name ?? null,
                activeScenarioId: activeCfg.activeScenarioId ?? null
            } : null
        },
        system: systemDef,
        // Design Intent summary (do not send full blocks verbatim; keep token-light)
        designIntent: (activeCfg && Array.isArray(activeCfg.blocks)) ? {
            blockCount: activeCfg.blocks.length,
            blocks: activeCfg.blocks.slice(0, 80).map(b => ({
                blockId: b?.blockId ?? null,
                blockType: b?.blockType ?? null,
                // Common parameters only
                parameters: {
                    glass: toStringOrNull(b?.parameters?.glass ?? b?.parameters?.material) ?? null,
                    radius: toNumberOrNull(b?.parameters?.radius),
                    thickness: toNumberOrNull(b?.parameters?.thickness),
                    semiDiameter: toNumberOrNull(b?.parameters?.semiDiameter)
                },
                variables: b?.variables ? Object.keys(b.variables).slice(0, 30) : []
            }))
        } : null,
        sources: sourceRows.map(s => ({
            id: toNumberOrNull(s?.id),
            wavelength: toNumberOrNull(s?.wavelength),
            weight: toNumberOrNull(s?.weight),
            primary: toStringOrNull(s?.primary),
            angle: toNumberOrNull(s?.angle)
        })),
        objects: objectRows.map(o => ({
            id: toNumberOrNull(o?.id),
            position: toStringOrNull(o?.position),
            xHeightAngle: toNumberOrNull(o?.xHeightAngle),
            yHeightAngle: toNumberOrNull(o?.yHeightAngle),
            angle: toNumberOrNull(o?.angle)
        })),
        targets,
        normalizedPerformance,
        performance: performance,
        runtimeDiagnostics,
        timestamp: new Date().toISOString()
    };
}
