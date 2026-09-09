import assert from 'node:assert/strict';
import {
  buildCandidateEvaluation,
  createDefaultToleranceStudy,
  getToleranceVariableValue,
  listToleranceCandidates,
  resultSummary,
  runMonteCarloTolerance,
  runSensitivityAnalysis,
  sensitivityContributionFractions,
  setToleranceVariableValue,
  wilsonConfidence95,
} from '../analysis/tolerance-study.ts';
import { evaluateRequirementsForToleranceCandidate } from '../analysis/tolerance-requirements-adapter.ts';

const clone = (value) => structuredClone(value);

const systemConfig = {
  activeConfigId: 1,
  configurations: [{
    id: 1,
    name: 'Tolerance verification',
    blocks: [
      { blockId: 'L1', blockType: 'Lens', parameters: { label: 'Lens 1', radius: 10, rindex: 1.5, conic: 0, semiDiameter: 5 }, variables: {} },
      { blockId: 'G1', blockType: 'Gap', parameters: { label: 'Image focus', thickness: 0 }, variables: {} },
    ],
    designConnections: [{ id: 'C1', label: 'Lens to detector', distanceMm: 20, azimuthDeg: 0, elevationDeg: 0 }],
    sequentialGroups: [{ id: 'S1', label: 'Imager', rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } } }],
  }],
};

const requirementRows = [{ id: 'R1', operand: 'TEST', configId: 1, op: '<=', target: 12, tol: 0, weight: 1, enabled: true }];

const evaluate = async (candidate, rows) => {
  const radius = getToleranceVariableValue(candidate, '1', 'L1.radius');
  const focus = getToleranceVariableValue(candidate, '1', 'G1.thickness');
  const values = new Map(rows.map((row) => [String(row.id), Number(radius) + Number(focus)]));
  return buildCandidateEvaluation(rows, values);
};
let candidateBatchCalls = 0;
let maximumCandidateBatch = 0;
const evaluateBatch = async (batch, rows) => {
  candidateBatchCalls += 1;
  maximumCandidateBatch = Math.max(maximumCandidateBatch, batch.length);
  return Promise.all(batch.map((candidate) => evaluate(candidate, rows)));
};

const candidates = listToleranceCandidates(systemConfig, ['1']);
assert(candidates.some((entry) => entry.id === 'L1.radius'), 'Lens radius must be available without an Optimize V flag.');
assert(candidates.some((entry) => entry.id === 'connection:C1.distanceMm'), 'Port distance must be available as an alignment tolerance.');
assert(candidates.some((entry) => entry.id === 'group:S1.rotationY'), 'Sequential Group pose must be available as an alignment tolerance.');

const mutated = clone(systemConfig);
assert.equal(setToleranceVariableValue(mutated, '1', 'L1.radius', 11.25), true);
assert.equal(getToleranceVariableValue(mutated, '1', 'L1.radius'), 11.25);
assert.equal(setToleranceVariableValue(mutated, '1', 'connection:C1.azimuthDeg', 4.5), true);
assert.equal(getToleranceVariableValue(mutated, '1', 'connection:C1.azimuthDeg'), 4.5);
assert.equal(setToleranceVariableValue(mutated, '1', 'group:S1.positionZ', 7), true);
assert.equal(getToleranceVariableValue(mutated, '1', 'group:S1.positionZ'), 7);

const study = createDefaultToleranceStudy('Verification');
study.runSettings = { trials: 64, seed: 123456, sensitivityStepFraction: 0.25, compensate: false };
study.parameters = [{
  id: 'P1', enabled: true, configId: '1', variableRef: 'L1.radius', label: 'Radius', unit: 'mm',
  minusTolerance: 1, plusTolerance: 1, distribution: 'normal', sigmaMode: 'three-sigma',
}];

const sensitivity = await runSensitivityAnalysis({ systemConfig, study, requirementRows, evaluateCandidate: evaluate });
assert.equal(sensitivity.parameters.length, 1);
assert(Math.abs(sensitivity.parameters[0].requirements[0].derivativePerUnit - 1) < 1e-12, 'Central sensitivity derivative must match the analytic value.');
assert.equal(sensitivity.nominal.passed, true);
const monitorRows = [{ ...requirementRows[0], id: 'MONITOR', analysisMonitor: true, op: '>=', target: 999 }];
const invalidMonitor = buildCandidateEvaluation(monitorRows, new Map(), new Map([['MONITOR', 'No finite MTF value.']]));
assert.equal(invalidMonitor.valid, false);
assert.equal(invalidMonitor.reason, 'No finite MTF value.', 'Invalid monitor evaluations must retain a user-visible reason.');
const monitorSensitivity = await runSensitivityAnalysis({ systemConfig, study, requirementRows: monitorRows, evaluateCandidate: evaluate });
assert.equal(monitorSensitivity.nominal.passed, true, 'A sensitivity-only monitor must not become a failing specification.');
assert.equal(monitorSensitivity.nominal.score, 0, 'A sensitivity-only monitor must not add merit violation.');
assert.equal(monitorSensitivity.nominal.requirements[0].monitorOnly, true);
assert(Math.abs(monitorSensitivity.parameters[0].requirements[0].normalizedImpact - 0.025) < 1e-12, 'Automatic monitor impact must be normalized to the nominal metric.');
assert.deepEqual(
  sensitivityContributionFractions([{ parameterId: 'A', impact: 3 }, { parameterId: 'B', impact: 4 }]),
  { A: 0.36, B: 0.64 },
  'Sensitivity contribution must use squared response and total 100%.',
);
const monitorTolerance = await runMonteCarloTolerance({ systemConfig, study, requirementRows: monitorRows, evaluateCandidate: evaluate });
assert.equal(monitorTolerance.monitorOnly, true, 'A monitor-only Monte Carlo run must identify itself as distribution-only.');
assert.equal(monitorTolerance.worstTrial, null, 'A monitor-only run must not invent a worst failing configuration.');
assert.equal(monitorTolerance.requirements[0].validSamples, 64);
assert(Number.isFinite(monitorTolerance.requirements[0].mean), 'A monitor-only run must still report metric statistics.');
assert.equal(resultSummary(monitorTolerance).yield, undefined, 'A monitor-only run must not persist a fake 100% yield.');
assert.equal(resultSummary(monitorTolerance).parameterCount, 1, 'Monitor-only summaries must retain the varied-parameter count.');
candidateBatchCalls = 0;
maximumCandidateBatch = 0;
const sensitivityProgress = [];
const batchedSensitivity = await runSensitivityAnalysis({
  systemConfig,
  study,
  requirementRows,
  evaluateCandidate: evaluate,
  evaluateCandidates: evaluateBatch,
  onProgress: (entry) => sensitivityProgress.push(entry),
});
assert.deepEqual(batchedSensitivity.parameters, sensitivity.parameters, 'Batched sensitivity must preserve the serial numeric result.');
assert.equal(candidateBatchCalls, 2, 'Uncompensated sensitivity must use one nominal batch and one minus/plus batch.');
assert.equal(maximumCandidateBatch, 2);
assert.equal(sensitivityProgress[0].percent, 1, 'Sensitivity must paint a non-zero preparing state before nominal evaluation.');
assert.equal(sensitivityProgress.at(-1).percent, 100, 'Sensitivity progress must finish at 100%.');
assert(sensitivityProgress.every((entry, index) => index === 0 || entry.percent >= sensitivityProgress[index - 1].percent), 'Sensitivity progress must not move backwards.');

const first = await runMonteCarloTolerance({ systemConfig, study, requirementRows, evaluateCandidate: evaluate });
const second = await runMonteCarloTolerance({ systemConfig, study, requirementRows, evaluateCandidate: evaluate });
assert.deepEqual(first.trials.map((trial) => trial.appliedDeltas), second.trials.map((trial) => trial.appliedDeltas), 'Seeded Monte Carlo must be reproducible.');
assert.equal(first.trialsCompleted, 64);
assert.equal(first.validTrials, 64);
candidateBatchCalls = 0;
maximumCandidateBatch = 0;
const monteCarloProgress = [];
const batchedMonteCarlo = await runMonteCarloTolerance({
  systemConfig,
  study,
  requirementRows,
  evaluateCandidate: evaluate,
  evaluateCandidates: evaluateBatch,
  candidateBatchSize: 16,
  onProgress: (entry) => monteCarloProgress.push(entry),
});
assert.deepEqual(batchedMonteCarlo.trials, first.trials, 'Batched Monte Carlo must preserve seeded serial results exactly.');
assert.equal(candidateBatchCalls, 5, '64 trials at batch size 16 must use one nominal batch plus four trial batches.');
assert.equal(batchedMonteCarlo.execution.maximumBatchSize, 16);
assert.equal(batchedMonteCarlo.execution.backend, 'candidate-batch');
assert.equal(monteCarloProgress[0].percent, 1, 'Tolerance analysis must paint a non-zero preparing state before nominal evaluation.');
assert.equal(monteCarloProgress.at(-1).percent, 100, 'Tolerance progress must finish at 100%.');
assert(monteCarloProgress.some((entry) => entry.percent > 5 && entry.percent < 100), 'Tolerance analysis must report intermediate batch progress.');
assert(monteCarloProgress.every((entry, index) => index === 0 || entry.percent >= monteCarloProgress[index - 1].percent), 'Tolerance progress must not move backwards.');

const zeroStudy = clone(study);
zeroStudy.parameters[0].minusTolerance = 0;
zeroStudy.parameters[0].plusTolerance = 0;
const zero = await runMonteCarloTolerance({ systemConfig, study: zeroStudy, requirementRows, evaluateCandidate: evaluate });
assert(zero.trials.every((trial) => trial.requirementValues.R1 === 10), 'Zero tolerance must reproduce the nominal design.');

const compensateRows = [{ ...requirementRows[0], op: '=', target: 10 }];
const uncompensatedStudy = clone(study);
uncompensatedStudy.runSettings.trials = 48;
uncompensatedStudy.runSettings.compensate = false;
const uncompensated = await runMonteCarloTolerance({ systemConfig, study: uncompensatedStudy, requirementRows: compensateRows, evaluateCandidate: evaluate });
const compensatedStudy = clone(uncompensatedStudy);
compensatedStudy.runSettings.compensate = true;
compensatedStudy.compensators = [{ id: 'C1', enabled: true, configId: '1', variableRef: 'G1.thickness', label: 'Image focus', minimum: -1.5, maximum: 1.5, samples: 31 }];
const compensated = await runMonteCarloTolerance({ systemConfig, study: compensatedStudy, requirementRows: compensateRows, evaluateCandidate: evaluate });
const meanScore = (result) => result.trials.reduce((sum, trial) => sum + trial.score, 0) / result.trials.length;
assert(meanScore(compensated) < meanScore(uncompensated), 'Compensation must reduce the average merit violation.');
const compensationBatchStudy = clone(compensatedStudy);
compensationBatchStudy.runSettings.trials = 12;
compensationBatchStudy.compensators[0].samples = 7;
const compensationSerial = await runMonteCarloTolerance({
  systemConfig,
  study: compensationBatchStudy,
  requirementRows: compensateRows,
  evaluateCandidate: evaluate,
});
candidateBatchCalls = 0;
maximumCandidateBatch = 0;
const compensationBatched = await runMonteCarloTolerance({
  systemConfig,
  study: compensationBatchStudy,
  requirementRows: compensateRows,
  evaluateCandidate: evaluate,
  evaluateCandidates: evaluateBatch,
  candidateBatchSize: 4,
});
assert.deepEqual(compensationBatched.trials, compensationSerial.trials, 'Batched compensator search must preserve the selected candidate and score.');
assert(candidateBatchCalls < compensationBatched.execution.candidateEvaluations, 'Compensator candidates must cross the evaluator in batches.');
assert.equal(maximumCandidateBatch, 4, 'Configured candidate chunks must cap compensation memory use.');

assert.deepEqual(wilsonConfidence95(0, 0), { low: 0, high: 0 });
const interval = wilsonConfidence95(50, 100);
assert(interval.low < 0.5 && interval.high > 0.5, 'Wilson interval must enclose the observed yield.');

const routeHost = {
  __cooptBlocksOverride: { sentinel: true },
  __cooptAssemblyOverride: { sentinel: true },
  __cooptSystemConfig: { sentinel: true },
  __cooptPreferRuntimeSystemConfig: false,
  meritFunctionEditor: {
    _runtimeCache: new Map([['sentinel', 1]]),
    async calculateOperandValueAsync(operand) {
      const assembly = routeHost.__cooptAssemblyOverride[String(operand.configId)];
      return assembly.designConnections.find((entry) => entry.id === 'C1').distanceMm;
    },
  },
  systemRequirementsEditor: {
    _buildScopedOperandObjects(_row, operand) { return [operand]; },
    computeViolationAmount(operator, current, target, tolerance) {
      const values = new Map([['ROUTE', current]]);
      return buildCandidateEvaluation([{ id: 'ROUTE', operand: 'ROUTE_OPL', op: operator, target, tol: tolerance, weight: 1 }], values).requirements[0].violation;
    },
  },
};
const routeRows = [{ id: 'ROUTE', operand: 'ROUTE_OPL', configId: 1, op: '<=', target: 25, tol: 0, weight: 1, enabled: true }];
const routeNominal = await evaluateRequirementsForToleranceCandidate(routeHost, systemConfig, routeRows);
assert.equal(routeNominal.passed, true, 'Route operands must use the candidate assembly snapshot.');
const routePerturbedConfig = clone(systemConfig);
setToleranceVariableValue(routePerturbedConfig, '1', 'connection:C1.distanceMm', 30);
const routePerturbed = await evaluateRequirementsForToleranceCandidate(routeHost, routePerturbedConfig, routeRows);
assert.equal(routePerturbed.passed, false, 'A Port connection tolerance must affect the Route requirement.');
assert.deepEqual(routeHost.__cooptAssemblyOverride, { sentinel: true }, 'Host assembly overrides must be restored after candidate evaluation.');
assert.deepEqual(routeHost.__cooptSystemConfig, { sentinel: true }, 'Host configuration must be restored after candidate evaluation.');

console.log(JSON.stringify({
  status: 'PASS',
  candidates: candidates.length,
  sensitivityDerivative: sensitivity.parameters[0].requirements[0].derivativePerUnit,
  seededTrials: first.trialsCompleted,
  candidateBatchCalls,
  maximumCandidateBatch,
  compensationCandidateEvaluations: compensationBatched.execution.candidateEvaluations,
  uncompensatedMeanScore: meanScore(uncompensated),
  compensatedMeanScore: meanScore(compensated),
  routeNominalPassed: routeNominal.passed,
  routePerturbedViolation: routePerturbed.requirements[0].violation,
  wilson95: interval,
}, null, 2));
