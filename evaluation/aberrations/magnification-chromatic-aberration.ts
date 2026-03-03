import { calculateChiefRayNewton } from './transverse-aberration.ts';
import { calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.ts';

function isMirrorRow(row) {
    if (!row) return false;
    if (row.material === 'MIRROR') return true;
    if (row.type === 'Mirror') return true;
    if (row._blockType === 'Mirror') return true;
    const surfType = String(row.surfType ?? row.type ?? row.surfaceType ?? '').trim().toLowerCase();
    return surfType === 'mirror';
}

function applyRotationMatrixToVector(matrix, v) {
    if (!matrix) return { x: v.x, y: v.y, z: v.z };
    const x = matrix[0][0] * v.x + matrix[0][1] * v.y + matrix[0][2] * v.z;
    const y = matrix[1][0] * v.x + matrix[1][1] * v.y + matrix[1][2] * v.z;
    const z = matrix[2][0] * v.x + matrix[2][1] * v.y + matrix[2][2] * v.z;
    return { x, y, z };
}

function findImageSurfaceIndex(opticalSystemRows) {
    if (!Array.isArray(opticalSystemRows)) return -1;
    for (let i = opticalSystemRows.length - 1; i >= 0; i--) {
        const row = opticalSystemRows[i];
        const surfType = String(row?.surfType ?? row?.type ?? '').toLowerCase();
        if (surfType === 'image') return i;
    }
    return opticalSystemRows.length - 1;
}

function normalizeRowTag(value) {
    return (value ?? '').toString().trim().toLowerCase();
}

function compactRowTag(value) {
    return normalizeRowTag(value).replace(/[^a-z0-9]/g, '');
}

function isObjectRow(row) {
    if (!row) return false;
    const surfType = normalizeRowTag(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const surfTypeCompact = compactRowTag(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const blockType = normalizeRowTag(row?._blockType ?? row?.blockType ?? '');
    const blockTypeCompact = compactRowTag(row?._blockType ?? row?.blockType ?? '');
    const kind = normalizeRowTag(row?.kind ?? '');
    return (
        surfType === 'object' || surfTypeCompact === 'object' ||
        blockType === 'object' || blockTypeCompact === 'object' ||
        kind === 'object'
    );
}

function isCoordTransRow(row) {
    if (!row) return false;
    const surfType = normalizeRowTag(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const surfTypeCompact = compactRowTag(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const blockType = normalizeRowTag(row?._blockType ?? row?.blockType ?? '');
    const blockTypeCompact = compactRowTag(row?._blockType ?? row?.blockType ?? '');
    return (
        surfType === 'coordtrans' || surfType === 'coordinate break' || surfType === 'coordinatebreak' ||
        surfTypeCompact === 'coordtrans' || surfTypeCompact === 'coordinatebreak' ||
        blockType === 'coordtrans' || blockType === 'coordinate break' || blockType === 'coordinatebreak' ||
        blockTypeCompact === 'coordtrans' || blockTypeCompact === 'coordinatebreak'
    );
}

function isGapRow(row) {
    if (!row) return false;
    const surfType = normalizeRowTag(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const surfTypeCompact = compactRowTag(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const blockType = normalizeRowTag(row?._blockType ?? row?.blockType ?? '');
    const blockTypeCompact = compactRowTag(row?._blockType ?? row?.blockType ?? '');
    const kind = normalizeRowTag(row?.kind ?? '');
    const kindCompact = compactRowTag(row?.kind ?? '');
    return (
        surfType === 'gap' || surfType === 'air gap' || surfTypeCompact === 'gap' || surfTypeCompact === 'airgap' ||
        blockType === 'gap' || blockType === 'air gap' || blockTypeCompact === 'gap' || blockTypeCompact === 'airgap' ||
        kind === 'gap' || kind === 'air gap' || kindCompact === 'gap' || kindCompact === 'airgap'
    );
}

function surfaceIndexToRayPathPointIndex(opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const sIdx = Math.max(0, Math.min(surfaceIndex, opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (isCoordTransRow(row)) continue;
        if (isObjectRow(row)) continue;
        if (isGapRow(row)) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function traceChiefRayImageHeight(opticalSystemRows, fieldSetting, wavelength, imageSurfaceInfo, imageSurfaceIndex, mirrorSign) {
    try {
        const chief = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength, 'unified', {
            rayCount: 101,
            chiefRayDefinition: 'stop-center',
            targetSurfaceIndex: imageSurfaceIndex
        });
        const rayPath = chief?.ray?.rayPathToTarget || chief?.ray?.path;
        if (!chief?.success || !Array.isArray(rayPath) || rayPath.length === 0) return null;

        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, imageSurfaceIndex);
        if (!(targetPointIndex !== null && targetPointIndex >= 0 && targetPointIndex < rayPath.length)) {
            return null;
        }
        const pointIndex = targetPointIndex;

        const pointGlobal = rayPath[pointIndex];
        if (!pointGlobal || !Number.isFinite(pointGlobal.x) || !Number.isFinite(pointGlobal.y) || !Number.isFinite(pointGlobal.z)) {
            return null;
        }

        let pointLocal = pointGlobal;
        if (imageSurfaceInfo?.rotationMatrix) {
            const origin = imageSurfaceInfo.origin || { x: 0, y: 0, z: 0 };
            const relative = {
                x: pointGlobal.x - origin.x,
                y: pointGlobal.y - origin.y,
                z: pointGlobal.z - origin.z
            };
            pointLocal = applyRotationMatrixToVector(imageSurfaceInfo.rotationMatrix, relative);
        }

        return pointLocal.y * mirrorSign;
    } catch (error) {
        console.warn('⚠️ Failed to trace chief ray for lateral color:', error);
        return null;
    }
}

function buildNaturalCubicSpline(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;

    const h = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
        h[i] = xs[i + 1] - xs[i];
        if (!(h[i] > 0)) return null;
    }

    const alpha = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
        alpha[i] = (3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]);
    }

    const l = new Array(n).fill(0);
    const mu = new Array(n).fill(0);
    const z = new Array(n).fill(0);
    const c = new Array(n).fill(0);
    const b = new Array(n - 1).fill(0);
    const d = new Array(n - 1).fill(0);

    l[0] = 1;
    for (let i = 1; i < n - 1; i++) {
        l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
        if (Math.abs(l[i]) < 1e-15) return null;
        mu[i] = h[i] / l[i];
        z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
    }
    l[n - 1] = 1;

    for (let j = n - 2; j >= 0; j--) {
        c[j] = z[j] - mu[j] * c[j + 1];
        b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
        d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }

    const evaluate = (xq) => {
        if (!Number.isFinite(xq)) return null;
        if (xq < xs[0] || xq > xs[n - 1]) return null;

        let i = n - 2;
        for (let k = 0; k < n - 1; k++) {
            if (xq >= xs[k] && xq <= xs[k + 1]) {
                i = k;
                break;
            }
        }

        const dx = xq - xs[i];
        return ys[i] + b[i] * dx + c[i] * dx * dx + d[i] * dx * dx * dx;
    };

    return { evaluate };
}

function fillMissingWithSpline(fieldValues, displacements) {
    const y = Array.isArray(fieldValues) ? fieldValues : [];
    const x = Array.isArray(displacements) ? displacements.slice() : [];
    if (y.length === 0 || x.length !== y.length) return x;

    const knownIndices = [];
    for (let i = 0; i < x.length; i++) {
        if (Number.isFinite(Number(x[i])) && Number.isFinite(Number(y[i]))) knownIndices.push(i);
    }
    if (knownIndices.length < 2) return x;

    const firstKnown = knownIndices[0];
    const lastKnown = knownIndices[knownIndices.length - 1];

    const xs = [];
    const ys = [];
    let lastXVal = null;
    for (const idx of knownIndices) {
        const xv = Number(y[idx]);
        const yv = Number(x[idx]);
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        if (lastXVal !== null && Math.abs(xv - lastXVal) < 1e-12) continue;
        xs.push(xv);
        ys.push(yv);
        lastXVal = xv;
    }

    if (xs.length < 2) return x;

    let evalAt = null;
    if (xs.length === 2) {
        const dx = xs[1] - xs[0];
        if (!(Math.abs(dx) > 1e-15)) return x;
        const m = (ys[1] - ys[0]) / dx;
        evalAt = (xq) => ys[0] + m * (xq - xs[0]);
    } else {
        const spline = buildNaturalCubicSpline(xs, ys);
        if (!spline) return x;
        evalAt = spline.evaluate;
    }

    for (let i = firstKnown; i <= lastKnown; i++) {
        if (Number.isFinite(Number(x[i]))) continue;
        const yi = Number(y[i]);
        if (!Number.isFinite(yi)) continue;
        const interpolated = evalAt(yi);
        if (Number.isFinite(interpolated)) x[i] = interpolated;
    }

    return x;
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
    if (!Array.isArray(wavelengths) || wavelengths.length === 0) {
        console.error('❌ magnification chromatic aberration: wavelengths empty');
        return null;
    }

    const referenceWavelength = Number.isFinite(Number(options.referenceWavelength))
        ? Number(options.referenceWavelength)
        : 0.5876;
    const heightMode = !!options.heightMode;
    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    const sortedFieldValues = fieldValues.slice().map(v => Number(v)).filter(v => Number.isFinite(v));
    sortedFieldValues.sort((a, b) => a - b);

    const mirrorCount = opticalSystemRows.filter(isMirrorRow).length;
    const mirrorSign = (mirrorCount % 2 === 1) ? -1 : 1;

    const imageSurfaceIndex = findImageSurfaceIndex(opticalSystemRows);
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const imageSurfaceInfo = surfaceOrigins?.[imageSurfaceIndex] || null;

    const makeFieldSetting = (value) => {
        if (heightMode) {
            return { fieldType: 'Height', xHeight: 0, yHeight: value, displayName: `h=${value}mm` };
        }
        return { fieldType: 'Angle', x: 0, y: value, displayName: `θ=${value}°` };
    };

    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    let lastYield = now();
    const maybeYield = async () => {
        const t = now();
        if (t - lastYield >= 16) {
            await new Promise(r => setTimeout(r, 0));
            lastYield = now();
        }
    };

    const referenceHeights = [];
    for (let i = 0; i < sortedFieldValues.length; i++) {
        const fieldValue = sortedFieldValues[i];
        const fieldSetting = makeFieldSetting(fieldValue);
        const height = traceChiefRayImageHeight(
            opticalSystemRows,
            fieldSetting,
            referenceWavelength,
            imageSurfaceInfo,
            imageSurfaceIndex,
            mirrorSign
        );
        referenceHeights.push(height);
        await maybeYield();
    }

    const dataByWavelength = [];
    for (let wIndex = 0; wIndex < wavelengths.length; wIndex++) {
        const wavelength = wavelengths[wIndex];
        if (onProgress) {
            try {
                const percent = Math.round((wIndex / Math.max(1, wavelengths.length)) * 100);
                onProgress({ percent, message: `λ=${Number(wavelength).toFixed(4)} μm` });
            } catch (_) {}
        }
        await maybeYield();
        const displacements = [];
        const imageHeights = [];

        for (let i = 0; i < sortedFieldValues.length; i++) {
            const fieldValue = sortedFieldValues[i];
            const fieldSetting = makeFieldSetting(fieldValue);
            const height = traceChiefRayImageHeight(
                opticalSystemRows,
                fieldSetting,
                wavelength,
                imageSurfaceInfo,
                imageSurfaceIndex,
                mirrorSign
            );
            const refHeight = referenceHeights[i];
            const displacement = (Number.isFinite(height) && Number.isFinite(refHeight))
                ? (height - refHeight)
                : null;

            imageHeights.push(height);
            displacements.push(displacement);
            await maybeYield();
        }

        dataByWavelength.push({ wavelength, displacements, imageHeights });
        if (onProgress) {
            try {
                const percent = Math.round(((wIndex + 1) / wavelengths.length) * 100);
                onProgress({ percent, message: `λ=${Number(wavelength).toFixed(4)} μm` });
            } catch (_) {}
        }
        await maybeYield();
    }

    const interpolatedDataByWavelength = dataByWavelength.map((entry) => ({
        ...entry,
        displacements: fillMissingWithSpline(sortedFieldValues, entry?.displacements)
    }));

    return {
        fieldValues: sortedFieldValues,
        heightMode,
        referenceWavelength,
        imageSurfaceIndex,
        dataByWavelength: interpolatedDataByWavelength
    };
}
