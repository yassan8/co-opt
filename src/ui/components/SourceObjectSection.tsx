import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_FIELD_SET_ID,
  DEFAULT_SOURCE_SET_ID,
  getActiveAnalysisSetId,
  loadSystemConfigurations,
  normalizeLensSectionAnalysisInputs,
  persistRowsToActiveAnalysisSet,
  saveSystemConfigurations,
  setActiveAnalysisSetId,
  type AnalysisFieldSet,
  type AnalysisSourceSet,
  type Configuration
} from '../../../data/table-configuration';

type AnalysisSetKind = 'source' | 'field';
type AnalysisSet = AnalysisSourceSet | AnalysisFieldSet;

function getActiveConfigurationSnapshot(): Configuration | null {
  const system = loadSystemConfigurations();
  const config = system.configurations.find((entry) => String(entry?.id) === String(system.activeConfigId)) ?? null;
  if (config) normalizeLensSectionAnalysisInputs(config);
  return config;
}

function notifyAnalysisInputSetsChanged(): void {
  window.dispatchEvent(new CustomEvent('coopt:analysis-input-sets-updated'));
  window.dispatchEvent(new CustomEvent('coopt:system-configurations-updated'));
  try { (window as any).refreshBlockInspector?.(); } catch (_) {}
}

function AnalysisSetToolbar({ kind }: { kind: AnalysisSetKind }) {
  const [revision, setRevision] = useState(0);
  const config = useMemo(() => getActiveConfigurationSnapshot(), [revision]);
  const sets: AnalysisSet[] = kind === 'source' ? (config?.sourceSets ?? []) : (config?.fieldSets ?? []);
  const activeSetId = config ? getActiveAnalysisSetId(kind, config) : '';
  const defaultSetId = kind === 'source' ? DEFAULT_SOURCE_SET_ID : DEFAULT_FIELD_SET_ID;
  const tableName = kind === 'source' ? 'tableSource' : 'tableObject';
  const storageKey = kind === 'source' ? 'sourceTableData' : 'objectTableData';
  const noun = kind === 'source' ? 'Source set' : 'Field set';

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener('coopt:analysis-input-sets-updated', refresh);
    window.addEventListener('coopt:configuration-changed', refresh);
    return () => {
      window.removeEventListener('coopt:analysis-input-sets-updated', refresh);
      window.removeEventListener('coopt:configuration-changed', refresh);
    };
  }, [refresh]);

  const applySet = useCallback(async (setId: string) => {
    const currentConfig = getActiveConfigurationSnapshot();
    if (!currentConfig) return;
    const table = (window as any)[tableName];
    const currentRows = table && typeof table.getData === 'function' ? table.getData() : [];
    persistRowsToActiveAnalysisSet(kind, currentRows);
    const refreshedConfig = getActiveConfigurationSnapshot();
    if (!refreshedConfig) return;
    const availableSets: AnalysisSet[] = kind === 'source' ? (refreshedConfig.sourceSets ?? []) : (refreshedConfig.fieldSets ?? []);
    const selected = availableSets.find((entry) => entry.id === setId) ?? availableSets[0];
    if (!selected) return;
    setActiveAnalysisSetId(kind, refreshedConfig, selected.id);
    const rows = JSON.parse(JSON.stringify(selected.rows ?? []));
    try { localStorage.setItem(storageKey, JSON.stringify(rows)); } catch (_) {}
    if (table && typeof table.replaceData === 'function') await table.replaceData(rows);
    notifyAnalysisInputSetsChanged();
  }, [kind, storageKey, tableName]);

  const addSet = useCallback(async () => {
    const system = loadSystemConfigurations();
    const currentConfig = system.configurations.find((entry) => String(entry?.id) === String(system.activeConfigId));
    if (!currentConfig) return;
    normalizeLensSectionAnalysisInputs(currentConfig);
    const table = (window as any)[tableName];
    const rows = table && typeof table.getData === 'function' ? table.getData() : [];
    persistRowsToActiveAnalysisSet(kind, rows);
    const targetSets: AnalysisSet[] = kind === 'source' ? currentConfig.sourceSets! : currentConfig.fieldSets!;
    const id = `${kind}-set-${Date.now().toString(36)}`;
    const nextSet: AnalysisSet = {
      id,
      label: `${noun} ${targetSets.length + 1}`,
      rows: JSON.parse(JSON.stringify(rows))
    };
    targetSets.push(nextSet);
    currentConfig.metadata.modified = new Date().toISOString();
    setActiveAnalysisSetId(kind, currentConfig, id);
    saveSystemConfigurations(system);
    notifyAnalysisInputSetsChanged();
    refresh();
  }, [kind, noun, refresh, tableName]);

  const renameSet = useCallback(() => {
    const system = loadSystemConfigurations();
    const currentConfig = system.configurations.find((entry) => String(entry?.id) === String(system.activeConfigId));
    if (!currentConfig) return;
    normalizeLensSectionAnalysisInputs(currentConfig);
    const targetSets: AnalysisSet[] = kind === 'source' ? currentConfig.sourceSets! : currentConfig.fieldSets!;
    const target = targetSets.find((entry) => entry.id === getActiveAnalysisSetId(kind, currentConfig));
    if (!target) return;
    const nextLabel = window.prompt(`Rename ${noun.toLowerCase()}`, target.label)?.trim();
    if (!nextLabel) return;
    target.label = nextLabel;
    currentConfig.metadata.modified = new Date().toISOString();
    saveSystemConfigurations(system);
    notifyAnalysisInputSetsChanged();
    refresh();
  }, [kind, noun, refresh]);

  const deleteSet = useCallback(async () => {
    if (!config || activeSetId === defaultSetId) return;
    const target = sets.find((entry) => entry.id === activeSetId);
    if (!target || !window.confirm(`Delete “${target.label}”? Lens designs using it will return to the default set.`)) return;
    const system = loadSystemConfigurations();
    const currentConfig = system.configurations.find((entry) => String(entry?.id) === String(system.activeConfigId));
    if (!currentConfig) return;
    normalizeLensSectionAnalysisInputs(currentConfig);
    if (kind === 'source') currentConfig.sourceSets = currentConfig.sourceSets!.filter((entry) => entry.id !== activeSetId);
    else currentConfig.fieldSets = currentConfig.fieldSets!.filter((entry) => entry.id !== activeSetId);
    for (const binding of currentConfig.lensSectionInputs ?? []) {
      if (kind === 'source' && binding.sourceSetId === activeSetId) binding.sourceSetId = DEFAULT_SOURCE_SET_ID;
      if (kind === 'field' && binding.fieldSetId === activeSetId) binding.fieldSetId = DEFAULT_FIELD_SET_ID;
    }
    setActiveAnalysisSetId(kind, currentConfig, defaultSetId);
    currentConfig.metadata.modified = new Date().toISOString();
    saveSystemConfigurations(system);
    const defaultRows = JSON.parse(JSON.stringify(
      (kind === 'source' ? currentConfig.sourceSets : currentConfig.fieldSets)?.find((entry) => entry.id === defaultSetId)?.rows ?? []
    ));
    try { localStorage.setItem(storageKey, JSON.stringify(defaultRows)); } catch (_) {}
    const table = (window as any)[tableName];
    if (table && typeof table.replaceData === 'function') await table.replaceData(defaultRows);
    notifyAnalysisInputSetsChanged();
    refresh();
  }, [activeSetId, config, defaultSetId, kind, refresh, sets, storageKey, tableName]);

  return (
    <div className="analysis-set-toolbar" aria-label={noun}>
      <label>
        <span>{noun}</span>
        <select value={activeSetId} onChange={(event) => void applySet(event.target.value)}>
          {sets.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => void addSet()}>Duplicate</button>
      <details className="window-action-menu analysis-set-toolbar__menu">
        <summary aria-label={`More ${noun.toLowerCase()} actions`}>More</summary>
        <div className="window-action-menu__panel" role="group">
          <button type="button" onClick={renameSet}>Rename</button>
          <button type="button" className="is-danger" disabled={activeSetId === defaultSetId} onClick={() => void deleteSet()}>Delete</button>
        </div>
      </details>
    </div>
  );
}

export function SourceSection() {
  return (
    <section className="source-section source-field-section ide-section-card" aria-label="Source">
      <AnalysisSetToolbar kind="source" />
      <div className="source-object-toolbar ide-toolbar window-commandbar" role="toolbar" aria-label="Source controls">
        <button id="add-source-btn" className="window-primary-action" type="button">Add source</button>
        <button id="delete-source-btn" className="window-quiet-action" type="button">Delete selected</button>
      </div>
      <div id="table-source" className="ide-table-container"></div>
    </section>
  );
}

export function FieldSection() {
  return (
    <section className="field-section object-section source-field-section ide-section-card" aria-label="Field">
      <AnalysisSetToolbar kind="field" />
      <div className="source-object-toolbar ide-toolbar window-commandbar" role="toolbar" aria-label="Field controls">
        <button id="add-object-btn" className="window-primary-action" type="button">Add field</button>
        <div className="window-segmented-control" role="group" aria-label="Field coordinate type">
          <button id="object-angle-btn" type="button">Angle</button>
          {/* <button id="object-height-circle-btn">Height Circle</button> */}
          <button id="object-height-rect-btn" type="button">Object height</button>
          <button id="object-image-height-btn" type="button">Image height</button>
        </div>
        <details className="window-action-menu">
          <summary aria-label="More field actions">More</summary>
          <div className="window-action-menu__panel" role="group" aria-label="Field actions" onClick={(event) => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; }}>
            <button id="delete-object-btn" className="is-danger" type="button">Delete selected</button>
          </div>
        </details>
      </div>
      <div id="table-object" className="ide-table-container"></div>
    </section>
  );
}

export default function SourceObjectSection() {
  return (
    <section className="source-object-container" aria-label="Source and Field">
      <SourceSection />
      <FieldSection />
    </section>
  );
}
