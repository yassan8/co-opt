import { useEffect, useState } from 'react';
import { OPERAND_DEFINITIONS } from '../../../ui/editors/merit-function-inspector';

type RequirementRow = Record<string, any>;
type SelectOption = { value: string; label: string };

const cloneRows = (rows: any): RequirementRow[] => {
  try { return JSON.parse(JSON.stringify(Array.isArray(rows) ? rows : [])); } catch (_) { return []; }
};

const formatValue = (value: any): string => {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(6) : String(value);
};

const operandLabel = (key: string): string => {
  const overrides: Record<string, string> = {
    EDGE: 'Edge Thickness', ALL_EDGE_ELEMENT: 'All Edge Element', EDGE_AIR: 'Edge Air Gap',
    ALL_EDGE_AIR: 'All Edge Air Gap', CTCT: 'Center Thickness', DBLT_K: 'Doublet Bending K',
    CRA_DEG: 'Chief@Image (deg)', GAP: 'Gap Thickness', THIC: 'All Thickness',
    SDIST: 'Surface distance', REQMATH: 'Req Arithmetic'
  };
  return overrides[key] || String(OPERAND_DEFINITIONS[key]?.name || key);
};

const getScopeParamKey = (operand: unknown, scope: 'field' | 'wavelength'): string | null => {
  const parameters = OPERAND_DEFINITIONS[String(operand ?? '').trim()]?.parameters;
  if (!Array.isArray(parameters)) return null;
  for (const parameter of parameters) {
    const label = String(parameter?.label ?? '').toLowerCase();
    const description = String(parameter?.description ?? '').toLowerCase();
    const matches = scope === 'field'
      ? label.includes('field idx') || label.includes('object idx') || description.includes('object row')
      : label.includes('λ') || description.includes('source row');
    if (matches) return String(parameter?.key ?? '').trim() || null;
  }
  return null;
};

export default function RequirementsSection() {
  const [rows, setRows] = useState<RequirementRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const getEditor = () => (window as any).systemRequirementsEditor;
  const refresh = () => setRows(cloneRows(getEditor()?.getData?.()));

  useEffect(() => {
    const init = (window as any).__cooptInitSystemRequirementsEditor;
    if (typeof init === 'function') init();
    const onChanged = (event: Event) => {
      const detailRows = (event as CustomEvent)?.detail?.rows;
      setRows(cloneRows(Array.isArray(detailRows) ? detailRows : getEditor()?.getData?.()));
    };
    window.addEventListener('coopt:requirements-data-changed', onChanged);
    window.addEventListener('coopt:requirements-updated', onChanged);
    const timer = window.setTimeout(refresh, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('coopt:requirements-data-changed', onChanged);
      window.removeEventListener('coopt:requirements-updated', onChanged);
    };
  }, []);

  const commitRows = (nextRows: RequirementRow[], evaluate = true) => {
    const editor = getEditor();
    const normalized = nextRows.map((row, index) => ({ ...row, id: index + 1 }));
    editor?.setData?.(normalized);
    editor?.saveToStorage?.();
    setRows(cloneRows(normalized));
    if (evaluate) editor?.scheduleEvaluateAndUpdate?.();
  };

  const patchRow = (id: any, patch: RequirementRow, evaluate = true) => {
    commitRows(rows.map((row) => String(row.id) === String(id) ? { ...row, ...patch } : row), evaluate);
  };

  const addRequirement = () => {
    const editor = getEditor();
    const row = editor?.createDefaultRequirementRow?.() || {
      enabled: true, operand: 'EFFL', configId: '', wavelengthScope: 'ALL', fieldScope: 'ALL',
      param1: '', param2: '', param3: '', param4: '', param5: '', op: '=', tol: 0, target: 0, weight: 1
    };
    const index = selectedId ? Math.max(0, rows.findIndex((entry) => String(entry.id) === selectedId) + 1) : rows.length;
    const next = [...rows];
    next.splice(index, 0, row);
    commitRows(next);
    setSelectedId(String(index + 1));
    setExpandedId(String(index + 1));
  };

  const addMemo = () => {
    const index = selectedId ? Math.max(0, rows.findIndex((entry) => String(entry.id) === selectedId) + 1) : rows.length;
    const next = [...rows];
    next.splice(index, 0, { rowType: 'memo', memo: '' });
    commitRows(next, false);
    setSelectedId(String(index + 1));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    commitRows(rows.filter((row) => String(row.id) !== selectedId));
    setSelectedId(null);
    setExpandedId(null);
  };

  const configurationOptions = (): SelectOption[] => {
    const values = getEditor()?.getConfigurationList?.() || {};
    return Object.entries(values).map(([value, label]) => ({ value, label: String(label) }));
  };
  const wavelengthOptions = (): SelectOption[] => cloneRows(getEditor()?._getWavelengthOptions?.()) as SelectOption[];
  const fieldOptions = (configId: any): SelectOption[] => cloneRows(getEditor()?._getObjectOptions?.(configId)) as SelectOption[];
  const scopeOptions = (kind: 'wavelength' | 'field', row: RequirementRow): SelectOption[] => [
    ...(kind === 'wavelength' && getScopeParamKey(row.operand, 'wavelength')
      ? [{ value: 'PRIMARY', label: 'Primary wavelength' }]
      : [{ value: 'DEFAULT', label: 'Operand default' }]),
    { value: 'ALL', label: kind === 'wavelength' ? 'All wavelengths' : 'All fields' },
    ...(kind === 'wavelength' ? wavelengthOptions() : fieldOptions(row.configId))
      .filter((option) => option.value)
  ];

  const updateAllEnabled = (enabled: boolean) => commitRows(rows.map((row) => row.rowType === 'memo' ? row : { ...row, enabled }));
  const updateAllWeights = () => commitRows(rows.map((row) => row.rowType === 'memo' ? row : { ...row, weight: 1 }));

  return (
    <section className="merit-function-section requirements-section ide-section-card" id="requirements-container" aria-label="Requirements">
      <div className="merit-function-buttons-container ide-toolbar" role="toolbar" aria-label="Requirements controls">
        <button type="button" onClick={addRequirement}>Add Requirement</button>
        <button type="button" onClick={addMemo}>Add Memo</button>
        <button type="button" onClick={deleteSelected} disabled={!selectedId}>Delete Requirement</button>
        <button id="update-requirement-btn" type="button" onClick={async () => { await getEditor()?.updateAllConfigsAndEvaluate?.(); refresh(); }}>Update Requirement</button>
        <button type="button" onClick={() => updateAllEnabled(true)}>All On</button>
        <button type="button" onClick={() => updateAllEnabled(false)}>All Off</button>
        <button type="button" onClick={updateAllWeights}>All Weight=1</button>
        <button type="button" onClick={async () => { await getEditor()?.normalizeWeightsForUnitScore?.(); refresh(); }}>Normalize Score=1</button>
      </div>

      <div className="requirements-layout">
        <div id="table-system-requirements" className="ide-table-container requirements-react-table" data-react-managed="true">
          <table className="sr-table">
            <thead><tr><th>Num</th><th>On</th><th>Requirement</th><th>Spec</th><th>Current</th><th>Status</th><th>Details</th><th>Score</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="requirements-react-empty">No requirements defined. Click Add Requirement to create one.</td></tr>}
              {rows.map((row) => {
                const id = String(row.id);
                if (row.rowType === 'memo') return (
                  <tr key={id} className={selectedId === id ? 'sr-selected' : ''} onClick={() => setSelectedId(id)}>
                    <td>{row.id}</td><td colSpan={7}><input className="requirements-react-memo" value={String(row.memo || '')} placeholder="Memo / Note" onChange={(event) => patchRow(id, { memo: event.target.value }, false)} /></td>
                  </tr>
                );
                const isExpanded = expandedId === id;
                const summary = [`Wave=${String(row.wavelengthScope || 'DEFAULT').toUpperCase()}`, `Field=${String(row.fieldScope || 'DEFAULT').toUpperCase()}`, `w=${row.weight ?? 1}`].join(' • ');
                return [
                  <tr key={id} className={selectedId === id ? 'sr-selected' : ''} onClick={() => setSelectedId(id)}>
                    <td>{row.id}</td>
                    <td><input type="checkbox" checked={row.enabled !== false} onChange={(event) => patchRow(id, { enabled: event.target.checked })} /></td>
                    <td><select value={String(row.operand || '')} onChange={(event) => patchRow(id, { operand: event.target.value })}>{Object.keys(OPERAND_DEFINITIONS).map((key) => <option key={key} value={key}>{operandLabel(key)}</option>)}</select></td>
                    <td>{`${row.op || '='} ${row.target ?? 0}`}</td><td>{formatValue(row.current)}</td><td>{row.status || ''}</td>
                    <td><button type="button" className="requirements-react-detailsButton" onClick={(event) => { event.stopPropagation(); setSelectedId(id); setExpandedId(isExpanded ? null : id); }}>{summary}</button></td>
                    <td>{formatValue(row._contribution)}</td>
                  </tr>,
                  isExpanded && <tr key={`${id}-details`} className="sr-inline-editor-row"><td colSpan={8}><RequirementDetails row={row} patch={(patch, evaluate) => patchRow(id, patch, evaluate)} configurationOptions={configurationOptions()} wavelengthOptions={scopeOptions('wavelength', row)} fieldOptions={scopeOptions('field', row)} /></td></tr>
                ];
              })}
            </tbody>
          </table>
        </div>
        <div id="requirement-inspector" className="operand-inspector requirement-inspector" style={{ display: 'none' }}><div id="requirement-inspector-content" /></div>
      </div>
    </section>
  );
}

function RequirementDetails({ row, patch, configurationOptions, wavelengthOptions, fieldOptions }: {
  row: RequirementRow; patch: (patch: RequirementRow, evaluate?: boolean) => void;
  configurationOptions: SelectOption[]; wavelengthOptions: SelectOption[]; fieldOptions: SelectOption[];
}) {
  const parameters = Array.isArray(OPERAND_DEFINITIONS[String(row.operand)]?.parameters) ? OPERAND_DEFINITIONS[String(row.operand)].parameters : [];
  const wavelengthParamKey = getScopeParamKey(row.operand, 'wavelength');
  const input = (label: string, key: string, type: 'text' | 'number' = 'text') => <label className="requirements-react-field"><span>{label}</span><input type={type} value={row[key] ?? ''} onChange={(event) => patch({ [key]: event.target.value }, false)} onBlur={() => (window as any).systemRequirementsEditor?.scheduleEvaluateAndUpdate?.()} /></label>;
  const select = (label: string, key: string, options: SelectOption[]) => <label className="requirements-react-field"><span>{label}</span><select value={String(row[key] ?? '')} onChange={(event) => patch({ [key]: event.target.value })}>{options.map((option) => <option key={`${key}-${option.value}`} value={option.value}>{option.label}</option>)}</select></label>;
  return <div className="sr-inline-editor requirements-react-details">
    <div className="sr-inline-editor-title">Details</div>
    {select('Config', 'configId', configurationOptions)}
    {select('Wavelength', 'wavelengthScope', wavelengthOptions)}
    {select('Field', 'fieldScope', fieldOptions)}
    <div className="requirements-react-parameters">
      {parameters.filter((parameter: any) => String(parameter?.key ?? '') !== wavelengthParamKey).map((parameter: any, index: number) => input(String(parameter.label || `P${index + 1}`).replace(/Object/g, 'Field'), String(parameter.key || `param${index + 1}`)))}
    </div>
    <div className="requirements-react-constraints">
      {select('Operand', 'op', ['=', '<=', '>='].map((value) => ({ value, label: value })))}
      {input('Tolerance', 'tol', 'number')}{input('Target', 'target', 'number')}{input('Weight', 'weight', 'number')}
    </div>
    <label className="requirements-react-field requirements-react-field--wide"><span>Rationale</span><textarea value={String(row.rationale || '')} onChange={(event) => patch({ rationale: event.target.value }, false)} /></label>
  </div>;
}
