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

    try {
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
    } catch (error) {
        console.error('❌ Native LCA failed:', error);
        return null;
    }
}
