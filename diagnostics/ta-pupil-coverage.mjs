import fs from 'node:fs';

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
        setItem: (key, value) => { store.set(String(key), String(value)); },
        removeItem: (key) => { store.delete(String(key)); },
        clear: () => { store.clear(); }
    };
}

const { calculateTransverseAberration } = await import('../evaluation/aberrations/transverse-aberration.ts');

const config = JSON.parse(fs.readFileSync('defaults/default-load.json', 'utf8'));
const opticalRows = config.opticalSystem;
const objectRows = config.object;
const imageIndex = opticalRows.findIndex((row) => String(row?.['object type'] ?? row?.object ?? '') === 'Image');

function makeFieldSetting(objectRow) {
    const position = String(objectRow?.position ?? 'Angle');
    const isAngle = position.toLowerCase().includes('angle');
    const xAngle = Number(objectRow?.xHeightAngle ?? objectRow?.xFieldAngle ?? objectRow?.x ?? 0);
    const yAngle = Number(objectRow?.yHeightAngle ?? objectRow?.yFieldAngle ?? objectRow?.y ?? 0);
    const xHeight = Number(objectRow?.xHeight ?? objectRow?.x ?? 0);
    const yHeight = Number(objectRow?.yHeight ?? objectRow?.y ?? 0);
    return {
        displayName: String(objectRow?.displayName ?? `Object ${Number(objectRow?.id ?? 0) + 1}`),
        objectIndex: Number(objectRow?.id ?? 0) + 1,
        fieldType: position,
        position,
        xFieldAngle: xAngle,
        yFieldAngle: yAngle,
        xHeight,
        yHeight,
        x: isAngle ? xAngle : xHeight,
        y: isAngle ? yAngle : yHeight,
    };
}

function summarize(points = []) {
    const coords = points
        .map((point) => Number(point?.pupilCoordinate))
        .filter((value) => Number.isFinite(value));
    return {
        count: coords.length,
        full: points.filter((point) => point?.isPartial !== true).length,
        partial: points.filter((point) => point?.isPartial === true).length,
        neg: coords.filter((value) => value < -1e-6).length,
        zeroish: coords.filter((value) => Math.abs(value) <= 1e-6).length,
        pos: coords.filter((value) => value > 1e-6).length,
        min: coords.length > 0 ? Math.min(...coords) : null,
        max: coords.length > 0 ? Math.max(...coords) : null,
    };
}

for (const objectRow of objectRows.slice(0, 3)) {
    const result = calculateTransverseAberration(
        opticalRows,
        imageIndex,
        [makeFieldSetting(objectRow)],
        0.546,
        101
    );

    const meridionalPoints = result?.meridionalData?.[0]?.points ?? [];
    const sagittalPoints = result?.sagittalData?.[0]?.points ?? [];

    console.log(JSON.stringify({
        objectId: Number(objectRow?.id ?? 0) + 1,
        displayName: objectRow?.displayName ?? null,
        position: objectRow?.position ?? null,
        x: objectRow?.xHeightAngle ?? objectRow?.xHeight ?? objectRow?.x ?? null,
        y: objectRow?.yHeightAngle ?? objectRow?.yHeight ?? objectRow?.y ?? null,
        meridional: summarize(meridionalPoints),
        sagittal: summarize(sagittalPoints),
    }, null, 2));
}