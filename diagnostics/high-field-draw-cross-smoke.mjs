import fs from 'node:fs';

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.localStorage) {
    const values = new Map();
    globalThis.localStorage = {
        getItem: (key) => values.get(String(key)) ?? null,
        setItem: (key, value) => values.set(String(key), String(value)),
        removeItem: (key) => values.delete(String(key)),
        clear: () => values.clear()
    };
}

const { buildAstigmatismLikeDrawCrossRays } = await import('../evaluation/aberrations/astigmatism.ts');
const { traceRayHitPoint } = await import('../raytracing/core/ray-tracing.ts');

const filePath = 'Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json';
const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const opticalRows = config.opticalSystem;
const baseObjects = config.object;
const wavelength = Number(config.source.find((row) => row.primary === 'Primary Wavelength')?.wavelength) || 0.5875618;
const targetSurfaceIndex = opticalRows.findIndex((row) => String(row?.['object type'] ?? '').trim().toLowerCase() === 'image');

if (targetSurfaceIndex < 0) throw new Error('Image surface not found');

function summarize(angle, objectRows) {
    const rays = buildAstigmatismLikeDrawCrossRays(
        opticalRows,
        objectRows,
        wavelength,
        targetSurfaceIndex,
        51
    );
    const fieldRays = rays.filter((ray) => Number(ray.objectAngle?.y) === angle);
    const successful = fieldRays.filter((ray) => ray.success);
    const immediateHits = fieldRays.filter((ray) => ray.targetHit);
    const imageHits = fieldRays.filter((ray) => traceRayHitPoint(
        opticalRows,
        {
            pos: ray.originalRay.pos,
            dir: ray.originalRay.dir,
            wavelength
        },
        1,
        targetSurfaceIndex,
        {
            useRustWasm: true,
            requireRustWasm: true,
            allowNonStrict: true,
            requireForwardHit: false
        }
    ));
    const pathLengths = successful.map((ray) => ray.rayPath.length);
    console.log(
        `${angle} deg: generated=${fieldRays.length}, visible=${successful.length}, ` +
        `selectedHits=${fieldRays[0]?.generationTargetHitCount ?? 0}, ` +
        `immediateHits=${immediateHits.length}, imageHits=${imageHits.length}, ` +
        `pathPoints=${pathLengths.length > 0 ? `${Math.min(...pathLengths)}..${Math.max(...pathLengths)}` : 'none'}`
    );
    if (angle === 43 && successful[0]) {
        console.log('43 deg sample path:', successful[0].rayPath);
    }
    return { successful: successful.length, imageHits: imageHits.length };
}

for (const angle of [23, 26, 32]) {
    const objectRows = baseObjects.slice(0, 2).map((row) => ({ ...row }));
    objectRows[1] = { ...objectRows[1], xHeightAngle: 0, yHeightAngle: angle, angle };
    summarize(angle, objectRows);
}

const full43 = summarize(43, baseObjects);
if (full43.imageHits === 0) {
    throw new Error('No Draw Cross rays reach the image surface at 43 degrees');
}