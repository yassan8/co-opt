import { Fragment, useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import { InspectorManager, OPERAND_DEFINITIONS } from '../../../ui/editors/merit-function-inspector';

type RequirementRow = Record<string, any>;
type SelectOption = { value: string; label: string };
const REQUIREMENT_OPERAND_KEYS = InspectorManager.getAvailableOperands();
const ZERNIKE_NOLL_LABELS = [
  '0: RMS (Remove P&T)', '1: Piston [0,0]', '2: Tilt Y [1,-1]', '3: Tilt X [1,1]',
  '4: Astigmatism [2,-2]', '5: Defocus [2,0]', '6: Astigmatism [2,2]',
  '7: Coma Y [3,-1]', '8: Coma X [3,1]', '9: Trefoil Y [3,-3]', '10: Trefoil X [3,3]',
  '11: Spherical [4,0]', '12: Secondary Astig [4,2]', '13: Secondary Astig [4,-2]',
  '14: Secondary Coma [4,4]', '15: Secondary Coma [4,-4]', '16: [5,-1]', '17: [5,1]',
  '18: [5,-3]', '19: [5,3]', '20: [5,-5]', '21: [5,5]', '22: Secondary Spherical [6,0]',
  '23: [6,2]', '24: [6,-2]', '25: [6,4]', '26: [6,-4]', '27: [6,6]', '28: [6,-6]',
  '29: [7,-1]', '30: [7,1]', '31: [7,-3]', '32: [7,3]', '33: [7,-5]', '34: [7,5]',
  '35: [7,-7]', '36: [7,7]', '37: Tertiary Spherical [8,0]'
];

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
    ALL_EDGE_AIR: 'All Edge Air Gap', CTCT: 'Center Thickness',
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

const getOpticalRows = (configId: any): any[] => {
  try {
    const rows = (window as any).meritFunctionEditor?.getOpticalSystemDataByConfigId?.(configId);
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
};

const isSelectableSurface = (row: any): boolean => {
  const type = String(row?.['object type'] ?? row?.object ?? row?.surfType ?? '').trim().toLowerCase();
  return !!row && type !== 'object' && type !== 'image' && type !== 'gap'
    && type !== 'ct' && !type.includes('coordinate') && !type.includes('coordtrans');
};

const getSurfaceOptions = (row: RequirementRow, includeTotal = false): SelectOption[] => {
  const options = includeTotal ? [{ value: '0', label: '0: Total' }] : [];
  getOpticalRows(row.configId).forEach((surface, index) => {
    if (!isSelectableSurface(surface)) return;
    const value = String(surface?.id ?? index + 1);
    options.push({ value, label: `${value}: ${String(surface?.comment || surface?.label || `Surface ${value}`)}` });
  });
  return options;
};

const getBlocks = (configId: any): any[] => {
  try {
    const blocks = (window as any).systemRequirementsEditor?._getBlocksForConfigHint?.(configId);
    return Array.isArray(blocks) ? blocks : [];
  } catch (_) { return []; }
};

const getBlockLabel = (block: any, index: number): string => {
  const type = String(block?.blockType ?? '').trim();
  return type ? `${type === 'PositiveLens' ? 'Lens' : type}-${index + 1}` : String(block?.blockId ?? index + 1);
};

const getElementAndGapOptions = (row: RequirementRow, kind: 'elements' | 'gaps' | 'both'): SelectOption[] => {
  const opticalRows = getOpticalRows(row.configId);
  const options: Array<SelectOption & { kind: 'element' | 'gap' }> = [];
  let lensCount = 0;
  let gapCount = 0;
  let index = 0;
  while (index < opticalRows.length) {
    const surface = opticalRows[index];
    const type = String(surface?.['object type'] ?? surface?.object ?? surface?.surfType ?? '').trim().toLowerCase();
    const material = String(surface?.material ?? '').trim().toLowerCase();
    const isExcluded = type === 'object' || type === 'image' || type === 'ct' || type.includes('coordinate') || type.includes('coordtrans');
    if (isExcluded) { index++; continue; }
    const isGlass = !!material && material !== 'air';
    const hasGapThickness = surface?.__cooptGapThickness !== undefined && surface?.__cooptGapThickness !== null && String(surface.__cooptGapThickness).trim() !== '';
    const isGap = type === 'gap' || type.includes('gap') || type === 'stop' || type === 'sto' || hasGapThickness
      || (!isGlass && Number.isFinite(Number(surface?.thickness)) && Math.abs(Number(surface.thickness)) > 1e-12);
    if (isGap) {
      gapCount++;
      options.push({ value: String(surface?.id ?? index + 1), label: `Gap ${gapCount}`, kind: 'gap' });
      index++;
      continue;
    }
    if (!isGlass) { index++; continue; }
    let consecutive = 1;
    while (index + consecutive < opticalRows.length) {
      const next = opticalRows[index + consecutive];
      const nextType = String(next?.['object type'] ?? next?.object ?? next?.surfType ?? '').trim().toLowerCase();
      const nextMaterial = String(next?.material ?? '').trim().toLowerCase();
      if (nextType === 'image' || nextType === 'stop' || nextType === 'sto' || !nextMaterial || nextMaterial === 'air') break;
      consecutive++;
    }
    lensCount++;
    const group = consecutive === 2 ? `Doublet ${lensCount}` : consecutive >= 3 ? `Triplet ${lensCount}` : `Lens ${lensCount}`;
    for (let offset = 0; offset < consecutive; offset++) {
      const member = opticalRows[index + offset];
      options.push({
        value: String(member?.id ?? index + offset + 1),
        label: consecutive > 1 ? `${group}_Lens${offset + 1}` : group,
        kind: 'element'
      });
    }
    index += consecutive;
  }
  return options.filter((option) => kind === 'both' || (kind === 'elements' ? option.kind === 'element' : option.kind === 'gap'));
};

const getHeightOptions = (row: RequirementRow): SelectOption[] | null => {
  const opticalRows = getOpticalRows(row.configId);
  const selectedId = String(row.param1 ?? '').trim();
  const selected = selectedId
    ? opticalRows.find((surface, index) => String(surface?.id ?? index + 1) === selectedId)
    : null;
  const selectedSemidia = Number(selected?.semidia);
  const availableSemidias = opticalRows.map((surface) => Number(surface?.semidia)).filter((value) => Number.isFinite(value) && value > 0);
  const semidia = Number.isFinite(selectedSemidia) && selectedSemidia > 0
    ? selectedSemidia
    : (availableSemidias.length > 0 ? Math.min(...availableSemidias) : NaN);
  if (!Number.isFinite(semidia) || semidia <= 0) return null;
  return [100, 95, 90, 85, 80, 70].map((percent) => ({
    value: String(semidia * percent / 100),
    label: `${(semidia * percent / 100).toFixed(2)} mm (${percent}%)`
  }));
};

const getOperandDefaults = (operand: string): RequirementRow => {
  if (operand === 'TA_RMS_UM') return { param1: '', param2: '1', param3: '', param4: '' };
  if (operand === 'OPD_RMS_WAVES') return { param1: '', param2: '1', param3: '', param4: '' };
  if (operand === 'ZERN_COEFF') return { param1: '', param2: '1', param3: '', param4: '', param5: '0' };
  if (operand === 'CRA_DEG') return { param1: '1', param2: '', param3: '', param4: '', param5: '' };
  if (['RADI_ALL', 'ALL_EDGE_AIR', 'ALL_EDGE_ELEMENT'].includes(operand)) return { param1: 'MIN', param2: '', param3: '', param4: '', param5: '' };
  return { param1: '', param2: '', param3: '', param4: '', param5: '' };
};

export default function RequirementsSection() {
  const [rows, setRows] = useState<RequirementRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);

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

  const reorderRow = (sourceId: string, targetId: string, after: boolean) => {
    if (sourceId === targetId) return;
    const sourceIndex = rows.findIndex((row) => String(row.id) === sourceId);
    if (sourceIndex < 0) return;
    const next = [...rows];
    const [sourceRow] = next.splice(sourceIndex, 1);
    const targetIndex = next.findIndex((row) => String(row.id) === targetId);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (after ? 1 : 0), 0, sourceRow);

    const selectedIndex = selectedId === null ? -1 : next.findIndex((row) => String(row.id) === selectedId);
    const expandedIndex = expandedId === null ? -1 : next.findIndex((row) => String(row.id) === expandedId);
    commitRows(next);
    setSelectedId(selectedIndex >= 0 ? String(selectedIndex + 1) : null);
    setExpandedId(expandedIndex >= 0 ? String(expandedIndex + 1) : null);
  };

  const moveRow = (id: string, offset: -1 | 1) => {
    const sourceIndex = rows.findIndex((row) => String(row.id) === id);
    const target = rows[sourceIndex + offset];
    if (sourceIndex < 0 || !target) return;
    reorderRow(id, String(target.id), offset > 0);
  };

  const rowDragProps = (id: string) => ({
    onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
      if (!draggedId || draggedId === id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const bounds = event.currentTarget.getBoundingClientRect();
      setDropTarget({ id, after: event.clientY >= bounds.top + bounds.height / 2 });
    },
    onDragLeave: (event: DragEvent<HTMLTableRowElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
    },
    onDrop: (event: DragEvent<HTMLTableRowElement>) => {
      event.preventDefault();
      const sourceId = draggedId || event.dataTransfer.getData('text/plain');
      const bounds = event.currentTarget.getBoundingClientRect();
      const after = event.clientY >= bounds.top + bounds.height / 2;
      if (sourceId) reorderRow(sourceId, id, after);
      setDraggedId(null);
      setDropTarget(null);
    }
  });

  const moveCell = (id: string, index: number) => <td className="requirements-react-moveCell">
    <span
      role="button"
      tabIndex={0}
      className="requirements-react-dragHandle"
      draggable
      title="Drag to reorder"
      aria-label={`Move requirement ${index + 1}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        moveRow(id, event.key === 'ArrowUp' ? -1 : 1);
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
        setDraggedId(id);
      }}
      onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}
    >⋮⋮</span>
    <span className="requirements-react-rowNumber">{index + 1}</span>
    <span className="requirements-react-moveButtons">
      <button type="button" title="Move up" aria-label={`Move requirement ${index + 1} up`} disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveRow(id, -1); }}>↑</button>
      <button type="button" title="Move down" aria-label={`Move requirement ${index + 1} down`} disabled={index === rows.length - 1} onClick={(event) => { event.stopPropagation(); moveRow(id, 1); }}>↓</button>
    </span>
  </td>;

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
              {rows.map((row, index) => {
                const id = String(row.id);
                const dragClass = [
                  selectedId === id ? 'sr-selected' : '',
                  draggedId === id ? 'sr-dragging' : '',
                  dropTarget?.id === id ? (dropTarget.after ? 'sr-drop-after' : 'sr-drop-before') : ''
                ].filter(Boolean).join(' ');
                if (row.rowType === 'memo') return (
                  <tr key={id} className={dragClass} onClick={() => setSelectedId(id)} {...rowDragProps(id)}>
                    {moveCell(id, index)}<td colSpan={7}><input className="requirements-react-memo" value={String(row.memo || '')} placeholder="Memo / Note" onChange={(event) => patchRow(id, { memo: event.target.value }, false)} /></td>
                  </tr>
                );
                const isExpanded = expandedId === id;
                const summary = [`Wave=${String(row.wavelengthScope || 'DEFAULT').toUpperCase()}`, `Field=${String(row.fieldScope || 'DEFAULT').toUpperCase()}`, `w=${row.weight ?? 1}`].join(' • ');
                return <Fragment key={id}>
                  <tr className={dragClass} onClick={() => setSelectedId(id)} {...rowDragProps(id)}>
                    {moveCell(id, index)}
                    <td><input type="checkbox" checked={row.enabled !== false} onChange={(event) => patchRow(id, { enabled: event.target.checked })} /></td>
                    <td><select value={String(row.operand || '')} onChange={(event) => patchRow(id, { operand: event.target.value, ...getOperandDefaults(event.target.value) })}>{REQUIREMENT_OPERAND_KEYS.map((key) => <option key={key} value={key}>{operandLabel(key)}</option>)}</select></td>
                    <td>{`${row.op || '='} ${row.target ?? 0}`}</td><td>{formatValue(row.current)}</td><td>{row.status || ''}</td>
                    <td><button type="button" className="requirements-react-detailsButton" onClick={(event) => { event.stopPropagation(); setSelectedId(id); setExpandedId(isExpanded ? null : id); }}>{summary}</button></td>
                    <td>{formatValue(row._contribution)}</td>
                  </tr>
                  {isExpanded && <tr className="sr-inline-editor-row"><td colSpan={8}><RequirementDetails row={row} rows={rows} patch={(patch, evaluate) => patchRow(id, patch, evaluate)} configurationOptions={configurationOptions()} wavelengthOptions={scopeOptions('wavelength', row)} fieldOptions={scopeOptions('field', row)} /></td></tr>}
                </Fragment>;
              })}
            </tbody>
          </table>
        </div>
        <div id="requirement-inspector" className="operand-inspector requirement-inspector" style={{ display: 'none' }}><div id="requirement-inspector-content" /></div>
      </div>
    </section>
  );
}

function RequirementDetails({ row, rows, patch, configurationOptions, wavelengthOptions, fieldOptions }: {
  row: RequirementRow; rows: RequirementRow[]; patch: (patch: RequirementRow, evaluate?: boolean) => void;
  configurationOptions: SelectOption[]; wavelengthOptions: SelectOption[]; fieldOptions: SelectOption[];
}) {
  const parameters = Array.isArray(OPERAND_DEFINITIONS[String(row.operand)]?.parameters) ? OPERAND_DEFINITIONS[String(row.operand)].parameters : [];
  const wavelengthParamKey = getScopeParamKey(row.operand, 'wavelength');
  const input = (label: string, key: string, type: 'text' | 'number' = 'text') => <label className="requirements-react-field"><span>{label}</span><input type={type} value={row[key] ?? ''} onChange={(event) => patch({ [key]: event.target.value }, false)} onBlur={() => (window as any).systemRequirementsEditor?.scheduleEvaluateAndUpdate?.()} /></label>;
  const inputWithList = (label: string, key: string, options: SelectOption[]) => {
    const listId = `requirement-${row.id}-${key}-options`;
    return <label className="requirements-react-field"><span>{label}</span><input list={listId} value={row[key] ?? ''} onChange={(event) => patch({ [key]: event.target.value }, false)} onBlur={() => (window as any).systemRequirementsEditor?.scheduleEvaluateAndUpdate?.()} /><datalist id={listId}>{options.map((option) => <option key={`${key}-${option.value}`} value={option.value}>{option.label}</option>)}</datalist></label>;
  };
  const select = (label: string, key: string, options: SelectOption[]) => <label className="requirements-react-field"><span>{label}</span><select value={String(row[key] ?? '')} onChange={(event) => patch({ [key]: event.target.value })}>{options.map((option) => <option key={`${key}-${option.value}`} value={option.value}>{option.label}</option>)}</select></label>;
  const parameterOptions = (parameter: any): SelectOption[] | null => {
    const operand = String(row.operand ?? '').trim();
    const key = String(parameter?.key ?? '').trim();
    const label = String(parameter?.label ?? '').trim();
    const description = String(parameter?.description ?? '');
    if ((label === 'Field idx' || label === 'Object idx') && fieldOptions.length > 0) return fieldOptions;
    if (label === 'Axis') return [{ value: '', label: '(Default)' }, { value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }];
    if (label === 'Metric') return [{ value: '', label: '(default rms)' }, { value: 'rms', label: 'RMS' }, { value: 'dia', label: 'Diameter' }];
    if (label === 'Component') return [{ value: '', label: '(default total)' }, { value: 'total', label: 'Total' }, { value: 'meridional', label: 'Meridional' }, { value: 'sagittal', label: 'Sagittal' }];
    if (label === 'Raynum') return ['11', '21', '51', '101', '501'].map((value) => ({ value, label: value }));
    if (label === 'Unit') return [{ value: '', label: '(default waves)' }, { value: 'waves', label: 'waves' }, { value: 'um', label: 'µm' }];
    if (label === 'Sampling') return ['', '32', '64', '128', '256', '512'].map((value) => ({ value, label: value ? `${value}×${value}` : '(default 32)' }));
    if (label === 'n (Noll)') return ZERNIKE_NOLL_LABELS.map((option, index) => ({ value: String(index), label: option }));
    if (label === 'Mode' && ['GAP', 'THIC', 'ALL_EDGE_AIR', 'ALL_EDGE_ELEMENT', 'RADI_ALL'].includes(operand)) return [{ value: 'MIN', label: 'Min' }, { value: 'MAX', label: 'Max' }];
    if (label === 'Mode') {
      if (operand === 'PP1' || operand === 'PP2') return [{ value: '', label: 'Surface Range' }, { value: 'ZG', label: 'Zoom Group' }];
      return [{ value: '0', label: 'Imaging' }, { value: '1', label: 'Afocal' }];
    }
    if (label === 'Scope') {
      const options = getSurfaceOptions(row, true);
      getBlocks(row.configId).forEach((block, index) => {
        const blockId = String(block?.blockId ?? '').trim();
        if (blockId) options.push({ value: blockId, label: `${getBlockLabel(block, index)} (Block)` });
        const zoomGroup = String(block?.parameters?.zoomGroup ?? '').trim();
        if (zoomGroup && !options.some((option) => option.value === `ZG:${zoomGroup}`)) options.push({ value: `ZG:${zoomGroup}`, label: `${zoomGroup} (Zoom Group)` });
      });
      return options;
    }
    if (((label === 'S1' || label === 'S2' || description.includes('Surface')) && !(operand === 'PP1' || operand === 'PP2')) || ((operand === 'PP1' || operand === 'PP2') && row.param4 !== 'ZG' && (key === 'param2' || key === 'param3'))) return getSurfaceOptions(row, label === 'S1');
    if ((operand === 'PP1' || operand === 'PP2') && row.param4 === 'ZG' && key === 'param2') return [{ value: '', label: '(select zoom group)' }, ...Array.from(new Set(getBlocks(row.configId).map((block) => String(block?.parameters?.zoomGroup ?? '').trim()).filter(Boolean))).map((value) => ({ value, label: value }))];
    if (operand === 'REQMATH' && (key === 'param1' || key === 'param3')) return [{ value: '', label: '(select requirement)' }, ...rows.filter((entry) => entry.rowType !== 'memo').map((entry) => ({ value: String(entry.id), label: `${entry.id}: ${operandLabel(String(entry.operand || 'Requirement'))}${String(entry.id) === String(row.id) ? ' (self)' : ''}` }))];
    if (operand === 'REQMATH' && key === 'param2') return ['+', '-', '*', '/'].map((value) => ({ value, label: value }));
    if (key === 'param1' && operand === 'EDGE') return getElementAndGapOptions(row, 'elements');
    if (key === 'param1' && operand === 'EDGE_AIR') return getElementAndGapOptions(row, 'gaps');
    if (key === 'param1' && operand === 'CTCT') return getElementAndGapOptions(row, 'both');
    if ((key === 'param1' && operand === 'RADI') || ((key === 'param1' || key === 'param2') && operand === 'SDIST')) return getSurfaceOptions(row);
    if (key === 'param2' && ['EDGE', 'EDGE_AIR', 'ALL_EDGE_ELEMENT'].includes(operand)) return getHeightOptions(row);
    if (key === 'param3' && ['EDGE', 'ALL_EDGE_ELEMENT', 'EDGE_AIR'].includes(operand)) return [{ value: '', label: '(Radial)' }, { value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }];
    if (key === 'param5' && operand.startsWith('SPOT_SIZE')) return [{ value: '', label: '(Image)' }, ...getSurfaceOptions(row)];
    return null;
  };
  const parameterControl = (parameter: any, index: number) => {
    const key = String(parameter?.key || `param${index + 1}`);
    const label = String(parameter?.label || `P${index + 1}`).replace(/Object/g, 'Field');
    if ((row.operand === 'PP1' || row.operand === 'PP2') && row.param4 === 'ZG' && key === 'param3') return null;
    if (row.operand === 'EFL' && key === 'param2') {
      const blocks = getBlocks(row.configId);
      const options: SelectOption[] = [{ value: 'ALL', label: 'All blocks' }];
      blocks.forEach((block, blockIndex) => {
        const blockId = String(block?.blockId ?? '').trim();
        if (blockId) options.push({ value: blockId, label: getBlockLabel(block, blockIndex) });
        const zoomGroup = String(block?.parameters?.zoomGroup ?? '').trim();
        if (zoomGroup && !options.some((option) => option.value === zoomGroup)) options.push({ value: zoomGroup, label: `${zoomGroup} (Zoom Group)` });
      });
      return inputWithList(label, key, options);
    }
    const options = parameterOptions(parameter);
    return options ? select(label, key, options) : input(label, key);
  };
  return <div className="sr-inline-editor requirements-react-details">
    <div className="sr-inline-editor-title">Details</div>
    {select('Config', 'configId', configurationOptions)}
    {select('Wavelength', 'wavelengthScope', wavelengthOptions)}
    {select('Field', 'fieldScope', fieldOptions)}
    <div className="requirements-react-parameters">
      {parameters.filter((parameter: any) => String(parameter?.key ?? '') !== wavelengthParamKey).map((parameter: any, index: number) => <Fragment key={String(parameter?.key || `param${index + 1}`)}>{parameterControl(parameter, index)}</Fragment>)}
    </div>
    <div className="requirements-react-constraints">
      {select('Operand', 'op', ['=', '<=', '>='].map((value) => ({ value, label: value })))}
      {input('Tolerance', 'tol', 'number')}{input('Target', 'target', 'number')}{input('Weight', 'weight', 'number')}
    </div>
    <label className="requirements-react-field requirements-react-field--wide"><span>Rationale</span><textarea value={String(row.rationale || '')} onChange={(event) => patch({ rationale: event.target.value }, false)} /></label>
  </div>;
}
