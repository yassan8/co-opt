import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileOpticalSystem } from '../analysis/optical-system-compiler.ts';

const inputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (!inputArgument) {
  throw new Error('Usage: npm run diag:optical-system-compiler -- <configuration.json>');
}

const payload = JSON.parse(await readFile(resolve(inputArgument), 'utf8'));
const configurations = payload?.configurations?.configurations ?? payload?.configurations ?? [];
if (!Array.isArray(configurations) || configurations.length === 0) throw new Error('No configurations were found.');

let failed = false;
for (const configuration of configurations) {
  const compiled = compileOpticalSystem(configuration, { pupilSampling: 64 });
  console.log(JSON.stringify({
    config: configuration.id,
    status: compiled.status,
    canRun: compiled.canRun,
    sourceOfTruth: compiled.sourceOfTruth,
    routeSource: compiled.routeSource,
    pathCount: compiled.paths.length,
    detectorCount: compiled.detectors.length,
    estimatedMemoryMiB: Math.round(compiled.estimatedWorkingBytes / 1024 ** 2),
    issues: compiled.issues.map((issue) => ({ severity: issue.severity, code: issue.code })),
  }, null, 2));
  if (!compiled.canRun || compiled.paths.length === 0 || compiled.detectors.length === 0) failed = true;
}

const baseline = structuredClone(configurations[0]);
baseline.blocks = (baseline.blocks ?? []).filter((block) => block.blockType !== 'AreaDetector' && block.blockType !== 'TimeDetector');
baseline.designConnections = [];
baseline.portRoutes = [];
baseline.routeSets = [];
const missingDetector = compileOpticalSystem(baseline);
if (missingDetector.canRun || !missingDetector.issues.some((issue) => issue.code === 'missing-detector')) {
  console.error('Missing-Detector preflight did not block Run.');
  failed = true;
}

const oversized = structuredClone(configurations[0]);
const detectorBlock = (oversized.blocks ?? []).find((block) => block.blockType === 'AreaDetector');
if (detectorBlock) {
  detectorBlock.parameters ??= {};
  detectorBlock.parameters.pixelCountX = 16384;
  detectorBlock.parameters.pixelCountY = 16384;
  const memoryCheck = compileOpticalSystem(oversized, { pupilSampling: 256 });
  if (memoryCheck.canRun || !memoryCheck.issues.some((issue) => issue.code === 'memory-budget-exceeded')) {
    console.error('Memory-budget preflight did not block an unsafe Detector allocation.');
    failed = true;
  }
}

if (failed) process.exitCode = 1;
