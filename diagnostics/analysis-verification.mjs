import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFoundationChecks } from './analysis-verification/foundation-checks.mjs';
import { runRaytraceBackendParity } from './analysis-verification/backend-parity-check.mjs';
import { runGeometricChecks } from './analysis-verification/geometric-checks.mjs';
import { runWavefrontChecks } from './analysis-verification/wavefront-checks.mjs';
import { runDiffractionChecks } from './analysis-verification/diffraction-checks.mjs';
import { runIntegratedChecks } from './analysis-verification/integrated-checks.mjs';
import { runEnvironmentChecks } from './analysis-verification/environment-checks.mjs';
import { verificationStages, getVerificationStage } from './analysis-verification/manifest.mjs';
import { writeVerificationReport } from './analysis-verification/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined || String(value).startsWith('--')) return 'true';
  return value;
}

const requestedStage = String(getArg('stage', 'foundation')).trim().toLowerCase();
const profile = String(getArg('profile', 'quick')).trim().toLowerCase();
const outputDirectory = path.resolve(projectRoot, getArg('out-dir', '.tmp/analysis-verification'));

const requestedDefinition = requestedStage === 'all' ? null : getVerificationStage(requestedStage);
if (requestedStage !== 'all' && !requestedDefinition) {
  throw new Error(`Unknown stage "${requestedStage}". Use an ID from the verification manifest or all.`);
}
if (requestedDefinition && requestedDefinition.status !== 'implemented') {
  throw new Error(`Stage "${requestedStage}" is registered but not implemented yet.`);
}
const requestedOrder = requestedStage === 'all' ? Infinity : requestedDefinition.order;

const startedAt = performance.now();
const resultsByStage = new Map();
if (requestedOrder >= 1) {
  const foundationChecks = await runFoundationChecks();
  foundationChecks.push(await runRaytraceBackendParity({
    projectRoot,
    outputDirectory,
    rayCount: profile === 'full' ? 81 : 25,
  }));
  resultsByStage.set('foundation', foundationChecks);
}
if (requestedOrder >= 2) {
  resultsByStage.set('geometric', await runGeometricChecks({ projectRoot, profile }));
}
if (requestedOrder >= 3) {
  resultsByStage.set('wavefront', await runWavefrontChecks({
    projectRoot,
    outputDirectory,
    profile,
  }));
}
if (requestedOrder >= 4) {
  resultsByStage.set('diffraction', await runDiffractionChecks({ projectRoot, profile }));
}
if (requestedOrder >= 5) {
  resultsByStage.set('integrated', await runIntegratedChecks({ projectRoot, profile }));
}
if (requestedOrder >= 6) {
  resultsByStage.set('environment', await runEnvironmentChecks({ projectRoot, profile }));
}
const stageResults = verificationStages.map((stage) => {
  const results = resultsByStage.get(stage.id) ?? [];
  const failed = results.filter((check) => check.status === 'fail').length;
  const resultStatus = results.length === 0 ? 'pending' : (failed === 0 ? 'pass' : 'fail');
  return { ...stage, resultStatus, results };
});

const completedChecks = stageResults.flatMap((stage) => stage.results);
const failed = completedChecks.filter((check) => check.status === 'fail').length;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  profile,
  requestedStage,
  summary: {
    total: completedChecks.length,
    passed: completedChecks.length - failed,
    failed,
    pendingStages: stageResults.filter((stage) => stage.resultStatus === 'pending').length,
    durationMs: performance.now() - startedAt,
  },
  stages: stageResults,
};

const paths = await writeVerificationReport(report, outputDirectory);
const relative = (filePath) => path.relative(projectRoot, filePath);

for (const stage of stageResults) {
  const marker = stage.resultStatus === 'pass' ? 'PASS' : stage.resultStatus === 'fail' ? 'FAIL' : 'PENDING';
  console.log(`${marker.padEnd(7)} ${stage.order}. ${stage.title}`);
  for (const check of stage.results) {
    console.log(`  ${check.status === 'pass' ? 'OK' : 'NG'} ${check.title}${check.error ? ` — ${check.error}` : ''}`);
  }
}

console.log('');
console.log(`JSON report: ${relative(paths.jsonPath)}`);
console.log(`HTML report: ${relative(paths.htmlPath)}`);
console.log(`Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed`);

if (failed > 0) process.exitCode = 1;
