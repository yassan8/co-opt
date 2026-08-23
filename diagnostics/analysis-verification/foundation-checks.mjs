const TEST_WAVELENGTH_UM = 0.5875618;

function installNodeBrowserShims() {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  if (typeof globalThis.self === 'undefined') globalThis.self = new EventTarget();
  if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
      setItem: (key, value) => store.set(String(key), String(value)),
      removeItem: (key) => store.delete(String(key)),
      clear: () => store.clear(),
    };
  }
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite: ${value}`);
  return Number(value);
}

function closeTo(actual, expected, options = {}) {
  const absTolerance = Number(options.absTolerance ?? 1e-9);
  const relTolerance = Number(options.relTolerance ?? 1e-9);
  const label = String(options.label ?? 'value');
  finite(actual, `${label}.actual`);
  finite(expected, `${label}.expected`);
  const delta = Math.abs(actual - expected);
  const allowed = Math.max(absTolerance, relTolerance * Math.max(Math.abs(actual), Math.abs(expected)));
  if (delta > allowed) {
    throw new Error(`${label}: expected ${expected}, got ${actual}, delta ${delta} > ${allowed}`);
  }
  return { actual, expected, delta, tolerance: allowed };
}

function pointCloseTo(actual, expected, options = {}) {
  if (!actual) throw new Error(`${options.label ?? 'point'} is null`);
  return {
    x: closeTo(Number(actual.x), Number(expected.x), { ...options, label: `${options.label ?? 'point'}.x` }),
    y: closeTo(Number(actual.y), Number(expected.y), { ...options, label: `${options.label ?? 'point'}.y` }),
    z: closeTo(Number(actual.z), Number(expected.z), { ...options, label: `${options.label ?? 'point'}.z` }),
  };
}

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

function baseSurface(overrides = {}) {
  return {
    id: 0,
    'object type': '',
    surfType: 'Spherical',
    radius: 'INF',
    thickness: 0,
    semidia: 100,
    material: 'AIR',
    rindex: '',
    abbe: '',
    conic: 0,
    ...overrides,
  };
}

async function record(checks, definition, run) {
  const startedAt = performance.now();
  try {
    const metrics = await run();
    checks.push({
      id: definition.id,
      title: definition.title,
      domain: definition.domain,
      reference: definition.reference,
      status: 'pass',
      durationMs: performance.now() - startedAt,
      metrics: metrics ?? null,
    });
  } catch (error) {
    checks.push({
      id: definition.id,
      title: definition.title,
      domain: definition.domain,
      reference: definition.reference,
      status: 'fail',
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runFoundationChecks() {
  installNodeBrowserShims();

  const rayTracing = await import('../../raytracing/core/ray-tracing.ts');
  const paraxial = await import('../../raytracing/core/ray-paraxial.ts');
  const checks = [];
  const jsIntersectionOptions = {
    disableWasmRayTracing: true,
    allowNonStrict: true,
    requireForwardHit: true,
  };

  await record(checks, {
    id: 'plane-intersection',
    title: 'Plane intersection agrees with the analytic line-plane solution',
    domain: 'intersection',
    reference: 'analytic',
  }, () => {
    const dir = normalize(1, -2, 10);
    const ray = { pos: { x: 0.5, y: -0.25, z: -12 }, dir };
    const t = -ray.pos.z / ray.dir.z;
    const expected = {
      x: ray.pos.x + t * ray.dir.x,
      y: ray.pos.y + t * ray.dir.y,
      z: 0,
    };
    const actual = rayTracing.intersectAsphericSurface(
      ray,
      { radius: Infinity, conic: 0, semidia: 100 },
      'even',
      30,
      1e-12,
      null,
      jsIntersectionOptions,
    );
    return pointCloseTo(actual, expected, { absTolerance: 1e-9, relTolerance: 1e-10, label: 'planeHitMm' });
  });

  await record(checks, {
    id: 'sphere-intersection',
    title: 'Spherical surface sag intersection agrees with sphere geometry',
    domain: 'intersection',
    reference: 'analytic',
  }, () => {
    const radius = 50;
    const x = 10;
    const expectedZ = radius - Math.sqrt(radius * radius - x * x);
    const ray = { pos: { x, y: 0, z: -20 }, dir: { x: 0, y: 0, z: 1 } };
    const actual = rayTracing.intersectAsphericSurface(
      ray,
      { radius, conic: 0, semidia: 20 },
      'even',
      30,
      1e-12,
      null,
      jsIntersectionOptions,
    );
    return pointCloseTo(actual, { x, y: 0, z: expectedZ }, { absTolerance: 2e-9, relTolerance: 1e-10, label: 'sphereHitMm' });
  });

  await record(checks, {
    id: 'paraboloid-intersection',
    title: 'Conic -1 surface agrees with the paraboloid sag equation',
    domain: 'intersection',
    reference: 'analytic',
  }, () => {
    const radius = 50;
    const x = 10;
    const expectedZ = (x * x) / (2 * radius);
    const ray = { pos: { x, y: 0, z: -20 }, dir: { x: 0, y: 0, z: 1 } };
    const actual = rayTracing.intersectAsphericSurface(
      ray,
      { radius, conic: -1, semidia: 20 },
      'even',
      30,
      1e-12,
      null,
      jsIntersectionOptions,
    );
    return pointCloseTo(actual, { x, y: 0, z: expectedZ }, { absTolerance: 2e-9, relTolerance: 1e-10, label: 'paraboloidHitMm' });
  });

  await record(checks, {
    id: 'forward-hit-policy',
    title: 'Sequential tracing rejects an intersection behind the ray',
    domain: 'intersection',
    reference: 'physical invariant',
  }, () => {
    const actual = rayTracing.intersectAsphericSurface(
      { pos: { x: 0, y: 0, z: 1 }, dir: { x: 0, y: 0, z: 1 } },
      { radius: Infinity, conic: 0, semidia: 20 },
      'even',
      30,
      1e-12,
      null,
      jsIntersectionOptions,
    );
    if (actual !== null) throw new Error(`expected no forward hit, got ${JSON.stringify(actual)}`);
    return { rejected: true };
  });

  await record(checks, {
    id: 'snell-plane-interface',
    title: 'Plane-interface ray path obeys Snell\'s law',
    domain: 'refraction',
    reference: 'analytic',
  }, () => {
    const incidentAngleDeg = 30;
    const incidentAngle = incidentAngleDeg * Math.PI / 180;
    const refractedAngle = Math.asin(Math.sin(incidentAngle) / 1.5);
    const rows = [
      baseSurface({ id: 0, 'object type': 'Object', thickness: 10 }),
      baseSurface({ id: 1, material: '', rindex: 1.5, thickness: 20 }),
      baseSurface({ id: 2, 'object type': 'Image', thickness: 0 }),
    ];
    const ray = {
      pos: { x: 0, y: 0, z: 0 },
      dir: { x: Math.sin(incidentAngle), y: 0, z: Math.cos(incidentAngle) },
      wavelength: TEST_WAVELENGTH_UM,
    };
    const path = rayTracing.traceRay(rows, ray, 1, null, null, {
      disableWasmRayTracing: true,
      allowNonStrict: true,
      requireForwardHit: true,
    });
    if (!Array.isArray(path) || path.length < 3) {
      throw new Error(`expected a 3-point ray path, got ${JSON.stringify(path)}`);
    }
    const interfacePoint = path[1];
    const imagePoint = path.at(-1);
    const expectedInterfaceX = 10 * Math.tan(incidentAngle);
    const expectedImageX = expectedInterfaceX + 20 * Math.tan(refractedAngle);
    return {
      interfaceX: closeTo(interfacePoint.x, expectedInterfaceX, { absTolerance: 2e-8, relTolerance: 1e-9, label: 'interfaceXmm' }),
      imageX: closeTo(imagePoint.x, expectedImageX, { absTolerance: 2e-8, relTolerance: 1e-9, label: 'imageXmm' }),
      refractedAngleDeg: refractedAngle * 180 / Math.PI,
    };
  });

  await record(checks, {
    id: 'coordinate-transform-roundtrip',
    title: 'Tilt/decenter surface coordinates round-trip without drift',
    domain: 'coordinate transform',
    reference: 'geometric invariant',
  }, () => {
    const rows = [
      baseSurface({ id: 0, 'object type': 'Object', thickness: 10 }),
      baseSurface({
        id: 1,
        'object type': 'Coord Trans',
        surfType: 'CoordTrans',
        decenterX: 2,
        decenterY: -3,
        decenterZ: 1,
        tiltX: 7,
        tiltY: -11,
        tiltZ: 19,
        order: 0,
        thickness: 0,
      }),
      baseSurface({ id: 2, 'object type': 'Stop', semidia: 4, thickness: 5 }),
      baseSurface({ id: 3, 'object type': 'Image', thickness: 0 }),
    ];
    const surfaceData = rayTracing.calculateSurfaceOrigins(rows);
    const coordInfo = surfaceData[1];
    pointCloseTo(coordInfo.origin, { x: 2, y: -3, z: 11 }, { absTolerance: 1e-10, relTolerance: 1e-10, label: 'coordOriginMm' });
    const localPoint = { x: 1.25, y: -0.75, z: 4.5 };
    const globalPoint = rayTracing.transformPointToGlobal(localPoint, coordInfo, false);
    const restored = rayTracing.transformPointToLocal(globalPoint, coordInfo);
    return {
      origin: coordInfo.origin,
      roundTrip: pointCloseTo(restored, localPoint, { absTolerance: 2e-12, relTolerance: 1e-12, label: 'restoredLocalMm' }),
    };
  });

  await record(checks, {
    id: 'stop-pupil-identity',
    title: 'A stop without surrounding optics is its own entrance and exit pupil',
    domain: 'stop and pupil',
    reference: 'analytic',
  }, () => {
    const rows = [
      baseSurface({ id: 0, 'object type': 'Object', thickness: 'INF' }),
      baseSurface({ id: 1, 'object type': 'Stop', semidia: 4, thickness: 20 }),
      baseSurface({ id: 2, 'object type': 'Image', thickness: 0 }),
    ];
    const result = paraxial.calculatePupilsByNewSpec(rows, TEST_WAVELENGTH_UM);
    if (!result?.isValid) throw new Error(`invalid pupil result: ${JSON.stringify(result)}`);
    if (result.stopIndex !== 1) throw new Error(`expected stop index 1, got ${result.stopIndex}`);
    return {
      entranceDiameterMm: closeTo(result.entrancePupil.diameter, 8, { absTolerance: 1e-12, relTolerance: 1e-12, label: 'entrancePupilDiameterMm' }),
      exitDiameterMm: closeTo(result.exitPupil.diameter, 8, { absTolerance: 1e-12, relTolerance: 1e-12, label: 'exitPupilDiameterMm' }),
      entrancePositionMm: closeTo(result.entrancePupil.position, 0, { absTolerance: 1e-12, relTolerance: 0, label: 'entrancePupilPositionMm' }),
      exitPositionMm: closeTo(result.exitPupil.position, 0, { absTolerance: 1e-12, relTolerance: 0, label: 'exitPupilPositionMm' }),
    };
  });

  await record(checks, {
    id: 'field-angle-projection',
    title: 'Positive and negative field angles project with the documented sign',
    domain: 'field convention',
    reference: 'analytic',
  }, () => {
    const distanceMm = 100;
    const angleDeg = 10;
    const angle = angleDeg * Math.PI / 180;
    const rows = [
      baseSurface({ id: 0, 'object type': 'Object', thickness: distanceMm }),
      baseSurface({ id: 1, 'object type': 'Image', thickness: 0 }),
    ];
    const trace = (sign) => rayTracing.traceRayHitPoint(rows, {
      pos: { x: 0, y: 0, z: 0 },
      dir: { x: sign * Math.sin(angle), y: 0, z: Math.cos(angle) },
      wavelength: TEST_WAVELENGTH_UM,
    }, 1, 1, {
      disableWasmRayTracing: true,
      allowNonStrict: true,
      requireForwardHit: true,
    });
    const positive = trace(1);
    const negative = trace(-1);
    const expectedMagnitude = distanceMm * Math.tan(angle);
    if (!positive || !negative) throw new Error('field projection ray did not reach the image plane');
    return {
      positiveXmm: closeTo(positive.x, expectedMagnitude, { absTolerance: 2e-8, relTolerance: 1e-9, label: 'positiveFieldXmm' }),
      negativeXmm: closeTo(negative.x, -expectedMagnitude, { absTolerance: 2e-8, relTolerance: 1e-9, label: 'negativeFieldXmm' }),
      symmetryMm: closeTo(positive.x + negative.x, 0, { absTolerance: 2e-10, relTolerance: 0, label: 'fieldSymmetryMm' }),
    };
  });

  await record(checks, {
    id: 'wavelength-dispersion',
    title: 'N-BK7 d-line index and normal dispersion agree with catalog physics',
    domain: 'wavelength and glass',
    reference: 'catalog invariant',
  }, () => {
    const glass = { material: 'N-BK7' };
    const nF = paraxial.getRefractiveIndex(glass, 0.4861327);
    const nd = paraxial.getRefractiveIndex(glass, TEST_WAVELENGTH_UM);
    const nC = paraxial.getRefractiveIndex(glass, 0.6562725);
    closeTo(nd, 1.5168, { absTolerance: 8e-5, relTolerance: 0, label: 'N-BK7 nd' });
    if (!(nF > nd && nd > nC)) {
      throw new Error(`expected normal dispersion nF > nd > nC, got ${nF}, ${nd}, ${nC}`);
    }
    return { nF, nd, nC, ordering: 'nF > nd > nC' };
  });

  await record(checks, {
    id: 'thin-lens-power',
    title: 'Paraxial focal length agrees with reciprocal thin-lens power',
    domain: 'paraxial',
    reference: 'analytic',
  }, () => {
    const powerPerMm = 0.02;
    const rows = [
      baseSurface({ id: 0, 'object type': 'Object', thickness: 'INF' }),
      baseSurface({ id: 1, __cooptCombinedPower: powerPerMm, thickness: 0 }),
      baseSurface({ id: 2, 'object type': 'Image', thickness: 0 }),
    ];
    const focalLength = paraxial.calculateFocalLength(rows, TEST_WAVELENGTH_UM);
    return {
      focalLengthMm: closeTo(focalLength, 1 / powerPerMm, { absTolerance: 1e-10, relTolerance: 1e-12, label: 'thinLensFocalLengthMm' }),
      powerPerMm,
    };
  });

  return checks;
}
