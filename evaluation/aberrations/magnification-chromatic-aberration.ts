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

function traceChiefRayImageHeight(opticalSystemRows, fieldSetting, wavelength, imageSurfaceInfo, mirrorSign) {
    try {
        const chief = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength, 'unified', { rayCount: 11 });
        if (!chief?.success || !chief?.ray?.path?.length) return null;

        const lastPointGlobal = chief.ray.path[chief.ray.path.length - 1];
        let lastPoint = lastPointGlobal;
        if (imageSurfaceInfo?.rotationMatrix) {
            const origin = imageSurfaceInfo.origin || { x: 0, y: 0, z: 0 };
            const relative = {
                x: lastPointGlobal.x - origin.x,
                y: lastPointGlobal.y - origin.y,
                z: lastPointGlobal.z - origin.z
            };
            lastPoint = applyRotationMatrixToVector(imageSurfaceInfo.rotationMatrix, relative);
        }

        return lastPoint.y * mirrorSign;
    } catch (error) {
        console.warn('⚠️ Failed to trace chief ray for lateral color:', error);
        return null;
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

    return {
        fieldValues: sortedFieldValues,
        heightMode,
        referenceWavelength,
        imageSurfaceIndex,
        dataByWavelength
    };
}
