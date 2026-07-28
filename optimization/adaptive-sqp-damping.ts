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
  const maxRelative = Math.max(minRelative, Number(update.maxRelativeDamping) || 1e12);
  const minimum = minRelative * hessianScale;
  const maximum = maxRelative * hessianScale;
  const damping = Math.max(minimum, Math.min(maximum, Number(state.damping) || minimum));
  const rejectMultiplier = Math.max(2, Math.min(1e6, Number(state.rejectMultiplier) || 2));
  const gainRatio = Number(update.gainRatio);

  if (!update.accepted || !Number.isFinite(gainRatio) || gainRatio <= 0) {
    return {
      damping: Math.max(minimum, Math.min(maximum, damping * rejectMultiplier)),
      rejectMultiplier: Math.min(1e6, rejectMultiplier * 2),
    };
  }

  const nielsenFactor = Math.max(1 / 3, 1 - Math.pow(2 * gainRatio - 1, 3));
  return {
    damping: Math.max(minimum, Math.min(maximum, damping * nielsenFactor)),
    rejectMultiplier: 2,
  };
}