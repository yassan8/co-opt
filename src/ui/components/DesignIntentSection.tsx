import { useEffect, useRef, useState } from 'react';
import { detectActivePortRoutes, readActiveCoherentDesign, subscribeActiveCoherentDesign, updateActiveCoherentDesign, type ActiveCoherentDesignSnapshot } from '../../../data/coherent-config-store.ts';
import { DESIGN_CONNECTION_SELECTED_EVENT, OPTICAL_ROUTE_SELECTED_EVENT, RENDER_SELECTED_ROUTE_STORAGE_KEY } from '../../app/nonsequential-render-overlay.ts';

const lensDesignLabel = (value: unknown, fallback = '') => {
  const label = String(value ?? '').trim() || fallback;
  return label.replace(/^Lens\s+section\b/i, 'Lens design');
};

function HybridAssemblySummary() {
  const [snapshot, setSnapshot] = useState<ActiveCoherentDesignSnapshot>(() => readActiveCoherentDesign());
  const [error, setError] = useState('');
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const connectionEditorRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => subscribeActiveCoherentDesign((next) => setSnapshot(next)), []);
  useEffect(() => {
    const selectConnection = (event: Event) => {
      const connectionId = String((event as CustomEvent<{ connectionId?: string }>).detail?.connectionId ?? '');
      if (!connectionId) return;
      setSelectedConnectionId(connectionId);
      if (connectionEditorRef.current) connectionEditorRef.current.open = true;
      window.requestAnimationFrame(() => {
        document.querySelector(`[data-design-connection-id="${CSS.escape(connectionId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
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
  const routeEndpoint = (route: (typeof routes)[number], side: 'source' | 'detector') => {
    const step = side === 'source' ? route.steps[0] : route.steps[route.steps.length - 1];
    const connection = snapshot.design.connections.find((entry) => entry.id === step?.connectionId);
    if (!connection) return side === 'source' ? route.sourceBlockId || 'Source' : route.detectorBlockId || 'Detector';
    const blockId = side === 'source'
      ? (step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId)
      : (step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId);
    return componentLabel(componentById(blockId), blockId);
  };
  const routeComponentChain = (route: (typeof routes)[number]) => {
    const componentIds: string[] = [];
    for (const step of route.steps) {
      const connection = snapshot.design.connections.find((entry) => entry.id === step.connectionId);
      if (!connection) continue;
      const departure = step.direction === 'reverse' ? connection.toComponentId : connection.fromComponentId;
      const arrival = step.direction === 'reverse' ? connection.fromComponentId : connection.toComponentId;
      if (componentIds.at(-1) !== departure) componentIds.push(departure);
      componentIds.push(arrival);
    }
    return componentIds.map((componentId) => componentLabel(componentById(componentId), componentId));
  };
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
        pathId: fromPortId === 'reflect' ? 'reflect' : 'main',
      });
    }, 'connection-add');
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
  return <div className="di-hybrid-summary" aria-label="Hybrid optical assembly status">
    <div className="di-assembly-overview">
      <div className="di-assembly-overview__title"><strong>Optical Assembly</strong><span>After building the Blocks above, place them and define complete Source-to-Detector paths.</span></div>
      <div className="di-hybrid-summary__metrics">
      {sequential ? <span>{sequentialComponents.length} lens {sequentialComponents.length === 1 ? 'design' : 'designs'}</span> : null}
      <span>{physical.length} physical Blocks</span>
      <span>{routes.length} optical {routes.length === 1 ? 'path' : 'paths'}</span>
      <span>{routeSets.length} detector {routeSets.length === 1 ? 'signal' : 'signals'}</span>
      </div>
    </div>
    {sequential ? <details className="di-sequential-group-editor di-assembly-panel">
      <summary><span><strong>Lens designs</strong><small>Each continuous physical lens train is authored once and may appear in multiple Optical paths.</small></span><em>{sequentialComponents.length}</em></summary>
      <div className="di-sequential-group-editor__body">
        <div className="di-context-note"><strong>What is a lens design?</strong><span>It is one continuous exact surface prescription with Front and Back ports, so the same real lens design can be placed in an arm and traced in either direction.</span></div>
        <div className="di-sequential-group-list">
          {snapshot.design.blockSequences.map((sequence, index) => <div className="di-sequential-group-row" key={sequence.id}>
            <span className="di-sequential-group-index">{index + 1}</span>
            <label className="di-control-field"><span>Name</span><input value={lensDesignLabel(sequence.label, `Lens design ${index + 1}`)} onChange={(event) => commit((draft) => {
              const target = draft.blockSequences.find((entry) => entry.id === sequence.id);
              if (target) target.label = event.target.value || `Lens design ${index + 1}`;
            }, 'sequential-group-label')} /></label>
            <span className="di-sequential-group-count">{sequence.blocks.length} blocks</span>
            <button type="button" className="di-connection-remove is-danger" onClick={() => removeSequentialGroup(sequence.id)} disabled={sequence.blocks.length > 0 || snapshot.design.blockSequences.length <= 1}>Remove</button>
            <div className="di-subsection-label"><strong>Assembly offset</strong><span>Fine adjustment from the position established by connected ports.</span></div>
            <div className="di-route-variable-grid" aria-label={`${sequence.label} pose variables`}>
              {([
                ['positionX', 'ΔX', 'positionMm', 'x'], ['positionY', 'ΔY', 'positionMm', 'y'], ['positionZ', 'ΔZ', 'positionMm', 'z'],
                ['rotationX', 'RX', 'rotationDeg', 'x'], ['rotationY', 'RY', 'rotationDeg', 'y'], ['rotationZ', 'RZ', 'rotationDeg', 'z'],
              ] as const).map(([key, label, section, axis]) => {
                const variable = (sequence.rootTransformVariables as any)?.[key];
                const mode = variable?.optimize?.mode === 'V' ? 'V' : 'F';
                const pose = sequence.manualOffset ?? sequence.rootTransform;
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
          </div>)}
        </div>
        <div className="di-single-section-note">Build and edit the optical Blocks inside each Lens design below. Drag a Block onto another design to move it.</div>
        <div className="di-connection-editor__actions"><button type="button" onClick={addSequentialGroup}>Add another lens design</button></div>
      </div>
    </details> : null}
    <details className="di-connection-editor di-assembly-panel" ref={connectionEditorRef}>
      <summary><span><strong>Placement links</strong><small>Physical spacing and port geometry used by the Optical paths. Open only when changing layout.</small></span><em>{snapshot.design.connections.length}</em></summary>
      <div className="di-connection-editor__body">
        <p>Each connection places the destination from the source port. Distance and direction can be fixed (F) or optimized (V).</p>
        {snapshot.design.connections.length === 0 ? <div className="di-connection-empty">No connections. Parts remain in the Config and Render, but no Hybrid path is traced.</div> : null}
        {snapshot.design.connections.map((connection, index) => {
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
            <label className="di-connection-reverse"><input type="checkbox" checked={connection.autoPlace !== false} onChange={(event) => commit((draft) => { draft.connections[index].autoPlace = event.target.checked; }, 'connection-auto-place')} />Auto-place</label>
            <label className="di-connection-reverse"><input type="checkbox" checked={connection.allowReverse === true} onChange={(event) => commit((draft) => { draft.connections[index].allowReverse = event.target.checked; }, 'connection-reverse')} />Bidirectional</label>
            <button type="button" className="di-connection-remove is-danger" onClick={() => commit((draft) => { draft.connections.splice(index, 1); }, 'connection-delete')}>Remove</button>
            </div>
          </div>;
        })}
        <div className="di-connection-editor__actions">
          <button type="button" onClick={() => addConnection()} disabled={connectable.length < 2}>Add connection</button>
          {splitter ? <button type="button" onClick={() => addConnection(splitter.id, 'reflect')}>Add reflected path</button> : null}
        </div>
        {error ? <div className="di-connection-error" role="alert">{error}</div> : null}
      </div>
    </details>
    <details className="di-route-editor di-assembly-panel" open>
      <summary><span><strong>Optical paths</strong><small>Complete Source-to-Detector sequences used by Render, Signal, and Optimize.</small></span><em>{routes.length}</em></summary>
      <div className="di-route-editor__body">
        <div className="di-route-editor__intro"><p>Work with one complete path at a time. Shared lens designs stay linked; placement links and repeated return passes are kept inside the path definition.</p><button type="button" onClick={() => { try { setSnapshot(detectActivePortRoutes()); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Detect paths</button></div>
        {routes.length === 0 ? <div className="di-connection-empty">No saved route. Add connections, then use Auto detect.</div> : routes.map((route, routeIndex) => {
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
            <details className="di-route-definition">
              <summary>Path definition · {route.steps.length} placement links · {routeEndpoint(route, 'source')} → {routeEndpoint(route, 'detector')}</summary>
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
        <div className="di-route-editor__actions"><button type="button" disabled={snapshot.design.connections.length === 0} onClick={() => commit((draft) => {
          draft.portRoutes ??= [];
          draft.portRoutes.push({ id: `route-${Date.now().toString(36)}`, label: `Route ${draft.portRoutes.length + 1}`, enabled: true, steps: [{ connectionId: draft.connections[0]?.id ?? '', direction: 'forward' }] });
        }, 'route-add')}>Add route</button></div>
      </div>
    </details>
    <details className="di-signal-editor di-assembly-panel" open>
      <summary><span><strong>Detector signals</strong><small>Group paths arriving at one Detector and assign their measurement, reference, and auxiliary roles.</small></span><em>{routeSets.length}</em></summary>
      <div className="di-signal-editor__body">
        <div className="di-context-note"><strong>Signal roles</strong><span>Choose the Measurement and Reference paths explicitly. Other included paths are treated as LO or auxiliary contributions.</span></div>
        <div className="di-route-sets">
          {routeSets.length === 0 ? <div className="di-connection-empty">No Detector signal is configured.</div> : null}
          {routeSets.map((set, setIndex) => <section className="di-signal-card" key={set.id}>
            <div className="di-signal-card__header">
              <label className="di-control-field"><span>Signal name</span><input aria-label="Detector signal name" value={set.label} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].label = event.target.value || `Detector signal ${setIndex + 1}`; }, 'route-set-label')} /></label>
              <label className="di-control-field"><span>Detector</span><select value={set.detectorBlockId ?? ''} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].detectorBlockId = event.target.value; }, 'route-set-detector')}><option value="">Select detector</option>{detectors.map((detector) => <option value={detector.id} key={detector.id}>{detector.label}</option>)}</select></label>
              <button type="button" className="di-connection-remove is-danger" onClick={() => commit((draft) => { draft.routeSets?.splice(setIndex, 1); }, 'route-set-delete')}>Remove</button>
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
              <small>Only checked paths contribute to this Detector signal.</small>
            </fieldset>
            <div className="di-signal-role-grid">
              <label className="di-control-field"><span>Measurement path</span><select value={set.measurementRouteId ?? ''} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].measurementRouteId = event.target.value || undefined; }, 'route-set-measurement')}><option value="">None</option>{set.routeIds.map((routeId) => <option key={routeId} value={routeId}>{routes.find((route) => route.id === routeId)?.label ?? routeId}</option>)}</select></label>
              <label className="di-control-field"><span>Reference path</span><select value={set.referenceRouteId ?? ''} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].referenceRouteId = event.target.value || undefined; }, 'route-set-reference')}><option value="">None</option>{set.routeIds.map((routeId) => <option key={routeId} value={routeId}>{routes.find((route) => route.id === routeId)?.label ?? routeId}</option>)}</select></label>
              <label className="di-control-field"><span>OPD calibration (mm)</span><input type="number" step="0.000001" value={Number(set.opdCalibrationMm ?? 0)} onChange={(event) => commit((draft) => { if (draft.routeSets?.[setIndex]) draft.routeSets[setIndex].opdCalibrationMm = Number(event.target.value) || 0; }, 'route-set-opd-calibration')} /></label>
            </div>
          </section>)}
          <button type="button" className="di-signal-add" disabled={routes.length === 0} onClick={() => commit((draft) => {
          draft.routeSets ??= [];
          const routeIds = (draft.portRoutes ?? []).map((route) => route.id);
          const firstRoute = draft.portRoutes?.[0];
          draft.routeSets.push({ id: `route-set-${Date.now().toString(36)}`, label: `Detector signal ${draft.routeSets.length + 1}`, detectorBlockId: firstRoute?.detectorBlockId ?? detectors[0]?.id ?? '', routeIds, measurementRouteId: routeIds[0], referenceRouteId: routeIds[1] });
        }, 'route-set-add')}>Add detector signal</button>
        </div>
      </div>
    </details>
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
