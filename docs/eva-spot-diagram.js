// Spot Diagram Evaluation Module
// 仕様書に基づくスポットダイアグラム機能

import { traceRay, calculateSurfaceOrigins, transformPointToLocal } from './ray-tracing.js';
import { findStopSurfaceIndex, calculateFocalLength, calculateParaxialData } from './ray-paraxial.js';
import { generateRayStartPointsForObject } from './optical/ray-renderer.js';

function derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wavelengthMicrons, preferEntrancePupil) {
    let pupilDiameterMm = 10.0;
    let focalLengthMm = 100.0;

    // Prefer paraxial pupils (EnPD/ExPD). Fallback to Stop.semidia/aperture.
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

function computeAiryInfo(primaryWavelengthMicrons, pupilDiameterMm, focalLengthMm) {
    const wavelength = Number(primaryWavelengthMicrons);
    const pupilDiameter = Number(pupilDiameterMm);
    const focalLength = Number(focalLengthMm);
    if (![wavelength, pupilDiameter, focalLength].every(Number.isFinite)) return null;
    if (wavelength <= 0 || pupilDiameter <= 0 || focalLength <= 0) return null;

    const fNumber = focalLength / pupilDiameter;
    if (!Number.isFinite(fNumber) || fNumber <= 0) return null;

    // Airy radius to first minimum: r = 1.22 * λ * F#
    const airyRadiusUm = 1.22 * wavelength * fNumber;
    if (!Number.isFinite(airyRadiusUm) || airyRadiusUm <= 0) return null;

    return {
        wavelengthMicrons: wavelength,
        pupilDiameterMm: pupilDiameter,
        focalLengthMm: focalLength,
        fNumber,
        airyRadiusUm,
        airyDiameterUm: airyRadiusUm * 2
    };
}

function normalizeVectorSafe(vec, fallback = { x: 0, y: 0, z: 1 }) {
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

function createPerpendicularBasis(direction) {
    const dir = normalizeVectorSafe(direction, { x: 0, y: 0, z: 1 });
    let reference = Math.abs(dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let uAxis = crossProduct(reference, dir);
    if (Math.hypot(uAxis.x, uAxis.y, uAxis.z) < 1e-12) {
        reference = { x: 1, y: 0, z: 0 };
        uAxis = crossProduct(reference, dir);
    }
    const u = normalizeVectorSafe(uAxis, { x: 1, y: 0, z: 0 });
    const v = normalizeVectorSafe(crossProduct(dir, u), { x: 0, y: 1, z: 0 });
    return { dir, u, v };
}

function __spot_cloneRowsPreserveSpecialNumbers(rows) {
    if (!Array.isArray(rows)) return rows;
    try {
        if (typeof structuredClone === 'function') return structuredClone(rows);
    } catch (_) {}
    try {
        const INF = '__COOPT_INFINITY__';
        const NINF = '__COOPT_NINFINITY__';
        const NAN = '__COOPT_NAN__';
        return JSON.parse(
            JSON.stringify(rows, (_k, v) => {
                if (v === Infinity) return INF;
                if (v === -Infinity) return NINF;
                if (typeof v === 'number' && Number.isNaN(v)) return NAN;
                return v;
            }),
            (_k, v) => {
                if (v === INF) return Infinity;
                if (v === NINF) return -Infinity;
                const pv = objectData?.physicalVignettingUsed;
                if (v === NAN) return NaN;
                modeInfo.textContent = `Pupil scale used: ${psText} \u007f Aim-through-stop: ${ats === true ? 'true' : (ats === false ? 'false' : 'N/A')} \u007f Physical vignetting: ${pv === true ? 'ON' : (pv === false ? 'OFF' : 'N/A')}`;
            }
        );
    } catch (_) {
        // Last-resort: shallow clone rows.
        return rows.map((row) => (row && typeof row === 'object' ? { ...row } : row));
    }
}

// 光線開始点生成関数（main.jsから利用）
function generateRayStartPointsForSpot(obj, opticalSystemRows, rayNumber, apertureInfo = null, options = {}) {
    // console.log('🎯 generateRayStartPointsForSpot called with:', {
    //     obj: obj,
    //     opticalSystemRowsLength: opticalSystemRows ? opticalSystemRows.length : 'null',
    //     rayNumber: rayNumber,
    //     apertureInfo: apertureInfo ? 'provided' : 'null'
    // });
    
    // デバッグ: 現在のレイパターンを確認
    if (typeof window !== 'undefined' && window.getRayEmissionPattern) {
        // console.log(`🔍 [SPOT DIAGRAM] Pattern: ${window.getRayEmissionPattern()}`);
    }
    
    // main.jsのgenerateRayStartPointsForObject関数を呼び出し
    // Draw機能と同じように開口制限なしで呼び出す（apertureInfo引数を渡さない）
    try {
        // 直接インポートした関数を使用
        const result = generateRayStartPointsForObject(obj, opticalSystemRows, rayNumber, null, options);
        return result;
    } catch (error) {
        console.error('❌ Error calling generateRayStartPointsForObject:', error);
        
        // Fallback to window object
        if (typeof window !== 'undefined' && window.generateRayStartPointsForObject) {
            console.log('🔄 Falling back to window.generateRayStartPointsForObject...');
            try {
                const result = window.generateRayStartPointsForObject(obj, opticalSystemRows, rayNumber, null, options);
                return result;
            } catch (windowError) {
                console.error('❌ Error with window fallback:', windowError);
                return [];
            }
        } else {
            console.error('❌ generateRayStartPointsForObject function not found on window object');
            console.log('🔍 Available window properties:', Object.keys(window).filter(k => k.includes('generate')));
            return [];
        }
    }
}

// スポットダイアグラムの生成
export function generateSpotDiagram(opticalSystemRows, sourceRows, objectRows, surfaceNumber, rayNumber = 501, ringCount = 3, options = {}) {
    // console.log('🎯 Generating spot diagram...');
    
    // 現在のカラーモードを表示
    const currentColorMode = window.rayColorMode || window.getRayColorMode?.() || 'object';
    // console.log(`🎨 Current ray color mode: ${currentColorMode}`);
    // console.log(`🔍 Debug rayColorMode sources: window.rayColorMode=${window.rayColorMode}, getRayColorMode=${window.getRayColorMode?.()}`);
    
    // 利用可能なwindowプロパティも表示
    const rayColorRelated = Object.keys(window).filter(k => k.toLowerCase().includes('color') || k.toLowerCase().includes('ray'));
    // console.log(`🔍 Available ray/color related window properties:`, rayColorRelated);
    
    // デバッグログを追加
    // console.log('📊 Debug - Input parameters:', {
    //     opticalSystemRows: opticalSystemRows ? opticalSystemRows.length : 'null',
    //     sourceRows: sourceRows ? sourceRows.length : 'null',
    //     objectRows: objectRows ? objectRows.length : 'null',
    //     surfaceNumber: surfaceNumber,
    //     rayNumber: rayNumber
    // });
    
    // 入力検証
    if (!opticalSystemRows || !Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        throw new Error('有効な光学系データが必要です。');
    }
    
    if (!objectRows || !Array.isArray(objectRows) || objectRows.length === 0) {
        throw new Error('有効なObjectデータが必要です。');
    }
    
    // Object面は選択しないようにする（面番号は1から開始）
    if (surfaceNumber <= 0) {
        throw new Error('Object面は選択できません。面番号を1以上で指定してください。');
    }
    
    // 実際の光学系の範囲チェック
    if (surfaceNumber > opticalSystemRows.length) {
        throw new Error(`面番号${surfaceNumber}は存在しません。利用可能な面は1〜${opticalSystemRows.length}です。`);
    }
    
    // 選択された面の種類をチェック
    const selectedSurface = opticalSystemRows[surfaceNumber - 1]; // 0-indexed
    const surfaceType = selectedSurface.surfType || 'Standard';
    
    // Object面の除外
    if (surfaceType === 'Object') {
        throw new Error('The Object surface cannot be selected as the spot diagram evaluation surface.');
    }
    
    // CB面（座標変換面）の除外
    if (surfaceType === 'CB' || surfaceType === 'Coordinate Break' || surfaceType === 'Coord Break') {
        throw new Error('The CB surface (coordinate transform surface) cannot be selected as the spot diagram evaluation surface. Please select a normal optical surface or the Image surface.');
    }
    
    // console.log(`📊 Selected surface ${surfaceNumber}: ${surfaceType}`);
    
    // 現在の光学系テーブルデータを再取得して確認
    // console.log('🔄 Re-checking current optical system data...');
    const currentOpticalData = getCurrentOpticalSystemData();
    if (currentOpticalData && currentOpticalData.length !== opticalSystemRows.length) {
        // console.warn(`⚠️ Optical system data mismatch! Passed: ${opticalSystemRows.length}, Current: ${currentOpticalData.length}`);
        // console.log('📊 Current optical system from table:', currentOpticalData);
    }
    
    // 光学系の構造とCB面を分析
    const opticalSystemStructure = analyzeOpticalSystemStructure(opticalSystemRows);
    const surfaceInfoList = calculateSurfaceOrigins(opticalSystemRows);

    // Source tableから波長情報を取得（引数で渡されたsourceRowsを使用）
    const wavelengthData = getWavelengthsFromSource(sourceRows);
    let { wavelengths, primaryWavelength } = wavelengthData;
    
    // primaryWavelengthが正しく設定されていない場合のフォールバック (μm)
    if (!primaryWavelength || !primaryWavelength.wavelength) {
        primaryWavelength = { wavelength: 0.5876, name: 'Default d-line', index: 0 };
        // console.warn('⚠️ Primary wavelength not properly set, using default d-line');
    }

    const primaryWavelengthMicrons = Number(primaryWavelength?.wavelength) || 0.5876;
    const derived = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, primaryWavelengthMicrons, true);
    const airy = computeAiryInfo(primaryWavelengthMicrons, derived.pupilDiameterMm, derived.focalLengthMm);

    // Physical vignetting mode: do NOT shrink the pupil to “make rays pass”.
    // This makes vignetting visible/realistic but may yield 0-hit for some fields/surfaces.
    const physicalVignetting = (() => {
        try {
            if (options && typeof options === 'object' && options.physicalVignetting === true) return true;
        } catch (_) {}
        try {
            if (typeof globalThis !== 'undefined' && globalThis.__cooptSpotPhysicalVignetting === true) return true;
        } catch (_) {}
        return false;
    })();
    
    // console.log('📊 Wavelength configuration:', {
    //     totalWavelengths: wavelengths.length,
    //     primaryWavelength: primaryWavelength,
    //     allWavelengths: wavelengths
    // });
    // console.log(`📊 Using ${wavelengths.length} wavelengths for spot diagram (Primary: ${primaryWavelength.wavelength}nm)`);

    // console.log(`📊 Processing ${objectRows.length} objects for surface ${surfaceNumber} with ${rayNumber} rays`);
    
    // Objectデータの詳細確認
    // console.log('🔍 ObjectRows detailed analysis:', objectRows.map((obj, index) => ({
    //     index: index,
    //     id: obj.id,
    //     position: obj.position,
    //     xHeightAngle: obj.xHeightAngle,
    //     yHeightAngle: obj.yHeightAngle,
    //     objectKeys: Object.keys(obj)
    // })));

    // 各Object毎にスポットを計算
    const spotData = [];
    
    for (let objectIndex = 0; objectIndex < objectRows.length; objectIndex++) {
        const obj = objectRows[objectIndex];
        if (!obj) {
            // console.warn(`⚠️ Skipping null/undefined object`);
            continue;
        }
        
        // positionプロパティをチェック（Objectテーブルの実際の構造に合わせる）
        const objectType = obj.position || 'Unknown';
        const objectTypeNorm = String(objectType ?? '').trim().toLowerCase();
        const isAngleObject = objectTypeNorm === 'angle';
        const objectId = obj.id || 'Unknown';
        const opdCompatibleAngle = physicalVignetting && isAngleObject;
        
        // console.log(`📊 Processing Object ${objectId}: ${objectType}`, obj);
        
        const targetSurfaceIndex = surfaceNumber - 1;
        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);

        const hasCoordinateBreak = (() => {
            try {
                const norm = (v) => String(v ?? '').trim().toLowerCase();
                const compact = (v) => norm(v).replace(/\s+/g, '');
                return (opticalSystemRows || []).some((row) => {
                    const t = row && typeof row === 'object'
                        ? (row.surfType ?? row['surf type'] ?? row.type ?? row.objectType ?? row['object type'] ?? '')
                        : '';
                    const n = norm(t);
                    const c = compact(t);
                    return n === 'cb' || n === 'coord break' || n === 'coordinate break' || c === 'coordbreak' || c === 'coordinatebreak';
                });
            } catch (_) {
                return false;
            }
        })();

        // physicalVignetting: allow shrinking the effective pupil to find rays that pass through
        // the physical apertures (matches OPD/spot behavior and avoids "0 rays reached" for angled fields).
        const pupilScalesToTry = physicalVignetting
            ? [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.085, 0.06, 0.04, 0.03, 0.02, 0.015, 0.01]
            : [1];
        let rayStartPoints = null;
        let annularRingsUsed = 0;
        let selectedRingOverride = Number(ringCount ?? 0);
        let successfulRays = 0;
        let spotPoints = [];
        let diagnostics = null;
        let pupilScaleUsed = null;

        const traceOnceWithScale = (scale, aimThroughStop, disableAngleObjectPositionOptimization, allowStopBasedOriginSolveOverride) => {
            const allowStopBasedOriginSolve = (typeof allowStopBasedOriginSolveOverride === 'boolean')
                ? allowStopBasedOriginSolveOverride
                : (opdCompatibleAngle && !!aimThroughStop);
            const starts = generateRayStartPointsForSpot(
                obj,
                opticalSystemRows,
                rayNumber,
                null,
                {
                    annularRingCount: ringCount,
                    targetSurfaceIndex,
                    useChiefRayAnalysis: !!aimThroughStop,
                    chiefRaySolveMode: (aimThroughStop ? 'fast' : 'legacy'),
                    aimThroughStop: !!aimThroughStop,
                    allowStopBasedOriginSolve,
                    wavelengthUm: Number(primaryWavelength?.wavelength) || 0.5876,
                    pupilScale: scale,
                    // Spot-diagram should be based on the physical stop/pupil, not on any temporary
                    // Draw-Cross-ray extent cached on window.
                    disableCrossExtent: true,
                    // When evaluating physical vignetting, keep the Angle object's emission origin stable.
                    // (optimizeAngleObjectPosition can otherwise shift the field and destroy angle↔chief correlation.)
                    // However, CB systems often require this optimization to avoid 0-hit rays.
                    disableAngleObjectPositionOptimization: !!disableAngleObjectPositionOptimization
                }
            );

            if (!starts || !Array.isArray(starts) || starts.length === 0) {
                return { starts, ok: 0, spotPoints: [], diagnostics: null };
            }

            const diag = {
                objectId,
                objectType,
                targetSurfaceNumber: surfaceNumber,
                rayCountRequested: rayNumber,
                rayCountGenerated: starts.length,
                kindCounts: {},
                surfaceCounts: {},
                examples: [],
                maxExamples: 6,
                retry: {
                    pupilScaleRequested: scale,
                    aimThroughStopRequested: !!aimThroughStop,
                    allowStopBasedOriginSolveRequested: !!allowStopBasedOriginSolve,
                    disableAngleObjectPositionOptimizationRequested: !!disableAngleObjectPositionOptimization,
                    firstRayStartP: (starts?.[0]?.startP && typeof starts[0].startP === 'object')
                        ? { x: Number(starts[0].startP.x), y: Number(starts[0].startP.y), z: Number(starts[0].startP.z) }
                        : null,
                    firstRayDir: (starts?.[0]?.dir && typeof starts[0].dir === 'object')
                        ? { x: Number(starts[0].dir.x), y: Number(starts[0].dir.y), z: Number(starts[0].dir.z) }
                        : null,
                    emissionBasis: (starts?.emissionBasis && typeof starts.emissionBasis === 'object')
                        ? {
                            origin: (starts.emissionBasis.origin && typeof starts.emissionBasis.origin === 'object')
                                ? { x: Number(starts.emissionBasis.origin.x), y: Number(starts.emissionBasis.origin.y), z: Number(starts.emissionBasis.origin.z) }
                                : null,
                            stopRadius: Number.isFinite(Number(starts.emissionBasis.stopRadius)) ? Number(starts.emissionBasis.stopRadius) : null,
                            stopIndex: Number.isFinite(Number(starts.emissionBasis.stopIndex)) ? Number(starts.emissionBasis.stopIndex) : null,
                            stopZ: Number.isFinite(Number(starts.emissionBasis.stopZ)) ? Number(starts.emissionBasis.stopZ) : null,
                            stopCenter: (starts.emissionBasis.stopCenter && typeof starts.emissionBasis.stopCenter === 'object')
                                ? { x: Number(starts.emissionBasis.stopCenter.x), y: Number(starts.emissionBasis.stopCenter.y) }
                                : null,
                        }
                        : null
                }
            };

            const pts = [];
            let ok = 0;
            const maxRays = Math.min(starts.length, rayNumber);
            for (let i = 0; i < maxRays; i++) {
                const rayStart = starts[i];
                if (!rayStart || !rayStart.startP || !rayStart.dir) continue;
                try {
                    const debugLog = [];
                    const opticalRowsCopy = __spot_cloneRowsPreserveSpecialNumbers(opticalSystemRows);
                    const ray0 = {
                        pos: rayStart.startP,
                        dir: rayStart.dir,
                        wavelength: Number(primaryWavelength?.wavelength) || 0.5876
                    };
                    const traced = __spot_withRayTraceFailureCapture(() => traceRay(opticalRowsCopy, ray0, 1.0, debugLog, targetSurfaceIndex));
                    const rayPath = traced.result;
                    if (rayPath && Array.isArray(rayPath) && targetPointIndex !== null && rayPath.length > targetPointIndex && targetSurfaceIndex >= 0) {
                        const hitPointGlobal = rayPath[targetPointIndex];
                        const surfaceInfo = surfaceInfoList[targetSurfaceIndex];
                        const hitPointLocal = surfaceInfo ? transformPointToLocal(hitPointGlobal, surfaceInfo) : hitPointGlobal;
                        if (hitPointLocal && typeof hitPointLocal.x === 'number' && typeof hitPointLocal.y === 'number') {
                            const startPointClone = rayStart?.startP && typeof rayStart.startP === 'object'
                                ? { x: rayStart.startP.x, y: rayStart.startP.y, z: rayStart.startP.z }
                                : null;
                            const isChief = rayStart.isChief === true || (rayStart.isChief === undefined && i === 0);
                            pts.push({
                                x: hitPointLocal.x,
                                y: hitPointLocal.y,
                                z: hitPointLocal.z,
                                globalX: hitPointGlobal?.x,
                                globalY: hitPointGlobal?.y,
                                globalZ: hitPointGlobal?.z,
                                wavelength: primaryWavelength.wavelength,
                                wavelengthName: primaryWavelength.name,
                                isPrimary: true,
                                objectId: obj.id,
                                rayIndex: i,
                                isChiefRay: isChief,
                                startPoint: startPointClone,
                                initialDir: rayStart && rayStart.dir ? { ...rayStart.dir } : undefined
                            });
                            ok++;
                        } else {
                            __spot_recordTraceFailure(diag, traced.failure, 'INVALID_HIT_POINT', opticalSystemRows, rayPath);
                        }
                    } else {
                        __spot_recordTraceFailure(diag, traced.failure, 'NOT_REACHED_TARGET', opticalSystemRows, rayPath);
                    }
                } catch (_) {
                    __spot_recordTraceFailure(diag, null, 'EXCEPTION', opticalSystemRows, null);
                }
            }
            return { starts, ok, spotPoints: pts, diagnostics: diag };
        };

        // Try progressively smaller pupils when CB/tilt causes aggressive vignetting.
        // If aiming through stop fails completely, retry without aiming-through-stop.
        const attempts = [];
        let aimThroughStopUsed = null;
        const baseDisableAngleOpt = physicalVignetting && !hasCoordinateBreak;
        const angleOptDisableToggles = (() => {
            // Default behavior tries to keep Angle emission stable in physical mode.
            // But some designs (including CB systems) need the opposite setting to get any rays through.
            // Therefore, for Angle objects in physical-vignetting mode, always try both.
            const list = [baseDisableAngleOpt];
            if (isAngleObject && physicalVignetting) {
                const other = !baseDisableAngleOpt;
                if (!list.includes(other)) list.push(other);
            }
            return list;
        })();

        const tryPupilScales = (aim) => {
            for (const disableAngleOpt of angleOptDisableToggles) {
                for (const s of pupilScalesToTry) {
                    const allowOriginSolveToggles = (() => {
                        if (!aim) return [false];
                        if (isAngleObject) {
                            // For Angle objects, aiming-through-stop without origin solving is often ineffective:
                            // the chief ray can remain clipped by physical apertures.
                            // Try both to recover at least one passing ray.
                            return [true, false];
                        }
                        if (!physicalVignetting) return [opdCompatibleAngle && !!aim];
                        return [opdCompatibleAngle && !!aim];
                    })();

                    for (const allowOriginSolve of allowOriginSolveToggles) {
                        const r = traceOnceWithScale(s, aim, disableAngleOpt, allowOriginSolve);
                        const rr = (r && r.diagnostics && r.diagnostics.retry) ? r.diagnostics.retry : null;
                        const topKind = (() => {
                            try {
                                const kc = r?.diagnostics?.kindCounts;
                                if (!kc || typeof kc !== 'object') return null;
                                let bestK = null;
                                let bestV = -1;
                                for (const [k, v] of Object.entries(kc)) {
                                    const vv = Number(v);
                                    if (Number.isFinite(vv) && vv > bestV) {
                                        bestV = vv;
                                        bestK = k;
                                    }
                                }
                                return bestK;
                            } catch (_) {
                                return null;
                            }
                        })();
                        const topSurface = (() => {
                            try {
                                const sc = r?.diagnostics?.surfaceCounts;
                                if (!sc || typeof sc !== 'object') return null;
                                let bestK = null;
                                let bestV = -1;
                                for (const [k, v] of Object.entries(sc)) {
                                    const vv = Number(v);
                                    if (Number.isFinite(vv) && vv > bestV) {
                                        bestV = vv;
                                        bestK = k;
                                    }
                                }
                                return bestK;
                            } catch (_) {
                                return null;
                            }
                        })();
                        const ex = (() => {
                            try {
                                const examples = r?.diagnostics?.examples;
                                if (!Array.isArray(examples) || examples.length === 0) return null;
                                const pick = examples.find(e => e && e.kind === 'PHYSICAL_APERTURE_BLOCK') || examples[0];
                                if (!pick || typeof pick !== 'object') return null;
                                return {
                                    kind: pick.kind ?? null,
                                    surfaceIndex: (pick.surfaceIndex ?? pick.surface ?? pick.surfaceNumber ?? null),
                                    note: pick.note ?? null
                                };
                            } catch (_) {
                                return null;
                            }
                        })();

                        attempts.push({
                            pupilScale: s,
                            aimThroughStop: !!aim,
                            allowStopBasedOriginSolveRequested: rr?.allowStopBasedOriginSolveRequested ?? allowOriginSolve,
                            disableAngleObjectPositionOptimizationRequested: rr?.disableAngleObjectPositionOptimizationRequested ?? !!disableAngleOpt,
                            ok: r.ok,
                            raysGenerated: Array.isArray(r.starts) ? r.starts.length : 0,
                            topKind,
                            topSurface,
                            example: ex,
                            firstRayStartP: rr?.firstRayStartP ?? null,
                            firstRayDir: rr?.firstRayDir ?? null,
                            emissionOrigin: rr?.emissionBasis?.origin ?? null,
                            stopIndex: rr?.emissionBasis?.stopIndex ?? null,
                            stopZ: rr?.emissionBasis?.stopZ ?? null,
                            stopRadius: rr?.emissionBasis?.stopRadius ?? null,
                            stopCenter: rr?.emissionBasis?.stopCenter ?? null,
                        });

                        if (r.ok > 0) {
                            rayStartPoints = r.starts;
                            spotPoints = r.spotPoints;
                            successfulRays = r.ok;
                            diagnostics = r.diagnostics;
                            pupilScaleUsed = s;
                            aimThroughStopUsed = !!aim;
                            return true;
                        }

                        // keep last diagnostics for reporting
                        diagnostics = r.diagnostics || diagnostics;
                        rayStartPoints = r.starts || rayStartPoints;
                    }
                }
            }
            return false;
        };

        // Prefer the nominal field definition first (aimThroughStop=false).
        // In physical-vignetting mode, do NOT fall back to aimThroughStop=true by default.
        // However, for Angle objects in physical mode, OPD mode often prefers aiming through stop.
        // If that produces 0 hits (common with strong vignetting), fall back to the nominal mode.
        if (opdCompatibleAngle) {
            if (!tryPupilScales(true)) {
                tryPupilScales(false);
            }
        } else {
            if (!tryPupilScales(false)) {
                // Last resort: allow aim-through-stop only when the default mode fails.
                // (Keeps existing semantics for most systems but avoids 0-hit errors.)
                tryPupilScales(true);
            }
        }

        if (diagnostics && typeof diagnostics === 'object') {
            diagnostics.retry = diagnostics.retry || {};
            diagnostics.retry.pupilScaleTried = attempts;
            diagnostics.retry.pupilScaleUsed = pupilScaleUsed;
            diagnostics.retry.aimThroughStopUsed = aimThroughStopUsed;
        }

        annularRingsUsed = Number(rayStartPoints?.annularRingsUsed ?? 0);
        selectedRingOverride = Number(rayStartPoints?.selectedRingOverride ?? ringCount ?? 0);
        if (!rayStartPoints || !Array.isArray(rayStartPoints) || rayStartPoints.length === 0) {
            continue;
        }

        if (successfulRays < rayStartPoints.length) {
            try {
                const total = rayStartPoints.length;
                const ok = successfulRays;
                const kinds = Object.entries(diagnostics.kindCounts).sort((a, b) => b[1] - a[1]);
                const surfaces = Object.entries(diagnostics.surfaceCounts).sort((a, b) => b[1] - a[1]);
                console.groupCollapsed(`🧪 SpotDiag diagnostics: Object ${objectId} (${objectType}) hits ${ok}/${total} @ surface ${surfaceNumber}`);
                if (kinds.length) console.log('Failure kinds:', kinds.slice(0, 6));
                if (surfaces.length) console.log('Top blocker surfaces:', surfaces.slice(0, 8));
                const ex = diagnostics.examples.find(e => e.kind === 'PHYSICAL_APERTURE_BLOCK') || diagnostics.examples[0];
                if (ex) console.log('Example failure:', ex);
                console.groupEnd();
            } catch (_) {}
        }
        
        const chiefStartPoint = spotPoints.find(p => p.isChiefRay && p.startPoint)?.startPoint
            || (rayStartPoints[0]?.startP ? { x: rayStartPoints[0].startP.x, y: rayStartPoints[0].startP.y, z: rayStartPoints[0].startP.z } : null);
        const chiefStartDir = rayStartPoints[0]?.dir;
        const basisFromGenerator = rayStartPoints.emissionBasis;
        const emissionBasis = (() => {
            if (basisFromGenerator && basisFromGenerator.origin && basisFromGenerator.u && basisFromGenerator.v) {
                return {
                    origin: { ...basisFromGenerator.origin },
                    u: { ...basisFromGenerator.u },
                    v: { ...basisFromGenerator.v },
                    direction: normalizeVectorSafe(basisFromGenerator.direction || chiefStartDir),
                    stopRadius: basisFromGenerator.stopRadius
                };
            }
            if (chiefStartPoint && chiefStartDir && Number.isFinite(chiefStartDir.x) && Number.isFinite(chiefStartDir.y) && Number.isFinite(chiefStartDir.z)) {
                const basis = createPerpendicularBasis(chiefStartDir);
                return {
                    origin: chiefStartPoint,
                    u: basis.u,
                    v: basis.v,
                    direction: basis.dir,
                    stopRadius: rayStartPoints?.emissionBasis?.stopRadius
                };
            }
            return null;
        })();

        const successfulRayIndices = new Set(spotPoints.map(point => point.rayIndex));
        const emissionPatternPoints = [];
        if (emissionBasis) {
            rayStartPoints.forEach((rayEntry, index) => {
                const origin = emissionBasis.origin;
                const startP = rayEntry?.startP;
                if (!startP) return;
                const deltaX = startP.x - origin.x;
                const deltaY = startP.y - origin.y;
                const deltaZ = startP.z - origin.z;
                const uValue = deltaX * emissionBasis.u.x + deltaY * emissionBasis.u.y + deltaZ * emissionBasis.u.z;
                const vValue = deltaX * emissionBasis.v.x + deltaY * emissionBasis.v.y + deltaZ * emissionBasis.v.z;
                emissionPatternPoints.push({
                    rayIndex: index,
                    u: uValue,
                    v: vValue,
                    succeeded: successfulRayIndices.has(index)
                });
            });
        }

        if (emissionBasis) {
            spotPoints.forEach(point => {
                if (!point.startPoint) return;
                const deltaX = point.startPoint.x - emissionBasis.origin.x;
                const deltaY = point.startPoint.y - emissionBasis.origin.y;
                const deltaZ = point.startPoint.z - emissionBasis.origin.z;
                point.emissionU = deltaX * emissionBasis.u.x + deltaY * emissionBasis.u.y + deltaZ * emissionBasis.u.z;
                point.emissionV = deltaX * emissionBasis.v.x + deltaY * emissionBasis.v.y + deltaZ * emissionBasis.v.z;
            });
        }
        
        // 重心位置を計算してオフセットを決定（主光線の代わりに重心を使用）
        let centroidXRaw = 0, centroidYRaw = 0;
        
        if (spotPoints.length > 0) {
            centroidXRaw = spotPoints.reduce((sum, p) => sum + p.x, 0) / spotPoints.length;
            centroidYRaw = spotPoints.reduce((sum, p) => sum + p.y, 0) / spotPoints.length;
        }
        const centroidRaw = { x: centroidXRaw, y: centroidYRaw };
        const chiefSpotPoint = spotPoints.find(p => p.isChiefRay);
        
        // 主光線位置の引き算を無効化して、十字線と一致させる
        const shouldApplyCentroidOffset = false;
        const centroidOffsetApplied = shouldApplyCentroidOffset
            ? {
                x: chiefSpotPoint ? chiefSpotPoint.x : centroidRaw.x,
                y: chiefSpotPoint ? chiefSpotPoint.y : centroidRaw.y
            }
            : { x: 0, y: 0 };

        const chiefRayNormalized = (() => {
            if (!rayStartPoints || rayStartPoints.length === 0) return null;
            const dir = rayStartPoints[0]?.dir;
            if (!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) return null;
            const mag = Math.hypot(dir.x, dir.y, dir.z);
            if (mag < 1e-12) return null;
            return { x: dir.x / mag, y: dir.y / mag, z: dir.z / mag };
        })();

        if (shouldApplyCentroidOffset) {
            spotPoints.forEach(point => {
                point.x -= centroidOffsetApplied.x;
                point.y -= centroidOffsetApplied.y;
            });
        }
        
        // 成功率が低い場合の警告
        const successRate = successfulRays / rayStartPoints.length;
        if (successRate < 0.1) {
            // console.warn(`⚠️ Low success rate (${(successRate * 100).toFixed(1)}%) for Object ${objectId}. Consider selecting a surface closer to the object.`);
        }
        
        // 主光線フラグが設定されていない場合、重心に最も近い光線を主光線とする
        const hasChiefRay = spotPoints.some(p => p.isChiefRay);
        if (!hasChiefRay && spotPoints.length > 0) {
            const centroidX = spotPoints.reduce((sum, p) => sum + p.x, 0) / spotPoints.length;
            const centroidY = spotPoints.reduce((sum, p) => sum + p.y, 0) / spotPoints.length;
            
            let minDist = Infinity;
            let closestIndex = 0;
            spotPoints.forEach((p, idx) => {
                const dist = Math.hypot(p.x - centroidX, p.y - centroidY);
                if (dist < minDist) {
                    minDist = dist;
                    closestIndex = idx;
                }
            });
            spotPoints[closestIndex].isChiefRay = true;
        }
        
        spotData.push({
            objectId: objectId,
            objectType: objectType,
            objectIndex: objectIndex,
            objectXHeightAngle: (obj && typeof obj === 'object') ? (obj.xHeightAngle ?? obj.xAngle ?? obj.x ?? obj.X ?? null) : null,
            objectYHeightAngle: (obj && typeof obj === 'object') ? (obj.yHeightAngle ?? obj.yAngle ?? obj.y ?? obj.Y ?? obj.angle ?? null) : null,
            spotPoints: spotPoints,
            successRate: successRate,
            totalRays: rayStartPoints.length,
            successfulRays: successfulRays,
            pupilScaleUsed: pupilScaleUsed,
            aimThroughStopUsed: aimThroughStopUsed,
            physicalVignettingUsed: physicalVignetting,
            centroidOffset: centroidOffsetApplied, // 実際に適用した重心オフセット量
            centroidRaw: centroidRaw, // 調整前の重心位置
            centroidAdjusted: shouldApplyCentroidOffset
                ? { x: centroidRaw.x - centroidOffsetApplied.x, y: centroidRaw.y - centroidOffsetApplied.y }
                : centroidRaw,
            centroidOffsetApplied: shouldApplyCentroidOffset,
            hasCentroid: spotPoints.length > 0,
            annularRingsUsed: annularRingsUsed,
            selectedRingOverride: selectedRingOverride,
            objectDir: chiefRayNormalized || (rayStartPoints.expectedChiefDir ? { ...rayStartPoints.expectedChiefDir } : null),
            expectedChiefDir: rayStartPoints.expectedChiefDir ? { ...rayStartPoints.expectedChiefDir } : null,
            expectedChiefOrigin: rayStartPoints.expectedChiefOrigin ? { ...rayStartPoints.expectedChiefOrigin } : null,
            emissionBasis: emissionBasis,
            emissionPoints: emissionPatternPoints,
            diagnostics: diagnostics
        });
    }
    
    // 結果の検証
    const totalSuccessfulRays = spotData.reduce((sum, obj) => sum + (obj.successfulRays || 0), 0);
    const totalRays = spotData.reduce((sum, obj) => sum + (obj.totalRays || 0), 0);
    
    if (totalSuccessfulRays === 0) {
        // より詳細なエラー情報を提供
        console.error(`❌ No rays reached Surf ${Math.max(0, surfaceNumber - 1)}`);
        console.error(`📊 Object analysis:`);
        spotData.forEach((obj, index) => {
            console.error(`   Object ${index + 1}: ${obj.totalRays} rays, ${obj.successfulRays} successful (${(obj.successRate * 100).toFixed(1)}%)`);
        });
        
        // 到達可能な面を検査
        const reachableSurfaces = findReachableSurfaces(opticalSystemRows, objectRows);
        console.error(`📊 Reachable surfaces: ${reachableSurfaces.join(', ')}`);
        
        // 光学系の面数を確認
        const maxSurfaceIndex = Math.max(...opticalSystemRows.map((_, index) => index + 1));
        const suggestedSurfaces = reachableSurfaces.filter(s => s < surfaceNumber && s > 0);
        
        let errorMessage = `Failed to generate spot data for Surf ${Math.max(0, surfaceNumber - 1)}.\n`;
        errorMessage += `光線が面に到達していない可能性があります。\n\n`;
        errorMessage += `詳細情報:\n`;
        errorMessage += `- 総光線数: ${totalRays}\n`;
        errorMessage += `- 成功した光線数: ${totalSuccessfulRays}\n`;
        errorMessage += `- 光学系の面数: ${opticalSystemRows.length}\n`;
        errorMessage += `- 指定された面: Surf ${Math.max(0, surfaceNumber - 1)}\n`;
        if (reachableSurfaces.length > 0) {
            errorMessage += `- 到達可能な面: ${reachableSurfaces.join(', ')}\n`;
        }

        // Include retry diagnostics (pupilScale / aimThroughStop) and top blocker hints.
        try {
            const summarizeValue = (v) => {
                try {
                    if (v === null) return null;
                    const t = typeof v;
                    if (t === 'string' || t === 'number' || t === 'boolean') return v;
                    if (Array.isArray(v)) {
                        if (v.length <= 6) return v.map(summarizeValue);
                        return `[Array(${v.length})]`;
                    }
                    if (t === 'object') {
                        const ks = Object.keys(v);
                        const out = {};
                        ks.slice(0, 12).forEach((k) => { out[k] = summarizeValue(v[k]); });
                        if (ks.length > 12) out.__moreKeys = ks.length - 12;
                        return out;
                    }
                    return String(v);
                } catch (_) {
                    return '[Unserializable]';
                }
            };

            const summarizeObjectRow = (row) => {
                if (!row || typeof row !== 'object') return null;
                const keys = Object.keys(row).sort();
                const pick = (k) => (k in row ? summarizeValue(row[k]) : undefined);
                const summary = {
                    id: pick('id'),
                    position: pick('position'),
                    angle: pick('angle'),
                    xHeightAngle: pick('xHeightAngle'),
                    yHeightAngle: pick('yHeightAngle'),
                    x: pick('x'),
                    y: pick('y'),
                    z: pick('z'),
                    fieldX: pick('fieldX'),
                    fieldY: pick('fieldY'),
                    wavelength: pick('wavelength'),
                };
                Object.keys(summary).forEach((k) => summary[k] === undefined && delete summary[k]);
                return {
                    keys: keys.slice(0, 120),
                    keyCount: keys.length,
                    summary,
                };
            };

            const findObjectRowForDiag = (o, i) => {
                if (Array.isArray(objectRows)) {
                    const oid = String(o?.objectId ?? '');
                    const byId = objectRows.find((r) => r && typeof r === 'object' && String(r.id ?? '') === oid);
                    if (byId) return byId;
                    if (i >= 0 && i < objectRows.length) return objectRows[i];
                }
                return null;
            };

            const summarizeSurfaceRowForNumber = (surfaceNumberMaybe1Based) => {
                const n = Number(surfaceNumberMaybe1Based);
                if (!Number.isFinite(n) || n < 1) return null;
                const idx = n - 1;
                const row = Array.isArray(opticalSystemRows) ? opticalSystemRows[idx] : null;
                if (!row || typeof row !== 'object') return { surfaceNumber: n, surfaceIndex: idx, missing: true };
                const comment = String(row.comment ?? row.Comment ?? row.note ?? row.Note ?? '').trim();
                return {
                    surfaceNumber: n,
                    surfaceIndex: idx,
                    objectType: row['object type'] ?? row.object ?? null,
                    surfType: row.surfType ?? row.type ?? null,
                    comment: comment || null,
                    aperture: row.aperture ?? row.Aperture ?? null,
                    semidia: row.semidia ?? row.Semidia ?? row['Semi Diameter'] ?? null,
                    radius: row.radius ?? null,
                    thickness: row.thickness ?? null,
                    glass: row.glass ?? row.material ?? row.Glass ?? null,
                };
            };

            const objDiag = spotData.map((o, i) => {
                const r = o && typeof o === 'object' ? (o.diagnostics?.retry ?? null) : null;
                const kindCounts = o && typeof o === 'object' && o.diagnostics && o.diagnostics.kindCounts
                    ? Object.entries(o.diagnostics.kindCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
                    : [];
                const surfaceCounts = o && typeof o === 'object' && o.diagnostics && o.diagnostics.surfaceCounts
                    ? Object.entries(o.diagnostics.surfaceCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
                    : [];
                const ex = o && typeof o === 'object' && o.diagnostics && Array.isArray(o.diagnostics.examples)
                    ? (o.diagnostics.examples.find(e => e && e.kind === 'PHYSICAL_APERTURE_BLOCK') || o.diagnostics.examples[0] || null)
                    : null;
                const exDetails = (ex && typeof ex === 'object') ? (ex.details ?? null) : null;
                const exHit = Number(exDetails?.hitRadiusMm);
                const exLim = Number(exDetails?.apertureLimitMm);
                const exOver = (Number.isFinite(exHit) && Number.isFinite(exLim)) ? (exHit - exLim) : null;

                const topSurfaceRows = surfaceCounts
                    .map(([k, c]) => {
                        const sn = Number(String(k).split(':')[0]);
                        return {
                            key: k,
                            count: c,
                            surfaceNumber: Number.isFinite(sn) ? sn : null,
                            row: Number.isFinite(sn) ? summarizeSurfaceRowForNumber(sn) : null,
                        };
                    })
                    .filter(x => x && x.row)
                    .slice(0, 8);
                const objRow = findObjectRowForDiag(o, i);
                const proto = summarizeObjectRow(objRow);
                return {
                    objectId: o?.objectId,
                    objectType: o?.objectType,
                    totalRays: o?.totalRays,
                    successfulRays: o?.successfulRays,
                    retry: r,
                    topKinds: kindCounts,
                    topSurfaces: surfaceCounts,
                    example: ex,
                    exampleSummary: (ex && typeof ex === 'object') ? {
                        kind: ex.kind ?? null,
                        surfaceIndex: Number.isFinite(Number(ex.surfaceIndex)) ? Number(ex.surfaceIndex) : null,
                        surfaceNumber: Number.isFinite(Number(exDetails?.surfaceNumber)) ? Number(exDetails.surfaceNumber) : null,
                        surfaceType: (exDetails?.surfaceType || exDetails?.surfType) ?? null,
                        hitRadiusMm: Number.isFinite(exHit) ? exHit : null,
                        apertureLimitMm: Number.isFinite(exLim) ? exLim : null,
                        overByMm: Number.isFinite(exOver) ? exOver : null,
                    } : null,
                    topSurfaceRowSummaries: topSurfaceRows,
                    objectRowIndex: (Array.isArray(objectRows) ? (objectRows.indexOf(objRow)) : null),
                    objectRowKeys: proto?.keys ?? null,
                    objectRowKeyCount: proto?.keyCount ?? null,
                    objectRowSummary: proto?.summary ?? null
                };
            });

            const coordBreakSummaries = (() => {
                try {
                    const norm = (v) => String(v ?? '').trim().toLowerCase();
                    const compact = (v) => norm(v).replace(/\s+/g, '');
                    const isCB = (row) => {
                        const t = row && typeof row === 'object'
                            ? (row.surfType ?? row['surf type'] ?? row.type ?? row.objectType ?? row['object type'] ?? '')
                            : '';
                        const n = norm(t);
                        const c = compact(t);
                        return n === 'cb' || n === 'coord break' || n === 'coordinate break' || c === 'coordbreak' || c === 'coordinatebreak';
                    };

                    const sd = calculateSurfaceOrigins(opticalSystemRows);
                    const out = [];
                    for (let si = 0; si < opticalSystemRows.length; si++) {
                        const row = opticalSystemRows[si];
                        if (!isCB(row)) continue;
                        const prev = (si > 0) ? opticalSystemRows[si - 1] : null;
                        const info = Array.isArray(sd) ? sd[si] : null;
                        out.push({
                            surfaceNumber: si + 1,
                            surfType: row?.surfType ?? null,
                            raw: {
                                semidia: row?.semidia ?? null,
                                material: row?.material ?? null,
                                rindex: row?.rindex ?? null,
                                abbe: row?.abbe ?? null,
                                conic: row?.conic ?? null,
                                coef1: row?.coef1 ?? null,
                                thickness: row?.thickness ?? null,
                            },
                            prevSemidia: prev?.semidia ?? null,
                            cbParams: (info && typeof info === 'object') ? (info.cbParams ?? null) : null,
                        });
                    }
                    return out;
                } catch (_) {
                    return null;
                }
            })();

            if (typeof globalThis !== 'undefined') {
                globalThis.__cooptLastSpotDiagramFailure = {
                    at: Date.now(),
                    surfaceNumber,
                    opticalSystemSurfaceCount: Array.isArray(opticalSystemRows) ? opticalSystemRows.length : null,
                    totalRays,
                    totalSuccessfulRays,
                    objects: objDiag,
                    coordBreakSummaries
                };
            }

            errorMessage += `\nDiagnostics (retry/blockers):\n`;
            objDiag.forEach((d, i) => {
                errorMessage += `- Object ${i + 1} (id=${d.objectId}): `;
                if (d.retry && typeof d.retry === 'object') {
                    const aim = d.retry.aimThroughStopUsed;
                    const used = d.retry.pupilScaleUsed;
                    errorMessage += `aimThroughStopUsed=${aim}, pupilScaleUsed=${used}. `;
                }
                if (Array.isArray(d.topKinds) && d.topKinds.length) {
                    errorMessage += `topKinds=${d.topKinds.map(([k, n]) => `${k}:${n}`).join(', ')}. `;
                }
                if (Array.isArray(d.topSurfaces) && d.topSurfaces.length) {
                    errorMessage += `topSurfaces=${d.topSurfaces.map(([k, n]) => `${k}:${n}`).join(', ')}. `;
                }
                if (d.example && typeof d.example === 'object') {
                    const ek = d.example.kind;
                    const es = d.example.surface;
                    errorMessage += `example=${ek}${(es !== undefined ? `@${es}` : '')}.`;
                }
                errorMessage += `\n`;
            });
        } catch (_) {}
        errorMessage += `\n対処方法:\n`;
        if (suggestedSurfaces.length > 0) {
            errorMessage += `- 推奨する面: ${suggestedSurfaces.slice(-3).join(', ')}\n`;
        }
        errorMessage += `- 光学系の設定を確認してください\n`;
        errorMessage += `- オブジェクトの位置や角度を確認してください\n`;
        errorMessage += `- 光線の発射パターンを変更してみてください`;
        
        throw new Error(errorMessage);
    }
    
    // Always keep a lightweight snapshot of the last run (even when there is no failure).
    try {
        if (typeof globalThis !== 'undefined') {
            globalThis.__cooptLastSpotDiagramRun = {
                at: Date.now(),
                surfaceNumber,
                totalObjects: Array.isArray(spotData) ? spotData.length : null,
                objects: Array.isArray(spotData)
                    ? spotData.map((o) => {
                        const chief = Array.isArray(o?.spotPoints) ? o.spotPoints.find(p => p && p.isChiefRay) : null;
                        const dir = o?.expectedChiefDir || o?.objectDir || null;
                        const origin = o?.emissionBasis?.origin || o?.expectedChiefOrigin || null;
                        return {
                            objectId: o?.objectId ?? null,
                            objectType: o?.objectType ?? null,
                            objectXHeightAngle: o?.objectXHeightAngle ?? null,
                            objectYHeightAngle: o?.objectYHeightAngle ?? null,
                            successfulRays: o?.successfulRays ?? null,
                            totalRays: o?.totalRays ?? null,
                            successRate: o?.successRate ?? null,
                            chiefLocalX: (chief && Number.isFinite(Number(chief.x))) ? Number(chief.x) : null,
                            chiefLocalY: (chief && Number.isFinite(Number(chief.y))) ? Number(chief.y) : null,
                            chiefDirY: (dir && Number.isFinite(Number(dir.y))) ? Number(dir.y) : null,
                            chiefDirZ: (dir && Number.isFinite(Number(dir.z))) ? Number(dir.z) : null,
                            emissionOriginY: (origin && Number.isFinite(Number(origin.y))) ? Number(origin.y) : null,
                        };
                    })
                    : null
            };
        }
    } catch (_) {}

    return {
        spotData: spotData,
        primaryWavelength: primaryWavelength,
        wavelengths: wavelengths,
        airy: airy,
        selectedRingCount: ringCount,
        surfaceInfoList: surfaceInfoList
    };
}

function __spot_isSkippableRayPathRow(row) {
    if (!row || typeof row !== 'object') return true;
    const ot = String(row['object type'] ?? row.object ?? '').trim().toLowerCase();
    if (ot === 'object') return true;
    // Coord Break rows are transforms only; traceRay() does not record hit points for them.
    const st = String(row.surfType ?? row.type ?? '').trim().toLowerCase();
    if (st === 'coord break' || st === 'coordbreak' || st === 'cb') return true;
    return false;
}

function surfaceIndexToRayPathPointIndex(rows, surfaceIndex) {
    if (!Array.isArray(rows)) return null;
    if (!Number.isInteger(surfaceIndex) || surfaceIndex < 0) return null;
    if (surfaceIndex >= rows.length) return null;
    // If the target row itself is not represented in rayPath, there is no point index.
    if (__spot_isSkippableRayPathRow(rows[surfaceIndex])) return null;

    // traceRay() returns rayPath with:
    // - rayPath[0] = start point
    // - rayPath[k] (k>=1) = hit points for each non-Object, non-CB surface in order.
    // So, pointIndex is a 1-based count of non-skippable rows up to surfaceIndex.
    let count = 0;
    for (let i = 0; i <= surfaceIndex && i < rows.length; i++) {
        if (__spot_isSkippableRayPathRow(rows[i])) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function rayPathPointIndexToSurfaceIndex(rows, pointIndex) {
    if (!Array.isArray(rows)) return null;
    if (!Number.isInteger(pointIndex) || pointIndex < 0) return null;
    // rayPath[0] is the start point, which does not correspond to any surface row.
    if (pointIndex === 0) return null;

    const targetCount = pointIndex; // 1..N counts non-skippable surfaces
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
        if (__spot_isSkippableRayPathRow(rows[i])) continue;
        count++;
        if (count === targetCount) return i;
    }
    return null;
}

function __spot_withRayTraceFailureCapture(runTraceFn) {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    if (!g || typeof runTraceFn !== 'function') {
        return { result: (typeof runTraceFn === 'function') ? runTraceFn() : null, failure: null };
    }
    const prevCapture = g.__COOPT_CAPTURE_RAYTRACE_FAILURE;
    const prevLast = g.__cooptLastRayTraceFailure;
    try {
        g.__COOPT_CAPTURE_RAYTRACE_FAILURE = true;
        g.__cooptLastRayTraceFailure = null;
        const result = runTraceFn();
        let failure = g.__cooptLastRayTraceFailure;
        try {
            if (failure && typeof structuredClone === 'function') {
                failure = structuredClone(failure);
            } else if (failure) {
                failure = JSON.parse(JSON.stringify(failure));
            }
        } catch (_) {}
        return { result, failure: failure || null };
    } finally {
        try {
            g.__COOPT_CAPTURE_RAYTRACE_FAILURE = prevCapture;
            g.__cooptLastRayTraceFailure = prevLast;
        } catch (_) {}
    }
}

function __spot_recordTraceFailure(diag, failure, fallbackKind, rows, rayPath) {
    if (!diag) return;
    const kind = (failure && typeof failure === 'object' && typeof failure.kind === 'string' && failure.kind)
        ? failure.kind
        : (fallbackKind || 'UNKNOWN');
    diag.kindCounts[kind] = (diag.kindCounts[kind] || 0) + 1;

    const details = (failure && typeof failure === 'object') ? failure.details : null;
    const surfaceNumber = Number(details?.surfaceNumber);
    const surfaceIndex = Number(details?.surfaceIndex);
    const surfaceType = String(details?.surfaceType || details?.surfType || '').trim();
    if (Number.isFinite(surfaceNumber) && surfaceNumber > 0) {
        const key = `${surfaceNumber}:${surfaceType || 'unknown'}`;
        diag.surfaceCounts[key] = (diag.surfaceCounts[key] || 0) + 1;
    } else if (Array.isArray(rayPath) && rayPath.length > 0 && Array.isArray(rows)) {
        const lastPointIndex = rayPath.length - 1;
        const lastSurfaceIndex = rayPathPointIndexToSurfaceIndex(rows, lastPointIndex);
        if (Number.isInteger(lastSurfaceIndex)) {
            const lastRow = rows[lastSurfaceIndex];
            const lastType = String(lastRow?.['object type'] || lastRow?.object || lastRow?.surfType || '').trim();
            const key = `${lastSurfaceIndex + 1}:${lastType || 'unknown'}`;
            diag.surfaceCounts[key] = (diag.surfaceCounts[key] || 0) + 1;
        }
    }

    if (Array.isArray(diag.examples) && diag.examples.length < (diag.maxExamples || 6)) {
        diag.examples.push({ kind, details: details || null, surfaceIndex: Number.isFinite(surfaceIndex) ? surfaceIndex : null });
    }
}

// Async generator for UI progress bars.
// This does NOT replace the synchronous `generateSpotDiagram` (used by merit-function evaluation).
export async function generateSpotDiagramAsync(
    opticalSystemRows,
    sourceRows,
    objectRows,
    surfaceNumber,
    rayNumber = 501,
    ringCount = 3,
    options = {}
) {
    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const yieldEvery = Number.isInteger(options?.yieldEvery) ? options.yieldEvery : 25;
    const yieldToUI = async () => new Promise(resolve => setTimeout(resolve, 0));
    const safeProgress = (percent, message) => {
        try { onProgress?.({ percent, message }); } catch (_) {}
    };

    safeProgress(0, 'Preparing spot diagram...');
    await yieldToUI();

    // Input validation (match sync behavior)
    if (!opticalSystemRows || !Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        throw new Error('有効な光学系データが必要です。');
    }
    if (!objectRows || !Array.isArray(objectRows) || objectRows.length === 0) {
        throw new Error('有効なObjectデータが必要です。');
    }
    if (surfaceNumber <= 0) {
        throw new Error('Object面は選択できません。面番号を1以上で指定してください。');
    }
    if (surfaceNumber > opticalSystemRows.length) {
        throw new Error(`面番号${surfaceNumber}は存在しません。利用可能な面は1〜${opticalSystemRows.length}です。`);
    }

    const selectedSurface = opticalSystemRows[surfaceNumber - 1];
    const surfaceType = selectedSurface.surfType || 'Standard';
    if (surfaceType === 'Object') {
        throw new Error('The Object surface cannot be selected as the spot diagram evaluation surface.');
    }
    if (surfaceType === 'CB' || surfaceType === 'Coordinate Break' || surfaceType === 'Coord Break') {
        throw new Error('The CB surface (coordinate transform surface) cannot be selected as the spot diagram evaluation surface. Please select a normal optical surface or the Image surface.');
    }

    // Prepare system structure
    analyzeOpticalSystemStructure(opticalSystemRows);
    const surfaceInfoList = calculateSurfaceOrigins(opticalSystemRows);

    // Wavelengths
    const wavelengthData = getWavelengthsFromSource(sourceRows);
    let { wavelengths, primaryWavelength } = wavelengthData;
    if (!primaryWavelength || !primaryWavelength.wavelength) {
        primaryWavelength = { wavelength: 0.5876, name: 'Default d-line', index: 0 };
    }

    const primaryWavelengthMicrons = Number(primaryWavelength?.wavelength) || 0.5876;
    const derived = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, primaryWavelengthMicrons, true);
    const airy = computeAiryInfo(primaryWavelengthMicrons, derived.pupilDiameterMm, derived.focalLengthMm);

    // Physical vignetting mode: do NOT shrink the pupil to “make rays pass”.
    // This makes vignetting visible/realistic but may yield 0-hit for some fields/surfaces.
    const physicalVignetting = (() => {
        try {
            if (options && typeof options === 'object' && options.physicalVignetting === true) return true;
        } catch (_) {}
        try {
            if (typeof globalThis !== 'undefined' && globalThis.__cooptSpotPhysicalVignetting === true) return true;
        } catch (_) {}
        return false;
    })();

    const spotData = [];
    const totalObjects = objectRows.length;
    let completedWork = 0;
    const estimatedTotalWork = Math.max(1, totalObjects * Math.max(1, rayNumber));

    for (let objectIndex = 0; objectIndex < objectRows.length; objectIndex++) {
        const obj = objectRows[objectIndex];
        if (!obj) continue;

        const objectType = obj.position || 'Unknown';
        const objectId = obj.id || 'Unknown';
        const opdCompatibleAngle = physicalVignetting && objectType === 'Angle';

        safeProgress(
            Math.min(90, 5 + (85 * (objectIndex / Math.max(1, totalObjects)))),
            `Tracing rays (Object ${objectIndex + 1}/${totalObjects})...`
        );
        await yieldToUI();

        const targetSurfaceIndex = surfaceNumber - 1;
        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        // NOTE: Even in physical-vignetting mode, we may shrink pupilScale to avoid 0-hit results.
        // This mirrors the synchronous spot-diagram/requirements pathway and prevents Angle+CB cases
        // from failing with PHYSICAL_APERTURE_BLOCK×N.
        const pupilScalesToTry = physicalVignetting
            ? [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08, 0.06, 0.04, 0.03, 0.02, 0.015, 0.01]
            : [1];

        let rayStartPoints = null;
        let annularRingsUsed = 0;
        let selectedRingOverride = Number(ringCount ?? 0);
        let spotPoints = [];
        let successfulRays = 0;
        let diagnostics = null;
        let pupilScaleUsed = null;
        const attempts = [];

        const traceOnceWithScale = async (scale, aimThroughStop, opts) => {
            const disableAngleObjectPositionOptimizationRequested = !!opts?.disableAngleObjectPositionOptimizationRequested;
            const allowStopBasedOriginSolveRequested = !!opts?.allowStopBasedOriginSolveRequested;
            const starts = generateRayStartPointsForSpot(
                obj,
                opticalSystemRows,
                rayNumber,
                null,
                {
                    annularRingCount: ringCount,
                    targetSurfaceIndex,
                    useChiefRayAnalysis: !!aimThroughStop,
                    chiefRaySolveMode: (aimThroughStop ? 'fast' : 'legacy'),
                    aimThroughStop: !!aimThroughStop,
                    allowStopBasedOriginSolve: opdCompatibleAngle && !!aimThroughStop && allowStopBasedOriginSolveRequested,
                    wavelengthUm: Number(primaryWavelength?.wavelength) || 0.5876,
                    pupilScale: scale,
                    // Spot-diagram should be based on the physical stop/pupil, not on any temporary
                    // Draw-Cross-ray extent cached on window.
                    disableCrossExtent: true,
                    // When evaluating physical vignetting, keep the Angle object's emission origin stable.
                    // (optimizeAngleObjectPosition can otherwise shift the field and destroy angle↔chief correlation.)
                    disableAngleObjectPositionOptimization: physicalVignetting && disableAngleObjectPositionOptimizationRequested
                }
            );
            if (!starts || !Array.isArray(starts) || starts.length === 0) {
                return { starts, ok: 0, spotPoints: [], diagnostics: null };
            }

            const diag = {
                objectId,
                objectType,
                targetSurfaceNumber: surfaceNumber,
                rayCountRequested: rayNumber,
                rayCountGenerated: starts.length,
                kindCounts: {},
                surfaceCounts: {},
                examples: [],
                maxExamples: 6,
                retry: {
                    pupilScaleRequested: scale,
                    aimThroughStopRequested: !!aimThroughStop,
                    allowStopBasedOriginSolveRequested: opdCompatibleAngle && !!aimThroughStop ? !!allowStopBasedOriginSolveRequested : null,
                    disableAngleObjectPositionOptimizationRequested: physicalVignetting ? !!disableAngleObjectPositionOptimizationRequested : null,
                    firstRayStartP: (starts?.[0]?.startP && typeof starts[0].startP === 'object')
                        ? { x: Number(starts[0].startP.x), y: Number(starts[0].startP.y), z: Number(starts[0].startP.z) }
                        : null,
                    firstRayDir: (starts?.[0]?.dir && typeof starts[0].dir === 'object')
                        ? { x: Number(starts[0].dir.x), y: Number(starts[0].dir.y), z: Number(starts[0].dir.z) }
                        : null,
                    emissionBasis: (starts?.emissionBasis && typeof starts.emissionBasis === 'object')
                        ? {
                            origin: (starts.emissionBasis.origin && typeof starts.emissionBasis.origin === 'object')
                                ? { x: Number(starts.emissionBasis.origin.x), y: Number(starts.emissionBasis.origin.y), z: Number(starts.emissionBasis.origin.z) }
                                : null,
                            stopRadius: Number.isFinite(Number(starts.emissionBasis.stopRadius)) ? Number(starts.emissionBasis.stopRadius) : null,
                            stopIndex: Number.isFinite(Number(starts.emissionBasis.stopIndex)) ? Number(starts.emissionBasis.stopIndex) : null,
                            stopZ: Number.isFinite(Number(starts.emissionBasis.stopZ)) ? Number(starts.emissionBasis.stopZ) : null,
                            stopCenter: (starts.emissionBasis.stopCenter && typeof starts.emissionBasis.stopCenter === 'object')
                                ? { x: Number(starts.emissionBasis.stopCenter.x), y: Number(starts.emissionBasis.stopCenter.y) }
                                : null,
                        }
                        : null
                }
            };
            const pts = [];
            let ok = 0;
            const maxRaysThisObject = Math.min(starts.length, rayNumber);

            for (let i = 0; i < maxRaysThisObject; i++) {
                const rayStart = starts[i];
                if (!rayStart || !rayStart.startP || !rayStart.dir) continue;

                try {
                    const opticalRowsCopy = __spot_cloneRowsPreserveSpecialNumbers(opticalSystemRows);
                    const ray0 = {
                        pos: rayStart.startP,
                        dir: rayStart.dir,
                        wavelength: Number(primaryWavelength?.wavelength) || 0.5876
                    };
                    const debugLog = [];
                    const traced = __spot_withRayTraceFailureCapture(() => traceRay(opticalRowsCopy, ray0, 1.0, debugLog, targetSurfaceIndex));
                    const rayPath = traced.result;

                    if (rayPath && Array.isArray(rayPath) && targetPointIndex !== null && rayPath.length > targetPointIndex && targetSurfaceIndex >= 0) {
                        const hitPointGlobal = rayPath[targetPointIndex];
                        const surfaceInfo = surfaceInfoList[targetSurfaceIndex];
                        const hitPointLocal = surfaceInfo ? transformPointToLocal(hitPointGlobal, surfaceInfo) : hitPointGlobal;

                        if (hitPointLocal && typeof hitPointLocal.x === 'number' && typeof hitPointLocal.y === 'number') {
                            const startPointClone = rayStart?.startP && typeof rayStart.startP === 'object'
                                ? { x: rayStart.startP.x, y: rayStart.startP.y, z: rayStart.startP.z }
                                : null;
                            const isChief = rayStart.isChief === true || (rayStart.isChief === undefined && i === 0);
                            pts.push({
                                x: hitPointLocal.x,
                                y: hitPointLocal.y,
                                z: hitPointLocal.z,
                                globalX: hitPointGlobal?.x,
                                globalY: hitPointGlobal?.y,
                                globalZ: hitPointGlobal?.z,
                                wavelength: primaryWavelength.wavelength,
                                wavelengthName: primaryWavelength.name,
                                isPrimary: true,
                                objectId: obj.id,
                                rayIndex: i,
                                isChiefRay: isChief,
                                startPoint: startPointClone,
                                initialDir: rayStart && rayStart.dir ? { ...rayStart.dir } : undefined
                            });
                            ok++;
                            if (rayStart && rayStart.dir) {
                                pts[pts.length - 1].initialDir = { ...rayStart.dir };
                            }
                        } else {
                            __spot_recordTraceFailure(diag, traced.failure, 'INVALID_HIT_POINT', opticalSystemRows, rayPath);
                        }
                    } else {
                        __spot_recordTraceFailure(diag, traced.failure, 'NOT_REACHED_TARGET', opticalSystemRows, rayPath);
                    }
                } catch (_) {
                    __spot_recordTraceFailure(diag, null, 'EXCEPTION', opticalSystemRows, null);
                }

                completedWork++;
                if (onProgress) {
                    const pct = 5 + (85 * (completedWork / estimatedTotalWork));
                    safeProgress(Math.min(90, Math.max(0, pct)), `Tracing rays (${completedWork}/${estimatedTotalWork})...`);
                }
                if (yieldEvery > 0 && (i % yieldEvery) === 0) {
                    await yieldToUI();
                }
            }

            return { starts, ok, spotPoints: pts, diagnostics: diag };
        };

        let aimThroughStopUsed = null;
        const tryPupilScales = async (aim) => {
            for (const s of pupilScalesToTry) {
                // For Angle objects under physical vignetting, we sometimes need to try multiple
                // origin-solve strategies and/or disable the Angle emission optimization.
                const disableAngleObjectPositionOptimizationModes = (opdCompatibleAngle && physicalVignetting)
                    ? [true, false]
                    : [true];
                const allowStopBasedOriginSolveModes = (opdCompatibleAngle && !!aim)
                    ? [true, false]
                    : [true];

                let r = null;
                let succeeded = false;

                for (const disableAngleObjectPositionOptimizationRequested of disableAngleObjectPositionOptimizationModes) {
                    for (const allowStopBasedOriginSolveRequested of allowStopBasedOriginSolveModes) {
                        r = await traceOnceWithScale(s, aim, {
                            disableAngleObjectPositionOptimizationRequested,
                            allowStopBasedOriginSolveRequested
                        });

                        const rr = (r && r.diagnostics && r.diagnostics.retry) ? r.diagnostics.retry : null;
                        const topKind = (() => {
                            try {
                                const kc = r?.diagnostics?.kindCounts;
                                if (!kc || typeof kc !== 'object') return null;
                                let bestK = null;
                                let bestV = -1;
                                for (const [k, v] of Object.entries(kc)) {
                                    const vv = Number(v);
                                    if (Number.isFinite(vv) && vv > bestV) {
                                        bestV = vv;
                                        bestK = k;
                                    }
                                }
                                return bestK;
                            } catch (_) {
                                return null;
                            }
                        })();
                        const topSurface = (() => {
                            try {
                                const sc = r?.diagnostics?.surfaceCounts;
                                if (!sc || typeof sc !== 'object') return null;
                                let bestK = null;
                                let bestV = -1;
                                for (const [k, v] of Object.entries(sc)) {
                                    const vv = Number(v);
                                    if (Number.isFinite(vv) && vv > bestV) {
                                        bestV = vv;
                                        bestK = k;
                                    }
                                }
                                return bestK;
                            } catch (_) {
                                return null;
                            }
                        })();
                        const ex = (() => {
                            try {
                                const examples = r?.diagnostics?.examples;
                                if (!Array.isArray(examples) || examples.length === 0) return null;
                                const pick = examples.find(e => e && e.kind === 'PHYSICAL_APERTURE_BLOCK') || examples[0];
                                if (!pick || typeof pick !== 'object') return null;
                                return {
                                    kind: pick.kind ?? null,
                                    surfaceIndex: (pick.surfaceIndex ?? pick.surface ?? pick.surfaceNumber ?? null),
                                    note: pick.note ?? null
                                };
                            } catch (_) {
                                return null;
                            }
                        })();

                        attempts.push({
                            pupilScale: s,
                            aimThroughStop: !!aim,
                            allowStopBasedOriginSolveRequested: rr?.allowStopBasedOriginSolveRequested ?? null,
                            disableAngleObjectPositionOptimizationRequested: rr?.disableAngleObjectPositionOptimizationRequested ?? null,
                            ok: r.ok,
                            raysGenerated: Array.isArray(r.starts) ? r.starts.length : 0,
                            topKind,
                            topSurface,
                            example: ex,
                            firstRayStartP: rr?.firstRayStartP ?? null,
                            firstRayDir: rr?.firstRayDir ?? null,
                            emissionOrigin: rr?.emissionBasis?.origin ?? null,
                            stopIndex: rr?.emissionBasis?.stopIndex ?? null,
                            stopZ: rr?.emissionBasis?.stopZ ?? null,
                            stopRadius: rr?.emissionBasis?.stopRadius ?? null,
                        });

                        diagnostics = r.diagnostics || diagnostics;
                        rayStartPoints = r.starts || rayStartPoints;

                        if (r.ok > 0) {
                            spotPoints = r.spotPoints;
                            successfulRays = r.ok;
                            pupilScaleUsed = s;
                            aimThroughStopUsed = !!aim;
                            succeeded = true;
                            break;
                        }
                    }
                    if (succeeded) break;
                }

                if (succeeded) {
                    return true;
                }
            }
            return false;
        };

        // Prefer the nominal field definition first (aimThroughStop=false).
        // In physical-vignetting mode, do NOT fall back to aimThroughStop=true by default.
        // However, for Angle objects in physical mode, match OPD behavior by aiming through stop.
        if (opdCompatibleAngle) {
            await tryPupilScales(true);
        } else if (!(await tryPupilScales(false)) && !physicalVignetting) {
            await tryPupilScales(true);
        }

        if (!rayStartPoints || !Array.isArray(rayStartPoints) || rayStartPoints.length === 0) {
            continue;
        }

        if (diagnostics && typeof diagnostics === 'object') {
            diagnostics.retry = diagnostics.retry || {};
            diagnostics.retry.pupilScaleTried = attempts;
            diagnostics.retry.pupilScaleUsed = pupilScaleUsed;
            diagnostics.retry.aimThroughStopUsed = aimThroughStopUsed;
        }

        annularRingsUsed = Number(rayStartPoints?.annularRingsUsed ?? 0);
        selectedRingOverride = Number(rayStartPoints?.selectedRingOverride ?? ringCount ?? 0);

        // Rays were traced inside traceOnceWithScale(); keep rayStartPoints for emission-pattern diagnostics.

        const chiefStartPoint = spotPoints.find(p => p.isChiefRay && p.startPoint)?.startPoint
            || (rayStartPoints[0]?.startP ? { x: rayStartPoints[0].startP.x, y: rayStartPoints[0].startP.y, z: rayStartPoints[0].startP.z } : null);
        const chiefStartDir = rayStartPoints[0]?.dir;
        const basisFromGenerator = rayStartPoints.emissionBasis;
        const emissionBasis = (() => {
            if (basisFromGenerator && basisFromGenerator.origin && basisFromGenerator.u && basisFromGenerator.v) {
                return {
                    origin: { ...basisFromGenerator.origin },
                    u: { ...basisFromGenerator.u },
                    v: { ...basisFromGenerator.v },
                    direction: normalizeVectorSafe(basisFromGenerator.direction || chiefStartDir),
                    stopRadius: basisFromGenerator.stopRadius
                };
            }
            if (chiefStartPoint && chiefStartDir && Number.isFinite(chiefStartDir.x) && Number.isFinite(chiefStartDir.y) && Number.isFinite(chiefStartDir.z)) {
                const basis = createPerpendicularBasis(chiefStartDir);
                return {
                    origin: chiefStartPoint,
                    u: basis.u,
                    v: basis.v,
                    direction: basis.dir,
                    stopRadius: rayStartPoints?.emissionBasis?.stopRadius
                };
            }
            return null;
        })();

        const successfulRayIndices = new Set(spotPoints.map(point => point.rayIndex));
        const emissionPatternPoints = [];
        if (emissionBasis) {
            rayStartPoints.forEach((rayEntry, index) => {
                const origin = emissionBasis.origin;
                const startP = rayEntry?.startP;
                if (!startP) return;
                const deltaX = startP.x - origin.x;
                const deltaY = startP.y - origin.y;
                const deltaZ = startP.z - origin.z;
                const uValue = deltaX * emissionBasis.u.x + deltaY * emissionBasis.u.y + deltaZ * emissionBasis.u.z;
                const vValue = deltaX * emissionBasis.v.x + deltaY * emissionBasis.v.y + deltaZ * emissionBasis.v.z;
                emissionPatternPoints.push({
                    rayIndex: index,
                    u: uValue,
                    v: vValue,
                    succeeded: successfulRayIndices.has(index)
                });
            });
        }

        if (emissionBasis) {
            spotPoints.forEach(point => {
                if (!point.startPoint) return;
                const deltaX = point.startPoint.x - emissionBasis.origin.x;
                const deltaY = point.startPoint.y - emissionBasis.origin.y;
                const deltaZ = point.startPoint.z - emissionBasis.origin.z;
                point.emissionU = deltaX * emissionBasis.u.x + deltaY * emissionBasis.u.y + deltaZ * emissionBasis.u.z;
                point.emissionV = deltaX * emissionBasis.v.x + deltaY * emissionBasis.v.y + deltaZ * emissionBasis.v.z;
            });
        }

        let centroidXRaw = 0, centroidYRaw = 0;
        if (spotPoints.length > 0) {
            centroidXRaw = spotPoints.reduce((sum, p) => sum + p.x, 0) / spotPoints.length;
            centroidYRaw = spotPoints.reduce((sum, p) => sum + p.y, 0) / spotPoints.length;
        }
        const centroidRaw = { x: centroidXRaw, y: centroidYRaw };
        const chiefSpotPoint = spotPoints.find(p => p.isChiefRay);

        const shouldApplyCentroidOffset = false;
        const centroidOffsetApplied = shouldApplyCentroidOffset
            ? {
                x: chiefSpotPoint ? chiefSpotPoint.x : centroidRaw.x,
                y: chiefSpotPoint ? chiefSpotPoint.y : centroidRaw.y
            }
            : { x: 0, y: 0 };

        const chiefRayNormalized = (() => {
            if (!rayStartPoints || rayStartPoints.length === 0) return null;
            const dir = rayStartPoints[0]?.dir;
            if (!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) return null;
            const mag = Math.hypot(dir.x, dir.y, dir.z);
            if (mag < 1e-12) return null;
            return { x: dir.x / mag, y: dir.y / mag, z: dir.z / mag };
        })();

        if (shouldApplyCentroidOffset) {
            spotPoints.forEach(point => {
                point.x -= centroidOffsetApplied.x;
                point.y -= centroidOffsetApplied.y;
            });
        }

        const successRate = successfulRays / rayStartPoints.length;

        if (successfulRays < rayStartPoints.length) {
            try {
                const total = rayStartPoints.length;
                const ok = successfulRays;
                const kinds = Object.entries(diagnostics.kindCounts).sort((a, b) => b[1] - a[1]);
                const surfaces = Object.entries(diagnostics.surfaceCounts).sort((a, b) => b[1] - a[1]);
                console.groupCollapsed(`🧪 SpotDiag diagnostics(async): Object ${objectId} (${objectType}) hits ${ok}/${total} @ surface ${surfaceNumber}`);
                if (kinds.length) console.log('Failure kinds:', kinds.slice(0, 6));
                if (surfaces.length) console.log('Top blocker surfaces:', surfaces.slice(0, 8));
                const ex = diagnostics.examples.find(e => e.kind === 'PHYSICAL_APERTURE_BLOCK') || diagnostics.examples[0];
                if (ex) console.log('Example failure:', ex);
                console.groupEnd();
            } catch (_) {}
        }

        const hasChiefRay = spotPoints.some(p => p.isChiefRay);
        if (!hasChiefRay && spotPoints.length > 0) {
            const centroidX = spotPoints.reduce((sum, p) => sum + p.x, 0) / spotPoints.length;
            const centroidY = spotPoints.reduce((sum, p) => sum + p.y, 0) / spotPoints.length;
            let minDist = Infinity;
            let closestIndex = 0;
            spotPoints.forEach((p, idx) => {
                const dist = Math.hypot(p.x - centroidX, p.y - centroidY);
                if (dist < minDist) {
                    minDist = dist;
                    closestIndex = idx;
                }
            });
            spotPoints[closestIndex].isChiefRay = true;
        }

        spotData.push({
            objectId: objectId,
            objectType: objectType,
            objectIndex: objectIndex,
            objectXHeightAngle: (obj && typeof obj === 'object') ? (obj.xHeightAngle ?? obj.xAngle ?? obj.x ?? obj.X ?? null) : null,
            objectYHeightAngle: (obj && typeof obj === 'object') ? (obj.yHeightAngle ?? obj.yAngle ?? obj.y ?? obj.Y ?? obj.angle ?? null) : null,
            spotPoints: spotPoints,
            successRate: successRate,
            totalRays: rayStartPoints.length,
            successfulRays: successfulRays,
            pupilScaleUsed: pupilScaleUsed,
            aimThroughStopUsed: aimThroughStopUsed,
            physicalVignettingUsed: physicalVignetting,
            centroidOffset: centroidOffsetApplied,
            centroidRaw: centroidRaw,
            centroidAdjusted: shouldApplyCentroidOffset
                ? { x: centroidRaw.x - centroidOffsetApplied.x, y: centroidRaw.y - centroidOffsetApplied.y }
                : centroidRaw,
            centroidOffsetApplied: shouldApplyCentroidOffset,
            hasCentroid: spotPoints.length > 0,
            annularRingsUsed: annularRingsUsed,
            selectedRingOverride: selectedRingOverride,
            objectDir: chiefRayNormalized || (rayStartPoints.expectedChiefDir ? { ...rayStartPoints.expectedChiefDir } : null),
            expectedChiefDir: rayStartPoints.expectedChiefDir ? { ...rayStartPoints.expectedChiefDir } : null,
            expectedChiefOrigin: rayStartPoints.expectedChiefOrigin ? { ...rayStartPoints.expectedChiefOrigin } : null,
            emissionBasis: emissionBasis,
            emissionPoints: emissionPatternPoints,
            diagnostics: diagnostics
        });
    }

    const totalSuccessfulRays = spotData.reduce((sum, obj) => sum + (obj.successfulRays || 0), 0);
    const totalRays = spotData.reduce((sum, obj) => sum + (obj.totalRays || 0), 0);

    if (totalSuccessfulRays === 0) {
        const reachableSurfaces = findReachableSurfaces(opticalSystemRows, objectRows);
        let errorMessage = `Failed to generate spot data for Surf ${Math.max(0, surfaceNumber - 1)}.\n`;
        errorMessage += `光線が面に到達していない可能性があります。\n\n`;
        errorMessage += `詳細情報:\n`;
        errorMessage += `- 総光線数: ${totalRays}\n`;
        errorMessage += `- 成功した光線数: ${totalSuccessfulRays}\n`;
        errorMessage += `- 光学系の面数: ${opticalSystemRows.length}\n`;
        errorMessage += `- 指定された面: Surf ${Math.max(0, surfaceNumber - 1)}\n`;
        if (reachableSurfaces.length > 0) {
            errorMessage += `- 到達可能な面: ${reachableSurfaces.join(', ')}\n`;
        }

        // Include retry diagnostics (pupilScale / aimThroughStop) and top blocker hints.
        try {
            const summarizeValue = (v) => {
                try {
                    if (v === null) return null;
                    const t = typeof v;
                    if (t === 'string' || t === 'number' || t === 'boolean') return v;
                    if (Array.isArray(v)) {
                        if (v.length <= 6) return v.map(summarizeValue);
                        return `[Array(${v.length})]`;
                    }
                    if (t === 'object') {
                        const ks = Object.keys(v);
                        const out = {};
                        ks.slice(0, 12).forEach((k) => { out[k] = summarizeValue(v[k]); });
                        if (ks.length > 12) out.__moreKeys = ks.length - 12;
                        return out;
                    }
                    return String(v);
                } catch (_) {
                    return '[Unserializable]';
                }
            };

            const summarizeObjectRow = (row) => {
                if (!row || typeof row !== 'object') return null;
                const keys = Object.keys(row).sort();
                const pick = (k) => (k in row ? summarizeValue(row[k]) : undefined);
                const summary = {
                    id: pick('id'),
                    position: pick('position'),
                    angle: pick('angle'),
                    xHeightAngle: pick('xHeightAngle'),
                    yHeightAngle: pick('yHeightAngle'),
                    x: pick('x'),
                    y: pick('y'),
                    z: pick('z'),
                    fieldX: pick('fieldX'),
                    fieldY: pick('fieldY'),
                    wavelength: pick('wavelength'),
                };
                Object.keys(summary).forEach((k) => summary[k] === undefined && delete summary[k]);
                return {
                    keys: keys.slice(0, 120),
                    keyCount: keys.length,
                    summary,
                };
            };

            const findObjectRowForDiag = (o, i) => {
                if (Array.isArray(objectRows)) {
                    const oid = String(o?.objectId ?? '');
                    const byId = objectRows.find((r) => r && typeof r === 'object' && String(r.id ?? '') === oid);
                    if (byId) return byId;
                    if (i >= 0 && i < objectRows.length) return objectRows[i];
                }
                return null;
            };

            const summarizeSurfaceRowForNumber = (surfaceNumberMaybe1Based) => {
                const n = Number(surfaceNumberMaybe1Based);
                if (!Number.isFinite(n) || n < 1) return null;
                const idx = n - 1;
                const row = Array.isArray(opticalSystemRows) ? opticalSystemRows[idx] : null;
                if (!row || typeof row !== 'object') return { surfaceNumber: n, surfaceIndex: idx, missing: true };
                const comment = String(row.comment ?? row.Comment ?? row.note ?? row.Note ?? '').trim();
                return {
                    surfaceNumber: n,
                    surfaceIndex: idx,
                    objectType: row['object type'] ?? row.object ?? null,
                    surfType: row.surfType ?? row.type ?? null,
                    comment: comment || null,
                    aperture: row.aperture ?? row.Aperture ?? null,
                    semidia: row.semidia ?? row.Semidia ?? row['Semi Diameter'] ?? null,
                    radius: row.radius ?? null,
                    thickness: row.thickness ?? null,
                    glass: row.glass ?? row.material ?? row.Glass ?? null,
                };
            };

            const objDiag = spotData.map((o, i) => {
                const r = o && typeof o === 'object' ? (o.diagnostics?.retry ?? null) : null;
                const kindCounts = o && typeof o === 'object' && o.diagnostics && o.diagnostics.kindCounts
                    ? Object.entries(o.diagnostics.kindCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
                    : [];
                const surfaceCounts = o && typeof o === 'object' && o.diagnostics && o.diagnostics.surfaceCounts
                    ? Object.entries(o.diagnostics.surfaceCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
                    : [];
                const ex = o && typeof o === 'object' && o.diagnostics && Array.isArray(o.diagnostics.examples)
                    ? (o.diagnostics.examples.find(e => e && e.kind === 'PHYSICAL_APERTURE_BLOCK') || o.diagnostics.examples[0] || null)
                    : null;
                const exDetails = (ex && typeof ex === 'object') ? (ex.details ?? null) : null;
                const exHit = Number(exDetails?.hitRadiusMm);
                const exLim = Number(exDetails?.apertureLimitMm);
                const exOver = (Number.isFinite(exHit) && Number.isFinite(exLim)) ? (exHit - exLim) : null;

                const topSurfaceRows = surfaceCounts
                    .map(([k, c]) => {
                        const sn = Number(String(k).split(':')[0]);
                        return {
                            key: k,
                            count: c,
                            surfaceNumber: Number.isFinite(sn) ? sn : null,
                            row: Number.isFinite(sn) ? summarizeSurfaceRowForNumber(sn) : null,
                        };
                    })
                    .filter(x => x && x.row)
                    .slice(0, 8);
                const objRow = findObjectRowForDiag(o, i);
                const proto = summarizeObjectRow(objRow);
                return {
                    objectId: o?.objectId,
                    objectType: o?.objectType,
                    totalRays: o?.totalRays,
                    successfulRays: o?.successfulRays,
                    retry: r,
                    topKinds: kindCounts,
                    topSurfaces: surfaceCounts,
                    example: ex,
                    exampleSummary: (ex && typeof ex === 'object') ? {
                        kind: ex.kind ?? null,
                        surfaceIndex: Number.isFinite(Number(ex.surfaceIndex)) ? Number(ex.surfaceIndex) : null,
                        surfaceNumber: Number.isFinite(Number(exDetails?.surfaceNumber)) ? Number(exDetails.surfaceNumber) : null,
                        surfaceType: (exDetails?.surfaceType || exDetails?.surfType) ?? null,
                        hitRadiusMm: Number.isFinite(exHit) ? exHit : null,
                        apertureLimitMm: Number.isFinite(exLim) ? exLim : null,
                        overByMm: Number.isFinite(exOver) ? exOver : null,
                    } : null,
                    topSurfaceRowSummaries: topSurfaceRows,
                    objectRowIndex: (Array.isArray(objectRows) ? (objectRows.indexOf(objRow)) : null),
                    objectRowKeys: proto?.keys ?? null,
                    objectRowKeyCount: proto?.keyCount ?? null,
                    objectRowSummary: proto?.summary ?? null
                };
            });

            if (typeof globalThis !== 'undefined') {
                globalThis.__cooptLastSpotDiagramFailure = {
                    at: Date.now(),
                    surfaceNumber,
                    opticalSystemSurfaceCount: Array.isArray(opticalSystemRows) ? opticalSystemRows.length : null,
                    totalRays,
                    totalSuccessfulRays,
                    objects: objDiag
                };
            }

            errorMessage += `\nDiagnostics (retry/blockers):\n`;
            objDiag.forEach((d, i) => {
                errorMessage += `- Object ${i + 1} (id=${d.objectId}): `;
                if (d.retry && typeof d.retry === 'object') {
                    const aim = d.retry.aimThroughStopUsed;
                    const used = d.retry.pupilScaleUsed;
                    errorMessage += `aimThroughStopUsed=${aim}, pupilScaleUsed=${used}. `;
                }
                if (Array.isArray(d.topKinds) && d.topKinds.length) {
                    errorMessage += `topKinds=${d.topKinds.map(([k, n]) => `${k}:${n}`).join(', ')}. `;
                }
                if (Array.isArray(d.topSurfaces) && d.topSurfaces.length) {
                    errorMessage += `topSurfaces=${d.topSurfaces.map(([k, n]) => `${k}:${n}`).join(', ')}. `;
                }
                if (d.example && typeof d.example === 'object') {
                    const ek = d.example.kind;
                    const es = d.example.surface;
                    errorMessage += `example=${ek}${(es !== undefined ? `@${es}` : '')}.`;
                }
                errorMessage += `\n`;
            });
        } catch (_) {}
        throw new Error(errorMessage);
    }

    safeProgress(95, 'Finalizing...');
    await yieldToUI();
    safeProgress(100, 'Done');

    // Always keep a lightweight snapshot of the last successful run (even when there is no failure).
    // This helps diagnose issues like "all objects look identical" without relying on the failure-only snapshot.
    try {
        if (typeof globalThis !== 'undefined') {
            globalThis.__cooptLastSpotDiagramRun = {
                at: Date.now(),
                surfaceNumber,
                totalObjects: Array.isArray(spotData) ? spotData.length : null,
                objects: Array.isArray(spotData)
                    ? spotData.map((o) => {
                        const chief = Array.isArray(o?.spotPoints) ? o.spotPoints.find(p => p && p.isChiefRay) : null;
                        return {
                            objectId: o?.objectId ?? null,
                            objectType: o?.objectType ?? null,
                            objectXHeightAngle: o?.objectXHeightAngle ?? null,
                            objectYHeightAngle: o?.objectYHeightAngle ?? null,
                            successfulRays: o?.successfulRays ?? null,
                            totalRays: o?.totalRays ?? null,
                            successRate: o?.successRate ?? null,
                            chiefLocalX: (chief && Number.isFinite(Number(chief.x))) ? Number(chief.x) : null,
                            chiefLocalY: (chief && Number.isFinite(Number(chief.y))) ? Number(chief.y) : null
                        };
                    })
                    : null
            };
        }
    } catch (_) {}

    return {
        spotData: spotData,
        primaryWavelength: primaryWavelength,
        wavelengths: wavelengths,
        airy: airy,
        selectedRingCount: ringCount,
        surfaceInfoList: surfaceInfoList
    };
}

// Developer helper: print a compact table of the last spot-diagram retry attempts.
// Usage in console: `__cooptPrintLastSpotDiagRetryTable()`
try {
    if (typeof globalThis !== 'undefined' && !globalThis.__cooptPrintLastSpotDiagRetryTable) {
        globalThis.__cooptPrintLastSpotDiagRetryTable = function __cooptPrintLastSpotDiagRetryTable(objectIndex0 = 0) {
            const sd = globalThis.__cooptLastSpotDiagramFailure
                || globalThis.opener?.__cooptLastSpotDiagramFailure
                || globalThis.parent?.__cooptLastSpotDiagramFailure
                || null;
            const obj = sd?.objects?.[objectIndex0];
            const tried = obj?.retry?.pupilScaleTried;
            if (!Array.isArray(tried)) {
                try {
                    console.warn('No retry table available: __cooptLastSpotDiagramFailure.objects[0].retry.pupilScaleTried is missing. Re-run a Spot Diagram (or failing Requirement) in this window, then call __cooptPrintLastSpotDiagRetryTable() again.');
                } catch (_) {}
                return [];
            }
            const rows = tried.map((a) => ({
                pupilScale: a?.pupilScale ?? a?.s ?? null,
                aimThroughStop: !!a?.aimThroughStop,
                ok: a?.ok ?? null,
                raysGenerated: a?.raysGenerated ?? a?.rays ?? null,
                originY: Number.isFinite(Number(a?.emissionOrigin?.y)) ? Number(a.emissionOrigin.y) : (Number.isFinite(Number(a?.firstRayStartP?.y)) ? Number(a.firstRayStartP.y) : null),
                dirY: Number.isFinite(Number(a?.firstRayDir?.y)) ? Number(a.firstRayDir.y) : null,
                dirZ: Number.isFinite(Number(a?.firstRayDir?.z)) ? Number(a.firstRayDir.z) : null,
                stopIndex: a?.stopIndex ?? null,
                stopZ: a?.stopZ ?? null,
                stopRadius: a?.stopRadius ?? null,
            }));
            try { console.table(rows); } catch (_) {}
            return rows;
        };
    }
} catch (_) {}

// Developer helper: locate where the last spot-diagram failure snapshot lives (current/opener/parent).
// Usage in console: `__cooptWhereLastSpotDiagFailure()`
try {
    if (typeof globalThis !== 'undefined' && !globalThis.__cooptWhereLastSpotDiagFailure) {
        globalThis.__cooptWhereLastSpotDiagFailure = function __cooptWhereLastSpotDiagFailure() {
            const here = globalThis.__cooptLastSpotDiagramFailure;
            const opener = globalThis.opener?.__cooptLastSpotDiagramFailure;
            const parent = globalThis.parent?.__cooptLastSpotDiagramFailure;
            const out = {
                hasHere: !!here,
                hasOpener: !!opener,
                hasParent: !!parent,
                hereAt: here?.at ?? null,
                openerAt: opener?.at ?? null,
                parentAt: parent?.at ?? null,
            };
            try { console.log(out); } catch (_) {}
            return out;
        };
    }
} catch (_) {}

// スポットダイアグラムの描画（仕様書準拠）
export function drawSpotDiagram(spotData, surfaceNumber, containerId, primaryWavelength = null) {
    console.log('🎨 [SPOT DIAGRAM] Drawing spot diagram...');
    
    // If spotData is an object with spotData property, extract the actual array
    let actualSpotData = spotData;
    let surfaceInfoList = null;
    let airyInfo = null;
    if (spotData && typeof spotData === 'object') {
        if (spotData.spotData) {
            console.log('🔄 [SPOT DIAGRAM] Extracting spotData from returned object');
            actualSpotData = spotData.spotData;
        }
        // Also extract primary wavelength if not provided
        if (!primaryWavelength && spotData.primaryWavelength) {
            primaryWavelength = spotData.primaryWavelength.wavelength || spotData.primaryWavelength;
        }
        if (Array.isArray(spotData.surfaceInfoList)) {
            surfaceInfoList = spotData.surfaceInfoList;
        }
        if (spotData.airy && typeof spotData.airy === 'object') {
            airyInfo = spotData.airy;
        }
    }
    
    console.log('📊 [SPOT DIAGRAM] Actual spotData:', {
        isArray: Array.isArray(actualSpotData),
        length: actualSpotData ? actualSpotData.length : 'null'
    });
    
    const container = typeof containerId === 'string'
        ? document.getElementById(containerId)
        : containerId;
    if (!container) {
        console.error('❌ [SPOT DIAGRAM] Spot diagram container not found:', containerId);
        return;
    }

    const doc = container.ownerDocument || document;
    const plotly = doc.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    
    console.log('✅ [SPOT DIAGRAM] Container found');
    
    // コンテナをクリア
    container.innerHTML = '';
    
    // 全体のコンテナを作成
    const mainContainer = doc.createElement('div');
    mainContainer.style.cssText = 'font-family: Arial, sans-serif; padding: 20px;';
    
    // タイトルを追加
    const title = doc.createElement('h3');
    title.textContent = `Spot Diagram - Surf ${Math.max(0, surfaceNumber - 1)}`;
    title.style.cssText = 'text-align: center; margin-bottom: 20px; color: #333;';
    mainContainer.appendChild(title);
    
    // Check if actualSpotData is valid
    if (!actualSpotData || !Array.isArray(actualSpotData) || actualSpotData.length === 0) {
        console.error('❌ [SPOT DIAGRAM] Invalid or empty spot data');
        const errorMessage = doc.createElement('div');
        errorMessage.textContent = 'No valid spot data to display. Check console for details.';
        errorMessage.style.cssText = 'text-align: center; color: red; margin: 20px;';
        mainContainer.appendChild(errorMessage);
        container.appendChild(mainContainer);
        return;
    }
    
    console.log(`📊 [SPOT DIAGRAM] Processing ${actualSpotData.length} objects`);

    // Lightweight debug snapshot for comparing against Requirements spot-size evaluation.
    const __cooptSpotUiMetrics = [];
    
    // 各Objectのデータを詳細にログ出力
    actualSpotData.forEach((obj, idx) => {
        console.log(`🔍 [SPOT DIAGRAM] Object ${idx}: objectId=${obj.objectId}, spotPoints=${obj.spotPoints?.length || 0}, successRate=${obj.successRate}`);
    });
    
    // Object数分のグラフを作成
    let graphsCreated = 0;
    actualSpotData.forEach((objectData, index) => {
        // ケラれたObjectの情報も表示
        if (!objectData.spotPoints || objectData.spotPoints.length === 0) {
            console.warn(`⚠️ [SPOT DIAGRAM] Skipping Object ${objectData.objectId} - no spot points (${objectData.spotPoints?.length || 0} points)`);
            
            // ケラれたObjectの警告メッセージを表示
            const warningContainer = doc.createElement('div');
            warningContainer.style.cssText = 'margin-bottom: 30px; padding: 15px; border: 2px solid #ff9800; border-radius: 5px; background-color: #fff3e0;';
            
            const warningTitle = doc.createElement('h4');
            warningTitle.textContent = `Object ${objectData.objectId} (${objectData.objectType})`;
            warningTitle.style.cssText = 'margin: 0 0 10px 0; color: #e65100;';
            warningContainer.appendChild(warningTitle);
            
            const warningText = doc.createElement('div');
            const totalRays = objectData.totalRays || 0;
            const successfulRays = objectData.successfulRays || 0;
            const successRate = objectData.successRate ? (objectData.successRate * 100).toFixed(1) : '0.0';
            const diag = objectData.diagnostics;
            let diagHtml = '';
            try {
                const kindCounts = diag && typeof diag === 'object' ? diag.kindCounts : null;
                const surfaceCounts = diag && typeof diag === 'object' ? diag.surfaceCounts : null;
                const kinds = kindCounts && typeof kindCounts === 'object'
                    ? Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
                    : [];
                const surfaces = surfaceCounts && typeof surfaceCounts === 'object'
                    ? Object.entries(surfaceCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
                    : [];
                if (kinds.length || surfaces.length) {
                    const kindsText = kinds.map(([k, v]) => `${k}×${v}`).join(', ');
                    const surfacesText = surfaces.map(([k, v]) => `Surf ${k}×${v}`).join(', ');
                    diagHtml = `
                        <div style="margin-top: 8px; font-size: 13px; color: #444;">
                            ${kindsText ? `• Failure kinds: ${kindsText}<br>` : ''}
                            ${surfacesText ? `• Top blocker surfaces: ${surfacesText}<br>` : ''}
                        </div>
                    `;
                }
            } catch (_) {
                diagHtml = '';
            }
            warningText.innerHTML = `
                <strong>⚠️ No rays reached Surf ${Math.max(0, surfaceNumber - 1)}</strong><br>
                <div style="margin-top: 8px; font-size: 14px; color: #555;">
                    • Total rays traced: ${totalRays}<br>
                    • Rays reached target surface: ${successfulRays} (${successRate}%)<br>
                    • Possible causes: vignetting (aperture clipping), incorrect field angle, or optical system configuration
                </div>
                ${diagHtml}
            `;
            warningText.style.cssText = 'color: #d84315; font-size: 15px;';
            warningContainer.appendChild(warningText);
            
            mainContainer.appendChild(warningContainer);
            return;
        }
        
        console.log(`✅ [SPOT DIAGRAM] Creating graph for Object ${objectData.objectId} with ${objectData.spotPoints.length} points`);
        graphsCreated++;
        
        const graphContainer = doc.createElement('div');
        graphContainer.style.cssText = 'margin-bottom: 30px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;';
        
        // Object毎のタイトル（成功率情報と主光線オフセット情報を含む）
        const objectTitle = doc.createElement('h4');
        const successRate = objectData.successRate ? (objectData.successRate * 100).toFixed(1) : 'N/A';
        const rayInfo = objectData.successfulRays ? `${objectData.successfulRays}/${objectData.totalRays}` : 'N/A';
        const centroidInfo = objectData.centroidRaw
            ? `Centroid @ target (mm): (${Number(objectData.centroidRaw.x).toFixed(6)}, ${Number(objectData.centroidRaw.y).toFixed(6)})`
            : '';
        const selectedRingValue = Number(objectData.selectedRingOverride);
        const selectedRings = Number.isFinite(selectedRingValue) && selectedRingValue > 0
            ? selectedRingValue
            : (Number.isFinite(Number(spotData?.selectedRingCount)) && Number(spotData?.selectedRingCount) > 0
                ? Number(spotData.selectedRingCount)
                : null);
        const appliedRingValue = Number(objectData.annularRingsUsed);
        const appliedRings = Number.isFinite(appliedRingValue) && appliedRingValue > 0
            ? appliedRingValue
            : null;
        let ringInfo = '';
        if (selectedRings || appliedRings) {
            if (selectedRings && appliedRings && selectedRings !== appliedRings) {
                ringInfo = ` • Annular rings: selected ${selectedRings} → applied ${appliedRings}`;
            } else if (!appliedRings && selectedRings) {
                ringInfo = ` • Annular rings: selected ${selectedRings} (no additional rings generated with current ray count)`;
            } else {
                const ringsToShow = appliedRings || selectedRings;
                ringInfo = ` • Annular rings: ${ringsToShow}`;
            }
        }
        const fmtAngle = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n.toFixed(3) : (v == null ? 'N/A' : String(v));
        };
        const angleInfo = (objectData.objectType === 'Angle')
            ? ` • Field(deg): (${fmtAngle(objectData.objectXHeightAngle)}, ${fmtAngle(objectData.objectYHeightAngle)})`
            : '';
        objectTitle.textContent = `Object ${objectData.objectId} (${objectData.objectType}) - Success: ${rayInfo} rays (${successRate}%)${ringInfo}${angleInfo}`;
        objectTitle.style.cssText = 'margin: 0 0 10px 0; color: #555;';
        graphContainer.appendChild(objectTitle);
        
        // Show the raw centroid at the target surface.
        // Note: the plot itself is centered on the chief-ray intersection.
        if (objectData.centroidRaw) {
            const centroidTitle = doc.createElement('div');
            centroidTitle.textContent = centroidInfo;
            centroidTitle.style.cssText = 'margin: 0 0 10px 0; font-size: 12px; color: #777; font-style: italic;';
            graphContainer.appendChild(centroidTitle);
        }
        
        const xValuesMm = objectData.spotPoints.map(p => p.x);
        const yValuesMm = objectData.spotPoints.map(p => p.y);
        const colors = objectData.spotPoints.map((point, pointIndex) => getSpotColor(point, objectData.objectId, pointIndex));
        
        // 主光線交点を取得
        // Note: for heavily vignetted fields the intended chief ray can fail to reach the target surface,
        // leaving no point with isChiefRay=true. In that case, fall back to the spot point closest to the
        // centroid (matches Requirements-side SPOT_SIZE_RECT behavior).
        const hasChiefFlag = objectData.spotPoints.some(p => p && p.isChiefRay);
        let chiefRayPoint = objectData.spotPoints.find(p => p && p.isChiefRay);
        if (!chiefRayPoint) {
            const pts = objectData.spotPoints;
            const cx = pts.reduce((sum, p) => sum + Number(p?.x || 0), 0) / pts.length;
            const cy = pts.reduce((sum, p) => sum + Number(p?.y || 0), 0) / pts.length;
            let bestIdx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const x = Number(p?.x);
                const y = Number(p?.y);
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                const d = Math.hypot(x - cx, y - cy);
                if (d < bestDist) {
                    bestDist = d;
                    bestIdx = i;
                }
            }
            chiefRayPoint = pts[bestIdx] || pts[0] || null;
        }
        const chiefXMm = chiefRayPoint ? Number(chiefRayPoint.x) : 0;
        const chiefYMm = chiefRayPoint ? Number(chiefRayPoint.y) : 0;
        
        if (!hasChiefFlag) {
            console.warn(`⚠️ Object ${objectData.objectId}: Chief ray not found! Using centroid-closest point instead.`);
            console.warn(`   spotPoints count: ${objectData.spotPoints.length}`);
            console.warn(`   isChiefRay flags: ${objectData.spotPoints.map(p => p.isChiefRay).join(', ')}`);
        } else {
            console.log(`📍 Object ${objectData.objectId}: Chief ray intersection at (${(chiefXMm * 1000).toFixed(3)}, ${(chiefYMm * 1000).toFixed(3)}) µm`);
        }

        // Also surface the absolute chief-ray intersection in the UI (plots are centered on chief ray).
        if (chiefRayPoint && Number.isFinite(Number(chiefXMm)) && Number.isFinite(Number(chiefYMm))) {
            const chiefInfo = doc.createElement('div');
            chiefInfo.textContent = `Chief @ target (mm): (${Number(chiefXMm).toFixed(6)}, ${Number(chiefYMm).toFixed(6)})`;
            chiefInfo.style.cssText = 'margin: 0 0 10px 0; font-size: 12px; color: #777; font-style: italic;';
            graphContainer.appendChild(chiefInfo);
        }

        // Surface the effective pupil sampling & aiming mode used by the generator.
        // Auto-retry may reduce pupilScale to get non-zero hits (which can make vignetting look small).
        {
            const ps = Number(objectData?.pupilScaleUsed);
            const psText = Number.isFinite(ps) ? ps.toFixed(3) : 'N/A';
            const ats = objectData?.aimThroughStopUsed;
            const modeInfo = doc.createElement('div');
            modeInfo.textContent = `Pupil scale used: ${psText}  Aim-through-stop: ${ats === true ? 'true' : (ats === false ? 'false' : 'N/A')}`;
            modeInfo.style.cssText = 'margin: 0 0 10px 0; font-size: 12px; color: #777; font-style: italic;';
            graphContainer.appendChild(modeInfo);
        }
        
        // 主光線交点を中心とした座標系に変換（RMS計算用）
        const xValuesUm = xValuesMm.map(x => (x - chiefXMm) * 1000);
        const yValuesUm = yValuesMm.map(y => (y - chiefYMm) * 1000);
        
        let adjustedXValuesUm = xValuesUm.slice();
        let adjustedYValuesUm = yValuesUm.slice();
        let centerShiftXUm = 0;
        let centerShiftYUm = 0;
        let centerShiftDetected = false;

        const plotDiv = doc.createElement('div');
        plotDiv.style.width = '100%';
        plotDiv.style.maxWidth = '620px';
        plotDiv.style.height = '520px';
        plotDiv.style.margin = '0 auto';
        graphContainer.appendChild(plotDiv);

        // Draw Cross rays を非表示にする
        const drawCrossRays = []; // Array.isArray(window.currentDrawCrossRays) ? window.currentDrawCrossRays : [];
        const crossTraces = [];
        const horizontalPoints = [];
        const verticalPoints = [];
        const targetObjectIndex = Number.isFinite(objectData.objectIndex)
            ? objectData.objectIndex
            : (Number.isFinite(Number(objectData.objectId)) ? Number(objectData.objectId) - 1 : null);
        if (drawCrossRays.length > 0) {
            const surfaceInfo = surfaceInfoList[surfaceNumber - 1];
            drawCrossRays.forEach(ray => {
                const path = Array.isArray(ray?.rayPath) ? ray.rayPath : null;
                const targetIndex = surfaceNumber - 1;
                if (!path || targetIndex < 0 || targetIndex >= path.length) return;
                const globalPoint = path[targetIndex];
                if (!globalPoint) return;
                const rayObjectIndex = Number.isFinite(ray.objectIndex)
                    ? ray.objectIndex
                    : (Number.isFinite(Number(ray.objectId)) ? Number(ray.objectId) - 1 : null);
                if (targetObjectIndex !== null && rayObjectIndex !== null && rayObjectIndex !== targetObjectIndex) {
                    return;
                }
                const localPoint = surfaceInfo ? transformPointToLocal(globalPoint, surfaceInfo) : globalPoint;
                const xLocal = Number(localPoint?.x);
                const yLocal = Number(localPoint?.y);
                if (!Number.isFinite(xLocal) || !Number.isFinite(yLocal)) return;
                const entry = {
                    xUm: xLocal * 1000,
                    yUm: yLocal * 1000,
                    ray
                };
                const orientation = (ray.orientation || '').toLowerCase();
                if (orientation === 'horizontal') {
                    horizontalPoints.push(entry);
                } else if (orientation === 'vertical') {
                    verticalPoints.push(entry);
                }
            });

            const centerCandidates = [];
            if (horizontalPoints.length > 0) {
                horizontalPoints.sort((a, b) => a.xUm - b.xUm);
                const hCenter = horizontalPoints.reduce((best, current) => {
                    return Math.abs(current.yUm) < Math.abs(best.yUm) ? current : best;
                }, horizontalPoints[0]);
                centerCandidates.push(hCenter);
            }
            if (verticalPoints.length > 0) {
                verticalPoints.sort((a, b) => a.yUm - b.yUm);
                const vCenter = verticalPoints.reduce((best, current) => {
                    return Math.abs(current.xUm) < Math.abs(best.xUm) ? current : best;
                }, verticalPoints[0]);
                centerCandidates.push(vCenter);
            }
            if (centerCandidates.length > 0) {
                centerShiftXUm = centerCandidates.reduce((sum, p) => sum + p.xUm, 0) / centerCandidates.length;
                centerShiftYUm = centerCandidates.reduce((sum, p) => sum + p.yUm, 0) / centerCandidates.length;
                centerShiftDetected = true;
            }
        }

        const emissionPatternRaw = (typeof window !== 'undefined' && window.getRayEmissionPattern)
            ? window.getRayEmissionPattern()
            : (typeof window !== 'undefined' && window.rayEmissionPattern) ? window.rayEmissionPattern : 'annular';
        const emissionPattern = typeof emissionPatternRaw === 'string' ? emissionPatternRaw.toLowerCase() : 'annular';
        const alignRectWithCross = centerShiftDetected && emissionPattern === 'grid';
        const shiftXForAlignment = alignRectWithCross ? centerShiftXUm : 0;
        const shiftYForAlignment = alignRectWithCross ? centerShiftYUm : 0;

        if (alignRectWithCross) {
            adjustedXValuesUm = adjustedXValuesUm.map(x => x - shiftXForAlignment);
            adjustedYValuesUm = adjustedYValuesUm.map(y => y - shiftYForAlignment);
            console.log(`📍 [SpotDiag] Aligning Rect pattern to cross center: shift=(${centerShiftXUm.toFixed(3)}, ${centerShiftYUm.toFixed(3)}) µm`);
        }

        const horizontalPlotPoints = alignRectWithCross
            ? horizontalPoints.map(p => ({ ...p, xUm: p.xUm - shiftXForAlignment, yUm: p.yUm - shiftYForAlignment }))
            : horizontalPoints;
        const verticalPlotPoints = alignRectWithCross
            ? verticalPoints.map(p => ({ ...p, xUm: p.xUm - shiftXForAlignment, yUm: p.yUm - shiftYForAlignment }))
            : verticalPoints;

        if (horizontalPlotPoints.length > 0) {
            crossTraces.push({
                x: horizontalPlotPoints.map(p => p.xUm),
                y: horizontalPlotPoints.map(p => p.yUm),
                mode: 'markers',
                type: 'scattergl',
                name: 'Draw Cross X',
                marker: { color: '#ff6b6b', size: 7, symbol: 'x' },
                hoverinfo: 'text',
                text: horizontalPlotPoints.map(p => `Draw Cross X<br>X: ${p.xUm.toFixed(3)} µm<br>Y: ${p.yUm.toFixed(3)} µm`)
            });
        }

        if (verticalPlotPoints.length > 0) {
            crossTraces.push({
                x: verticalPlotPoints.map(p => p.xUm),
                y: verticalPlotPoints.map(p => p.yUm),
                mode: 'markers',
                type: 'scattergl',
                name: 'Draw Cross Y',
                marker: { color: '#4e9bff', size: 7, symbol: 'cross' },
                hoverinfo: 'text',
                text: verticalPlotPoints.map(p => `Draw Cross Y<br>X: ${p.xUm.toFixed(3)} µm<br>Y: ${p.yUm.toFixed(3)} µm`)
            });
        }

        if (horizontalPoints.length > 0 || verticalPoints.length > 0) {
            console.log(`📐 [SpotDiag] Overlay draw-cross rays (aligned=${alignRectWithCross}): horizontal=${horizontalPoints.length}, vertical=${verticalPoints.length} at surface ${surfaceNumber}`);
        }

        const distancesUm = adjustedXValuesUm.map((x, idx) => Math.hypot(x, adjustedYValuesUm[idx]));
        const maxDistanceUm = distancesUm.length > 0 ? Math.max(...distancesUm) : 0;
        const spotDiameterUm = maxDistanceUm * 2;
        const hoverTexts = adjustedXValuesUm.map((xUm, pointIndex) => {
            const wavelengthText = objectData.spotPoints[pointIndex].wavelength ? `${objectData.spotPoints[pointIndex].wavelength.toFixed(4)} μm` : 'N/A';
            return `Ray ${pointIndex + 1}<br>X: ${xUm.toFixed(3)} µm<br>Y: ${(adjustedYValuesUm[pointIndex]).toFixed(3)} µm<br>Wavelength: ${wavelengthText}`;
        });

        const maxAbsX = Math.max(...adjustedXValuesUm.map(x => Math.abs(x)), 1);
        const maxAbsY = Math.max(...adjustedYValuesUm.map(y => Math.abs(y)), 1);
        const airyRadiusUm = Number(airyInfo?.airyRadiusUm);
        const rangeBase = Math.max(maxAbsX, maxAbsY, Number.isFinite(airyRadiusUm) ? airyRadiusUm : 0);
        const maxRange = rangeBase * (objectData.spotPoints.length > 1 ? 1.1 : 1.2);
        const xRangePadding = maxRange;
        const yRangePadding = maxRange;

        const globalShiftXmm = alignRectWithCross ? centerShiftXUm / 1000 : 0;
        const globalShiftYmm = alignRectWithCross ? centerShiftYUm / 1000 : 0;
        const maxGlobalRadiusMm = Math.max(...objectData.spotPoints.map(p => {
            const gx = typeof p.globalX === 'number' ? p.globalX : p.x;
            const gy = typeof p.globalY === 'number' ? p.globalY : p.y;
            return Math.hypot(gx - globalShiftXmm, gy - globalShiftYmm);
        }), 0);
        const maxLocalRadiusUm = Math.max(...adjustedXValuesUm.map((x, idx) => Math.hypot(x, adjustedYValuesUm[idx])), 0);
        console.log(`📏 [SpotDiag] Surface ${surfaceNumber} Object ${objectData.objectId}: local max ${(maxLocalRadiusUm).toFixed(3)} µm vs global max ${(maxGlobalRadiusMm * 1000).toFixed(3)} µm`);

        const scatterTrace = {
            x: adjustedXValuesUm,
            y: adjustedYValuesUm,
            text: hoverTexts,
            mode: 'markers',
            type: 'scattergl',
            name: `Object ${objectData.objectId}`,
            marker: {
                color: colors,
                size: 6,
                symbol: 'circle',
                opacity: 0.85,
                line: {
                    width: 0.8,
                    color: '#333333'
                }
            },
            hovertemplate: '%{text}<extra></extra>'
        };

        const layout = {
            autosize: true,
            width: 540,
            height: 520,
            margin: { l: 60, r: 35, t: 20, b: 60 },
            xaxis: {
                title: 'X (µm)',
                autorange: false,
                range: [-xRangePadding, xRangePadding],
                zeroline: false,
                showgrid: true,
                gridcolor: '#e5e5e5',
                gridwidth: 1,
                scaleanchor: 'y',
                scaleratio: 1
            },
            yaxis: {
                title: 'Y (µm)',
                autorange: false,
                range: [-yRangePadding, yRangePadding],
                zeroline: false,
                showgrid: true,
                gridcolor: '#e5e5e5',
                gridwidth: 1
            },
            hovermode: 'closest',
            showlegend: false,
            shapes: [],
            annotations: [
                {
                    text: `Surface: ${surfaceNumber}`,
                    x: 1,
                    y: 1.12,
                    xref: 'paper',
                    yref: 'paper',
                    xanchor: 'right',
                    showarrow: false,
                    font: { size: 12, color: '#333' }
                },
                {
                    text: `Object ${objectData.objectId}`,
                    x: 1,
                    y: 1.05,
                    xref: 'paper',
                    yref: 'paper',
                    xanchor: 'right',
                    showarrow: false,
                    font: { size: 11, color: getObjectColor(objectData.objectId) }
                }
            ]
        };

        if (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) {
            layout.shapes.push({
                type: 'circle',
                xref: 'x',
                yref: 'y',
                x0: -airyRadiusUm,
                y0: -airyRadiusUm,
                x1: airyRadiusUm,
                y1: airyRadiusUm,
                line: { color: '#000000', width: 1 },
                fillcolor: 'rgba(0,0,0,0)'
            });
        }

        const primaryWavelengthMicronsForDisplay = Number(primaryWavelength?.wavelength ?? primaryWavelength);
        if (Number.isFinite(primaryWavelengthMicronsForDisplay) && primaryWavelengthMicronsForDisplay > 0) {
            layout.annotations.push({
                text: `Primary: ${primaryWavelengthMicronsForDisplay.toFixed(4)} μm`,
                x: 0,
                y: 1.12,
                xref: 'paper',
                yref: 'paper',
                xanchor: 'left',
                showarrow: false,
                font: { size: 11, color: '#d4302b' }
            });
        }

        const config = {
            displaylogo: false,
            responsive: true,
            modeBarButtonsToRemove: ['toImage']
        };

        if (plotly && typeof plotly.newPlot === 'function') {
            const plotTraces = [scatterTrace, ...crossTraces];
            plotly.newPlot(plotDiv, plotTraces, layout, config).catch(err => {
                console.error('❌ Plotly spot diagram rendering error:', err);
                plotDiv.textContent = 'Failed to render spot diagram with Plotly.';
            });
        } else {
            console.error('❌ Plotly is not available. Please ensure the library is loaded.');
            plotDiv.textContent = 'Plotly.js is not available. Spot diagram cannot be rendered.';
        }

        // Emission U/V plane rendering disabled by user request
        /*
        try {
            const emissionPointsAll = Array.isArray(objectData.emissionPoints)
                ? objectData.emissionPoints.filter(point => Number.isFinite(point.u) && Number.isFinite(point.v))
                : [];
            if (emissionPointsAll.length > 0 && window.Plotly && typeof window.Plotly.newPlot === 'function') {
                const emissionPointsSucceeded = emissionPointsAll.filter(point => point.succeeded);
                const emissionDiv = document.createElement('div');
                emissionDiv.style.width = '100%';
                emissionDiv.style.maxWidth = '620px';
                emissionDiv.style.height = '520px';
                emissionDiv.style.margin = '30px auto 10px auto';
                graphContainer.appendChild(emissionDiv);

                const emissionXUm = emissionPointsAll.map(p => p.u * 1000);
                const emissionYUm = emissionPointsAll.map(p => p.v * 1000);
                const emissionHoverAll = emissionPointsAll.map((point, idx) => {
                    return `Ray ${point.rayIndex + 1}<br>U: ${emissionXUm[idx].toFixed(3)} µm<br>V: ${emissionYUm[idx].toFixed(3)} µm`;
                });

                const emissionTraceAll = {
                    x: emissionXUm,
                    y: emissionYUm,
                    text: emissionHoverAll,
                    mode: 'markers',
                    type: 'scattergl',
                    name: 'Emission plane (all rays)',
                    marker: {
                        color: '#bbbbbb',
                        size: 5,
                        symbol: 'circle',
                        opacity: 0.35,
                        line: {
                            width: 0.5,
                            color: '#888888'
                        }
                    },
                    hovertemplate: '%{text}<extra></extra>'
                };

                let emissionTraceSuccess = null;
                if (emissionPointsSucceeded.length > 0) {
                    const successX = emissionPointsSucceeded.map(p => p.u * 1000);
                    const successY = emissionPointsSucceeded.map(p => p.v * 1000);
                    const successHover = emissionPointsSucceeded.map(point => `Ray ${point.rayIndex + 1} (success)<br>U: ${(point.u * 1000).toFixed(3)} µm<br>V: ${(point.v * 1000).toFixed(3)} µm`);
                    emissionTraceSuccess = {
                        x: successX,
                        y: successY,
                        text: successHover,
                        mode: 'markers',
                        type: 'scattergl',
                        name: 'Successful rays',
                        marker: {
                            color: '#1f77b4',
                            size: 6,
                            symbol: 'circle',
                            opacity: 0.85,
                            line: {
                                width: 0.8,
                                color: '#222222'
                            }
                        },
                        hovertemplate: '%{text}<extra></extra>'
                    };
                }

                const emissionAbsX = emissionXUm.map(x => Math.abs(x));
                const emissionAbsY = emissionYUm.map(y => Math.abs(y));
                const emissionMaxRange = Math.max(
                    emissionAbsX.length > 0 ? Math.max(...emissionAbsX) : 1,
                    emissionAbsY.length > 0 ? Math.max(...emissionAbsY) : 1,
                    1
                ) * (emissionPointsAll.length > 1 ? 1.1 : 1.2);

                const emissionLayout = {
                    autosize: true,
                    width: 540,
                    height: 520,
                    margin: { l: 60, r: 35, t: 20, b: 60 },
                    xaxis: {
                        title: 'Emission U (µm)',
                        autorange: true,
                        zeroline: true,
                        zerolinewidth: 2,
                        zerolinecolor: '#555',
                        showgrid: true,
                        gridcolor: '#e5e5e5',
                        gridwidth: 1,
                        scaleanchor: 'y',
                        scaleratio: 1
                    },
                    yaxis: {
                        title: 'Emission V (µm)',
                        autorange: true,
                        zeroline: true,
                        zerolinewidth: 2,
                        zerolinecolor: '#555',
                        showgrid: true,
                        gridcolor: '#e5e5e5',
                        gridwidth: 1
                    },
                    hovermode: 'closest',
                    showlegend: false,
                    shapes: [
                        {
                            type: 'line',
                            x0: 0,
                            x1: 0,
                            y0: -emissionMaxRange,
                            y1: emissionMaxRange,
                            line: { color: '#666', width: 1.2 }
                        },
                        {
                            type: 'line',
                            x0: -emissionMaxRange,
                            x1: emissionMaxRange,
                            y0: 0,
                            y1: 0,
                            line: { color: '#666', width: 1.2 }
                        }
                    ],
                    annotations: [
                        {
                            text: `Emission Plane - Object ${objectData.objectId}`,
                            x: 0,
                            y: 1.08,
                            xref: 'paper',
                            yref: 'paper',
                            showarrow: false,
                            font: { size: 12, color: '#333' }
                        }
                    ]
                };

                const stopRadius = Number.isFinite(objectData.emissionBasis?.stopRadius)
                    ? objectData.emissionBasis.stopRadius * 1000
                    : null;
                if (stopRadius && stopRadius > 0) {
                    emissionLayout.shapes.push({
                        type: 'circle',
                        x0: -stopRadius,
                        x1: stopRadius,
                        y0: -stopRadius,
                        y1: stopRadius,
                        xref: 'x',
                        yref: 'y',
                        line: { color: '#999', dash: 'dot', width: 1 }
                    });
                }

                const emissionTraces = emissionTraceSuccess ? [emissionTraceAll, emissionTraceSuccess] : [emissionTraceAll];

                Plotly.newPlot(emissionDiv, emissionTraces, emissionLayout, config).catch(err => {
                    console.error('❌ Plotly emission plane rendering error:', err);
                    emissionDiv.textContent = 'Failed to render emission plane.';
                });
            }
        } catch (emissionError) {
            console.error('❌ Emission plane rendering failed:', emissionError);
        }
        */
        const formatMicron = (valueUm) => {
            if (!Number.isFinite(valueUm)) {
                return 'N/A';
            }
            const absValue = Math.abs(valueUm);
            if (absValue >= 1) {
                return valueUm.toFixed(3);
            }
            if (absValue >= 1e-3) {
                return valueUm.toFixed(6);
            }
            return valueUm.toExponential(3);
        };

        const formatMillimeter = (valueMm) => {
            if (!Number.isFinite(valueMm)) {
                return 'N/A';
            }
            const absValue = Math.abs(valueMm);
            if (absValue >= 1) {
                return `${valueMm.toFixed(6)} mm`;
            }
            if (absValue >= 1e-3) {
                return `${valueMm.toFixed(6)} mm`;
            }
            return `${valueMm.toExponential(3)} mm`;
        };

        const normalizeDir = (vec) => {
            if (!vec || !Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)) {
                return null;
            }
            const mag = Math.hypot(vec.x, vec.y, vec.z);
            if (mag < 1e-12) return null;
            return { x: vec.x / mag, y: vec.y / mag, z: vec.z / mag };
        };

        // Initialize centroid offset and raw centroid values with defaults
        const centroidOffsetAppliedXUm = typeof centerShiftXUm !== 'undefined' ? centerShiftXUm : 0;
        const centroidOffsetAppliedYUm = typeof centerShiftYUm !== 'undefined' ? centerShiftYUm : 0;
        const rawCentroidXUm = xValuesUm && xValuesUm.length > 0 ? (xValuesUm.reduce((a, b) => a + b) / xValuesUm.length) : 0;
        const rawCentroidYUm = yValuesUm && yValuesUm.length > 0 ? (yValuesUm.reduce((a, b) => a + b) / yValuesUm.length) : 0;

        // Calculate RMS values from adjusted spot positions (centered at origin)
        const rmsXUm = adjustedXValuesUm && adjustedXValuesUm.length > 0 
            ? Math.sqrt(adjustedXValuesUm.reduce((sum, x) => sum + x * x, 0) / adjustedXValuesUm.length)
            : 0;
        const rmsYUm = adjustedYValuesUm && adjustedYValuesUm.length > 0 
            ? Math.sqrt(adjustedYValuesUm.reduce((sum, y) => sum + y * y, 0) / adjustedYValuesUm.length)
            : 0;
        const rmsTotalUm = Math.sqrt(rmsXUm * rmsXUm + rmsYUm * rmsYUm);

        // Store per-object debug snapshot (for console comparison)
        try {
            __cooptSpotUiMetrics.push({
                objectId: objectData.objectId ?? null,
                objectType: objectData.objectType ?? null,
                surfaceNumber: surfaceNumber,
                emissionPattern,
                alignRectWithCross,
                chiefSelection: hasChiefFlag ? 'flagged-chief' : 'centroid-closest',
                chiefXMm: Number.isFinite(chiefXMm) ? chiefXMm : null,
                chiefYMm: Number.isFinite(chiefYMm) ? chiefYMm : null,
                nPoints: Array.isArray(objectData.spotPoints) ? objectData.spotPoints.length : null,
                totalRays: objectData.totalRays ?? null,
                successfulRays: objectData.successfulRays ?? null,
                rmsXUm: Number.isFinite(rmsXUm) ? rmsXUm : null,
                rmsYUm: Number.isFinite(rmsYUm) ? rmsYUm : null,
                rmsTotalUm: Number.isFinite(rmsTotalUm) ? rmsTotalUm : null,
                diameterUm: Number.isFinite(spotDiameterUm) ? spotDiameterUm : null,
            });
        } catch (_) {}
        
        // Calculate centroid positions (used for display in adjusted/plotting coordinates)
        const centroidXUm = adjustedXValuesUm && adjustedXValuesUm.length > 0 
            ? (adjustedXValuesUm.reduce((a, b) => a + b, 0) / adjustedXValuesUm.length)
            : 0;
        const centroidYUm = adjustedYValuesUm && adjustedYValuesUm.length > 0 
            ? (adjustedYValuesUm.reduce((a, b) => a + b, 0) / adjustedYValuesUm.length)
            : 0;

        const alignmentShiftText = alignRectWithCross
            ? `<div>Crosshair alignment shift: ${formatMicron(shiftXForAlignment)}, ${formatMicron(shiftYForAlignment)} µm</div>`
            : '';
        const chiefAnalysis = objectData.chiefRayAnalysis;
        const chiefErrorText = chiefAnalysis && Number.isFinite(chiefAnalysis.error)
            ? `<div>Stop center distance: ${formatMillimeter(chiefAnalysis.error)}</div>`
            : '';
        const chiefMethodDisplay = (() => {
            if (!chiefAnalysis || !chiefAnalysis.method) return '';
            const map = {
                'grid-brent-hybrid': 'Grid + Brent hybrid optimization',
                'brent-optimization': 'Brent optimization',
                'geometric-approximation': 'Geometric approximation',
                'geometric-fallback': 'Geometric fallback',
                'unknown': 'Unknown method'
            };
            const label = map[chiefAnalysis.method] || chiefAnalysis.method;
            return `<div>Optimization method: ${label}</div>`;
        })();
        const chiefAnalysisOriginText = chiefAnalysis && Number.isFinite(chiefAnalysis.optimalX) && Number.isFinite(chiefAnalysis.optimalY)
            ? `<div>Optimized start point (analysis): (${formatMillimeter(chiefAnalysis.optimalX)}, ${formatMillimeter(chiefAnalysis.optimalY)})</div>`
            : '';
        const chiefAnalysisDirText = (() => {
            if (!chiefAnalysis || !chiefAnalysis.direction) return '';
            const dir = chiefAnalysis.direction;
            if (![dir.i, dir.j, dir.k].every(Number.isFinite)) return '';
            return `<div>Analysis direction vector: (${dir.i.toFixed(6)}, ${dir.j.toFixed(6)}, ${dir.k.toFixed(6)})</div>`;
        })();

        const airyDiameterText = (Number.isFinite(Number(airyInfo?.airyDiameterUm)) && Number(airyInfo?.airyDiameterUm) > 0)
            ? `<div>Airy diameter (1st min): ${Number(airyInfo.airyDiameterUm).toFixed(3)} µm</div>`
            : '';

        // Create stats DOM element
        const stats = doc.createElement('div');
        stats.style.cssText = 'padding: 10px; background: #f9f9f9; border-left: 3px solid #0066cc; margin: 10px 0;';
        
        stats.innerHTML = `
            <div><strong>Object ${objectData.objectId} Statistics:</strong></div>
            <div>Valid rays: ${objectData.spotPoints.length} / ${objectData.totalRays} (${(objectData.successRate * 100).toFixed(1)}%)</div>
            <div>RMS X: ${rmsXUm.toFixed(3)} µm</div>
            <div>RMS Y: ${rmsYUm.toFixed(3)} µm</div>
            <div>RMS Total: ${rmsTotalUm.toFixed(3)} µm</div>
            <div>Spot diameter: ${spotDiameterUm.toFixed(3)} µm</div>
            ${airyDiameterText}
            ${alignmentShiftText}
            ${chiefErrorText}
            ${chiefMethodDisplay}
            ${chiefAnalysisOriginText}
            ${chiefAnalysisDirText}
        `;
        graphContainer.appendChild(stats);
        
        mainContainer.appendChild(graphContainer);
        console.log(`✅ [SPOT DIAGRAM] Graph ${graphsCreated} appended to mainContainer for Object ${objectData.objectId}`);
    });
    
    console.log(`📊 [SPOT DIAGRAM] Total graphs created: ${graphsCreated} out of ${actualSpotData.length} objects`);
    container.appendChild(mainContainer);

    // Publish debug snapshot for SD vs Requirements comparisons.
    try {
        if (typeof globalThis !== 'undefined') {
            globalThis.__cooptLastSpotDiagramMetrics = {
                at: Date.now(),
                surfaceNumber,
                selectedRingCount: (spotData && typeof spotData === 'object') ? (spotData.selectedRingCount ?? null) : null,
                objects: __cooptSpotUiMetrics
            };
        }
    } catch (_) {}
}

// Ray colors by設定に従った色を取得
function getSpotColor(point, objectId, pointIndex) {
    // グローバル変数rayColorModeを参照（main.jsで定義）
    const colorMode = window.rayColorMode || window.getRayColorMode?.() || 'object';
    
    // デバッグ出力を抑制（コメントアウト）
    // if (pointIndex < 5) {
    //     console.log(`🎨 getSpotColor called: mode=${colorMode}, objectId=${objectId}, pointIndex=${pointIndex}`);
    //     console.log(`🔍 Debug rayColorMode sources: window.rayColorMode=${window.rayColorMode}, getRayColorMode=${window.getRayColorMode?.()}`);
    // }
    
    switch (colorMode) {
        case 'source':
            // 波長に基づく色分け
            const wavelengthColor = getWavelengthColor(point.wavelength);
            // if (pointIndex < 5) {
            //     console.log(`🌈 Source color: wavelength=${point.wavelength}μm → ${wavelengthColor}`);
            // }
            return wavelengthColor;
        case 'object':
            const objectColor = getObjectColor(objectId);
            // if (pointIndex < 5) {
            //     console.log(`📦 Object color: objectId=${objectId} → ${objectColor}`);
            // }
            return objectColor;
        case 'segment':
            // セグメント番号に基づく色分け
            const segmentColors = ['#ff4444', '#44ff44', '#4444ff', '#ffaa44', '#ff44aa', '#44aaff', '#aaff44', '#aa44ff'];
            const segmentIndex = point.segmentNumber || (pointIndex % 8);
            const segmentColor = segmentColors[segmentIndex];
            // if (pointIndex < 5) {
            //     console.log(`🔢 Segment color: segmentNumber=${point.segmentNumber || 'undefined'}, pointIndex=${pointIndex}, segmentIndex=${segmentIndex} → ${segmentColor}`);
            // }
            return segmentColor;
        default:
            return getObjectColor(objectId);
    }
}

// 波長に基づく色を取得
function getWavelengthColor(wavelength) {
    if (!wavelength || typeof wavelength !== 'number') {
        return '#888888'; // グレー（デフォルト）
    }
    
    // 可視光の波長範囲での色分け（380-700nm）
    if (wavelength < 0.4) { // 380nm未満（紫外線域）
        return '#9400D3'; // 濃い紫
    } else if (wavelength < 0.45) { // 380-450nm（紫）
        return '#8A2BE2'; // ブルーバイオレット
    } else if (wavelength < 0.48) { // 450-480nm（青）
        return '#0000FF'; // 青
    } else if (wavelength < 0.51) { // 480-510nm（青緑）
        return '#00BFFF'; // ディープスカイブルー
    } else if (wavelength < 0.55) { // 510-550nm（緑）
        return '#00FF00'; // 緑
    } else if (wavelength < 0.58) { // 550-580nm（黄緑）
        return '#ADFF2F'; // グリーンイエロー
    } else if (wavelength < 0.60) { // 580-600nm（黄）
        return '#FFFF00'; // 黄
    } else if (wavelength < 0.63) { // 600-630nm（オレンジ）
        return '#FFA500'; // オレンジ
    } else if (wavelength < 0.70) { // 630-700nm（赤）
        return '#FF0000'; // 赤
    } else { // 700nm以上（赤外線域）
        return '#8B0000'; // ダークレッド
    }
}

// オブジェクトIDに基づいて色を取得（Draw機能と同じ順序）
function getObjectColor(objectId) {
    // Draw Cross（クロスビーム）で実際に使用されている色
    // ray-renderer.jsのcrossBeamColorsに基づく
    const colors = [
        '#0000ff', // 青 (Object0 - Draw Crossの色)
        '#00cc00', // 緑 (Object1)
        '#ff8000', // オレンジ (Object2)
        '#8000ff', // 紫 (Object3)
        '#ff0080', // ピンク (Object4)
        '#00ff80', // 青緑 (Object5)
        '#ffff00', // 黄色 (Object6)
        '#aa00ff', // マゼンタ (Object7)
        '#ffaa00', // 黄オレンジ (Object8)
        '#00aaff'  // 水色 (Object9)
    ];
    // Draw機能と同じ計算: (objectId - 1) % colors.length
    return colors[(objectId - 1) % colors.length];
}

// 面選択のオプションを生成（CB面を除外）
export function generateSurfaceOptions(opticalSystemRows) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        // console.warn('⚠️ No optical system data available for surface options');
        return [];
    }
    
    // console.log('🔍 Generating surface options...');
    // console.log(`📊 Optical system has ${opticalSystemRows.length} surfaces defined`);
    
    const options = [];

    // Spot Diagram "surface id" matches Design Intent numbering:
    // Object = 0 (not selectable), then first non-object row = 1.
    // CB surfaces DO count in the id sequence (but are not selectable).
    let surfaceId = 0;

    const normalizeType = (v) => String(v ?? '').trim().toLowerCase();
    const compactType = (v) => normalizeType(v).replace(/[\s_-]+/g, '');
    const isCoordBreakType = (v) => {
        const n = normalizeType(v);
        const c = compactType(v);
        return (
            n === 'cb' ||
            n === 'coord break' ||
            n === 'coordinate break' ||
            c === 'cb' ||
            c === 'coordbreak' ||
            c === 'coordinatebreak'
        );
    };

    const isObjectType = (v) => {
        const n = normalizeType(v);
        const c = compactType(v);
        if (!n && !c) return false;
        // Be strict: avoid treating unrelated strings containing "object" as Object.
        // Accept common tokens/prefixes used by the table and block schema.
        if (n === 'object' || c === 'object') return true;
        if (c === 'objectplane' || c === 'objectsurface') return true;
        if (n.startsWith('object ') || n.startsWith('object-') || n.startsWith('object_')) return true;
        return false;
    };

    const isImageType = (v) => {
        const n = normalizeType(v);
        const c = compactType(v);
        if (!n && !c) return false;
        return n === 'image' || c === 'image' || n.includes('image');
    };

    const isStopType = (v) => {
        const n = normalizeType(v);
        const c = compactType(v);
        if (!n && !c) return false;
        return n === 'stop' || c === 'stop' || n.includes('stop');
    };

    // 各面をチェックして適切な面のみを選択肢に追加（到達可能性の制限は削除）
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surfaceData = opticalSystemRows[i];
        // Prefer canonical field used by the Optical System table.
        // Avoid using `Object` (capital O) here because it is ambiguous and can cause false positives.
        const objTypeRaw = surfaceData?.['object type'] ?? surfaceData?.objectType ?? surfaceData?.object ?? '';
        const surfTypeRaw = surfaceData?.surfType ?? surfaceData?.['surf type'] ?? surfaceData?.type ?? '';
        const surfaceType = (objTypeRaw || surfTypeRaw || 'Standard');
        const radius = surfaceData.radius || 'INF';

        // Object is id 0 and is not selectable.
        if (isObjectType(objTypeRaw) || isObjectType(surfTypeRaw) || isObjectType(surfaceType)) {
            continue;
        }

        // Increment id for every non-object row (including CB).
        surfaceId++;

        // CB surfaces are not selectable, but they DO count in the numbering.
        if (isCoordBreakType(objTypeRaw) || isCoordBreakType(surfTypeRaw) || isCoordBreakType(surfaceType)) {
            continue;
        }
        const rowId = (surfaceData && surfaceData.id !== undefined && surfaceData.id !== null)
            ? String(surfaceData.id)
            : null;

        const rowSig = (() => {
            try {
                const norm = (v) => String(v ?? '').trim().toLowerCase();
                const n0 = (v) => {
                    const x = Number(v);
                    return Number.isFinite(x) ? String(x) : norm(v);
                };
                // Prefer explicit ids when present.
                if (rowId && rowId !== '') return `id:${rowId}`;
                const mat = surfaceData?.material ?? surfaceData?.glass ?? surfaceData?.['glass'] ?? surfaceData?.refractiveIndex ?? '';
                const cmt = surfaceData?.comment ?? surfaceData?.name ?? '';
                // Do NOT include rowIndex so CB insert/delete doesn't change the signature.
                return [
                    `t:${norm(surfaceType)}`,
                    `r:${n0(surfaceData?.radius ?? surfaceData?.R ?? radius)}`,
                    `th:${n0(surfaceData?.thickness ?? surfaceData?.T ?? '')}`,
                    `sd:${n0(surfaceData?.semidia ?? surfaceData?.semiDia ?? '')}`,
                    `m:${norm(mat)}`,
                    `c:${norm(cmt)}`
                ].join('|');
            } catch (_) {
                return null;
            }
        })();
        
        // Stop面、通常の光学面、Image面は選択可能
        const isStop = isStopType(objTypeRaw) || isStopType(surfTypeRaw) || isStopType(surfaceType);
        const isImage = isImageType(objTypeRaw) || isImageType(surfTypeRaw) || isImageType(surfaceType);

        let displayName = `Surf ${surfaceId}`;
        if (isStop) {
            displayName += ` (Stop)`;
        } else if (isImage) {
            displayName += ` (Image)`;
        } else {
            displayName += ` (${surfaceType})`;
        }
        
        if (radius !== 'INF') {
            displayName += `, R=${radius}`;
        }
        
        // IMPORTANT:
        // - `surfaceId` is the UI-friendly label number (counts non-object rows, including CB).
        // - `value` must match the evaluator's expected surfaceNumber, which is the 1-based row index
        //   into `opticalSystemRows` (because the evaluator uses `rows[surfaceNumber - 1]`).
        // Using `surfaceId` as `value` breaks when Coord Break rows exist.
        options.push({
            value: i + 1,
            surfaceId,
            label: displayName,
            rowId,
            rowSig,
            rowIndex: i
        });
        
    // console.log(`✅ Added surface option: ${displayName}`);
    }
    
    // console.log(`✅ Generated ${options.length} valid surface options (excluding Object and CB surfaces)`);
    return options;
}

// 開口制限を分析して適切な光線生成範囲を決定
function analyzeApertureLimits(opticalSystemRows, targetSurfaceNumber) {
    let minAperture = Infinity;
    let limitingSurface = -1;
    
    // 対象面までの各面の開口径をチェック
    for (let i = 0; i < Math.min(targetSurfaceNumber, opticalSystemRows.length); i++) {
        const surface = opticalSystemRows[i];
        const semidia = parseFloat(surface.semidia);
        
        if (!isNaN(semidia) && semidia > 0) {
    // console.log(`📏 Surface ${i + 1}: semidia = ${semidia}mm`);
            if (semidia < minAperture) {
                minAperture = semidia;
                limitingSurface = i + 1;
            }
        }
    }
    
    // 制限が見つからない場合のデフォルト値
    if (minAperture === Infinity) {
        // console.warn('⚠️ No aperture limits found, using default 10mm');
        minAperture = 10; // デフォルトで10mm
        limitingSurface = -1;
    }
    
    // 安全マージンを適用（50%の範囲で光線を生成して開口制限を回避）
    const effectiveAperture = minAperture * 0.5;
    
    return {
        minAperture: minAperture,
        effectiveAperture: effectiveAperture,
        limitingSurface: limitingSurface
    };
}

// 光学系の構造とCB面を分析
function analyzeOpticalSystemStructure(opticalSystemRows) {
    // console.log('🔍 Analyzing optical system structure...');
    // console.log(`📊 Total surfaces in optical system: ${opticalSystemRows.length}`);
    
    const surfaceTypes = [];
    let cbSurfaces = [];
    
    opticalSystemRows.forEach((surface, index) => {
        const surfType = surface.surfType || 'Standard';
        const semidia = surface.semidia || 'undefined';
        const thickness = surface.thickness || 'undefined';
        const radius = surface.radius || 'undefined';
        
        surfaceTypes.push({
            index: index + 1, // 1-based
            surfType: surfType,
            semidia: semidia,
            thickness: thickness,
            radius: radius
        });
        
        if (surfType === 'CB' || surfType === 'Coordinate Break' || surfType === 'Coord Break') {
            cbSurfaces.push({
                index: index + 1,
                cbParams: surface.cbParams || 'undefined',
                surface: surface
            });
        }
        
        // console.log(`📋 Surface ${index + 1}: ${surfType}, R=${radius}, semidia=${semidia}, thickness=${thickness}`);
        
        // 各面の詳細情報もログ出力
        // if (index < 10) { // 最初の10面のみ詳細表示
        //     console.log(`   🔍 Surface ${index + 1} full data:`, surface);
        // }
    });
    
    // console.log(`🔄 Found ${cbSurfaces.length} CB surfaces:`, cbSurfaces);
    
    // 面8が存在するかチェック
    if (opticalSystemRows.length >= 8) {
        const surface8 = opticalSystemRows[7]; // 0-indexed
        // console.log(`✅ Surface 8 exists:`, {
        //     surfType: surface8.surfType,
        //     radius: surface8.radius,
        //     semidia: surface8.semidia,
        //     thickness: surface8.thickness,
        //     fullData: surface8
        // });
    } else {
    // console.error(`❌ Surface 8 does not exist! Only ${opticalSystemRows.length} surfaces are defined.`);
    }
    
    return {
        totalSurfaces: opticalSystemRows.length,
        surfaceTypes: surfaceTypes,
        cbSurfaces: cbSurfaces
    };
}

// 現在の光学系テーブルデータを取得して分析
function getCurrentOpticalSystemData() {
    // console.log('🔍 Getting current optical system data from tables...');
    
    try {
        // main.jsから光学系データを取得
        if (typeof window !== 'undefined' && window.getOpticalSystemRows) {
            const currentData = window.getOpticalSystemRows();
            // console.log('📊 Current optical system data:', currentData);
            return currentData;
        } else {
            // console.warn('⚠️ getOpticalSystemRows function not found on window object');
            return null;
        }
    } catch (error) {
    // console.error('❌ Error getting optical system data:', error);
        return null;
    }
}

// Source tableから波長情報を取得（Primary Wavelength対応）
function getWavelengthsFromSource(sourceRows) {
    if (!sourceRows || !Array.isArray(sourceRows) || sourceRows.length === 0) {
        // console.warn('⚠️ No source data available, using default wavelength');
        return {
            // Wavelengths are stored/used in micrometers (μm) across this project.
            wavelengths: [{ wavelength: 0.5876, name: 'Default d-line', isPrimary: true }],
            primaryWavelength: { wavelength: 0.5876, name: 'Default d-line', index: 0 }
        };
    }
    
    const wavelengths = [];
    let primaryWavelength = null;
    
    sourceRows.forEach((source, index) => {
        if (source && source.wavelength) {
            const wavelength = parseFloat(source.wavelength);
            if (!isNaN(wavelength) && wavelength > 0) {
                const isPrimary = source.primary === "Primary Wavelength";
                const wavelengthData = {
                    wavelength: wavelength,
                    name: source.name || `λ${index + 1}`,
                    index: index,
                    isPrimary: isPrimary
                };
                
                wavelengths.push(wavelengthData);
                
                // Primary Wavelengthが設定されている場合
                if (isPrimary) {
                    primaryWavelength = wavelengthData;
                    // console.log(`✅ Found Primary Wavelength: ${wavelength}nm at index ${index}`);
                }
            }
        }
    });
    
    if (wavelengths.length === 0) {
        // console.warn('⚠️ No valid wavelengths found in source data, using default');
        return {
            wavelengths: [{ wavelength: 0.5876, name: 'Default d-line', isPrimary: true }],
            primaryWavelength: { wavelength: 0.5876, name: 'Default d-line', index: 0 }
        };
    }
    
    // Primary Wavelengthが設定されていない場合は最初の波長を使用
    if (!primaryWavelength && wavelengths.length > 0) {
        primaryWavelength = { ...wavelengths[0], isPrimary: true };
        // console.log(`⚠️ No Primary Wavelength set, using first wavelength: ${primaryWavelength.wavelength}nm`);
    }
    
    // console.log(`📊 Found ${wavelengths.length} wavelengths, Primary: ${primaryWavelength.wavelength}nm`);
    
    return {
        wavelengths: wavelengths,
        primaryWavelength: primaryWavelength
    };
}

// 真の主光線を計算する関数（絞りの中心を通る光線）
function calculateTrueChiefRay(obj, opticalSystemRows, surfaceNumber, primaryWavelength) {
    try {
        // パラメータの検証
        if (!obj) {
    // console.error('❌ obj parameter is undefined');
            return null;
        }
        if (!opticalSystemRows) {
    // console.error('❌ opticalSystemRows parameter is undefined');
            return null;
        }
        if (!primaryWavelength) {
    // console.error('❌ primaryWavelength parameter is undefined');
            return null;
        }
        
    // console.log('🎯 calculateTrueChiefRay parameters:', {
    //         objId: obj.id || 'undefined',
    //         objX: obj.x || 0,
    //         objY: obj.y || 0,
    //         objXHeightAngle: obj.xHeightAngle || 'undefined',
    //         objYHeightAngle: obj.yHeightAngle || 'undefined',
    //         objPosition: obj.position || 'undefined',
    //         surfaceNumber: surfaceNumber,
    //         primaryWavelengthExists: !!primaryWavelength,
    //         primaryWavelengthValue: primaryWavelength ? primaryWavelength.wavelength : 'undefined'
    //     });
        
        // 絞り面を特定
        const apertureStopIndex = findStopSurfaceIndex(opticalSystemRows);
        if (apertureStopIndex === -1) {
    // console.warn('⚠️ 絞り面が見つかりません。従来の方法を使用します。');
            return null;
        }
        
    // console.log(`🎯 絞り面特定: インデックス ${apertureStopIndex}`);
        
        // Object 1 (Angle 0)の特別なケース: 軸上オブジェクトの場合
        // オブジェクトの種類に応じて軸上判定を行う
        let isOnAxis = false;
        let objectX = 0, objectY = 0;
        
        if (obj.position === "Point") {
            // Point objectの場合、座標で判定
            objectX = typeof obj.x === 'number' ? obj.x : 0;
            objectY = typeof obj.y === 'number' ? obj.y : 0;
            isOnAxis = (Math.abs(objectX) < 1e-10 && Math.abs(objectY) < 1e-10);
        } else if (obj.position === "Angle") {
            // Angle objectの場合、角度で判定（座標は常に光軸上とみなす）
            const angleX = typeof obj.xHeightAngle === 'number' ? obj.xHeightAngle : (typeof obj.xHeightAngle === 'string' ? parseFloat(obj.xHeightAngle) : 0);
            const angleY = typeof obj.yHeightAngle === 'number' ? obj.yHeightAngle : (typeof obj.yHeightAngle === 'string' ? parseFloat(obj.yHeightAngle) : 0);
            isOnAxis = (Math.abs(angleX) < 1e-10 && Math.abs(angleY) < 1e-10);
            objectX = 0; // Angle objectは光軸上から出射
            objectY = 0;
        }
        
    // console.log(`🔍 calculateTrueChiefRay 軸上判定: position=${obj.position}, isOnAxis=${isOnAxis}`, {
    //         objectX, objectY, xHeightAngle: obj.xHeightAngle, yHeightAngle: obj.yHeightAngle
    //     });
        
        if (isOnAxis) {
    // console.log(`📍 軸上オブジェクト検出: Object(${objectX}, ${objectY}, ${objectZ}) - 理論的主光線は光軸`);
            
            // 軸上オブジェクトの場合、主光線は光軸に沿って進む
            // 評価面での交点は(0, 0, 評価面Z座標)になるはず
            let evaluationZ = 0;
            for (let i = 0; i <= surfaceNumber && i < opticalSystemRows.length; i++) {
                if (i > 0) {
                    const prevSurface = opticalSystemRows[i - 1];
                    const thickness = parseFloat(prevSurface.thickness) || 0;
                    if (isFinite(thickness)) {
                        evaluationZ += thickness;
                    }
                }
            }
            
    // console.log(`✅ 軸上主光線: 評価面${surfaceNumber}での理論交点 (0, 0, ${evaluationZ})`);
            return {
                x: 0,
                y: 0,
                z: evaluationZ
            };
        }
        
        const objectZ = 0; // Object面のZ座標
        
        // 絞り面のZ座標を計算
        let apertureZ = 0;
        for (let i = 0; i <= apertureStopIndex; i++) {
            if (i > 0) {
                const prevSurface = opticalSystemRows[i - 1];
                const thickness = parseFloat(prevSurface.thickness) || 0;
                apertureZ += thickness;
            }
        }
        
        // Objectから絞り面中心への方向ベクトルを計算
        const dirX = 0 - objectX; // 絞り面中心は(0, 0, apertureZ)
        const dirY = 0 - objectY;
        const dirZ = apertureZ - objectZ;
        
        // 方向ベクトルを正規化
        const length = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
        const normalizedDir = {
            x: dirX / length,
            y: dirY / length,
            z: dirZ / length
        };
        
    // console.log(`📍 主光線計算: Object(${objectX}, ${objectY}, ${objectZ}) → 絞り面中心(0, 0, ${apertureZ})`);
    // console.log(`📐 方向ベクトル: (${normalizedDir.x.toFixed(6)}, ${normalizedDir.y.toFixed(6)}, ${normalizedDir.z.toFixed(6)})`);
        
        // 主光線をトレース
        const wavelengthValue = primaryWavelength && primaryWavelength.wavelength ? 
                       primaryWavelength.wavelength : 0.5876; // デフォルト波長 (μm)
        
        const chiefRayData = {
            startP: { x: objectX, y: objectY, z: objectZ },
            dir: normalizedDir,
            wavelength: wavelengthValue
        };
        
    // console.log('📊 Chief ray data:', chiefRayData);
        
        // 正しい引数順序でtraceRayを呼び出し
        const ray0 = {
            pos: chiefRayData.startP,
            dir: chiefRayData.dir,
            wavelength: wavelengthValue
        };
        
        const debugLog = [];
        const rayPath = traceRay(opticalSystemRows, ray0, 1.0, debugLog);
         // 面番号は0から始まる
        const targetSurfaceIndex = surfaceNumber;
        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        
    // console.log('📊 Ray path result:', {
    //         rayPathExists: !!rayPath,
    //         rayPathLength: rayPath ? rayPath.length : 'null',
    //         surfaceNumber: surfaceNumber,
    //         targetSurfaceIndex: targetSurfaceIndex,
    //         requiredLength: targetSurfaceIndex + 1
    //     });

        if (rayPath && Array.isArray(rayPath) && targetPointIndex !== null && rayPath.length > targetPointIndex) {
            const hitPoint = rayPath[targetPointIndex];
    // console.log('📊 Hit point:', {
    //             exists: !!hitPoint,
    //             type: typeof hitPoint,
    //             x: hitPoint ? hitPoint.x : 'undefined',
    //             y: hitPoint ? hitPoint.y : 'undefined',
    //             z: hitPoint ? hitPoint.z : 'undefined'
    //         });
            
            if (hitPoint && 
                hitPoint.x !== undefined && hitPoint.x !== null && 
                hitPoint.y !== undefined && hitPoint.y !== null &&
                typeof hitPoint.x === 'number' && typeof hitPoint.y === 'number') {
    // console.log(`✅ 主光線計算成功: 評価面での交点 (${hitPoint.x.toFixed(6)}, ${hitPoint.y.toFixed(6)})`);
                return {
                    x: hitPoint.x,
                    y: hitPoint.y,
                    z: (hitPoint.z !== undefined && hitPoint.z !== null) ? hitPoint.z : 0
                };
            } else {
    // console.warn('⚠️ 主光線の交点が無効:', { hitPoint, surfaceNumber, targetSurfaceIndex });
            }
        } else {
    // console.warn('⚠️ 主光線が評価面に到達しませんでした:', {
    //             rayPathLength: rayPath ? rayPath.length : 'null',
    //             surfaceNumber: surfaceNumber,
    //             targetSurfaceIndex: targetSurfaceIndex
    //         });
        }
        return null;
        
    } catch (error) {
    // console.error('❌ 主光線計算でエラーが発生:', error);
        return null;
    }
}

/**
 * Find surfaces that rays can reach by testing a sample ray
 * @param {Array} opticalSystemRows - Optical system data
 * @param {Array} objectRows - Object data
 * @returns {Array} Array of reachable surface numbers
 */
function findReachableSurfaces(opticalSystemRows, objectRows) {
    const reachableSurfaces = [];
    
    if (!opticalSystemRows || opticalSystemRows.length === 0 || !objectRows || objectRows.length === 0) {
        return reachableSurfaces;
    }
    
    try {
        // Use the first object for a simple “can we reach?” trace.
        const testObject = objectRows[0];
        const testRayStart = generateRayStartPointsForObject(testObject, opticalSystemRows, 1, null);
        if (!testRayStart || testRayStart.length === 0) return reachableSurfaces;

        const { startP, dir } = testRayStart[0];
        if (!startP || !dir) return reachableSurfaces;

        const opticalRowsCopy = __spot_cloneRowsPreserveSpecialNumbers(opticalSystemRows);
        const ray0 = { pos: startP, dir, wavelength: 0.5876 };
        const debugLog = [];
        const rayPath = traceRay(opticalRowsCopy, ray0, 1.0, debugLog);
        if (!rayPath || !Array.isArray(rayPath) || rayPath.length === 0) return reachableSurfaces;

        for (let pointIndex = 0; pointIndex < rayPath.length; pointIndex++) {
            const surfaceIndex = rayPathPointIndexToSurfaceIndex(opticalSystemRows, pointIndex);
            if (surfaceIndex === null) continue;
            reachableSurfaces.push(surfaceIndex + 1); // 1-based surface numbers
        }

        // De-dupe and sort.
        return Array.from(new Set(reachableSurfaces)).sort((a, b) => a - b);
    } catch (error) {
        console.warn('⚠️ Error in findReachableSurfaces:', error);
    }
    
    return reachableSurfaces;
}

