export interface AdaptiveSpotSamplingPlan {
  enabled: boolean;
  coarseRayCount: number;
  mediumRayCount: number;
  finalRayCount: number;
  transitionIteration: number;
  finalTransitionIteration: number;
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
  const coarseRayCount = Math.max(minimumGridRayCount, Math.floor(finalRayCount / 8));
  const mediumRayCount = Math.max(coarseRayCount, Math.floor(finalRayCount / 3));
  const enabled = requested && maxIterations > 1 && coarseRayCount < finalRayCount;

  if (!enabled) {
    return {
      enabled: false,
      coarseRayCount: finalRayCount,
      mediumRayCount: finalRayCount,
      finalRayCount,
      transitionIteration: 0,
      finalTransitionIteration: 0,
    };
  }

  const finalFractionRaw = Number(finalFractionInput);
  const finalFraction = Number.isFinite(finalFractionRaw)
    ? Math.max(0.1, Math.min(0.9, finalFractionRaw))
    : 0.25;
  const finalIterations = Math.max(1, Math.ceil(maxIterations * finalFraction));
  const warmupIterations = Math.max(1, Math.floor((maxIterations - finalIterations) * 0.7));
  const transitionIteration = Math.max(1, warmupIterations);
  const finalTransitionIteration = Math.max(
    transitionIteration + 1,
    maxIterations - finalIterations,
  );

  return {
    enabled: true,
    coarseRayCount,
    mediumRayCount: Math.max(coarseRayCount, Math.min(finalRayCount, mediumRayCount)),
    finalRayCount,
    transitionIteration,
    finalTransitionIteration,
  };
}

export function adaptiveSpotRayCountAtIteration(
  plan: AdaptiveSpotSamplingPlan,
  completedIterationsInput: unknown,
  forceFinal: boolean = false,
): number {
  const completedIterations = Math.max(0, Math.floor(Number(completedIterationsInput) || 0));
  if (!plan.enabled || forceFinal || completedIterations >= plan.finalTransitionIteration) {
    return plan.finalRayCount;
  }
  if (completedIterations >= plan.transitionIteration) {
    return plan.mediumRayCount;
  }
  return plan.coarseRayCount;
}

export function adaptiveSpotIterationsUntilNextTransition(
  plan: AdaptiveSpotSamplingPlan,
  completedIterationsInput: unknown,
  forceFinal: boolean = false,
): number {
  if (!plan.enabled || forceFinal) return Number.MAX_SAFE_INTEGER;
  const completedIterations = Math.max(0, Math.floor(Number(completedIterationsInput) || 0));
  if (completedIterations < plan.transitionIteration) {
    return Math.max(1, plan.transitionIteration - completedIterations);
  }
  if (completedIterations < plan.finalTransitionIteration) {
    return Math.max(1, plan.finalTransitionIteration - completedIterations);
  }
  return Number.MAX_SAFE_INTEGER;
}