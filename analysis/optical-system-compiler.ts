import type { DesignConnection, PortRoute, PortRouteSet } from '../data/block-schema.ts';
import type { Configuration } from '../data/table-configuration.ts';
import type {
  CoherentAssemblyDesign,
  CoherentDetectorSpec,
  CoherentPhysicalComponent,
  CoherentSourceSpec,
} from './coherent-assembly.ts';
import {
  compileAutomaticAssemblyRouting,
  type AutomaticAssemblyRoutingResult,
} from './automatic-assembly-routing.ts';

export type OpticalSystemIssueSeverity = 'error' | 'warning' | 'info';
export type OpticalSystemStatus = 'ready' | 'warning' | 'invalid';

export interface OpticalSystemIssue {
  id: string;
  severity: OpticalSystemIssueSeverity;
  code: string;
  title: string;
  message: string;
  componentId?: string;
  detectorId?: string;
  routeId?: string;
}

export interface CompiledOpticalPath {
  id: string;
  label: string;
  sourceId: string;
  detectorId: string;
  componentIds: string[];
  hasTarget: boolean;
  hasGrating: boolean;
  hasBeamSplitter: boolean;
}

export interface CompiledDetectorPlan {
  id: string;
  componentId: string;
  label: string;
  kind: 'area' | 'time';
  routeIds: string[];
  pixelCount: number;
  estimatedWorkingBytes: number;
}

export interface OpticalSystemCompileOptions {
  pupilSampling?: number;
}

export interface CompiledOpticalSystem {
  configuration: Configuration;
  design: CoherentAssemblyDesign;
  connections: DesignConnection[];
  routes: PortRoute[];
  routeSets: PortRouteSet[];
  routeSource: AutomaticAssemblyRoutingResult['routeSource'];
  paths: CompiledOpticalPath[];
  detectors: CompiledDetectorPlan[];
  issues: OpticalSystemIssue[];
  status: OpticalSystemStatus;
  canRun: boolean;
  estimatedWorkingBytes: number;
  sourceOfTruth: 'blocks';
}

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const positiveInteger = (value: unknown): number => Math.max(0, Math.floor(finite(value)));

function routeComponentIds(route: PortRoute, connections: DesignConnection[]): string[] {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const ids: string[] = [];
  for (const step of route.steps ?? []) {
    const connection = connectionById.get(step.connectionId);
    if (!connection) continue;
    const reverse = step.direction === 'reverse';
    const departure = reverse ? connection.to.blockId : connection.from.blockId;
    const arrival = reverse ? connection.from.blockId : connection.to.blockId;
    if (ids[ids.length - 1] !== departure) ids.push(departure);
    if (ids[ids.length - 1] !== arrival) ids.push(arrival);
  }
  return ids;
}

function detectorSpecFor(
  component: CoherentPhysicalComponent,
  design: CoherentAssemblyDesign,
): CoherentDetectorSpec | undefined {
  return (design.detectors?.length ? design.detectors : [design.detector]).find((detector) => (
    String(detector.componentId ?? detector.id ?? '') === component.id
    || String(detector.id ?? '') === component.id
  ));
}

function sourceSpecFor(
  component: CoherentPhysicalComponent,
  design: CoherentAssemblyDesign,
): CoherentSourceSpec | undefined {
  return (design.sources?.length ? design.sources : [design.source]).find((source) => (
    String(source.componentId ?? source.id ?? '') === component.id
    || String(source.id ?? '') === component.id
  ));
}

function estimateDetectorWorkingBytes(
  detector: CoherentDetectorSpec,
  routeCount: number,
  sources: CoherentSourceSpec[],
  pupilSampling: number,
): number {
  if (detector.kind === 'time') {
    return Math.max(1, positiveInteger(detector.sampleCount)) * 8 * 8;
  }
  const pixels = Math.max(1, positiveInteger(detector.pixelCountX))
    * Math.max(1, positiveInteger(detector.pixelCountY));
  // Physical power, complex accumulation, electrons/ADU and two display or
  // calibration rasters coexist during the conversion stage.
  const detectorRasters = pixels * 8 * 14;
  const spectralRayRecords = sources.reduce((sum, source) => {
    const spectral = source.kind === 'frequency-comb'
      ? Math.max(1, positiveInteger(source.lineCount ?? source.spectralSamples))
      : Math.max(1, positiveInteger(source.spectralSamples));
    const spatial = Math.max(1, positiveInteger(source.detectorSpatialSamples ?? source.spatialSamples));
    return sum + Math.min(2_000_000, spectral * spatial * Math.max(1, routeCount)) * 112;
  }, 0);
  const psfWorkspace = Math.max(32, pupilSampling) ** 2 * 8 * 16;
  return detectorRasters + spectralRayRecords + psfWorkspace;
}

function addIssue(
  issues: OpticalSystemIssue[],
  issue: Omit<OpticalSystemIssue, 'id'>,
): void {
  const signature = `${issue.severity}:${issue.code}:${issue.componentId ?? ''}:${issue.detectorId ?? ''}:${issue.routeId ?? ''}`;
  if (issues.some((entry) => entry.id === signature)) return;
  issues.push({ ...issue, id: signature });
}

/**
 * Compiles the Blocks-based optical system into the exact lens trains and
 * physical Source-to-Detector paths shared by Render, Signal and Optimize.
 * Connections and Port routes are derived outputs in automatic mode.
 */
export function compileOpticalSystem(
  config: Configuration,
  options: OpticalSystemCompileOptions = {},
): CompiledOpticalSystem {
  const compiledRouting = compileAutomaticAssemblyRouting(config);
  const { configuration, design, connections, routes, routeSets, routeSource } = compiledRouting;
  const issues: OpticalSystemIssue[] = [];
  const componentById = new Map<string, CoherentPhysicalComponent>();

  for (const component of design.components) {
    if (componentById.has(component.id)) {
      addIssue(issues, {
        severity: 'error', code: 'duplicate-component-id', title: 'Duplicate Block ID',
        message: `${component.label || component.id} shares an ID with another component.`, componentId: component.id,
      });
    }
    componentById.set(component.id, component);
  }

  const sourceComponents = design.components.filter((component) => component.kind === 'source');
  const detectorComponents = design.components.filter((component) => component.kind === 'detector' || component.kind === 'time-detector');
  const sourceSpecs = sourceComponents.map((component) => sourceSpecFor(component, design)).filter(Boolean) as CoherentSourceSpec[];

  if (!sourceComponents.length) {
    addIssue(issues, {
      severity: 'error', code: 'missing-source', title: 'Source is missing',
      message: 'Add a Broadband or Frequency Comb Source Block.',
    });
  }
  if (!detectorComponents.length) {
    addIssue(issues, {
      severity: 'error', code: 'missing-detector', title: 'Detector is missing',
      message: 'Add an Area Detector or Time Detector Block.',
    });
  }

  for (const warning of compiledRouting.warnings) {
    addIssue(issues, {
      severity: routeSource === 'legacy-fallback' ? 'warning' : 'error',
      code: routeSource === 'legacy-fallback' ? 'legacy-route-fallback' : 'route-discovery-failed',
      title: routeSource === 'legacy-fallback' ? 'Saved-path fallback' : 'Detector path not found',
      message: warning,
    });
  }

  const paths: CompiledOpticalPath[] = routes.map((route) => {
    const componentIds = routeComponentIds(route, connections);
    const components = componentIds.map((id) => componentById.get(id)).filter(Boolean) as CoherentPhysicalComponent[];
    return {
      id: route.id,
      label: route.label || route.id,
      sourceId: String(route.sourceBlockId ?? componentIds[0] ?? ''),
      detectorId: String(route.detectorBlockId ?? componentIds[componentIds.length - 1] ?? ''),
      componentIds,
      hasTarget: components.some((component) => component.kind === 'target'),
      hasGrating: components.some((component) => component.kind === 'reflection-grating'),
      hasBeamSplitter: components.some((component) => component.kind === 'beam-splitter'),
    };
  });

  if (sourceComponents.length && detectorComponents.length && paths.length === 0) {
    addIssue(issues, {
      severity: 'error', code: 'no-source-detector-path', title: 'No Source-to-Detector path',
      message: 'Align the component positions and rotations so a physical path reaches a Detector.',
    });
  }

  for (const source of sourceComponents) {
    const spec = sourceSpecFor(source, design);
    if (!spec || !(finite(spec.totalPowerW) > 0)) {
      addIssue(issues, {
        severity: 'error', code: 'invalid-source-power', title: 'Source power is zero',
        message: `${source.label} needs positive optical power.`, componentId: source.id,
      });
    }
    if (spec && !(finite(spec.centerWavelengthNm) > 0)) {
      addIssue(issues, {
        severity: 'error', code: 'invalid-source-wavelength', title: 'Source wavelength is invalid',
        message: `${source.label} needs a positive center wavelength.`, componentId: source.id,
      });
    }
  }

  for (const sequence of design.blockSequences) {
    if (sequence.blocks.length === 0) {
      addIssue(issues, {
        severity: 'warning', code: 'empty-lens-train', title: 'Empty lens train',
        message: `${sequence.label} contains no exact optical Blocks.`,
        componentId: sequence.id.replace(/^sequential:/, 'sequential-group:'),
      });
    }
  }

  for (const component of design.components) {
    if (component.kind === 'sequential-group' || component.kind === 'source') continue;
    if (!(finite(component.dimensions.widthMm) > 0) || !(finite(component.dimensions.heightMm) > 0)) {
      addIssue(issues, {
        severity: 'error', code: 'invalid-component-size', title: 'Component size is invalid',
        message: `${component.label} needs positive width and height.`, componentId: component.id,
      });
    } else if (component.dimensionConfidence === 'Missing') {
      addIssue(issues, {
        severity: 'warning', code: 'missing-dimensions', title: 'Estimated placement only',
        message: `${component.label} has missing physical dimensions.`, componentId: component.id,
      });
    }
    if (component.kind === 'reflection-grating'
      && !(finite(component.metadata?.grooveDensityLinesPerMm, design.grating.grooveDensityLinesPerMm) > 0)) {
      addIssue(issues, {
        severity: 'error', code: 'invalid-grating-density', title: 'Grating density is invalid',
        message: `${component.label} needs a positive groove density.`, componentId: component.id,
      });
    }
  }

  const pupilSampling = Math.max(32, positiveInteger(options.pupilSampling ?? 64));
  const detectorPlans: CompiledDetectorPlan[] = detectorComponents.map((component) => {
    const spec = detectorSpecFor(component, design);
    const detectorId = String(spec?.id ?? spec?.componentId ?? component.id);
    const detectorRoutes = paths.filter((path) => path.detectorId === detectorId || path.detectorId === component.id);
    const kind = spec?.kind === 'time' || component.kind === 'time-detector' ? 'time' as const : 'area' as const;
    const pixelCount = kind === 'time'
      ? Math.max(1, positiveInteger(spec?.sampleCount))
      : Math.max(0, positiveInteger(spec?.pixelCountX)) * Math.max(0, positiveInteger(spec?.pixelCountY));
    const estimatedWorkingBytes = spec
      ? estimateDetectorWorkingBytes(spec, detectorRoutes.length, sourceSpecs, pupilSampling)
      : 0;
    if (!spec) {
      addIssue(issues, {
        severity: 'error', code: 'missing-detector-spec', title: 'Detector settings are missing',
        message: `${component.label} has no Detector specification.`, componentId: component.id, detectorId,
      });
    } else if (kind === 'area' && (
      positiveInteger(spec.pixelCountX) === 0
      || positiveInteger(spec.pixelCountY) === 0
      || !(finite(spec.pixelPitchUm) > 0)
    )) {
      addIssue(issues, {
        severity: 'error', code: 'invalid-detector-grid', title: 'Detector grid is invalid',
        message: `${component.label} needs positive X/Y pixel counts and pixel pitch.`, componentId: component.id, detectorId,
      });
    }
    if (detectorRoutes.length === 0) {
      addIssue(issues, {
        severity: 'error', code: 'detector-not-reached', title: 'Detector is not reached',
        message: `${component.label} has no compiled Source-to-Detector path.`, componentId: component.id, detectorId,
      });
    }
    if (estimatedWorkingBytes >= 1024 * 1024 * 1024) {
      addIssue(issues, {
        severity: 'error', code: 'memory-budget-exceeded', title: 'Estimated memory is too large',
        message: `${component.label} needs about ${(estimatedWorkingBytes / 1024 ** 3).toFixed(2)} GiB. Reduce Detector pixels, ray samples, spectral samples or PSF sampling.`,
        componentId: component.id, detectorId,
      });
    } else if (estimatedWorkingBytes >= 384 * 1024 * 1024) {
      addIssue(issues, {
        severity: 'warning', code: 'memory-budget-high', title: 'High browser memory use',
        message: `${component.label} may need about ${Math.round(estimatedWorkingBytes / 1024 ** 2)} MiB. Use a smaller preview before a full run.`,
        componentId: component.id, detectorId,
      });
    }
    return {
      id: detectorId,
      componentId: component.id,
      label: component.label || detectorId,
      kind,
      routeIds: detectorRoutes.map((path) => path.id),
      pixelCount,
      estimatedWorkingBytes,
    };
  });

  const hasSplitter = design.components.some((component) => component.kind === 'beam-splitter');
  const frequencyCombCount = sourceSpecs.filter((source) => source.kind === 'frequency-comb').length;
  for (const detector of detectorPlans) {
    const detectorPaths = paths.filter((path) => detector.routeIds.includes(path.id));
    const routeSet = routeSets.find((set) => (
      String(set.detectorBlockId) === detector.id || String(set.detectorBlockId) === detector.componentId
    ));
    if ((hasSplitter || detectorPaths.some((path) => path.hasGrating)) && detectorPaths.length < 2) {
      addIssue(issues, {
        severity: 'warning', code: 'single-interferometer-arm', title: 'Only one arm reaches the Detector',
        message: `${detector.label} needs at least two overlapping routes for an interference signal.`,
        componentId: detector.componentId, detectorId: detector.id,
      });
    }
    if (detectorPaths.length >= 2 && (!routeSet?.measurementRouteId || !routeSet?.referenceRouteId)) {
      addIssue(issues, {
        severity: 'warning', code: 'missing-route-role', title: 'Signal roles are incomplete',
        message: `${detector.label} has multiple paths, but measurement and reference roles could not be inferred.`,
        componentId: detector.componentId, detectorId: detector.id,
      });
    }
    if (frequencyCombCount >= 2 && detectorPaths.length < 3) {
      addIssue(issues, {
        severity: 'warning', code: 'dual-comb-route-count', title: 'Dual-comb LO path is missing',
        message: `${detector.label} needs measurement, reference and LO paths for Camera RF phase reconstruction.`,
        componentId: detector.componentId, detectorId: detector.id,
      });
    }
  }

  const severityOrder: Record<OpticalSystemIssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.title.localeCompare(b.title));
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const status: OpticalSystemStatus = errorCount > 0 ? 'invalid' : warningCount > 0 ? 'warning' : 'ready';

  return {
    configuration,
    design,
    connections,
    routes,
    routeSets,
    routeSource,
    paths,
    detectors: detectorPlans,
    issues,
    status,
    canRun: errorCount === 0,
    estimatedWorkingBytes: detectorPlans.reduce((sum, detector) => sum + detector.estimatedWorkingBytes, 0),
    sourceOfTruth: 'blocks',
  };
}
