export interface AdaptiveSqpDampingState {
  damping: number;
  rejectMultiplier: number;
}

export interface AdaptiveSqpDampingUpdate {
  accepted: boolean;
  gainRatio: number;
  hessianScale: number;
  tau?: number;
  minRelativeDamping?: number;
  maxRelativeDamping?: number;
  rejectGrowthFactor?: number;
}

export function shouldRollbackRejectedSqpState(
  current: number[] | null | undefined,
  best: number[] | null | undefined,
  scales: number[] | null | undefined,
): boolean {
  if (!Array.isArray(current) || !Array.isArray(best) || current.length !== best.length) return false;
  let normalizedDistanceSquared = 0;
  for (let index = 0; index < current.length; index++) {
    const currentValue = Number(current[index]);
    const bestValue = Number(best[index]);
    if (!Number.isFinite(currentValue) || !Number.isFinite(bestValue)) return false;
    const scaleValue = Number(scales?.[index]);
    const scale = Number.isFinite(scaleValue) && Math.abs(scaleValue) > 0
      ? Math.abs(scaleValue)
      : Math.max(1, Math.abs(currentValue), Math.abs(bestValue));
    const normalizedDelta = (currentValue - bestValue) / scale;
    normalizedDistanceSquared += normalizedDelta * normalizedDelta;
  }
  const tolerance = Math.sqrt(Number.EPSILON) * Math.sqrt(Math.max(1, current.length));
  return Math.sqrt(normalizedDistanceSquared) > tolerance;
}

export function sqpHessianDiagonalScale(hessian: number[][] | null | undefined): number {
  if (!Array.isArray(hessian) || hessian.length === 0) return 1;
  let scale = 0;
  for (let index = 0; index < hessian.length; index++) {
    const diagonal = Math.abs(Number(hessian[index]?.[index]));
    if (Number.isFinite(diagonal)) scale = Math.max(scale, diagonal);
  }
  return Math.max(1e-12, scale);
}

export function initializeAdaptiveSqpDamping(
  currentDampingInput: unknown,
  hessianScaleInput: unknown,
  tauInput: unknown = 1e-3,
): AdaptiveSqpDampingState {
  const hessianScale = Math.max(1e-12, Number(hessianScaleInput) || 1);
  const tau = Math.max(1e-12, Number(tauInput) || 1e-3);
  const currentDamping = Math.max(0, Number(currentDampingInput) || 0);
  return {
    damping: Math.max(currentDamping, tau * hessianScale),
    rejectMultiplier: 2,
  };
}

export function updateAdaptiveSqpDamping(
  state: AdaptiveSqpDampingState,
  update: AdaptiveSqpDampingUpdate,
): AdaptiveSqpDampingState {
  const hessianScale = Math.max(1e-12, Number(update.hessianScale) || 1);
  const minRelative = Math.max(1e-15, Number(update.minRelativeDamping) || 1e-12);
  const requestedMaxRelative = Number(update.maxRelativeDamping);
  const maxRelative = Math.max(
    minRelative,
    Number.isFinite(requestedMaxRelative) && requestedMaxRelative > 0 ? requestedMaxRelative : 0.1,
  );
  const minimum = minRelative * hessianScale;
  const maximum = maxRelative * hessianScale;
  const damping = Math.max(minimum, Math.min(maximum, Number(state.damping) || minimum));
  const rejectMultiplier = Math.max(2, Math.min(1e6, Number(state.rejectMultiplier) || 2));
  const gainRatio = Number(update.gainRatio);
  const requestedRejectGrowth = Number(update.rejectGrowthFactor);
  const rejectGrowth = Number.isFinite(requestedRejectGrowth) && requestedRejectGrowth > 1
    ? requestedRejectGrowth
    : 2;

  if (!update.accepted) {
    return {
      damping: Math.max(minimum, Math.min(maximum, damping * rejectGrowth)),
      rejectMultiplier: 2,
    };
  }

  if (!Number.isFinite(gainRatio) || gainRatio <= 0) {
    return {
      damping,
      rejectMultiplier: 2,
    };
  }

  const nielsenFactor = Math.min(rejectGrowth, Math.max(1 / 3, 1 - Math.pow(2 * gainRatio - 1, 3)));
  return {
    damping: Math.max(minimum, Math.min(maximum, damping * nielsenFactor)),
    rejectMultiplier: 2,
  };
}