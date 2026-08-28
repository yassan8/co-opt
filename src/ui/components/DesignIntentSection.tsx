import { useEffect, useMemo, useRef, useState } from 'react';
import { detectActivePortRoutes, readActiveCoherentDesign, readActiveConfiguration, subscribeActiveCoherentDesign, updateActiveCoherentDesign, type ActiveCoherentDesignSnapshot } from '../../../data/coherent-config-store.ts';
import { getConnectionLayoutParameters } from '../../../analysis/coherent-port-layout.ts';
import { compileOpticalSystem } from '../../../analysis/optical-system-compiler.ts';
import { DESIGN_CONNECTION_SELECTED_EVENT, OPTICAL_ROUTE_SELECTED_EVENT, RENDER_SELECTED_ROUTE_STORAGE_KEY } from '../../app/nonsequential-render-overlay.ts';

const lensDesignLabel = (value: unknown, fallback = '') => {
  const label = String(value ?? '').trim() || fallback;
  return label.replace(/^Lens\s+section\b/i, 'Lens design');
};

const SYSTEM_KIND_LABELS: Record<string, string> = {
  source: 'Source',
  mirror: 'Mirror',
  attenuator: 'Filter',
  lens: 'Lens',
  'cylindrical-lens': 'Cylindrical lens',
  'beam-splitter': 'Beam splitter',
  target: 'Target',
  'reflection-grating': 'Grating',
  detector: 'Area detector',
  'time-detector': 'Time detector',
  'stl-object': 'STL object',
  'sequential-group': 'Lens train',
  stop: 'Stop',
};

function HybridAssemblySummary() {
  const [snapshot, setSnapshot] = useState<ActiveCoherentDesignSnapshot>(() => readActiveCoherentDesign());
  const [selectedComponentId, setSelectedComponentId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => subscribeActiveCoherentDesign((next) => setSnapshot(next)), []);
  useEffect(() => {
    setSelectedComponentId('');
    setError('');
  }, [snapshot.configId]);

  const design = snapshot.design;
  const components = design.components ?? [];
  const physical = components.filter((component) => component.kind !== 'sequential-group');
  const lensTrains = components.filter((component) => component.kind === 'sequential-group');
  const sources = physical.filter((component) => component.kind === 'source');
  const detectors = physical.filter((component) => component.kind === 'detector' || component.kind === 'time-detector');
  const routingParts = physical.filter((component) => !['source', 'detector', 'time-detector'].includes(component.kind));
  const componentById = new Map(components.map((component) => [component.id, component]));
  const sequenceByComponentId = new Map(design.blockSequences.map((sequence) => [
    sequence.id.replace(/^sequential:/, 'sequential-group:'),
    sequence,
  ]));
  const compiledSystem = useMemo(() => {
    const configuration = readActiveConfiguration();
    return configuration ? compileOpticalSystem(configuration) : null;
  }, [snapshot.configId, design]);

  const commit = (mutate: (draft: ActiveCoherentDesignSnapshot['design']) => void, reason: string) => {
    try {
      const draft = JSON.parse(JSON.stringify(design)) as ActiveCoherentDesignSnapshot['design'];
      mutate(draft);
      updateActiveCoherentDesign(draft, reason);
      setSnapshot(readActiveCoherentDesign());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const displayLabel = (componentId: string) => {
    const component = componentById.get(componentId);
    if (!component) return componentId;
    if (component.kind !== 'sequential-group') return component.label || SYSTEM_KIND_LABELS[component.kind] || component.kind;
    const sequence = sequenceByComponentId.get(componentId);
    const label = lensDesignLabel(sequence?.label ?? component.label, 'Lens train');
    return label.replace(/^Lens\s+design\b/i, 'Lens train');
  };

  const routeComponentIds = (route: NonNullable<typeof design.portRoutes>[number]) => {
    const ids: string[] = [];
    for (const step of route.steps) {
      const connection = design.connections.find((entry) => entry.id === step.connectionId);
      if (!connection) continue;
      const departure = step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId;
      const arrival = step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId;
      if (ids[ids.length - 1] !== departure) ids.push(departure);
      if (ids[ids.length - 1] !== arrival) ids.push(arrival);
    }
    return ids;
  };

  const graphLanes = (() => {
    if (!design.connections.length) return [] as Array<{ id: string; label: string; ids: string[] }>;
    const outgoing = new Map<string, typeof design.connections>();
    const incoming = new Set<string>();
    for (const connection of design.connections) {
      const entries = outgoing.get(connection.fromComponentId) ?? [];
      entries.push(connection);
      outgoing.set(connection.fromComponentId, entries);
      incoming.add(connection.toComponentId);
    }
    const roots = sources.map((source) => source.id);
    if (!roots.length) {
      for (const component of components) if (!incoming.has(component.id)) roots.push(component.id);
    }
    const lanes: Array<{ id: string; label: string; ids: string[] }> = [];
    const walk = (currentId: string, ids: string[], usedConnections: Set<string>) => {
      if (lanes.length >= 12 || ids.length > Math.max(components.length * 2, 12)) return;
      const next = (outgoing.get(currentId) ?? []).filter((connection) => !usedConnections.has(connection.id));
      const current = componentById.get(currentId);
      if (!next.length || current?.kind === 'detector' || current?.kind === 'time-detector') {
        if (ids.length > 1) lanes.push({ id: `scene-${lanes.length}`, label: `Path ${lanes.length + 1}`, ids });
        return;
      }
      for (const connection of next) {
        walk(connection.toComponentId, [...ids, connection.toComponentId], new Set([...usedConnections, connection.id]));
      }
    };
    for (const root of roots) walk(root, [root], new Set());
    return lanes;
  })();

  const savedRouteLanes = (design.portRoutes ?? [])
    .filter((route) => route.enabled !== false)
    .map((route) => ({ id: route.id, label: route.label || 'Optical path', ids: routeComponentIds(route) }))
    .filter((route) => route.ids.length > 1);
  const compiledRouteLanes = (compiledSystem?.paths ?? [])
    .map((path) => ({ id: path.id, label: path.label || 'Optical path', ids: path.componentIds }))
    .filter((path) => path.ids.length > 1);
  const fallbackIds = [
    ...sources.map((component) => component.id),
    ...lensTrains.map((component) => component.id),
    ...routingParts.map((component) => component.id),
    ...detectors.map((component) => component.id),
  ];
  // Saved routes are display hints only in unified mode. They preserve the
  // intended return/recombine order better than a raw directed connection
  // graph; when absent, the physical graph supplies a compact preview.
  const rawLanes = compiledRouteLanes.length
    ? compiledRouteLanes
    : savedRouteLanes.length
      ? savedRouteLanes
      : graphLanes;
  const seenLaneSignatures = new Set<string>();
  const flowLanes = (rawLanes.length ? rawLanes : [{ id: 'system', label: 'System', ids: fallbackIds }])
    .filter((lane) => {
      const signature = lane.ids.join('>');
      if (!signature || seenLaneSignatures.has(signature)) return false;
      seenLaneSignatures.add(signature);
      return true;
    });
  const visibleLanes = flowLanes.slice(0, 8);

  const focusComponent = (componentId: string) => {
    setSelectedComponentId(componentId);
    const component = componentById.get(componentId);
    if (!component) return;
    let target: HTMLElement | null = null;
    if (component.kind === 'sequential-group') {
      const groupId = String(component.metadata?.groupId ?? component.id.replace(/^sequential-group:/, ''));
      target = document.querySelector<HTMLElement>(`#block-inspector [data-sequential-group-id="${CSS.escape(groupId)}"]`);
      if (target?.classList.contains('is-collapsed')) target.querySelector<HTMLButtonElement>('.block-inspector-section-toggle')?.click();
    } else {
      const blockId = String(component.metadata?.blockId ?? component.id);
      target = document.querySelector<HTMLElement>(`#block-inspector [data-block-id="${CSS.escape(blockId)}"]`);
      target?.click();
    }
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  };

  const addLensTrain = () => commit((draft) => {
    const keys = new Set((draft.blockSequences ?? []).map((sequence) => String(sequence.id).replace(/^sequential:/, '')));
    let ordinal = Math.max(2, keys.size + 1);
    while (keys.has(`group-${ordinal}`)) ordinal += 1;
    draft.blockSequences.push({
      id: `sequential:group-${ordinal}`,
      label: `Lens train ${ordinal}`,
      pathId: `group-${ordinal}`,
      blocks: [],
      manualOffset: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
      rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
    });
  }, 'sequential-group-add');

  const removeEmptyLensTrain = (sequenceId: string) => commit((draft) => {
    const sequence = draft.blockSequences.find((entry) => entry.id === sequenceId);
    if (!sequence || sequence.blocks.length > 0 || draft.blockSequences.length <= 1) return;
    const componentId = sequenceId.replace(/^sequential:/, 'sequential-group:');
    draft.blockSequences = draft.blockSequences.filter((entry) => entry.id !== sequenceId);
    draft.components = draft.components.filter((component) => component.id !== componentId);
    draft.connections = draft.connections.filter((connection) => connection.fromComponentId !== componentId && connection.toComponentId !== componentId);
  }, 'sequential-group-delete');

  const exactBlockCount = design.blockSequences.reduce((sum, sequence) => sum + sequence.blocks.length, 0);
  const selectedComponent = componentById.get(selectedComponentId);
  const isLegacyRouted = design.routingMode === 'engineered-paths';
  const checkErrors = compiledSystem?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const checkWarnings = compiledSystem?.issues.filter((issue) => issue.severity === 'warning') ?? [];
  const formattedMemory = compiledSystem
    ? compiledSystem.estimatedWorkingBytes >= 1024 ** 3
      ? `${(compiledSystem.estimatedWorkingBytes / 1024 ** 3).toFixed(2)} GiB`
      : `${Math.max(1, Math.round(compiledSystem.estimatedWorkingBytes / 1024 ** 2))} MiB`
    : '—';

  return <div className="di-hybrid-summary di-unified-system" aria-label="Optical System">
    <div className="di-system-header">
      <div className="di-system-header__title">
        <strong>Optical System</strong>
        <span>One physical design for exact lens analysis, branching, Render and Detector signal.</span>
      </div>
      <div className="di-system-header__metrics" aria-label="Optical System summary">
        <span><b>{exactBlockCount}</b> exact Blocks</span>
        <span><b>{routingParts.length}</b> routing parts</span>
        <span><b>{detectors.length}</b> Detectors</span>
      </div>
    </div>

    {isLegacyRouted ? <div className="di-system-legacy-note">
      <span><strong>Saved path compatibility</strong>This imported design still follows its authored Port routes.</span>
      <button type="button" onClick={() => commit((draft) => { draft.routingMode = 'automatic-scene'; }, 'assembly-use-unified-system')}>Use unified tracing</button>
    </div> : null}

    <section className="di-system-flow" aria-label="System Flow">
      <header>
        <span><strong>System Flow</strong><small>Click a component to edit it in Blocks. Lens trains use the exact sequential tracer automatically.</small></span>
        <em>{flowLanes.length} {flowLanes.length === 1 ? 'path' : 'paths'}</em>
      </header>
      <div className="di-system-flow__lanes">
        {visibleLanes.map((lane, laneIndex) => <div className="di-system-flow__lane" key={lane.id}>
          <span className="di-system-flow__lane-label">{lane.label || `Path ${laneIndex + 1}`}</span>
          <div className="di-system-flow__chain">
            {lane.ids.map((componentId, index) => {
              const component = componentById.get(componentId);
              if (!component) return null;
              const sequence = sequenceByComponentId.get(componentId);
              return <span className="di-system-flow__step" key={`${lane.id}-${componentId}-${index}`}>
                <button
                  type="button"
                  className={`di-system-node is-${component.kind}${selectedComponentId === componentId ? ' is-selected' : ''}`}
                  onClick={() => focusComponent(componentId)}
                  title={`Edit ${displayLabel(componentId)}`}
                >
                  <span>{SYSTEM_KIND_LABELS[component.kind] || component.kind}</span>
                  <strong>{displayLabel(componentId)}</strong>
                  {sequence ? <small>{sequence.blocks.length} exact {sequence.blocks.length === 1 ? 'Block' : 'Blocks'}</small> : null}
                </button>
                {index < lane.ids.length - 1 ? <i aria-hidden="true">→</i> : null}
              </span>;
            })}
          </div>
        </div>)}
        {flowLanes.length > visibleLanes.length ? <div className="di-system-flow__more">+ {flowLanes.length - visibleLanes.length} additional paths are traced automatically</div> : null}
        {fallbackIds.length === 0 ? <div className="di-connection-empty">Add a Source, optical Blocks and a Detector above.</div> : null}
      </div>
    </section>

    <div className="di-system-workflow" aria-label="Optical System workflow">
      <span><b>1</b><strong>Build</strong>Add and order Blocks above.</span>
      <span><b>2</b><strong>Edit</strong>{selectedComponent ? displayLabel(selectedComponent.id) : 'Select a component in the flow.'}</span>
      <span><b>3</b><strong>Analyze</strong>The analysis chooses exact or scene tracing.</span>
    </div>

    {compiledSystem ? <section className={`di-system-check is-${compiledSystem.status}`} aria-label="System Check">
      <header>
        <span>
          <strong>System Check</strong>
          <small>Blocks compile into the paths shared by Render, Signal and Optimize.</small>
        </span>
        <em>{compiledSystem.status === 'ready' ? 'Ready' : compiledSystem.status === 'warning' ? `${checkWarnings.length} warnings` : `${checkErrors.length} errors`}</em>
      </header>
      <div className="di-system-check__summary">
        <span><b>{compiledSystem.paths.length}</b> compiled paths</span>
        <span><b>{compiledSystem.detectors.length}</b> receivers</span>
        <span><b>{formattedMemory}</b> estimated working memory</span>
        <span><b>{compiledSystem.routeSource === 'physical-scene' ? 'Physical scene' : compiledSystem.routeSource === 'saved-paths' ? 'Stored branch hints' : 'Compatibility fallback'}</b></span>
      </div>
      {compiledSystem.issues.length ? <div className="di-system-check__issues">
        {compiledSystem.issues.map((issue) => <button
          type="button"
          className={`is-${issue.severity}`}
          key={issue.id}
          onClick={() => issue.componentId && focusComponent(issue.componentId)}
          disabled={!issue.componentId}
        >
          <span>{issue.severity === 'error' ? 'Error' : issue.severity === 'warning' ? 'Check' : 'Info'}</span>
          <strong>{issue.title}</strong>
          <small>{issue.message}</small>
        </button>)}
      </div> : <p className="di-system-check__ready">Every Source and Detector has a complete compiled path. Run verifies apertures and detector-pixel hits.</p>}
    </section> : null}

    <details className="di-system-engineering">
      <summary><span><strong>Engineering</strong><small>Open only for compound Lens train placement or legacy design migration.</small></span><em>{design.blockSequences.length}</em></summary>
      <div className="di-system-engineering__body">
        <div className="di-system-engineering__heading">
          <span><strong>Lens train placement</strong><small>Optical prescription Blocks remain in the main Blocks editor.</small></span>
          <button type="button" onClick={addLensTrain}>Add lens train</button>
        </div>
        <div className="di-system-lens-list">
          {design.blockSequences.map((sequence, index) => {
            const pose = sequence.manualOffset ?? sequence.rootTransform;
            return <details className="di-system-lens" key={sequence.id}>
              <summary>
                <span><strong>{lensDesignLabel(sequence.label, `Lens train ${index + 1}`).replace(/^Lens\s+design\b/i, 'Lens train')}</strong><small>{sequence.blocks.length} exact {sequence.blocks.length === 1 ? 'Block' : 'Blocks'} · Front ↔ Back</small></span>
                <em>XYZ {Number(pose?.positionMm?.x ?? 0).toFixed(1)}, {Number(pose?.positionMm?.y ?? 0).toFixed(1)}, {Number(pose?.positionMm?.z ?? 0).toFixed(1)} mm</em>
              </summary>
              <div className="di-system-lens__body">
                <label className="di-control-field"><span>Name</span><input value={lensDesignLabel(sequence.label, `Lens train ${index + 1}`).replace(/^Lens\s+design\b/i, 'Lens train')} onChange={(event) => commit((draft) => {
                  const target = draft.blockSequences.find((entry) => entry.id === sequence.id);
                  if (target) target.label = event.target.value || `Lens train ${index + 1}`;
                }, 'sequential-group-label')} /></label>
                <div className="di-route-variable-grid" aria-label={`${sequence.label} pose variables`}>{([
                  ['positionX', 'X (mm)', 'positionMm', 'x'], ['positionY', 'Y (mm)', 'positionMm', 'y'], ['positionZ', 'Z (mm)', 'positionMm', 'z'],
                  ['rotationX', 'RX (°)', 'rotationDeg', 'x'], ['rotationY', 'RY (°)', 'rotationDeg', 'y'], ['rotationZ', 'RZ (°)', 'rotationDeg', 'z'],
                ] as const).map(([key, label, section, axis]) => {
                  const variable = (sequence.rootTransformVariables as any)?.[key];
                  const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
                  return <label key={key}><span>{label}</span><input type="number" step="0.1" value={Number((pose as any)?.[section]?.[axis] ?? 0)} onChange={(event) => commit((draft) => {
                    const target = draft.blockSequences.find((entry) => entry.id === sequence.id) as any;
                    if (!target) return;
                    target.manualOffset ??= JSON.parse(JSON.stringify(target.rootTransform));
                    target.manualOffset[section][axis] = Number(event.target.value) || 0;
                  }, 'sequential-group-pose')} /><button type="button" className={`di-variable-mode ${mode === 'V' ? 'is-variable' : ''}`} onClick={() => commit((draft) => {
                    const target = draft.blockSequences.find((entry) => entry.id === sequence.id) as any;
                    if (!target) return;
                    target.rootTransformVariables ??= {};
                    const targetPose = target.manualOffset ?? target.rootTransform;
                    target.rootTransformVariables[key] = { value: Number(targetPose[section][axis] ?? 0), optimize: { ...(target.rootTransformVariables[key]?.optimize ?? {}), mode: mode === 'V' ? 'F' : 'V' } };
                  }, 'sequential-group-variable')}>{mode}</button></label>;
                })}</div>
                <button type="button" className="di-connection-remove is-danger" onClick={() => removeEmptyLensTrain(sequence.id)} disabled={sequence.blocks.length > 0 || design.blockSequences.length <= 1}>Remove empty train</button>
              </div>
            </details>;
          })}
        </div>
        {(design.connections.length || (design.portRoutes?.length ?? 0) || (design.routeSets?.length ?? 0)) ? <p className="di-system-derived-note">Internal routing data is retained for compatibility and optimization, but is generated or inferred from the physical system and is not edited in the normal workflow.</p> : null}
      </div>
    </details>
    {error ? <div className="di-connection-error" role="alert">{error}</div> : null}
  </div>;
}

function LegacyHybridAssemblySummary() {
  const [snapshot, setSnapshot] = useState<ActiveCoherentDesignSnapshot>(() => readActiveCoherentDesign());
  const [error, setError] = useState('');
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [pathDraft, setPathDraft] = useState<string[]>([]);
  const [splitterOutputPort, setSplitterOutputPort] = useState<'transmit' | 'reflect' | 'recombine'>('transmit');
  const [pathBuilderMessage, setPathBuilderMessage] = useState('');
  const engineeringViewRef = useRef<HTMLDetailsElement>(null);
  const revealPlacementException = (connectionId: string) => {
    if (!connectionId) return;
    setSelectedConnectionId(connectionId);
    if (engineeringViewRef.current) engineeringViewRef.current.open = true;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.querySelector(`[data-design-connection-id="${CSS.escape(connectionId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  };
  useEffect(() => subscribeActiveCoherentDesign((next) => setSnapshot(next)), []);
  useEffect(() => {
    setPathDraft([]);
    setPathBuilderMessage('');
  }, [snapshot.configId]);
  useEffect(() => {
    const selectConnection = (event: Event) => {
      const connectionId = String((event as CustomEvent<{ connectionId?: string }>).detail?.connectionId ?? '');
      if (!connectionId) return;
      revealPlacementException(connectionId);
    };
    window.addEventListener(DESIGN_CONNECTION_SELECTED_EVENT, selectConnection);
    return () => window.removeEventListener(DESIGN_CONNECTION_SELECTED_EVENT, selectConnection);
  }, []);
  const physical = snapshot.design.components.filter((component) => component.kind !== 'sequential-group');
  const sequentialComponents = snapshot.design.components.filter((component) => component.kind === 'sequential-group');
  const detectors = physical.filter((component) => component.kind === 'detector' || component.kind === 'time-detector');
  const connectable = [...physical, ...sequentialComponents];
  const sequential = sequentialComponents.length > 0;
  const routes = snapshot.design.portRoutes ?? [];
  const routeSets = snapshot.design.routeSets ?? [];
  const placementExceptions = snapshot.design.connections.filter((connection) => connection.placementOverride === true);
  const automaticConnections = snapshot.design.connections.filter((connection) => connection.placementOverride !== true);
  const exceptionCandidateId = automaticConnections.some((connection) => connection.id === selectedConnectionId)
    ? selectedConnectionId
    : (automaticConnections[0]?.id ?? '');

  const commit = (mutate: (draft: ActiveCoherentDesignSnapshot['design']) => void, reason: string) => {
    try {
      const draft = JSON.parse(JSON.stringify(snapshot.design)) as ActiveCoherentDesignSnapshot['design'];
      mutate(draft);
      updateActiveCoherentDesign(draft, reason);
      setSnapshot(readActiveCoherentDesign());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const componentById = (id: string) => connectable.find((component) => component.id === id);
  const componentLabel = (component: (typeof connectable)[number] | undefined, fallback = '') => {
    if (component?.kind !== 'sequential-group') return component?.label ?? fallback;
    const key = String(component.id ?? '').replace(/^sequential-group:/, '');
    const index = snapshot.design.blockSequences.findIndex((sequence) => String(sequence.id ?? '').replace(/^sequential:/, '') === key);
    const authoredLabel = lensDesignLabel(component.label);
    const label = !authoredLabel || authoredLabel === 'Exact sequential optics'
      ? (index <= 0 ? 'Main lens train' : `Lens train ${index + 1}`)
      : authoredLabel;
    return /^Lens\s+design\b/i.test(label) ? label : `Lens design · ${label}`;
  };
  const sequenceBlockLabel = (block: unknown, index: number) => {
    if (!block || typeof block !== 'object') return `Block ${index + 1}`;
    const entry = block as { blockId?: unknown; blockType?: unknown; metadata?: { label?: unknown } };
    return String(entry.metadata?.label ?? '').trim()
      || String(entry.blockId ?? '').trim()
      || `${String(entry.blockType ?? 'Block').trim() || 'Block'} ${index + 1}`;
  };
  const routeEndpoint = (route: (typeof routes)[number], side: 'source' | 'detector') => {
    const step = side === 'source' ? route.steps[0] : route.steps[route.steps.length - 1];
    const connection = snapshot.design.connections.find((entry) => entry.id === step?.connectionId);
    if (!connection) return side === 'source' ? route.sourceBlockId || 'Source' : route.detectorBlockId || 'Detector';
    const blockId = side === 'source'
      ? (step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId)
      : (step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId);
    return componentLabel(componentById(blockId), blockId);
  };
  const routeComponentIds = (route: (typeof routes)[number]) => {
    const componentIds: string[] = [];
    for (const step of route.steps) {
      const connection = snapshot.design.connections.find((entry) => entry.id === step.connectionId);
      if (!connection) continue;
      const departure = step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId;
      const arrival = step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId;
      if (componentIds[componentIds.length - 1] !== departure) componentIds.push(departure);
      componentIds.push(arrival);
    }
    return componentIds;
  };
  const routeComponentChain = (route: (typeof routes)[number]) => routeComponentIds(route)
    .map((componentId) => componentLabel(componentById(componentId), componentId));
  const routeRole = (routeId: string) => {
    const set = routeSets.find((entry) => entry.routeIds.includes(routeId));
    if (set?.measurementRouteId === routeId) return 'Measurement';
    if (set?.referenceRouteId === routeId) return 'Reference';
    return set ? 'LO / Auxiliary' : 'Unassigned';
  };
  const defaultPort = (componentId: string, side: 'from' | 'to') => {
    const component = componentById(componentId);
    const preferred = side === 'from'
      ? ['emit', 'transmit', 'specular', 'order+1', 'back', 'out']
      : ['detect', 'common', 'incident', 'front', 'in'];
    return preferred.find((id) => component?.ports.some((port) => port.id === id))
      ?? component?.ports[side === 'from' ? Math.max(0, component.ports.length - 1) : 0]?.id
      ?? '';
  };
  const setPlacementMode = (
    draft: ActiveCoherentDesignSnapshot['design'],
    connectionId: string,
    mode: 'automatic' | 'override' | 'fixed',
  ) => {
    const target = draft.connections.find((connection) => connection.id === connectionId);
    if (!target) return;
    if (mode === 'override') {
      const initialized = getConnectionLayoutParameters(draft, target);
      if (initialized) Object.assign(target, initialized);
      target.autoPlace = true;
      target.placementOverride = true;
      return;
    }
    target.autoPlace = mode === 'automatic';
    target.placementOverride = false;
    const variables = target.variables as Record<string, unknown> | undefined;
    if (variables) {
      delete variables.distanceMm;
      delete variables.azimuthDeg;
      delete variables.elevationDeg;
      if (Object.keys(variables).length === 0) delete target.variables;
    }
  };
  const addConnection = (fromId?: string, fromPortId?: string) => {
    if (connectable.length < 2) return;
    const from = componentById(fromId ?? '') ?? connectable[0];
    const to = connectable.find((component) => component.id !== from.id) ?? connectable[1];
    const passive = (component: typeof from) => !['source', 'detector', 'time-detector'].includes(component.kind);
    commit((draft) => {
      draft.connections.push({
        id: `connection-${Date.now().toString(36)}`,
        fromComponentId: from.id,
        fromPortId: fromPortId ?? defaultPort(from.id, 'from'),
        toComponentId: to.id,
        toPortId: defaultPort(to.id, 'to'),
        distanceMm: 10,
        allowReverse: passive(from) && passive(to),
        autoPlace: true,
        placementOverride: true,
        pathId: fromPortId === 'reflect' ? 'reflect' : 'main',
      });
    }, 'connection-add');
  };
  const appendPathComponent = (componentId: string) => {
    setPathDraft((current) => [...current, componentId]);
    setPathBuilderMessage('');
  };
  const createPathFromDraft = () => {
    if (pathDraft.length < 2) {
      setError('Choose at least two Blocks in traversal order.');
      return;
    }
    const chain = [...pathDraft];
    const stamp = Date.now().toString(36);
    let createdLinks = 0;
    let routeWasCreated = false;
    commit((draft) => {
      const routeId = `route-${stamp}`;
      const passive = (componentId: string) => {
        const component = componentById(componentId);
        return component ? !['source', 'detector', 'time-detector'].includes(component.kind) : false;
      };
      const nextConnectionId = () => {
        let id = `connection-${stamp}-${createdLinks + 1}`;
        while (draft.connections.some((connection) => connection.id === id)) {
          createdLinks += 1;
          id = `connection-${stamp}-${createdLinks + 1}`;
        }
        return id;
      };
      const steps: NonNullable<typeof draft.portRoutes>[number]['steps'] = [];
      for (let index = 0; index < chain.length - 1; index += 1) {
        const fromId = chain[index];
        const toId = chain[index + 1];
        if (!fromId || !toId || fromId === toId) continue;
        const fromComponent = componentById(fromId);
        const toComponent = componentById(toId);
        const returningThroughSplitter = fromComponent?.kind === 'beam-splitter'
          && (chain.slice(0, index).includes(fromId) || ['detector', 'time-detector'].includes(toComponent?.kind ?? ''));
        const requestedFromPort = fromComponent?.kind === 'beam-splitter'
          ? (returningThroughSplitter ? 'recombine' : splitterOutputPort)
          : defaultPort(fromId, 'from');
        const requestedToPort = defaultPort(toId, 'to');
        const directCandidates = draft.connections.filter((connection) => (
          connection.fromComponentId === fromId && connection.toComponentId === toId
        ));
        const direct = directCandidates.find((connection) => (
          connection.fromPortId === requestedFromPort && connection.toPortId === requestedToPort
        )) ?? (fromComponent?.kind === 'beam-splitter' ? undefined : directCandidates[0]);
        if (direct) {
          steps.push({ connectionId: direct.id, direction: 'forward' });
          continue;
        }
        const reverse = draft.connections.find((connection) => (
          connection.fromComponentId === toId
          && connection.toComponentId === fromId
          && connection.allowReverse === true
        ));
        if (reverse) {
          steps.push({ connectionId: reverse.id, direction: 'reverse' });
          continue;
        }
        const connectionId = nextConnectionId();
        draft.connections.push({
          id: connectionId,
          fromComponentId: fromId,
          fromPortId: requestedFromPort,
          toComponentId: toId,
          toPortId: requestedToPort,
          distanceMm: 10,
          allowReverse: passive(fromId) && passive(toId),
          autoPlace: true,
          placementOverride: false,
          pathId: routeId,
        });
        createdLinks += 1;
        steps.push({ connectionId, direction: 'forward' });
      }
      if (steps.length === 0) throw new Error('The selected order does not contain a valid connection.');
      draft.portRoutes ??= [];
      const signature = steps.map((step) => `${step.connectionId}:${step.direction}`).join('|');
      const existingRoute = draft.portRoutes.find((route) => (
        route.steps.map((step) => `${step.connectionId}:${step.direction}`).join('|') === signature
      ));
      let savedRouteId = routeId;
      if (existingRoute) {
        existingRoute.enabled = true;
        savedRouteId = existingRoute.id;
      } else {
        const first = componentById(chain[0]);
        const last = componentById(chain[chain.length - 1] ?? '');
        draft.portRoutes.push({
          id: routeId,
          label: `Optical path ${draft.portRoutes.length + 1}`,
          enabled: true,
          sourceBlockId: first?.kind === 'source' ? first.id : undefined,
          detectorBlockId: last && ['detector', 'time-detector'].includes(last.kind) ? last.id : undefined,
          steps,
        });
        routeWasCreated = true;
      }
      const last = componentById(chain[chain.length - 1] ?? '');
      if (last && ['detector', 'time-detector'].includes(last.kind)) {
        draft.routeSets ??= [];
        let set = draft.routeSets.find((entry) => entry.detectorBlockId === last.id);
        if (!set) {
          set = { id: `route-set-${stamp}`, label: `${componentLabel(last)} signal`, detectorBlockId: last.id, routeIds: [] };
          draft.routeSets.push(set);
        }
        if (!set.routeIds.includes(savedRouteId)) set.routeIds.push(savedRouteId);
        if (!set.measurementRouteId) set.measurementRouteId = savedRouteId;
        else if (!set.referenceRouteId && set.measurementRouteId !== savedRouteId) set.referenceRouteId = savedRouteId;
      }
    }, 'path-and-connections-add');
    setPathDraft([]);
    setPathBuilderMessage(`${routeWasCreated ? 'Optical path created' : 'Existing optical path reused'} · ${createdLinks} missing ${createdLinks === 1 ? 'link' : 'links'} added.`);
  };
  const splitter = physical.find((component) => component.kind === 'beam-splitter');
  const addSequentialGroup = () => commit((draft) => {
    const keys = new Set((draft.blockSequences ?? []).map((sequence) => String(sequence.id).replace(/^sequential:/, '')));
    let ordinal = Math.max(2, keys.size + 1);
    while (keys.has(`group-${ordinal}`)) ordinal += 1;
    draft.blockSequences.push({
      id: `sequential:group-${ordinal}`,
      label: `Lens design ${ordinal}`,
      pathId: `group-${ordinal}`,
      blocks: [],
      manualOffset: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
      rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
    });
  }, 'sequential-group-add');
  const removeSequentialGroup = (sequenceId: string) => commit((draft) => {
    const sequence = draft.blockSequences.find((entry) => entry.id === sequenceId);
    if (!sequence || sequence.blocks.length > 0 || draft.blockSequences.length <= 1) return;
    const componentId = sequenceId.replace(/^sequential:/, 'sequential-group:');
    draft.blockSequences = draft.blockSequences.filter((entry) => entry.id !== sequenceId);
    draft.components = draft.components.filter((component) => component.id !== componentId);
    draft.connections = draft.connections.filter((connection) => (
      connection.fromComponentId !== componentId && connection.toComponentId !== componentId
    ));
  }, 'sequential-group-delete');
  const automaticRouting = snapshot.design.routingMode === 'automatic-scene';
  if (automaticRouting) return <div className="di-hybrid-summary is-automatic" aria-label="Automatic optical assembly status">
    <div className="di-assembly-overview">
      <div className="di-assembly-overview__title"><strong>Optical Assembly</strong><span>Build the physical scene; rays find the next surface and Detector automatically.</span></div>
      <label className="di-routing-mode"><span>Tracing</span><select value="automatic-scene" onChange={(event) => commit((draft) => { draft.routingMode = event.target.value as 'automatic-scene' | 'engineered-paths'; }, 'assembly-routing-mode')}><option value="automatic-scene">Automatic scene trace</option><option value="engineered-paths">Engineered paths</option></select></label>
      <div className="di-hybrid-summary__metrics">
        <span>{physical.length} physical Blocks</span>
        <span>{sequentialComponents.length} exact lens {sequentialComponents.length === 1 ? 'design' : 'designs'}</span>
        <span>{detectors.length} {detectors.length === 1 ? 'Detector' : 'Detectors'}</span>
      </div>
    </div>
    <div className="di-auto-routing-note"><strong>No Port wiring is required.</strong><span>Beam Splitters branch automatically; mirrors and Targets reflect; gratings diffract; each exact Lens design is traversed Front↔Back as one physical component.</span></div>
    <div className="di-assembly-guide" aria-label="Automatic Optical Assembly setup steps">
      <div><span>1</span><strong>Blocks</strong><small>Add Sources, optics, Targets and Detectors in the table above.</small></div>
      <div><span>2</span><strong>Lens designs</strong><small>Group each continuous exact surface prescription once.</small></div>
      <div><span>3</span><strong>Detector signals</strong><small>Run Coherent Signal; route roles are inferred from the encountered parts.</small></div>
    </div>
    <section className="di-assembly-main di-auto-block-summary" aria-label="Assembly Blocks">
      <div className="di-assembly-main__header"><span><strong>1 · Blocks</strong><small>The block list above is the physical scene. XYZ and rotation determine what a ray can hit.</small></span><em>{physical.length}</em></div>
      <div className="di-auto-component-kinds">
        {physical.map((component) => <span key={component.id}>{component.label}</span>)}
      </div>
    </section>
    <section className="di-assembly-main di-assembly-lens-designs" aria-label="Lens designs">
      <div className="di-assembly-main__header"><span><strong>2 · Lens designs</strong><small>Optical Blocks stay in the table above. Open only to change the compound component pose.</small></span><em>{sequentialComponents.length}</em></div>
      <div className="di-lens-design-summary-list">
        {snapshot.design.blockSequences.map((sequence, index) => {
          const pose = sequence.manualOffset ?? sequence.rootTransform;
          const position = pose?.positionMm ?? { x: 0, y: 0, z: 0 };
          const rotation = pose?.rotationDeg ?? { x: 0, y: 0, z: 0 };
          return <details className="di-lens-design-summary" key={sequence.id}>
            <summary>
              <span className="di-sequential-group-index">{index + 1}</span>
              <span className="di-lens-design-summary__identity"><strong>{lensDesignLabel(sequence.label, `Lens design ${index + 1}`)}</strong><small>{sequence.blocks.length} {sequence.blocks.length === 1 ? 'Block' : 'Blocks'} · Front ↔ Back</small></span>
              <span className={`di-lens-placement-blocks${sequence.blocks.length === 0 ? ' is-empty' : ''}`} aria-label={`${sequence.label} Blocks`}>
                {sequence.blocks.length === 0 ? 'No Blocks yet' : sequence.blocks.map((block, blockIndex) => {
                  const label = sequenceBlockLabel(block, blockIndex);
                  return <span key={String((block as { blockId?: unknown })?.blockId ?? blockIndex)} title={label}><b>{blockIndex + 1}</b>{label}</span>;
                })}
              </span>
              <span className="di-lens-design-summary__placement">XYZ {Number(position.x ?? 0).toFixed(1)}, {Number(position.y ?? 0).toFixed(1)}, {Number(position.z ?? 0).toFixed(1)} mm · R {Number(rotation.x ?? 0).toFixed(1)}, {Number(rotation.y ?? 0).toFixed(1)}, {Number(rotation.z ?? 0).toFixed(1)}°</span>
            </summary>
            <div className="di-lens-design-summary__body">
              <label className="di-control-field"><span>Name</span><input value={lensDesignLabel(sequence.label, `Lens design ${index + 1}`)} onChange={(event) => commit((draft) => {
                const target = draft.blockSequences.find((entry) => entry.id === sequence.id);
                if (target) target.label = event.target.value || `Lens design ${index + 1}`;
              }, 'sequential-group-label')} /></label>
              <div className="di-route-variable-grid" aria-label={`${sequence.label} pose variables`}>{([
                ['positionX', 'X (mm)', 'positionMm', 'x'], ['positionY', 'Y (mm)', 'positionMm', 'y'], ['positionZ', 'Z (mm)', 'positionMm', 'z'],
                ['rotationX', 'RX (°)', 'rotationDeg', 'x'], ['rotationY', 'RY (°)', 'rotationDeg', 'y'], ['rotationZ', 'RZ (°)', 'rotationDeg', 'z'],
              ] as const).map(([key, label, section, axis]) => {
                const variable = (sequence.rootTransformVariables as any)?.[key];
                const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
                return <label key={key}><span>{label}</span><input type="number" step="0.1" value={Number((pose as any)?.[section]?.[axis] ?? 0)} onChange={(event) => commit((draft) => {
                  const target = draft.blockSequences.find((entry) => entry.id === sequence.id) as any;
                  if (!target) return;
                  target.manualOffset ??= JSON.parse(JSON.stringify(target.rootTransform));
                  target.manualOffset[section][axis] = Number(event.target.value) || 0;
                }, 'sequential-group-pose')} /><button type="button" className={`di-variable-mode ${mode === 'V' ? 'is-variable' : ''}`} onClick={() => commit((draft) => {
                  const target = draft.blockSequences.find((entry) => entry.id === sequence.id) as any;
                  if (!target) return;
                  target.rootTransformVariables ??= {};
                  const targetPose = target.manualOffset ?? target.rootTransform;
                  target.rootTransformVariables[key] = { value: Number(targetPose[section][axis] ?? 0), optimize: { ...(target.rootTransformVariables[key]?.optimize ?? {}), mode: mode === 'V' ? 'F' : 'V' } };
                }, 'sequential-group-variable')}>{mode}</button></label>;
              })}</div>
              <button type="button" className="di-connection-remove is-danger" onClick={() => removeSequentialGroup(sequence.id)} disabled={sequence.blocks.length > 0 || snapshot.design.blockSequences.length <= 1}>Remove empty design</button>
            </div>
          </details>;
        })}
        <button type="button" className="di-lens-design-add" onClick={addSequentialGroup}>Add lens design</button>
      </div>
    </section>
    <section className="di-assembly-main di-assembly-signals" aria-label="Detector signals">
      <div className="di-assembly-main__header"><span><strong>3 · Detector signals</strong><small>Every physical Detector is collected automatically. Target and Grating histories determine Measurement and Reference roles.</small></span><em>{detectors.length}</em></div>
      <div className="di-auto-detector-list">
        {detectors.length === 0 ? <div className="di-connection-empty">Add an Area Detector or Time Detector Block.</div> : detectors.map((detector) => {
          const set = routeSets.find((entry) => entry.detectorBlockId === detector.id);
          return <div className="di-auto-detector" key={detector.id}><strong>{detector.label}</strong><span>{set?.measurementRouteId ? 'Measurement' : 'Measurement pending'}</span><span>{set?.referenceRouteId ? 'Reference' : 'Reference pending'}</span><em>{set?.routeIds.length ?? 0} signal branches</em></div>;
        })}
      </div>
    </section>
    {error ? <div className="di-connection-error" role="alert">{error}</div> : null}
  </div>;
  return <div className="di-hybrid-summary" aria-label="Hybrid optical assembly status">
    <div className="di-assembly-overview">
      <div className="di-assembly-overview__title"><strong>Optical Assembly</strong><span>After building the Blocks above, place them and define complete Source-to-Detector paths.</span></div>
      <label className="di-routing-mode"><span>Tracing</span><select value="engineered-paths" onChange={(event) => commit((draft) => { draft.routingMode = event.target.value as 'automatic-scene' | 'engineered-paths'; }, 'assembly-routing-mode')}><option value="automatic-scene">Automatic scene trace</option><option value="engineered-paths">Engineered paths</option></select></label>
      <div className="di-hybrid-summary__metrics">
      {sequential ? <span>{sequentialComponents.length} lens {sequentialComponents.length === 1 ? 'design' : 'designs'}</span> : null}
      <span>{physical.length} physical Blocks</span>
      <span>{routes.length} optical {routes.length === 1 ? 'path' : 'paths'}</span>
      <span>{routeSets.length} detector {routeSets.length === 1 ? 'signal' : 'signals'}</span>
      </div>
    </div>
    <div className="di-assembly-guide" aria-label="Optical Assembly setup steps">
      <div><span>1</span><strong>Lens designs</strong><small>Confirm which Blocks form each exact lens train.</small></div>
      <div><span>2</span><strong>Optical paths</strong><small>Choose the Source-to-Detector traversal order.</small></div>
      <div><span>3</span><strong>Detector signals</strong><small>Select the Detector, Measurement path, and Reference path.</small></div>
    </div>
    <section className="di-assembly-main di-assembly-lens-designs" aria-label="Lens designs">
      <div className="di-assembly-main__header"><span><strong>1 · Lens designs</strong><small>Open a design only when its name or physical pose needs to change. Its optical Blocks remain in the table above.</small></span><em>{sequentialComponents.length}</em></div>
      <div className="di-lens-design-summary-list">
        {snapshot.design.blockSequences.map((sequence, index) => {
          const pose = sequence.manualOffset ?? sequence.rootTransform;
          const position = pose?.positionMm ?? { x: 0, y: 0, z: 0 };
          const rotation = pose?.rotationDeg ?? { x: 0, y: 0, z: 0 };
          return <details className="di-lens-design-summary" key={sequence.id}>
            <summary>
              <span className="di-sequential-group-index">{index + 1}</span>
              <span className="di-lens-design-summary__identity"><strong>{lensDesignLabel(sequence.label, `Lens design ${index + 1}`)}</strong><small>{sequence.blocks.length} {sequence.blocks.length === 1 ? 'Block' : 'Blocks'} · Front → Back</small></span>
              <span className={`di-lens-placement-blocks${sequence.blocks.length === 0 ? ' is-empty' : ''}`} aria-label={`${sequence.label} Blocks`}>
                {sequence.blocks.length === 0 ? 'No Blocks yet' : sequence.blocks.map((block, blockIndex) => {
                  const label = sequenceBlockLabel(block, blockIndex);
                  return <span key={String((block as { blockId?: unknown })?.blockId ?? blockIndex)} title={label}><b>{blockIndex + 1}</b>{label}</span>;
                })}
              </span>
              <span className="di-lens-design-summary__placement">XYZ {Number(position.x ?? 0).toFixed(1)}, {Number(position.y ?? 0).toFixed(1)}, {Number(position.z ?? 0).toFixed(1)} mm · R {Number(rotation.x ?? 0).toFixed(1)}, {Number(rotation.y ?? 0).toFixed(1)}, {Number(rotation.z ?? 0).toFixed(1)}°</span>
            </summary>
            <div className="di-lens-design-summary__body">
              <label className="di-control-field"><span>Name</span><input value={lensDesignLabel(sequence.label, `Lens design ${index + 1}`)} onChange={(event) => commit((draft) => {
                const target = draft.blockSequences.find((entry) => entry.id === sequence.id);
                if (target) target.label = event.target.value || `Lens design ${index + 1}`;
              }, 'sequential-group-label')} /></label>
              <div className="di-route-variable-grid" aria-label={`${sequence.label} pose variables`}>
                {([
                  ['positionX', 'X (mm)', 'positionMm', 'x'], ['positionY', 'Y (mm)', 'positionMm', 'y'], ['positionZ', 'Z (mm)', 'positionMm', 'z'],
                  ['rotationX', 'RX (°)', 'rotationDeg', 'x'], ['rotationY', 'RY (°)', 'rotationDeg', 'y'], ['rotationZ', 'RZ (°)', 'rotationDeg', 'z'],
                ] as const).map(([key, label, section, axis]) => {
                  const variable = (sequence.rootTransformVariables as any)?.[key];
                  const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
                  return <label key={key}><span>{label}</span><input type="number" step="0.1" value={Number((pose as any)?.[section]?.[axis] ?? 0)} onChange={(event) => commit((draft) => {
                    const target = draft.blockSequences.find((entry) => entry.id === sequence.id) as any;
                    if (!target) return;
                    target.manualOffset ??= JSON.parse(JSON.stringify(target.rootTransform));
                    target.manualOffset[section][axis] = Number(event.target.value) || 0;
                  }, 'sequential-group-pose')} /><button type="button" className={`di-variable-mode ${mode === 'V' ? 'is-variable' : ''}`} onClick={() => commit((draft) => {
                    const target = draft.blockSequences.find((entry) => entry.id === sequence.id) as any;
                    if (!target) return;
                    target.rootTransformVariables ??= {};
                    const targetPose = target.manualOffset ?? target.rootTransform;
                    target.rootTransformVariables[key] = { value: Number(targetPose[section][axis] ?? 0), optimize: { ...(target.rootTransformVariables[key]?.optimize ?? {}), mode: mode === 'V' ? 'F' : 'V' } };
                  }, 'sequential-group-variable')}>{mode}</button></label>;
                })}
              </div>
              <button type="button" className="di-connection-remove is-danger" onClick={() => removeSequentialGroup(sequence.id)} disabled={sequence.blocks.length > 0 || snapshot.design.blockSequences.length <= 1}>Remove empty design</button>
            </div>
          </details>;
        })}
        <button type="button" className="di-lens-design-add" onClick={addSequentialGroup}>Add lens design</button>
      </div>
    </section>
    <details className="di-assembly-advanced di-assembly-engineering" ref={engineeringViewRef}>
      <summary><span><strong>Engineering view</strong><small>Raw ports and connection records for troubleshooting or nonstandard routing.</small></span><em>Optional</em></summary>
      <div className="di-assembly-advanced__body">
    <section className="di-connection-editor di-layout-section">
      <header className="di-layout-section__header"><span><strong>Placement exceptions</strong><small>Only links whose automatic placement has been intentionally overridden are listed here.</small></span><em>{placementExceptions.length}</em></header>
      <div className="di-connection-editor__body">
        {placementExceptions.length === 0 ? <div className="di-connection-empty">No placement exceptions. Normal path links use their automatically initialized spacing and direction.</div> : null}
        {placementExceptions.map((connection) => {
          const index = snapshot.design.connections.findIndex((entry) => entry.id === connection.id);
          const from = componentById(connection.fromComponentId);
          const to = componentById(connection.toComponentId);
          return <div className={`di-connection-row${selectedConnectionId === connection.id ? ' is-selected' : ''}`} data-design-connection-id={connection.id} key={connection.id} onPointerDown={() => setSelectedConnectionId(connection.id)}>
            <div className="di-connection-path">
            <label className="di-control-field"><span>From component</span><select value={connection.fromComponentId} onChange={(event) => commit((draft) => {
              draft.connections[index].fromComponentId = event.target.value;
              draft.connections[index].fromPortId = defaultPort(event.target.value, 'from');
            }, 'connection-from')}>
              {connectable.map((component) => <option value={component.id} key={component.id}>{componentLabel(component)}</option>)}
            </select></label>
            <label className="di-control-field di-port-field"><span>Output</span><select value={connection.fromPortId ?? ''} onChange={(event) => commit((draft) => { draft.connections[index].fromPortId = event.target.value; }, 'connection-from-port')}>
              {(from?.ports ?? []).map((port) => <option value={port.id} key={port.id}>{port.label}</option>)}
            </select></label>
            <span className="di-connection-arrow" aria-hidden="true">→</span>
            <label className="di-control-field"><span>To component</span><select value={connection.toComponentId} onChange={(event) => commit((draft) => {
              draft.connections[index].toComponentId = event.target.value;
              draft.connections[index].toPortId = defaultPort(event.target.value, 'to');
            }, 'connection-to')}>
              {connectable.map((component) => <option value={component.id} key={component.id}>{componentLabel(component)}</option>)}
            </select></label>
            <label className="di-control-field di-port-field"><span>Input</span><select value={connection.toPortId ?? ''} onChange={(event) => commit((draft) => { draft.connections[index].toPortId = event.target.value; }, 'connection-to-port')}>
              {(to?.ports ?? []).map((port) => <option value={port.id} key={port.id}>{port.label}</option>)}
            </select></label>
            </div>
            <div className="di-connection-geometry">
            {([['distanceMm', 'Distance (mm)', 0.1], ['azimuthDeg', 'Azimuth (°)', 0.1], ['elevationDeg', 'Elevation (°)', 0.1]] as const).map(([key, label, step]) => {
              const variable = (connection.variables as any)?.[key];
              const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
              return <label className="di-control-field" key={key}><span>{label}</span><span className="di-variable-input"><input type="number" min={key === 'distanceMm' ? 0 : undefined} step={step} value={Number((connection as any)[key] ?? 0)} onChange={(event) => commit((draft) => {
                const value = Number(event.target.value) || 0;
                (draft.connections[index] as any)[key] = key === 'distanceMm' ? Math.max(0, value) : (key === 'elevationDeg' ? Math.max(-90, Math.min(90, value)) : value);
              }, `connection-${key}`)} /><button type="button" className={`di-variable-mode ${mode === 'V' ? 'is-variable' : ''}`} onClick={() => commit((draft) => {
                const target = draft.connections[index] as any;
                target.variables ??= {};
                target.variables[key] = { value: Number(target[key] ?? 0), optimize: { ...(target.variables[key]?.optimize ?? {}), mode: mode === 'V' ? 'F' : 'V' } };
              }, 'connection-variable')}>{mode}</button></span></label>;
            })}
            <label className="di-connection-reverse"><input type="checkbox" checked={connection.allowReverse === true} onChange={(event) => commit((draft) => { draft.connections[index].allowReverse = event.target.checked; }, 'connection-reverse')} />Bidirectional</label>
            <button type="button" className="di-connection-remove is-danger" onClick={() => commit((draft) => setPlacementMode(draft, connection.id, 'automatic'), 'connection-placement-automatic')}>Remove override</button>
            </div>
          </div>;
        })}
        <div className="di-connection-editor__actions">
          <label className="di-control-field di-placement-exception-picker"><span>Automatic link</span><select value={exceptionCandidateId} onChange={(event) => setSelectedConnectionId(event.target.value)} disabled={automaticConnections.length === 0}>
            {automaticConnections.length === 0 ? <option value="">All links have overrides</option> : automaticConnections.map((connection) => <option value={connection.id} key={connection.id}>{componentLabel(componentById(connection.fromComponentId), connection.fromComponentId)} → {componentLabel(componentById(connection.toComponentId), connection.toComponentId)}</option>)}
          </select></label>
          <button type="button" onClick={() => {
            commit((draft) => setPlacementMode(draft, exceptionCandidateId, 'override'), 'connection-placement-override');
            revealPlacementException(exceptionCandidateId);
          }} disabled={!exceptionCandidateId}>Override selected link</button>
          <button type="button" onClick={() => addConnection()} disabled={connectable.length < 2}>Add custom connection</button>
          {splitter ? <button type="button" onClick={() => addConnection(splitter.id, 'reflect')}>Add reflected connection</button> : null}
        </div>
        {error ? <div className="di-connection-error" role="alert">{error}</div> : null}
      </div>
    </section>
      </div>
    </details>
    <section className="di-assembly-main di-assembly-paths" aria-label="Optical paths">
      <div className="di-assembly-main__header"><span><strong>2 · Optical paths</strong><small>Choose Blocks in traversal order. Placement links are generated automatically.</small></span><em>{routes.length}</em></div>
      <div className="di-route-editor__body">
        <div className="di-route-editor__intro"><p>Choose Blocks in traversal order. Missing placement links and the complete Optical path are created together.</p><button type="button" onClick={() => { try { setSnapshot(detectActivePortRoutes()); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Detect from links</button></div>
        <div className="di-path-builder">
          <div className="di-path-builder__intro"><strong>Build a complete path</strong><span>Click the Source, intervening Blocks, and Detector in order. Click the same Block again for a return pass.</span></div>
          <div className="di-path-builder__palette" aria-label="Blocks available for a new optical path">
            {connectable.map((component) => {
              const uses = pathDraft.filter((id) => id === component.id).length;
              return <button type="button" key={component.id} className={uses > 0 ? 'is-used' : ''} onClick={() => appendPathComponent(component.id)}><span>+</span>{componentLabel(component)}{uses > 0 ? <em>{uses}</em> : null}</button>;
            })}
          </div>
          <div className={`di-path-builder__chain${pathDraft.length === 0 ? ' is-empty' : ''}`} aria-label="New optical path order">
            {pathDraft.length === 0 ? <span>Choose the Source, intervening Blocks, and Detector.</span> : pathDraft.map((componentId, index) => <span key={`${componentId}-${index}`}><b>{index + 1}</b>{componentLabel(componentById(componentId), componentId)}<button type="button" aria-label={`Remove ${componentLabel(componentById(componentId), componentId)} from path`} onClick={() => setPathDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}
          </div>
          <div className="di-path-builder__actions">
            {routes.length > 0 ? <label className="di-control-field"><span>Start from existing path</span><select value="" onChange={(event) => {
              const route = routes.find((entry) => entry.id === event.target.value);
              if (!route) return;
              setPathDraft(routeComponentIds(route));
              const splitterStep = route.steps.map((step) => ({ step, connection: snapshot.design.connections.find((connection) => connection.id === step.connectionId) }))
                .find(({ step, connection }) => step.direction === 'forward' && connection?.fromComponentId === splitter?.id);
              const port = splitterStep?.connection?.fromPortId;
              if (port === 'transmit' || port === 'reflect' || port === 'recombine') setSplitterOutputPort(port);
              setPathBuilderMessage('');
            }}><option value="">Copy path…</option>{routes.map((route) => <option value={route.id} key={route.id}>{route.label}</option>)}</select></label> : null}
            {splitter && pathDraft.includes(splitter.id) ? <label className="di-control-field"><span>First Beam Splitter output</span><select value={splitterOutputPort} onChange={(event) => setSplitterOutputPort(event.target.value as typeof splitterOutputPort)}><option value="transmit">Transmit</option><option value="reflect">Reflect</option><option value="recombine">Recombine</option></select></label> : null}
            <button type="button" className="di-primary-button" disabled={pathDraft.length < 2} onClick={createPathFromDraft}>Create optical path</button>
            <button type="button" disabled={pathDraft.length === 0} onClick={() => { setPathDraft([]); setPathBuilderMessage(''); }}>Clear</button>
          </div>
          {pathBuilderMessage ? <div className="di-path-builder__message" role="status">{pathBuilderMessage}</div> : null}
        </div>
        {routes.length === 0 ? <div className="di-connection-empty">No saved Optical path. Choose Blocks above, or detect paths from existing links.</div> : routes.map((route, routeIndex) => {
          const missingStep = route.steps.find((step) => !snapshot.design.connections.some((connection) => connection.id === step.connectionId));
          const routeIssue = (() => {
            if (missingStep) return `Connection ${missingStep.connectionId} was removed.`;
            let previousArrival = '';
            for (const step of route.steps) {
              const connection = snapshot.design.connections.find((entry) => entry.id === step.connectionId);
              if (!connection) continue;
              if (step.direction === 'reverse' && connection.allowReverse !== true) return `${connection.id} does not allow reverse traversal.`;
              const departure = step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId;
              const arrival = step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId;
              if (previousArrival && previousArrival !== departure) return `Route is discontinuous at ${departure}.`;
              previousArrival = arrival;
            }
            return '';
          })();
          return <div className={`di-route-row${routeIssue ? ' is-invalid' : ''}`} key={route.id}>
            <div className="di-route-row__header">
              <label><input type="checkbox" checked={route.enabled !== false} onChange={(event) => commit((draft) => { if (draft.portRoutes?.[routeIndex]) draft.portRoutes[routeIndex].enabled = event.target.checked; }, 'route-enable')} />Use</label>
              <input aria-label="Route name" value={route.label} onChange={(event) => commit((draft) => { if (draft.portRoutes?.[routeIndex]) draft.portRoutes[routeIndex].label = event.target.value || `Route ${routeIndex + 1}`; }, 'route-label')} />
              <span className="di-route-role">{routeRole(route.id)}</span>
              <button type="button" onClick={() => {
                try { localStorage.setItem(RENDER_SELECTED_ROUTE_STORAGE_KEY, route.id); } catch (_) {}
                window.dispatchEvent(new CustomEvent(OPTICAL_ROUTE_SELECTED_EVENT, { detail: { routeId: route.id } }));
              }}>Show in Render</button>
              <button type="button" onClick={() => commit((draft) => {
                const removedId = draft.portRoutes?.[routeIndex]?.id;
                draft.portRoutes?.splice(routeIndex, 1);
                for (const set of draft.routeSets ?? []) {
                  set.routeIds = set.routeIds.filter((id) => id !== removedId);
                  if (set.measurementRouteId === removedId) set.measurementRouteId = undefined;
                  if (set.referenceRouteId === removedId) set.referenceRouteId = undefined;
                }
              }, 'route-delete')}>Remove</button>
            </div>
            <div className="di-route-chain" aria-label={`${route.label} component order`}>
              {routeComponentChain(route).map((label, index, chain) => <span key={`${route.id}-${index}-${label}`}>{label}{index < chain.length - 1 ? <i aria-hidden="true">→</i> : null}</span>)}
            </div>
            <details className="di-route-geometry">
              <summary><span><strong>Path geometry</strong><small>Spacing and placement for the links used by this path.</small></span><em>{route.steps.length}</em></summary>
              <div className="di-path-segment-list">
                {route.steps.map((step, stepIndex) => {
                  const connectionIndex = snapshot.design.connections.findIndex((entry) => entry.id === step.connectionId);
                  const connection = snapshot.design.connections[connectionIndex];
                  if (!connection) return <div className="di-connection-error" role="alert" key={`${route.id}-geometry-${stepIndex}`}>Link {stepIndex + 1} is missing.</div>;
                  const departureId = step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId;
                  const arrivalId = step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId;
                  const sharedPathCount = routes.filter((candidate) => candidate.steps.some((candidateStep) => candidateStep.connectionId === connection.id)).length;
                  const autoPlace = connection.autoPlace !== false;
                  const placementOverride = autoPlace && connection.placementOverride === true;
                  const placementMode = !autoPlace ? 'fixed' : (placementOverride ? 'override' : 'automatic');
                  return <details className="di-path-segment" key={`${route.id}-geometry-${stepIndex}-${connection.id}`}>
                    <summary>
                      <span className="di-route-step__number">{stepIndex + 1}</span>
                      <span className="di-path-segment__identity"><strong>{componentLabel(componentById(departureId), departureId)} → {componentLabel(componentById(arrivalId), arrivalId)}</strong><small>{step.direction === 'reverse' ? 'Reverse traversal' : 'Forward traversal'}</small></span>
                      <span className="di-path-segment__distance">{Number(connection.distanceMm ?? 0).toFixed(2)} mm</span>
                      <span className={`di-path-segment__mode${autoPlace ? ' is-auto' : ''}${placementOverride ? ' is-override' : ''}`}>{placementMode === 'automatic' ? 'Automatic' : (placementMode === 'override' ? 'Override' : 'Fixed positions')}</span>
                      {sharedPathCount > 1 ? <span className="di-path-segment__shared">Shared by {sharedPathCount} paths</span> : null}
                    </summary>
                    <div className="di-path-segment__body">
                      {placementOverride ? ([['distanceMm', 'Distance (mm)', 0.1]] as const).map(([key, label, inputStep]) => {
                        const variable = (connection.variables as any)?.[key];
                        const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
                        return <label className="di-control-field" key={key}><span>{label}</span><span className="di-variable-input"><input type="number" min={0} step={inputStep} value={Number(connection.distanceMm ?? 0)} onChange={(event) => commit((draft) => {
                          const target = draft.connections.find((entry) => entry.id === connection.id) as any;
                          if (target) target.distanceMm = Math.max(0, Number(event.target.value) || 0);
                        }, 'connection-distanceMm')} /><button type="button" className={`di-variable-mode ${mode === 'V' ? 'is-variable' : ''}`} onClick={() => commit((draft) => {
                          const target = draft.connections.find((entry) => entry.id === connection.id) as any;
                          if (!target) return;
                          target.variables ??= {};
                          target.variables[key] = { value: Number(target[key] ?? 0), optimize: { ...(target.variables[key]?.optimize ?? {}), mode: mode === 'V' ? 'F' : 'V' } };
                        }, 'connection-variable')}>{mode}</button></span></label>;
                      }) : null}
                      <label className="di-control-field"><span>Placement</span><select value={placementMode} onChange={(event) => {
                        const nextMode = event.target.value as 'automatic' | 'override' | 'fixed';
                        commit((draft) => setPlacementMode(draft, connection.id, nextMode), 'connection-placement-mode');
                        if (nextMode === 'override') revealPlacementException(connection.id);
                      }}><option value="automatic">Automatic (read-only)</option><option value="override">Override placement</option><option value="fixed">Keep component positions</option></select></label>
                      {placementOverride ? ([['azimuthDeg', 'Azimuth (°)', -360, 360], ['elevationDeg', 'Elevation (°)', -90, 90]] as const).map(([key, label, min, max]) => {
                        const variable = (connection.variables as any)?.[key];
                        const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
                        return <label className="di-control-field" key={key}><span>{label}</span><span className="di-variable-input"><input type="number" min={min} max={max} step="0.1" value={Number((connection as any)[key] ?? 0)} onChange={(event) => commit((draft) => {
                          const target = draft.connections.find((entry) => entry.id === connection.id) as any;
                          if (!target) return;
                          const value = Number(event.target.value) || 0;
                          target[key] = key === 'elevationDeg' ? Math.max(-90, Math.min(90, value)) : value;
                        }, `connection-${key}`)} /><button type="button" className={`di-variable-mode ${mode === 'V' ? 'is-variable' : ''}`} onClick={() => commit((draft) => {
                          const target = draft.connections.find((entry) => entry.id === connection.id) as any;
                          if (!target) return;
                          target.variables ??= {};
                          target.variables[key] = { value: Number(target[key] ?? 0), optimize: { ...(target.variables[key]?.optimize ?? {}), mode: mode === 'V' ? 'F' : 'V' } };
                        }, 'connection-variable')}>{mode}</button></span></label>;
                      }) : <p className="di-path-segment__help">{autoPlace
                        ? `Automatic placement: ${Number(connection.distanceMm ?? 0).toFixed(2)} mm · Az ${Number(connection.azimuthDeg ?? 0).toFixed(1)}° · El ${Number(connection.elevationDeg ?? 0).toFixed(1)}°. Select Override placement to edit.`
                        : 'Distance and direction are derived from the stored positions of both Blocks.'}</p>}
                    </div>
                  </details>;
                })}
              </div>
            </details>
            <details className="di-route-definition">
              <summary>Advanced path definition · {route.steps.length} links · {routeEndpoint(route, 'source')} → {routeEndpoint(route, 'detector')}</summary>
              <div className="di-route-steps">
              {route.steps.map((step, stepIndex) => {
                const connection = snapshot.design.connections.find((entry) => entry.id === step.connectionId);
                return <div className={`di-route-step${connection ? '' : ' is-invalid'}`} key={`${route.id}-${stepIndex}`}>
                  <span className="di-route-step__number">{stepIndex + 1}</span>
                  <select aria-label={`Route ${route.label} step ${stepIndex + 1}`} value={step.connectionId} onChange={(event) => commit((draft) => { if (draft.portRoutes?.[routeIndex]) draft.portRoutes[routeIndex].steps[stepIndex].connectionId = event.target.value; }, 'route-step-connection')}>
                    {!connection ? <option value={step.connectionId}>Missing: {step.connectionId}</option> : null}
                    {snapshot.design.connections.map((option) => <option key={option.id} value={option.id}>{componentLabel(componentById(option.fromComponentId), option.fromComponentId)} → {componentLabel(componentById(option.toComponentId), option.toComponentId)}</option>)}
                  </select>
                  <select aria-label={`Route ${route.label} step ${stepIndex + 1} direction`} value={step.direction} onChange={(event) => commit((draft) => { if (draft.portRoutes?.[routeIndex]) draft.portRoutes[routeIndex].steps[stepIndex].direction = event.target.value as 'forward' | 'reverse'; }, 'route-step-direction')}>
                    <option value="forward">Forward</option>
                    <option value="reverse" disabled={connection?.allowReverse !== true}>Reverse</option>
                  </select>
                  <button type="button" disabled={stepIndex === 0} onClick={() => commit((draft) => { const steps = draft.portRoutes?.[routeIndex]?.steps; if (!steps || stepIndex === 0) return; [steps[stepIndex - 1], steps[stepIndex]] = [steps[stepIndex], steps[stepIndex - 1]]; }, 'route-step-up')}>↑</button>
                  <button type="button" disabled={stepIndex >= route.steps.length - 1} onClick={() => commit((draft) => { const steps = draft.portRoutes?.[routeIndex]?.steps; if (!steps || stepIndex >= steps.length - 1) return; [steps[stepIndex + 1], steps[stepIndex]] = [steps[stepIndex], steps[stepIndex + 1]]; }, 'route-step-down')}>↓</button>
                  <button type="button" onClick={() => commit((draft) => { draft.portRoutes?.[routeIndex]?.steps.splice(stepIndex, 1); }, 'route-step-delete')}>Remove</button>
                </div>;
              })}
              <button type="button" disabled={snapshot.design.connections.length === 0} onClick={() => commit((draft) => { draft.portRoutes?.[routeIndex]?.steps.push({ connectionId: snapshot.design.connections[0]?.id ?? '', direction: 'forward' }); }, 'route-step-add')}>Add step</button>
              </div>
            </details>
            {routeIssue ? <div className="di-connection-error" role="alert">{routeIssue}</div> : null}
          </div>;
        })}
      </div>
    </section>
    <section className="di-assembly-main di-assembly-signals" aria-label="Detector signals">
      <div className="di-assembly-main__header"><span><strong>3 · Detector signals</strong><small>Normally only these three selections are needed. Extra LO paths and calibration remain optional.</small></span><em>{routeSets.length}</em></div>
      <div className="di-signal-editor">
      <div className="di-signal-editor__body">
        <div className="di-route-sets">
          {routeSets.length === 0 ? <div className="di-connection-empty">No Detector signal is configured.</div> : null}
          {routeSets.map((set, setIndex) => <section className="di-signal-card" key={set.id}>
            <div className="di-signal-primary-grid">
              <label className="di-control-field"><span>Detector</span><select value={set.detectorBlockId ?? ''} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].detectorBlockId = event.target.value; }, 'route-set-detector')}><option value="">Select detector</option>{detectors.map((detector) => <option value={detector.id} key={detector.id}>{detector.label}</option>)}</select></label>
              <label className="di-control-field"><span>Measurement path</span><select value={set.measurementRouteId ?? ''} onChange={(event) => commit((draft) => {
                const target = draft.routeSets?.[setIndex]; if (!target) return;
                target.measurementRouteId = event.target.value || undefined;
                if (event.target.value && !target.routeIds.includes(event.target.value)) target.routeIds.push(event.target.value);
              }, 'route-set-measurement')}><option value="">None</option>{routes.map((route) => <option key={route.id} value={route.id}>{route.label}</option>)}</select></label>
              <label className="di-control-field"><span>Reference path</span><select value={set.referenceRouteId ?? ''} onChange={(event) => commit((draft) => {
                const target = draft.routeSets?.[setIndex]; if (!target) return;
                target.referenceRouteId = event.target.value || undefined;
                if (event.target.value && !target.routeIds.includes(event.target.value)) target.routeIds.push(event.target.value);
              }, 'route-set-reference')}><option value="">None</option>{routes.map((route) => <option key={route.id} value={route.id}>{route.label}</option>)}</select></label>
            </div>
            <div className="di-signal-primary-note"><strong>{set.label}</strong><span>{Math.max(0, set.routeIds.length - Number(Boolean(set.measurementRouteId)) - Number(Boolean(set.referenceRouteId)))} additional / LO {set.routeIds.length === 1 ? 'path' : 'paths'}</span></div>
            <details className="di-signal-advanced">
              <summary>Advanced signal calibration</summary>
              <div className="di-signal-advanced__body">
              <div className="di-signal-card__header">
                <label className="di-control-field"><span>Signal name</span><input aria-label="Detector signal name" value={set.label} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].label = event.target.value || `Detector signal ${setIndex + 1}`; }, 'route-set-label')} /></label>
                <label className="di-control-field"><span>OPD calibration (mm)</span><input type="number" step="0.000001" value={Number(set.opdCalibrationMm ?? 0)} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].opdCalibrationMm = Number(event.target.value) || 0; }, 'route-set-opd-calibration')} /></label>
                <button type="button" className="di-connection-remove is-danger" onClick={() => commit((draft) => { draft.routeSets?.splice(setIndex, 1); }, 'route-set-delete')}>Remove signal</button>
              </div>
            <fieldset className="di-signal-path-group">
              <legend>Included Optical paths</legend>
              <div className="di-signal-path-options">{routes.map((route) => {
                const included = set.routeIds.includes(route.id);
                const role = set.measurementRouteId === route.id
                  ? 'Measurement'
                  : (set.referenceRouteId === route.id ? 'Reference' : 'LO / Auxiliary');
                return <label className={included ? 'is-included' : ''} key={route.id}><input type="checkbox" checked={included} onChange={(event) => commit((draft) => {
                  const target = draft.routeSets?.[setIndex]; if (!target) return;
                  target.routeIds = event.target.checked ? Array.from(new Set([...target.routeIds, route.id])) : target.routeIds.filter((id) => id !== route.id);
                  if (!event.target.checked && target.measurementRouteId === route.id) target.measurementRouteId = undefined;
                  if (!event.target.checked && target.referenceRouteId === route.id) target.referenceRouteId = undefined;
                }, 'route-set-membership')} /><span>{route.label}</span>{included ? <em>{role}</em> : null}</label>;
              })}</div>
              <small>Checked paths contribute to this Detector signal. Paths other than Measurement and Reference are treated as LO or auxiliary.</small>
            </fieldset>
              </div>
            </details>
          </section>)}
          <button type="button" className="di-signal-add" disabled={routes.length === 0} onClick={() => commit((draft) => {
          draft.routeSets ??= [];
          const routeIds = (draft.portRoutes ?? []).map((route) => route.id);
          const firstRoute = draft.portRoutes?.[0];
          draft.routeSets.push({ id: `route-set-${Date.now().toString(36)}`, label: `Detector signal ${draft.routeSets.length + 1}`, detectorBlockId: firstRoute?.detectorBlockId ?? detectors[0]?.id ?? '', routeIds, measurementRouteId: routeIds[0], referenceRouteId: routeIds[1] });
        }, 'route-set-add')}>Add detector signal</button>
        </div>
      </div>
      </div>
    </section>
  </div>;
}

function LegacyDesignIntentSection({ hideTable }: { hideTable?: boolean } = {}) {
  return (
    <section className="optical-system-section ide-section-card" id="design-intent-container" aria-label="Design Intent">
      <div id="design-intent-toolbar" className="optical-system-buttons-container ide-toolbar" role="toolbar" aria-label="Design Intent controls">
        <div className="di-add-control">
          <label htmlFor="design-intent-add-block-type">Add physical Block</label>
          <select id="design-intent-add-block-type" aria-label="Physical Block type">
            <optgroup label="Sources">
              <option value="BroadbandSource">Broadband / Supercontinuum Source</option>
              <option value="FrequencyCombSource">Frequency Comb Source</option>
            </optgroup>
            <optgroup label="Physical assembly">
              <option value="BeamSplitter">Beam Splitter</option>
              <option value="FoldMirror">Fold Mirror</option>
              <option value="NDFilter">ND Filter</option>
              <option value="ReflectionGrating">Reflection Grating</option>
              <option value="Target">Target</option>
              <option value="STLObject">STL Object</option>
            </optgroup>
            <optgroup label="Detectors">
              <option value="AreaDetector">Area Detector</option>
              <option value="TimeDetector">Time Detector</option>
            </optgroup>
          </select>
          <button id="design-intent-add-block-btn" className="di-primary-button" type="button">Add</button>
        </div>
        <button id="design-intent-delete-block-btn" className="di-delete-button" type="button" title="Delete the selected block">Delete</button>
        <button id="design-intent-auto-set-apertures-btn" type="button" title="Calculate apertures for the current field conditions">Auto apertures</button>
        <details className="di-more-actions">
          <summary>More</summary>
          <div className="di-more-actions__menu" role="group" aria-label="Bulk parameter actions">
            <div className="di-more-actions__title">Bulk parameter mode</div>
            <button id="design-intent-param-all-on-btn" type="button">Enable all</button>
            <button id="design-intent-param-all-off-btn" type="button">Disable all</button>
          </div>
        </details>
      </div>

      <div id="import-analyze-mode-banner" className="merit-function-help" style={{ display: 'none' }}>
        <strong>Import / Analyze Mode</strong><br />
        Imported optical systems can be analyzed as exact surfaces. Design Intent is partial when an imported element cannot be represented as a block.
      </div>

      {!hideTable && <div className="block-inspector-panel"><div id="block-inspector" className="block-inspector" role="listbox" aria-label="Design blocks"></div></div>}
      {!hideTable && <div id="table-optical-system" className="di-derived-surface-host" aria-hidden="true"></div>}

      <HybridAssemblySummary />
    </section>
  );
}

export default function DesignIntentSection({ hideTable }: { hideTable?: boolean } = {}) {
  return <LegacyDesignIntentSection hideTable={hideTable} />;
}
