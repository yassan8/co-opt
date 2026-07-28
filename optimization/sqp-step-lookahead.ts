export interface SqpLookaheadCandidate {
  score: number;
  maxViolation: number;
}

export function buildSqpLineSearchAlphas(
  backtrackCountInput: unknown,
  lookaheadEnabled: boolean,
): number[] {
  const backtrackCount = Math.max(1, Math.floor(Number(backtrackCountInput) || 1));
  const backtracking = Array.from({ length: backtrackCount }, (_, index) => Math.pow(0.5, index));
  return lookaheadEnabled
    ? [1, 1.5, 2, ...backtracking.slice(1)]
    : backtracking;
}

export function isBetterSqpLookaheadCandidate(
  selected: SqpLookaheadCandidate,
  candidate: SqpLookaheadCandidate,
): boolean {
  if (!Number.isFinite(candidate.score) || !Number.isFinite(candidate.maxViolation)) return false;
  if (!Number.isFinite(selected.score) || !Number.isFinite(selected.maxViolation)) return true;
  const scoreTolerance = Math.max(1e-12, Math.abs(selected.score) * 1e-12);
  const violationTolerance = Math.max(1e-9, Math.abs(selected.maxViolation) * 1e-9);
  return candidate.score < selected.score - scoreTolerance
    && candidate.maxViolation <= selected.maxViolation + violationTolerance;
}