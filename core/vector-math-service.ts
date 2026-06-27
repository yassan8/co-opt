type Vec3 = { x: number; y: number; z: number };

type DotProductFn = (a: Vec3, b: Vec3) => number;
type CrossProductFn = (a: Vec3, b: Vec3) => Vec3;
type NormalizeFn = (v: Vec3) => Vec3;

const fallbackDotProduct: DotProductFn = (a, b) => (a?.x || 0) * (b?.x || 0) + (a?.y || 0) * (b?.y || 0) + (a?.z || 0) * (b?.z || 0);
const fallbackCrossProduct: CrossProductFn = (a, b) => ({
  x: (a?.y || 0) * (b?.z || 0) - (a?.z || 0) * (b?.y || 0),
  y: (a?.z || 0) * (b?.x || 0) - (a?.x || 0) * (b?.z || 0),
  z: (a?.x || 0) * (b?.y || 0) - (a?.y || 0) * (b?.x || 0)
});
const fallbackNormalize: NormalizeFn = (v) => {
  const x = v?.x || 0;
  const y = v?.y || 0;
  const z = v?.z || 0;
  const len = Math.sqrt(x * x + y * y + z * z);
  return len === 0 ? { x: 0, y: 0, z: 0 } : { x: x / len, y: y / len, z: z / len };
};

let dotProductImpl: DotProductFn = fallbackDotProduct;
let crossProductImpl: CrossProductFn = fallbackCrossProduct;
let normalizeImpl: NormalizeFn = fallbackNormalize;

export function getDotProductImplementation(): DotProductFn {
  return dotProductImpl;
}
export function setDotProductImplementation(fn: DotProductFn | null | undefined): void {
  if (typeof fn === 'function') dotProductImpl = fn;
}

export function getCrossProductImplementation(): CrossProductFn {
  return crossProductImpl;
}
export function setCrossProductImplementation(fn: CrossProductFn | null | undefined): void {
  if (typeof fn === 'function') crossProductImpl = fn;
}

export function getNormalizeImplementation(): NormalizeFn {
  return normalizeImpl;
}
export function setNormalizeImplementation(fn: NormalizeFn | null | undefined): void {
  if (typeof fn === 'function') normalizeImpl = fn;
}

export function installVectorMathGlobals(target: any = globalThis): void {
  try {
    if (!target) return;
    if (target.__cooptVectorMathServiceInstalled) return;
    target.__cooptVectorMathServiceInstalled = true;

    const dotFacade: DotProductFn = (a, b) => dotProductImpl(a, b);
    const crossFacade: CrossProductFn = (a, b) => crossProductImpl(a, b);
    const normalizeFacade: NormalizeFn = (v) => normalizeImpl(v);

    if (typeof window !== 'undefined') {
      if (typeof window['dotProduct'] === 'function') dotProductImpl = window['dotProduct'];
      if (typeof window['crossProduct'] === 'function') crossProductImpl = window['crossProduct'];
      if (typeof window['normalize'] === 'function') normalizeImpl = window['normalize'];

      window['dotProduct'] = dotFacade as any;
      window['crossProduct'] = crossFacade as any;
      window['normalize'] = normalizeFacade as any;
    }

    if (typeof target.dotProduct !== 'function') target.dotProduct = dotFacade;
    if (typeof target.crossProduct !== 'function') target.crossProduct = crossFacade;
    if (typeof target.normalize !== 'function') target.normalize = normalizeFacade;
  } catch (_) {
    // ignore
  }
}

installVectorMathGlobals();
