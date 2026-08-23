import { useEffect, useState } from 'react';
import { readActiveCoherentDesign, subscribeActiveCoherentDesign, updateActiveCoherentDesign, type ActiveCoherentDesignSnapshot } from '../../../data/coherent-config-store.ts';

function HybridAssemblySummary() {
  const [snapshot, setSnapshot] = useState<ActiveCoherentDesignSnapshot>(() => readActiveCoherentDesign());
  const [error, setError] = useState('');
  useEffect(() => subscribeActiveCoherentDesign((next) => setSnapshot(next)), []);
  const physical = snapshot.design.components.filter((component) => component.kind !== 'sequential-group');
  const sequential = snapshot.design.components.some((component) => component.kind === 'sequential-group');
  if (physical.length === 0) return null;

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
  const componentById = (id: string) => physical.find((component) => component.id === id);
  const defaultPort = (componentId: string, side: 'from' | 'to') => {
    const component = componentById(componentId);
    const preferred = side === 'from'
      ? ['emit', 'transmit', 'specular', 'order+1', 'out']
      : ['detect', 'common', 'incident', 'in'];
    return preferred.find((id) => component?.ports.some((port) => port.id === id))
      ?? component?.ports[side === 'from' ? Math.max(0, component.ports.length - 1) : 0]?.id
      ?? '';
  };
  const addConnection = (fromId?: string, fromPortId?: string) => {
    if (physical.length < 2) return;
    const from = componentById(fromId ?? '') ?? physical[0];
    const to = physical.find((component) => component.id !== from.id) ?? physical[1];
    commit((draft) => {
      draft.connections.push({
        id: `connection-${Date.now().toString(36)}`,
        fromComponentId: from.id,
        fromPortId: fromPortId ?? defaultPort(from.id, 'from'),
        toComponentId: to.id,
        toPortId: defaultPort(to.id, 'to'),
        distanceMm: 10,
        pathId: fromPortId === 'reflect' ? 'reflect' : 'main',
      });
    }, 'connection-add');
  };
  const splitter = physical.find((component) => component.kind === 'beam-splitter');

  return <div className="di-hybrid-summary" aria-label="Hybrid optical assembly status">
    <div><strong>Hybrid Assembly</strong><span>Exact sequential surfaces and physical ports share the active Config.</span></div>
    <div className="di-hybrid-summary__metrics">
      {sequential ? <span>Exact lens train</span> : null}
      <span>{physical.length} physical parts</span>
      <span>{snapshot.design.connections.length} connections</span>
      <span>{snapshot.design.paths.length} {snapshot.design.paths.length === 1 ? 'path' : 'paths'}</span>
      <span>Render + Detector linked</span>
    </div>
    <details className="di-connection-editor">
      <summary>Port connections</summary>
      <div className="di-connection-editor__body">
        <p>Connect sources, split paths, gratings, targets, and detectors. Changes are saved immediately to the active Config.</p>
        {snapshot.design.connections.length === 0 ? <div className="di-connection-empty">No connections. Parts remain in the Config and Render, but no Hybrid path is traced.</div> : null}
        {snapshot.design.connections.map((connection, index) => {
          const from = componentById(connection.fromComponentId);
          const to = componentById(connection.toComponentId);
          return <div className="di-connection-row" key={connection.id}>
            <label>Path<input value={connection.pathId} onChange={(event) => commit((draft) => { draft.connections[index].pathId = event.target.value || 'main'; }, 'connection-path')} /></label>
            <label>From<select value={connection.fromComponentId} onChange={(event) => commit((draft) => {
              draft.connections[index].fromComponentId = event.target.value;
              draft.connections[index].fromPortId = defaultPort(event.target.value, 'from');
            }, 'connection-from')}>
              {physical.map((component) => <option value={component.id} key={component.id}>{component.label}</option>)}
            </select></label>
            <label>Port<select value={connection.fromPortId ?? ''} onChange={(event) => commit((draft) => { draft.connections[index].fromPortId = event.target.value; }, 'connection-from-port')}>
              {(from?.ports ?? []).map((port) => <option value={port.id} key={port.id}>{port.label}</option>)}
            </select></label>
            <span className="di-connection-arrow" aria-hidden="true">→</span>
            <label>To<select value={connection.toComponentId} onChange={(event) => commit((draft) => {
              draft.connections[index].toComponentId = event.target.value;
              draft.connections[index].toPortId = defaultPort(event.target.value, 'to');
            }, 'connection-to')}>
              {physical.map((component) => <option value={component.id} key={component.id}>{component.label}</option>)}
            </select></label>
            <label>Port<select value={connection.toPortId ?? ''} onChange={(event) => commit((draft) => { draft.connections[index].toPortId = event.target.value; }, 'connection-to-port')}>
              {(to?.ports ?? []).map((port) => <option value={port.id} key={port.id}>{port.label}</option>)}
            </select></label>
            <label>Distance (mm)<input type="number" min="0" step="0.1" value={Number(connection.distanceMm ?? 0)} onChange={(event) => commit((draft) => { draft.connections[index].distanceMm = Math.max(0, Number(event.target.value) || 0); }, 'connection-distance')} /></label>
            <label>Azimuth (°)<input type="number" step="0.1" value={Number(connection.azimuthDeg ?? 0)} onChange={(event) => commit((draft) => { draft.connections[index].azimuthDeg = Number(event.target.value) || 0; }, 'connection-azimuth')} /></label>
            <label>Elevation (°)<input type="number" step="0.1" value={Number(connection.elevationDeg ?? 0)} onChange={(event) => commit((draft) => { draft.connections[index].elevationDeg = Math.max(-90, Math.min(90, Number(event.target.value) || 0)); }, 'connection-elevation')} /></label>
            <button type="button" className="di-connection-remove" onClick={() => commit((draft) => { draft.connections.splice(index, 1); }, 'connection-delete')}>Remove</button>
          </div>;
        })}
        <div className="di-connection-editor__actions">
          <button type="button" onClick={() => addConnection()} disabled={physical.length < 2}>Add connection</button>
          {splitter ? <button type="button" onClick={() => addConnection(splitter.id, 'reflect')}>Add reflected path</button> : null}
        </div>
        {error ? <div className="di-connection-error" role="alert">{error}</div> : null}
      </div>
    </details>
  </div>;
}

function LegacyDesignIntentSection({ hideTable }: { hideTable?: boolean } = {}) {
  return (
    <section className="optical-system-section ide-section-card" id="design-intent-container" aria-label="Design Intent">
      <div id="design-intent-toolbar" className="optical-system-buttons-container ide-toolbar" role="toolbar" aria-label="Design Intent controls">
        <div className="di-add-control">
          <label htmlFor="design-intent-add-block-type">Add block</label>
          <select id="design-intent-add-block-type" aria-label="Block type">
            <optgroup label="Planes">
              <option value="ObjectPlane">Object Surface</option>
              <option value="ImagePlane">Image Surface</option>
            </optgroup>
            <optgroup label="Exact sequential optics">
              <option value="SingleSurface">Single Surface</option>
              <option value="Lens">Lens</option>
              <option value="Paraxial">Paraxial</option>
              <option value="Doublet">Doublet</option>
              <option value="Triplet">Triplet</option>
              <option value="Mirror">Sequential Mirror</option>
              <option value="Gap">Gap</option>
              <option value="Stop">Stop</option>
              <option value="CoordTrans">Coordinate Transform</option>
            </optgroup>
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

      <div className="di-physical-add-strip" role="group" aria-label="Add physical assembly part">
        <span>Assembly parts</span>
        <button type="button" data-design-intent-add-type="BroadbandSource">Broadband source</button>
        <button type="button" data-design-intent-add-type="FrequencyCombSource">Frequency comb</button>
        <button type="button" data-design-intent-add-type="BeamSplitter" className="is-splitter">Beam splitter</button>
        <button type="button" data-design-intent-add-type="FoldMirror">Fold mirror</button>
        <button type="button" data-design-intent-add-type="ReflectionGrating">Grating</button>
        <button type="button" data-design-intent-add-type="Target">Target</button>
        <button type="button" data-design-intent-add-type="AreaDetector">Area detector</button>
      </div>

      <HybridAssemblySummary />

      <div id="import-analyze-mode-banner" className="merit-function-help" style={{ display: 'none' }}>
        <strong>Import / Analyze Mode</strong><br />
        Imported optical systems can be analyzed as exact surfaces. Design Intent is partial when an imported element cannot be represented as a block.
      </div>

      {!hideTable && <div className="block-inspector-panel"><div id="block-inspector" className="block-inspector" role="listbox" aria-label="Design blocks"></div></div>}
      {!hideTable && <div id="table-optical-system" className="di-derived-surface-host" aria-hidden="true"></div>}
    </section>
  );
}

export default function DesignIntentSection({ hideTable }: { hideTable?: boolean } = {}) {
  return <LegacyDesignIntentSection hideTable={hideTable} />;
}