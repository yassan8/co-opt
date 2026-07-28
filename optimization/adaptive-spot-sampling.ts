export interface AdaptiveSpotSamplingPlan {
  enabled: boolean;
  coarseRayCount: number;
  finalRayCount: number;
  transitionIteration: number;
}

export function annularRingCountForRayCount(rayCountInput: unknown): number {
  const rayCount = Math.max(1, Math.floor(Number(rayCountInput) || 1));
  return Math.max(1, Math.ceil((rayCount - 1) / 8));
}

export function createAdaptiveSpotSamplingPlan(
  finalRayCountInput: unknown,
  maxIterationsInput: unknown,
  enabledInput: unknown = true,
  finalFractionInput: unknown = 0.25,
): AdaptiveSpotSamplingPlan {
  const finalRayCount = Math.max(1, Math.floor(Number(finalRayCountInput) || 1));
  const maxIterations = Math.max(1, Math.floor(Number(maxIterationsInput) || 1));
  const requested = enabledInput !== false;
  const minimumGridRayCount = 4 * 4;
  const coarseRayCount = Math.max(minimumGridRayCount, Math.floor(finalRayCount / 4));
  const enabled = requested && maxIterations > 1 && coarseRayCount < finalRayCount;

  if (!enabled) {
    return {
      enabled: false,
      coarseRayCount: finalRayCount,
      finalRayCount,
      transitionIteration: 0,
    };
  }

  const finalFractionRaw = Number(finalFractionInput);
  const finalFraction = Number.isFinite(finalFractionRaw)
    ? Math.max(0.1, Math.min(0.9, finalFractionRaw))
    : 0.25;
  const finalIterations = Math.max(1, Math.ceil(maxIterations * finalFraction));

  return {
    enabled: true,
    coarseRayCount,
    finalRayCount,
    transitionIteration: Math.max(1, maxIterations - finalIterations),
  };
}

export function adaptiveSpotRayCountAtIteration(
  plan: AdaptiveSpotSamplingPlan,
  completedIterationsInput: unknown,
  forceFinal: boolean = false,
): number {
  const completedIterations = Math.max(0, Math.floor(Number(completedIterationsInput) || 0));
  if (!plan.enabled || forceFinal || completedIterations >= plan.transitionIteration) {
    return plan.finalRayCount;
  }
  return plan.coarseRayCount;
}