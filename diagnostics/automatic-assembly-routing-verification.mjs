import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileAutomaticAssemblyRouting } from '../analysis/automatic-assembly-routing.ts';
import { buildHybridAssemblyFromConfiguration } from '../analysis/hybrid-design.ts';
import { worldPortDirection, worldPortPosition } from '../analysis/coherent-port-layout.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';

const inputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (!inputArgument) {
  throw new Error('Usage: npm run diag:automatic-assembly-routing -- <configuration.json> [--trace] [--spatial=49]');
}
const inputPath = resolve(inputArgument);
const payload = JSON.parse(await readFile(inputPath, 'utf8'));
const configurations = payload?.configurations?.configurations ?? payload?.configurations ?? [];
const tracePhysicalRays = process.argv.includes('--trace');
const spatialSamplesArg = process.argv.find((argument) => argument.startsWith('--spatial='));
const spatialSamples = Math.max(1, Number.parseInt(spatialSamplesArg?.slice('--spatial='.length) || '9', 10) || 9);
let failed = false;
for (const configuration of configurations) {
  const authored = buildHybridAssemblyFromConfiguration(configuration);
  const componentById = new Map(authored.components.map((component) => [component.id, component]));
  const savedGeometry = (configuration.portRoutes ?? []).map((route) => ({
    route: route.id,
    links: route.steps.map((step) => {
      const connection = (configuration.designConnections ?? []).find((entry) => entry.id === step.connectionId);
      if (!connection) return { missing: step.connectionId };
      const fromEndpoint = step.direction === 'reverse' ? connection.to : connection.from;
      const toEndpoint = step.direction === 'reverse' ? connection.from : connection.to;
      const from = componentById.get(fromEndpoint.blockId);
      const to = componentById.get(toEndpoint.blockId);
      if (!from || !to) return { missing: `${fromEndpoint.blockId}>${toEndpoint.blockId}` };
      const origin = worldPortPosition(from, fromEndpoint.portId, 'from');
      const target = worldPortPosition(to, toEndpoint.portId, 'to');
      const direction = worldPortDirection(from, fromEndpoint.portId, 'from');
      const delta = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z };
      const axial = delta.x * direction.x + delta.y * direction.y + delta.z * direction.z;
      const lateral = Math.sqrt(Math.max(0, delta.x ** 2 + delta.y ** 2 + delta.z ** 2 - axial ** 2));
      const facingDirection = worldPortDirection(to, toEndpoint.portId, 'to');
      const facing = facingDirection.x * direction.x + facingDirection.y * direction.y + facingDirection.z * direction.z;
      return { link: `${fromEndpoint.blockId}:${fromEndpoint.portId}>${toEndpoint.blockId}:${toEndpoint.portId}`, axial, lateral, facing };
    }),
  }));
  const result = compileAutomaticAssemblyRouting(configuration);
  const routeChains = result.routes.map((route) => ({
    label: route.label,
    steps: route.steps.map((step) => {
      const connection = result.connections.find((entry) => entry.id === step.connectionId);
      return `${connection?.from.blockId}:${connection?.from.portId}>${connection?.to.blockId}:${connection?.to.portId}`;
    }),
  }));
  console.log(JSON.stringify({
    config: configuration.id,
    routes: routeChains,
    routeSets: result.routeSets,
    warnings: result.warnings,
    savedGeometry,
  }, null, 2));
  if (tracePhysicalRays) {
    const trace = await runPortRoutedTrace({ ...configuration, assemblyRoutingMode: 'automatic-scene' }, {
      spatialSamples,
      spectralSamples: 1,
      renderRayLimit: 500,
      spectralFieldsOnly: true,
    });
    console.log(JSON.stringify({
      config: configuration.id,
      physicalRoutes: trace.routeMetrics.map((metric) => ({
        route: metric.routeId,
        valid: metric.valid,
        launched: metric.launchedRays,
        reached: metric.reachedRays,
        reason: metric.failureReason,
      })),
      warnings: trace.warnings,
    }, null, 2));
    if (!trace.routeMetrics.some((metric) => metric.valid)) failed = true;
  }
  if (result.routes.length === 0 || result.routeSets.length === 0) failed = true;
}
if (failed) process.exitCode = 1;
