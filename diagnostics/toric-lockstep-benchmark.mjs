if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => { store.clear(); }
  };
}

const {
  traceRayHitPointBatch,
  enableRayTracingProfiler,
  getRayTracingProfile
} = await import('../raytracing/core/ray-tracing.ts');

const rayGrid = Number.isFinite(Number(process.env.TORIC_RAY_GRID)) ? Math.max(5, Number(process.env.TORIC_RAY_GRID)) : 81;
const runs = Number.isFinite(Number(process.env.TORIC_RUNS)) ? Math.max(1, Number(process.env.TORIC_RUNS)) : 5;
const pupilRadiusMm = Number.isFinite(Number(process.env.TORIC_PUPIL_RADIUS_MM)) ? Number(process.env.TORIC_PUPIL_RADIUS_MM) : 8;

const toricRows = [
  {
    id: 1,
    'object type': 'Object',
    object: 'Object',
    surfType: 'Object',
    radius: 'INF',
    thickness: 'INF',
    semidia: 25,
    material: 'AIR'
  },
  {
    id: 2,
    'object type': 'Standard',
    object: 'Surface 2',
    surfType: 'Toric',
    radius: 55,
    radiusX: 45,
    radiusY: 70,
    conic: 0,
    axis: 0,
    thickness: 5,
    semidia: 15,
    material: 'BK7'
  },
  {
    id: 3,
    'object type': 'Image',
    object: 'Image',
    surfType: 'Standard',
    radius: 'INF',
    thickness: 0,
    semidia: 20,
    material: 'AIR'
  }
];

function buildRays(grid, radius) {
  const rays = [];
  for (let j = 0; j < grid; j++) {
    const y = -radius + (2 * radius * j) / (grid - 1);
    for (let i = 0; i < grid; i++) {
      const x = -radius + (2 * radius * i) / (grid - 1);
      if ((x * x + y * y) > radius * radius) continue;
      rays.push({
        pos: { x, y, z: -120 },
        dir: { x: 0, y: 0, z: 1 },
        wavelength: 0.5876
      });
    }
  }
  return rays;
}

const rays = buildRays(rayGrid, pupilRadiusMm);

const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

async function bench(mode) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    enableRayTracingProfiler(true, true);
    const t0 = now();
    const out = traceRayHitPointBatch(
      toricRows,
      rays,
      1.0,
      1,
      mode === 'scalar' ? { disableLockstep: true } : null
    );
    const t1 = now();
    const stats = getRayTracingProfile({ reset: true });
    const valid = out.filter(Boolean).length;
    samples.push({
      ms: t1 - t0,
      valid,
      lockstepCalls: Number(stats.traceBatchLockstepCalls || 0),
      fallbackCalls: Number(stats.traceBatchFallbackCalls || 0),
      traceTime: Number(stats.traceTime || 0),
      applyMatTime: Number(stats.applyMatTime || 0),
      transformRayToLocalTime: Number(stats.transformRayToLocalTime || 0)
    });
  }

  const avg = (arr, key) => arr.reduce((a, b) => a + Number(b[key] || 0), 0) / Math.max(1, arr.length);
  const mins = Math.min(...samples.map(s => s.ms));
  const maxs = Math.max(...samples.map(s => s.ms));
  return {
    mode,
    runs,
    rays: rays.length,
    avgMs: avg(samples, 'ms'),
    minMs: mins,
    maxMs: maxs,
    avgTraceTimeMs: avg(samples, 'traceTime'),
    avgLockstepCalls: avg(samples, 'lockstepCalls'),
    avgFallbackCalls: avg(samples, 'fallbackCalls'),
    avgValidHits: avg(samples, 'valid'),
    samples
  };
}

console.log('▶ Toric lockstep benchmark start', { rayGrid, runs, pupilRadiusMm, rays: rays.length });

const lockstep = await bench('lockstep');
const scalar = await bench('scalar');

const deltaMs = lockstep.avgMs - scalar.avgMs;
const speedupPct = (1 - (lockstep.avgMs / Math.max(1e-9, scalar.avgMs))) * 100;

const summary = {
  rayGrid,
  runs,
  rays: rays.length,
  lockstep: {
    avgMs: lockstep.avgMs,
    minMs: lockstep.minMs,
    maxMs: lockstep.maxMs,
    avgTraceTimeMs: lockstep.avgTraceTimeMs,
    avgLockstepCalls: lockstep.avgLockstepCalls,
    avgFallbackCalls: lockstep.avgFallbackCalls,
    avgValidHits: lockstep.avgValidHits
  },
  scalar: {
    avgMs: scalar.avgMs,
    minMs: scalar.minMs,
    maxMs: scalar.maxMs,
    avgTraceTimeMs: scalar.avgTraceTimeMs,
    avgLockstepCalls: scalar.avgLockstepCalls,
    avgFallbackCalls: scalar.avgFallbackCalls,
    avgValidHits: scalar.avgValidHits
  },
  deltaMs,
  speedupPct,
  samples: {
    lockstep: lockstep.samples,
    scalar: scalar.samples
  }
};

console.log('✅ Toric lockstep benchmark summary');
console.log(JSON.stringify(summary, null, 2));
