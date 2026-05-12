/**
 * System Requirements Editor (DOM)
 * - Requirements are the source of truth (pass/fail constraints)
 * - System Evaluation UI is deprecated (no transfer)
 */

import { OPERAND_DEFINITIONS, InspectorManager } from './merit-function-inspector.ts';
import { getOpticalSystemRows } from '../../utils/data-utils.ts';
import { loadSystemConfigurations, saveSystemConfigurations } from '../../data/table-configuration.ts';
import { loadTableData as loadSourceTableData } from '../../data/table-source.ts';
import { loadTableData as loadObjectTableData } from '../../data/table-object.ts';
import { loadTableData as loadSystemRequirementsTableData, saveTableData as saveSystemRequirementsTableData } from '../../data/table-system-requirements.ts';
import { loadSpotDiagramSettingsByConfigId, saveSpotDiagramSettingsByConfigId } from '../spot-diagram-settings-storage.ts';
import { generateSurfaceOptions } from '../../evaluation/spot-diagram.ts';
import { calculateChiefRayNewton } from '../../evaluation/aberrations/transverse-aberration.ts';

// Extend Window interface for global properties
declare global {
  interface Window {
    [key: string]: any;
  }
}

// Safe window property accessors (avoiding 'as' to prevent compilation issues)
const w: Record<string, any> = window;

function tryLoadSystemConfigurations(): any {
  try {
    if (typeof localStorage === 'undefined') return null;
    return loadSystemConfigurations();
  } catch {
    return null;
  }
}

function trySaveSystemConfigurations(systemConfig: any): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    saveSystemConfigurations(systemConfig);
    return true;
  } catch {
    return false;
  }
}

// Zernike Noll index names (0-37)
const ZERNIKE_NOLL_NAMES = [
  '0: RMS (Remove P&T)',
  '1: Piston [0,0]',
  '2: Tilt Y [1,-1]',
  '3: Tilt X [1,1]',
  '4: Astigmatism [2,-2]',
  '5: Defocus [2,0]',
  '6: Astigmatism [2,2]',
  '7: Coma Y [3,-1]',
  '8: Coma X [3,1]',
  '9: Trefoil Y [3,-3]',
  '10: Trefoil X [3,3]',
  '11: Spherical [4,0]',
  '12: Secondary Astig [4,2]',
  '13: Secondary Astig [4,-2]',
  '14: Secondary Coma [4,4]',
  '15: Secondary Coma [4,-4]',
  '16: [5,-1]',
  '17: [5,1]',
  '18: [5,-3]',
  '19: [5,3]',
  '20: [5,-5]',
  '21: [5,5]',
  '22: Secondary Spherical [6,0]',
  '23: [6,2]',
  '24: [6,-2]',
  '25: [6,4]',
  '26: [6,-4]',
  '27: [6,6]',
  '28: [6,-6]',
  '29: [7,-1]',
  '30: [7,1]',
  '31: [7,-3]',
  '32: [7,3]',
  '33: [7,-5]',
  '34: [7,5]',
  '35: [7,-7]',
  '36: [7,7]',
  '37: Tertiary Spherical [8,0]'
];

class SystemRequirementsEditor {
  requirements: any[];
  table: any;
  _evalTimer: any;
  _meritHookInstalled: boolean;
  _isEditingCell: boolean;
  _pendingEvalAfterEdit: boolean;
  _tableRoot: HTMLTableElement | null;
  _tbody: HTMLTableSectionElement | null;
  _selectedId: any;
  _selectedIds: string[];
  _selectionAnchorId: string | null;
  _selectedTr: HTMLTableRowElement | null;
  _paramHeaderEls: any;
  _operandKeys: string[];
  _isEvaluating: boolean;
  _pendingEvalRequested: boolean;
  _evaluationPromise: Promise<void> | null;
  inspector: InspectorManager;
  _renderBody: any;
  _renderRow: any;
  _paramsExpanded: boolean;
  _paramToggleBtn: HTMLButtonElement | null;
  _copiedRows: any[];
  _keydownHandler: ((e: KeyboardEvent) => void) | null;

  constructor() {
    this.requirements = [];
    this.table = null;
    this._evalTimer = null;
    this._meritHookInstalled = false;
    this._isEditingCell = false;
    this._pendingEvalAfterEdit = false;
    this._tableRoot = null;
    this._tbody = null;
    this._selectedId = null;
    this._selectedIds = [];
    this._selectionAnchorId = null;
    this._selectedTr = null;
    this._paramHeaderEls = { param1: null, param2: null, param3: null, param4: null };
    this._operandKeys = [];
    this._isEvaluating = false;
    this._pendingEvalRequested = false;
    this._evaluationPromise = null;
    this._paramsExpanded = false;
    this._paramToggleBtn = null;
    this._copiedRows = [];
    this._keydownHandler = null;
    this.inspector = new InspectorManager('requirement-inspector', 'requirement-inspector-content');

    this.loadFromStorage();
    this.initializeTable();

    // Auto-update status when Merit is recalculated
    this.installMeritHook();
    this.scheduleEvaluateAndUpdate();
  }

  _getBlocksForConfigHint(configIdValue: any): any[] {
    try {
      let sys = null;
      try {
        if (typeof w.loadSystemConfigurationsFromTableConfig === 'function') {
          sys = w.loadSystemConfigurationsFromTableConfig();
        } else if (typeof w.ConfigurationManager !== 'undefined' && typeof w.ConfigurationManager.loadSystemConfigurations === 'function') {
          sys = w.ConfigurationManager.loadSystemConfigurations();
        } else if (typeof w.loadSystemConfigurations === 'function') {
          sys = w.loadSystemConfigurations();
        }
      } catch (_) {
        sys = null;
      }
      if (!sys) {
        sys = tryLoadSystemConfigurations();
      }

      const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
      const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null)
        ? String(sys.activeConfigId).trim()
        : '';

      const hint = (configIdValue === undefined || configIdValue === null)
        ? ''
        : String(configIdValue).trim();

      let cfg: any = null;
      if (hint) {
        cfg = configs.find((c: any) => c && String(c.id).trim() === hint)
          || configs.find((c: any) => c && String(c.name).trim() === hint)
          || null;
      }
      if (!cfg && activeId) {
        cfg = configs.find((c: any) => c && String(c.id).trim() === activeId) || null;
      }
      if (!cfg) {
        cfg = configs[0] || null;
      }

      return (cfg && Array.isArray(cfg.blocks)) ? cfg.blocks : [];
    } catch (_) {
      return [];
    }
  }

  _normalizeConfigId(configIdValue: any, systemConfig: any, activeConfigId: string): string {
    const raw = (configIdValue === undefined || configIdValue === null) ? '' : String(configIdValue).trim();
    if (!raw) return '';

    const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
    // Already a valid id?
    const byId = configs.find((c: any) => c && String(c.id) === raw);
    if (byId) return String(byId.id);

    // Backward compatibility: allow specifying config by name (e.g. "Wide")
    const byName = configs.find((c: any) => c && String(c.name).trim() === raw);
    if (byName) return String(byName.id);

    return raw;
  }

  _getLiveRequirementsData(): any[] {
    return Array.isArray(this.requirements) ? this.requirements : [];
  }

  _cloneLiveRequirementsRows(): any[] {
    try {
      return JSON.parse(JSON.stringify(this._getLiveRequirementsData()));
    } catch (_) {
      return Array.isArray(this.requirements) ? this.requirements.slice() : [];
    }
  }

  _getSelectedRequirementIds(): string[] {
    const rawIds = Array.isArray(this._selectedIds) && this._selectedIds.length > 0
      ? this._selectedIds
      : ((this._selectedId === null || this._selectedId === undefined || String(this._selectedId).trim() === '')
        ? []
        : [String(this._selectedId)]);
    const uniqueIds: string[] = [];
    for (const id of rawIds) {
      const normalized = String(id ?? '').trim();
      if (!normalized || uniqueIds.includes(normalized)) continue;
      uniqueIds.push(normalized);
    }
    return uniqueIds;
  }

  _isRequirementSelected(rowId: any): boolean {
    const rowKey = String(rowId ?? '').trim();
    if (!rowKey) return false;
    return this._getSelectedRequirementIds().includes(rowKey);
  }

  _getRequirementRangeIds(anchorId: any, rowId: any): string[] {
    const items = Array.isArray(this.requirements) ? this.requirements : [];
    const anchorKey = String(anchorId ?? '').trim();
    const rowKey = String(rowId ?? '').trim();
    if (!anchorKey || !rowKey) return rowKey ? [rowKey] : [];
    const anchorIndex = items.findIndex((entry: any) => entry && String(entry.id) === anchorKey);
    const rowIndex = items.findIndex((entry: any) => entry && String(entry.id) === rowKey);
    if (anchorIndex < 0 || rowIndex < 0) return [rowKey];
    const start = Math.min(anchorIndex, rowIndex);
    const end = Math.max(anchorIndex, rowIndex);
    return items
      .slice(start, end + 1)
      .map((entry: any) => String(entry?.id ?? '').trim())
      .filter(Boolean);
  }

  initializeTable(): void {
    this._operandKeys = (() => {
      try {
        const keys = InspectorManager.getAvailableOperands?.();
        return Array.isArray(keys) ? keys : Object.keys(OPERAND_DEFINITIONS);
      } catch (_) {
        return Object.keys(OPERAND_DEFINITIONS);
      }
    })();

    const escapeHtml = (s: any): string => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const formatNumberShort = (v: any): string => {
      if (v === null || v === undefined) return '';
      const s = String(v).trim();
      if (!s) return '';
      const n = Number(s);
      if (!Number.isFinite(n)) return s;
      if (n !== 0 && Math.abs(n) < 1e-6) return n.toExponential(3);
      if (Math.abs(n) >= 1e6) return n.toExponential(3);
      return String(n);
    };

    const getCtctElementLabelBySurfaceValue = (surfaceValue: any): string => {
      const raw = String(surfaceValue ?? '').trim();
      if (!raw) return '';
      try {
        const opticalRows = (getOpticalSystemRows as any)(null);
        if (!Array.isArray(opticalRows)) return raw;

        let lensCount = 0;
        let gapCount = 0;

        for (let i = 0; i < opticalRows.length; i++) {
          const surfRow = opticalRows[i];
          if (!surfRow) continue;

          const objType = String(surfRow['object type'] || surfRow.object || surfRow.surfType || '').trim().toLowerCase();
          const material = String(surfRow.material || '').trim().toLowerCase();
          const thickness = Number(surfRow.thickness);

          const isObject = objType === 'object';
          const isImage = objType === 'image';
          const isCT = objType === 'ct' || objType.includes('coordinate') || objType.includes('coordtrans');
          const isStop = objType === 'stop' || objType === 'sto' || objType === 'aperturestop';
          const isGlass = material && material !== 'air' && material !== '';
          const isGapType = objType === 'gap' || objType.includes('gap');
          const hasFiniteThickness = Number.isFinite(thickness);
          const gapThicknessRaw = surfRow.__cooptGapThickness;
          const hasAttachedGapThickness = gapThicknessRaw !== undefined
            && gapThicknessRaw !== null
            && String(gapThicknessRaw).trim() !== '';
          const isGapLike = isGapType || isStop || hasAttachedGapThickness || (!isGlass && hasFiniteThickness && Math.abs(thickness) > 1e-12);

          if (isObject || isCT || isImage) continue;

          const valueKey = String((surfRow.id !== undefined && surfRow.id !== null) ? surfRow.id : (i + 1));
          let label = '';

          if (isGapLike) {
            gapCount++;
            label = `Gap ${gapCount}`;
          } else if (isGlass) {
            lensCount++;
            label = `Lens ${lensCount}`;
          }

          if (valueKey === raw) return label || raw;
        }
      } catch (_) {}
      return raw;
    };

    const makeSpecSummary = (row: any): string => {
      const op = String(row?.op || '=').trim();
      const targetS = formatNumberShort(row?.target ?? 0);
      const tolRaw = row?.tol;
      const tol = Number(String(tolRaw ?? '').trim() === '' ? 0 : tolRaw);
      const tolS = formatNumberShort(tolRaw ?? 0);
      if (Number.isFinite(tol) && tol > 0) {
        if (op === '=') return `${op} ${targetS} ± ${tolS}`;
        if (op === '<=') return `${op} ${targetS} + ${tolS}`;
        if (op === '>=') return `${op} ${targetS} - ${tolS}`;
        return `${op} ${targetS} (tol ${tolS})`;
      }
      return `${op} ${targetS}`;
    };

    const rationalePreview = (v: any, maxLen = 64): string => {
      const s = (v === null || v === undefined) ? '' : String(v);
      const oneLine = s.split(/\r?\n/)[0].trim();
      if (!oneLine) return '';
      if (oneLine.length <= maxLen) return oneLine;
      return oneLine.slice(0, Math.max(0, maxLen - 1)) + '…';
    };

    const getEflDisplayLabelByBlockId = (blocks: any[]): Map<string, string> => {
      const labelById = new Map<string, string>();
      try {
        const counts = new Map<string, number>();
        for (const b of blocks || []) {
          if (!b || typeof b !== 'object') continue;
          const id = String(b.blockId ?? '').trim();
          if (!id) continue;
          const tRaw = String(b.blockType ?? '').trim();
          if (!tRaw) continue;
          if (tRaw === 'ObjectSurface' || tRaw === 'ImageSurface') {
            labelById.set(id, tRaw);
            continue;
          }
          const baseType = (tRaw === 'PositiveLens') ? 'Lens' : tRaw;
          const next = (counts.get(baseType) || 0) + 1;
          counts.set(baseType, next);
          labelById.set(id, `${baseType}-${next}`);
        }
      } catch (_) {}
      return labelById;
    };

    const ensureEflBlocksDatalist = (blocks: any[]): string | null => {
      try {
        const id = 'coopt-efl-blocks-datalist';
        let dl = document.getElementById(id) as HTMLDataListElement | null;
        if (!dl) {
          dl = document.createElement('datalist');
          dl.id = id;
          document.body.appendChild(dl);
        }
        dl.innerHTML = '';
        const displayLabelById = getEflDisplayLabelByBlockId(blocks || []);
        const addOpt = (value: string) => {
          const o = document.createElement('option');
          o.value = value;
          dl!.appendChild(o);
        };
        addOpt('ALL');
        const zoomGroups = Array.from(new Set(
          (blocks || [])
            .map((b: any) => String(b?.parameters?.zoomGroup ?? '').trim())
            .filter(Boolean)
        ));
        for (const group of zoomGroups) {
          addOpt(group);
        }
        for (const b of blocks || []) {
          const bid = String(b?.blockId ?? '').trim();
          if (!bid) continue;
          const label = displayLabelById.get(bid) || bid;
          addOpt(label);
        }
        return id;
      } catch (_) {
        return null;
      }
    };

    const ensurePrincipalPointZoomGroupsDatalist = (blocks: any[]): string | null => {
      try {
        const id = 'coopt-pp-zoom-groups-datalist';
        let dl = document.getElementById(id) as HTMLDataListElement | null;
        if (!dl) {
          dl = document.createElement('datalist');
          dl.id = id;
          document.body.appendChild(dl);
        }
        dl.innerHTML = '';

        const zoomGroups = Array.from(new Set(
          (blocks || [])
            .map((b: any) => String(b?.parameters?.zoomGroup ?? '').trim())
            .filter(Boolean)
        ));

        for (const group of zoomGroups) {
          const o = document.createElement('option');
          o.value = group;
          dl.appendChild(o);
        }
        return id;
      } catch (_) {
        return null;
      }
    };

    const getPrincipalPointZoomGroups = (blocks: any[]): string[] => {
      try {
        return Array.from(new Set(
          (blocks || [])
            .map((b: any) => String(b?.parameters?.zoomGroup ?? '').trim())
            .filter(Boolean)
        ));
      } catch (_) {
        return [];
      }
    };

    const getRequirementScopeOptions = (configIdValue: any): Array<{ value: string; label: string }> => {
      const options: Array<{ value: string; label: string }> = [
        { value: '0', label: '0: Total' },
      ];

      try {
        const opticalRows = (getOpticalSystemRows as any)(null);
        if (Array.isArray(opticalRows)) {
          for (let i = 0; i < opticalRows.length; i++) {
            const surfRow = opticalRows[i];
            if (!surfRow) continue;

            const objType = String(surfRow['object type'] || surfRow.object || surfRow.surfType || '').trim();
            const isObject = objType === 'Object';
            const isImage = objType === 'Image';
            const isCT = objType === 'CT' || objType.includes('Coordinate') || objType.includes('CoordTrans');
            const isGap = objType === 'GAP' || objType.toLowerCase() === 'gap';
            if (isObject || isImage || isCT || isGap) continue;

            const surfId = surfRow.id !== undefined && surfRow.id !== null ? String(surfRow.id) : String(i);
            const surfLabel = String(surfRow.comment || surfRow.label || `Surface ${surfId}`);
            options.push({ value: surfId, label: `${surfId}: ${surfLabel}` });
          }
        }
      } catch (_) {}

      try {
        const blocks = this._getBlocksForConfigHint(configIdValue);
        const displayLabelById = getEflDisplayLabelByBlockId(blocks || []);
        const seenZoomGroups = new Set<string>();
        for (const block of blocks || []) {
          const blockId = String(block?.blockId ?? '').trim();
          if (!blockId) continue;
          const label = displayLabelById.get(blockId) || blockId;
          options.push({ value: blockId, label: `${label} (Block)` });

          const zoomGroup = String(block?.parameters?.zoomGroup ?? '').trim().toUpperCase();
          if (zoomGroup && !seenZoomGroups.has(zoomGroup)) {
            seenZoomGroups.add(zoomGroup);
            options.push({ value: `ZG:${zoomGroup}`, label: `ZG:${zoomGroup} (Zoom Group)` });
          }
        }
      } catch (_) {}

      return options;
    };

    const getRequirementScopeLabel = (configIdValue: any, rawValue: any): string => {
      const raw = String(rawValue ?? '').trim();
      if (!raw) return '';
      const match = getRequirementScopeOptions(configIdValue).find((option) => option.value === raw);
      return match ? match.label : raw;
    };

    const container = document.getElementById('table-system-requirements');
    if (!container) {
      console.warn('[Requirements] Table container not found');
      return;
    }
    
    // Clear only table-related content, preserve other elements
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'sr-table-wrap';
    wrap.style.height = 'auto';
    wrap.style.minHeight = '100%';
    wrap.style.maxHeight = 'none';
    wrap.style.overflowX = 'auto';
    wrap.style.overflowY = 'auto';
    wrap.style.boxSizing = 'border-box';

    const table = document.createElement('table');
    table.className = 'sr-table';
    table.style.borderCollapse = 'collapse';
    table.style.width = 'max-content';
    table.style.minWidth = '100%';
    table.style.height = 'auto';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const mkTh = (text: string, widthPx: number, stickyLeftPx: number | null = null): HTMLTableCellElement => {
      const th = document.createElement('th');
      th.textContent = text;
      th.style.padding = '4px 6px';
      th.style.borderBottom = '1px solid #ddd';
      th.style.background = '#f9f9f9';
      th.style.fontSize = '12px';
      th.style.fontWeight = '600';
      th.style.position = 'sticky';
      th.style.top = '0px';
      th.style.zIndex = '10';
      th.style.whiteSpace = 'nowrap';
      if (widthPx) {
        th.style.width = `${widthPx}px`;
        th.style.minWidth = `${widthPx}px`;
        th.style.maxWidth = `${widthPx}px`;
      }
      if (stickyLeftPx !== null) {
        th.style.left = `${stickyLeftPx}px`;
        th.style.zIndex = '11';
      }
      return th;
    };

    // Sticky (left) columns
    const widths = {
      id: 48,
      enabled: 60,
      operand: 200,
      spec: 88,
      current: 96,
      status: 72,
      rationale: 220,
      configId: 120,
      param: 100,
      param2: 120,
      op: 80,
      tol: 90,
      target: 100,
      weight: 100,
      score: 110
    };
    const stickyOrder = [
      { key: 'id', label: 'Num', width: widths.id },
      { key: 'enabled', label: 'On', width: widths.enabled },
      { key: 'operand', label: 'Requirement', width: widths.operand },
      { key: '_spec', label: 'Spec', width: widths.spec },
      { key: 'current', label: 'Current', width: widths.current },
      { key: 'status', label: 'Status', width: widths.status }
    ];

    let left = 0;
    for (const c of stickyOrder) {
      headRow.appendChild(mkTh(c.label, c.width, left));
      left += c.width;
    }
    const detailsColumnWidth = 320;

    // Collapse the wide right-side controls into one compact summary column.
    const thDetails = mkTh('Details', detailsColumnWidth, null);
    headRow.appendChild(thDetails);
    headRow.appendChild(mkTh('Score', widths.score, null));

    this._paramToggleBtn = null as any;

    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    this._tbody = tbody;
    this._tableRoot = table;

    const setEditing = (editing: boolean): void => {
      this._isEditingCell = !!editing;
      if (!editing && this._pendingEvalAfterEdit) {
        this._pendingEvalAfterEdit = false;
        this.scheduleEvaluateAndUpdate();
      }
    };

    const onCellFocus = (): void => setEditing(true);
    const onCellBlur = (): void => setEditing(false);
    let draggedRequirementId: string | null = null;

    const clearRequirementDropIndicator = (rowEl: HTMLTableRowElement | null): void => {
      if (!rowEl) return;
      rowEl.style.boxShadow = '';
    };

    const moveRequirementRow = (fromId: string, toId: string, position: 'before' | 'after'): void => {
      const beforeRows = (() => {
        try {
          const rows = loadSystemRequirementsTableData();
          return Array.isArray(rows) && rows.length > 0
            ? JSON.parse(JSON.stringify(rows))
            : JSON.parse(JSON.stringify(this.requirements || []));
        } catch (_) {
          return [];
        }
      })();

      if (!Array.isArray(beforeRows) || beforeRows.length < 2) return;

      const fromIndex = beforeRows.findIndex((entry: any) => String(entry?.id) === String(fromId));
      const toIndex = beforeRows.findIndex((entry: any) => String(entry?.id) === String(toId));
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

      const afterRows = beforeRows.slice();
      const [movedRow] = afterRows.splice(fromIndex, 1);
      if (!movedRow) return;

      let insertIndex = toIndex;
      if (position === 'after') insertIndex += 1;
      if (fromIndex < insertIndex) insertIndex -= 1;
      insertIndex = Math.max(0, Math.min(afterRows.length, insertIndex));

      afterRows.splice(insertIndex, 0, movedRow);
      afterRows.forEach((entry: any, index: number) => {
        if (entry && typeof entry === 'object') entry.id = index + 1;
      });

      try {
        if (w.undoHistory && w.ReorderRequirementsCommand && !w.undoHistory.isExecuting) {
          const command = new w.ReorderRequirementsCommand(beforeRows, afterRows);
          w.undoHistory.record(command);
        }
      } catch (_) {}

      this.persistRequirementsRows(afterRows);
      this.loadFromStorage();
      this._selectedId = insertIndex + 1;
      this.renderTable();
      this.scheduleEvaluateAndUpdate();
    };

    const formatCurrentCell = (v: any): string => {
      if (v === null || v === undefined) return '';
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(6) : String(v);
    };

    const formatScoreCell = (v: any): string => {
      if (v === null || v === undefined) return '';
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(6) : String(v);
    };

    const setSelectedRow = (rowId: any, options?: { shiftKey?: boolean }): void => {
      const rowKey = String(rowId ?? '').trim();
      if (!rowKey) return;

      if (options?.shiftKey) {
        const anchorId = this._selectionAnchorId || String(this._selectedId ?? '').trim() || rowKey;
        this._selectedIds = this._getRequirementRangeIds(anchorId, rowKey);
        this._selectedId = rowId;
      } else {
        this._selectedId = rowId;
        this._selectedIds = [rowKey];
        this._selectionAnchorId = rowKey;
      }

      if (!this._tbody) return;

      const selectedIds = new Set(this._getSelectedRequirementIds());
      const rows = this._tbody.querySelectorAll('tr[data-id]');
      for (const rowEl of Array.from(rows)) {
        const tr = rowEl as HTMLTableRowElement;
        const id = String(tr.dataset.id ?? '').trim();
        tr.classList.toggle('sr-selected', !!id && selectedIds.has(id));
        if (id === rowKey) {
          this._selectedTr = tr;
        }
      }
      if (!this._selectedTr || String(this._selectedTr.dataset.id ?? '').trim() !== rowKey) this._selectedTr = null;

      const row = this.requirements.find((r: any) => r && String(r.id) === String(rowId)) || null;
      if (row) {
        try {
          if (this.inspector && typeof this.inspector.hide === 'function') this.inspector.hide();
        } catch (_) {}
      }
    };

    const renderRow = (row: any): { tr: HTMLTableRowElement; editorTr: HTMLTableRowElement | null } => {
      const tr = document.createElement('tr');
      tr.dataset.id = String(row.id);
      if (this._isRequirementSelected(row.id)) tr.classList.add('sr-selected');

      const mkTd = (widthPx: number, stickyLeftPx: number | null = null): HTMLTableCellElement => {
        const td = document.createElement('td');
        td.style.padding = '3px 6px';
        td.style.borderBottom = '1px solid #eee';
        td.style.fontSize = '12px';
        td.style.whiteSpace = 'nowrap';
        if (widthPx) {
          td.style.width = `${widthPx}px`;
          td.style.minWidth = `${widthPx}px`;
          td.style.maxWidth = `${widthPx}px`;
        }
        if (stickyLeftPx !== null) {
          td.style.position = 'sticky';
          td.style.left = `${stickyLeftPx}px`;
          td.style.zIndex = '5';
          td.style.background = 'inherit';
        }
        return td;
      };

      tr.addEventListener('click', (e) => {
        const t = e?.target as HTMLElement | null;
        const shiftKey = !!(e as MouseEvent).shiftKey;
        const selectionChanged = String(this._selectedId) !== String(row.id) || (shiftKey && !this._isRequirementSelected(row.id));
        const clickedCheckbox = !!(t && (t as HTMLInputElement).type === 'checkbox');
        const clickedControl = !!(t && typeof t.closest === 'function' && t.closest('input,select,textarea,button'));

        if (clickedCheckbox) {
          // Clicking a checkbox should never trigger expand/collapse.
          // Only update selection without expanding.
          if (selectionChanged) {
            setSelectedRow(row.id, { shiftKey });
          }
          return;
        }

        if (clickedControl) {
          if (selectionChanged) {
            if (!shiftKey) this._paramsExpanded = true;
            setSelectedRow(row.id, { shiftKey });
            if (!shiftKey) this.renderTable();
          }
          return;
        }

        if (shiftKey) {
          setSelectedRow(row.id, { shiftKey: true });
        } else if (selectionChanged) {
          this._paramsExpanded = true;
          setSelectedRow(row.id);
        } else {
          this._paramsExpanded = !this._paramsExpanded;
        }
        this.renderTable();
      });

      // Sticky cells
      let leftPx = 0;
      const tdId = mkTd(widths.id, leftPx);
      const idWrap = document.createElement('div');
      idWrap.style.display = 'flex';
      idWrap.style.alignItems = 'center';
      idWrap.style.gap = '4px';

      const dragHandle = document.createElement('span');
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to reorder';
      dragHandle.style.cursor = 'grab';
      dragHandle.style.fontSize = '12px';
      dragHandle.style.color = '#666';
      dragHandle.draggable = this.requirements.length > 1;

      const idLabel = document.createElement('span');
      idLabel.textContent = String(row.id);

      idWrap.appendChild(dragHandle);
      idWrap.appendChild(idLabel);
      tdId.appendChild(idWrap);
      tr.appendChild(tdId);
      leftPx += widths.id;

      if (this.requirements.length > 1) {
        dragHandle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        dragHandle.addEventListener('dragstart', (e: DragEvent) => {
          draggedRequirementId = String(row.id);
          tr.classList.add('dragging');
          dragHandle.style.cursor = 'grabbing';
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(row.id));
          }
          e.stopPropagation();
        });

        dragHandle.addEventListener('dragend', () => {
          draggedRequirementId = null;
          tr.classList.remove('dragging');
          dragHandle.style.cursor = 'grab';
          clearRequirementDropIndicator(tr);
        });

        tr.addEventListener('dragover', (e: DragEvent) => {
          if (!draggedRequirementId || draggedRequirementId === String(row.id)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          const rect = tr.getBoundingClientRect();
          const isBefore = e.clientY < rect.top + rect.height / 2;
          tr.style.boxShadow = isBefore
            ? 'inset 0 2px 0 #2563eb'
            : 'inset 0 -2px 0 #2563eb';
        });

        tr.addEventListener('dragleave', (e: DragEvent) => {
          const related = e.relatedTarget as Node | null;
          if (related && tr.contains(related)) return;
          clearRequirementDropIndicator(tr);
        });

        tr.addEventListener('drop', (e: DragEvent) => {
          if (!draggedRequirementId || draggedRequirementId === String(row.id)) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = tr.getBoundingClientRect();
          const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          clearRequirementDropIndicator(tr);
          moveRequirementRow(draggedRequirementId, String(row.id), position);
        });
      }

      // ── MEMO ROW ─────────────────────────────────────────────────────────────
      if (row.rowType === 'memo') {
        tr.style.background = '#fffbeb';
        const tdMemo = document.createElement('td');
        tdMemo.colSpan = 100;
        tdMemo.style.padding = '2px 8px';
        tdMemo.style.background = '#fffbeb';
        tdMemo.style.borderBottom = '1px solid #f0e7c0';
        const memoInput = document.createElement('input');
        memoInput.type = 'text';
        memoInput.value = String(row.memo || '');
        memoInput.placeholder = 'Memo / Note…';
        memoInput.style.width = '100%';
        memoInput.style.fontSize = '12px';
        memoInput.style.border = 'none';
        memoInput.style.background = 'transparent';
        memoInput.style.outline = 'none';
        memoInput.style.color = '#78716c';
        memoInput.style.fontStyle = 'italic';
        memoInput.addEventListener('focus', onCellFocus);
        memoInput.addEventListener('blur', onCellBlur);
        memoInput.addEventListener('input', () => {
          row.memo = memoInput.value;
          this.saveToStorage();
        });
        tdMemo.appendChild(memoInput);
        tr.appendChild(tdMemo);
        return { tr, editorTr: null };
      }
      // ─────────────────────────────────────────────────────────────────────────

      const tdOn = mkTd(widths.enabled, leftPx);
      const onCb = document.createElement('input');
      onCb.type = 'checkbox';
      onCb.checked = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
      onCb.addEventListener('change', () => {
        const nextValue = !!onCb.checked;
        const selectedIds = this._getSelectedRequirementIds();
        const applyIds = selectedIds.length > 1 && selectedIds.includes(String(row.id))
          ? selectedIds
          : [String(row.id)];

        for (const targetId of applyIds) {
          const targetRow = this.requirements.find((entry: any) => entry && String(entry.id) === String(targetId));
          if (!targetRow) continue;
          const oldValue = targetRow.enabled;
          targetRow.enabled = nextValue;

          if (w.undoHistory && w.SetRequirementCommand && !w.undoHistory.isExecuting && oldValue !== targetRow.enabled) {
            const command = new w.SetRequirementCommand(
              targetRow.id,
              'enabled',
              oldValue,
              targetRow.enabled
            );
            w.undoHistory.record(command);
          }
        }

        this.saveToStorage();
        this.renderTable();
        this.scheduleEvaluateAndUpdate();
      });
      onCb.addEventListener('focus', onCellFocus);
      onCb.addEventListener('blur', onCellBlur);
      tdOn.style.textAlign = 'center';
      tdOn.appendChild(onCb);
      tr.appendChild(tdOn);
      leftPx += widths.enabled;

      const tdOpd = mkTd(widths.operand, leftPx);
      const operandSel = document.createElement('select');
      operandSel.style.width = '100%';
      operandSel.style.fontSize = '12px';
      operandSel.addEventListener('focus', onCellFocus);
      operandSel.addEventListener('blur', onCellBlur);
      const formatOperandLabel = (key: string): string => {
        const labelOverrides: Record<string, string> = {
          EDGE: 'Edge Thickness',
          CTCT: 'Center Thickness'
        };
        if (labelOverrides[key]) {
          return labelOverrides[key];
        }
        const def: any = OPERAND_DEFINITIONS[key] || {};
        const source = String(def.name || def.description || key);
        const withoutSystemData = source
          .replace(/\s*\((?:System\s*data|System\s*Data)\)\s*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const maxLen = 34;
        if (withoutSystemData.length <= maxLen) return withoutSystemData;
        return `${withoutSystemData.slice(0, maxLen - 1)}…`;
      };
      for (const key of this._operandKeys) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = formatOperandLabel(key);
        operandSel.appendChild(opt);
      }
      operandSel.value = String(row.operand || '').trim();
      operandSel.addEventListener('change', () => {
        const oldValue = row.operand;
        row.operand = operandSel.value;

        // Initialize default params for specific operands
        if (row.operand === 'TA_RMS_UM') {
          row.param1 = '';   // Source: Primary wavelength
          row.param2 = '1';  // Object: first row
          row.param3 = '';   // Component: total
          row.param4 = '';   // Raynum: default(51)
        } else if (row.operand === 'OPD_RMS_WAVES') {
          row.param1 = '';   // Source: Primary wavelength
          row.param2 = '1';  // Object: first row
          row.param3 = '';   // Sampling: default(32)
          row.param4 = '';
        } else if (row.operand === 'ZERN_COEFF') {
          row.param1 = '';   // Source: Primary wavelength
          row.param2 = '1';  // Object: first row
          row.param3 = '';   // Unit: default waves
          row.param4 = '';   // Sampling: default(32)
          row.param5 = '0';  // Noll: RMS over coefficients
        }
        
        // Record undo command
        if (w.undoHistory && w.SetRequirementCommand && !w.undoHistory.isExecuting && oldValue !== row.operand) {
          const command = new w.SetRequirementCommand(
            row.id,
            'operand',
            oldValue,
            row.operand
          );
          w.undoHistory.record(command);
        }
        
        this.saveToStorage();
        
        // Operand change affects parameter types (dropdown vs text), so re-render entire table
        this.renderTable();
        this.scheduleEvaluateAndUpdate();
      });
      tdOpd.appendChild(operandSel);
      tr.appendChild(tdOpd);
      leftPx += widths.operand;

      const tdSpec = mkTd(widths.spec, leftPx);
      tdSpec.textContent = makeSpecSummary(row);
      tdSpec.dataset.role = 'spec';
      tr.appendChild(tdSpec);
      leftPx += widths.spec;

      const tdCur = mkTd(widths.current, leftPx);
      tdCur.style.textAlign = 'center';
      tdCur.textContent = formatCurrentCell(row.current);
      tdCur.dataset.role = 'current';
      tr.appendChild(tdCur);
      leftPx += widths.current;

      const tdSt = mkTd(widths.status, leftPx);
      tdSt.style.textAlign = 'center';
      tdSt.textContent = String(row.status ?? '').trim();
      tdSt.dataset.role = 'status';
      tr.appendChild(tdSt);
      leftPx += widths.status;

      // Collapsed summary + inline details editor
      let editorTr: HTMLTableRowElement | null = null;

      const cfgValues = this.getConfigurationList();
      const cfgSel = document.createElement('select');
      cfgSel.style.width = '100%';
      cfgSel.style.fontSize = '12px';
      cfgSel.style.height = '28px';
      cfgSel.style.lineHeight = '28px';
      cfgSel.style.padding = '4px 8px';
      cfgSel.style.boxSizing = 'border-box';
      cfgSel.addEventListener('focus', onCellFocus);
      cfgSel.addEventListener('blur', onCellBlur);
      for (const [val, label] of Object.entries(cfgValues || {})) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        cfgSel.appendChild(opt);
      }
      cfgSel.value = (row.configId === undefined || row.configId === null) ? '' : String(row.configId);
      const populateObjectSelect = (selectEl: HTMLSelectElement | null, cfgId: string): void => {
        if (!selectEl) return;
        const prev = selectEl.value;
        const objects = this._getObjectOptions(cfgId);
        while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
        for (const opt of objects) {
          const el = document.createElement('option');
          el.value = opt.value;
          el.textContent = opt.label;
          selectEl.appendChild(el);
        }
        if (prev !== undefined && prev !== null && prev !== '') {
          selectEl.value = prev;
        }
      };

      const mkInput = (field: string, widthPx: number, placeholder = '', paramDef: any = null): { td: HTMLTableCellElement; input: HTMLInputElement | HTMLSelectElement } => {
        const td = mkTd(widthPx, null);
        td.style.textAlign = 'center';
        td.dataset.paramField = field; // Mark for dynamic visibility
        
        let control: HTMLInputElement | HTMLSelectElement;
        const paramLabel = paramDef?.label || '';
        const paramDesc = paramDef?.description || '';
        
        // Determine if this should be a dropdown
        const isWavelengthParam = paramLabel.includes('λ') || paramDesc.toLowerCase().includes('source row');
        const isObjectParam = paramLabel.includes('Field idx') || paramLabel.includes('Object idx');
        const isMetricParam = paramLabel === 'Metric';
        const isComponentParam = paramLabel === 'Component';
        const isRaynumParam = paramLabel === 'Raynum';
        const isUnitParam = paramLabel === 'Unit';
        const isModeParam = paramLabel === 'Mode' || paramDesc.includes('0=Imaging, 1=Afocal');
        const isScopeParam = paramLabel === 'Scope';
        const isNollParam = paramLabel === 'n (Noll)';
        const isSamplingParam = paramLabel === 'Sampling';
        const isS1Param = paramLabel === 'S1' || (paramLabel.startsWith('S') && paramDesc.includes('Surface'));
        const isPrincipalPointOperand = String(row?.operand ?? '').trim() === 'PP1' || String(row?.operand ?? '').trim() === 'PP2';
        const isPrincipalPointModeParam = isPrincipalPointOperand && field === 'param4';
        const isPrincipalPointZoomGroupParam = isPrincipalPointOperand && field === 'param2' && String(row?.param4 ?? '').trim().toUpperCase() === 'ZG';
        const isPrincipalPointZoomGroupUnusedParam = isPrincipalPointOperand && field === 'param3' && String(row?.param4 ?? '').trim().toUpperCase() === 'ZG';
        const operandName = String(row?.operand ?? '').trim();
        const isAxisParam =
          (operandName === 'FL' || operandName === 'BFL' || operandName === 'IMD') && field === 'param2'
          || (operandName === 'EFL' && field === 'param3')
          || (operandName === 'EFFL' && field === 'param4');
        
        // SPOT_SIZE param5: Surface selection (1-based, empty=image)
        const isSpotSizeSurfaceParam = field === 'param5' && String(row?.operand ?? '').startsWith('SPOT_SIZE');
        
        // EDGE param2: Height selection (based on semidia)
        const isEdgeHeightParam = field === 'param2' && String(row?.operand ?? '').trim() === 'EDGE';
        
        // EDGE param3: Direction selection (X/Y/blank=Radial)
        const isEdgeDirectionParam = field === 'param3' && String(row?.operand ?? '').trim() === 'EDGE';
        
        if (isSpotSizeSurfaceParam) {
          // SPOT_SIZE param5: Surface selection dropdown (1-based surface numbers, empty=image)
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          
          // Add "Image" option (empty value)
          const imageOpt = document.createElement('option');
          imageOpt.value = '';
          imageOpt.textContent = '(Image)';
          control.appendChild(imageOpt);
          
          // Get optical system rows from Design Intent/config and use Spot Diagram-compatible numbering.
          try {
            const opticalRows = (getOpticalSystemRows as any)(null);
            if (Array.isArray(opticalRows)) {
              const surfaceOptions = generateSurfaceOptions(opticalRows);
              if (Array.isArray(surfaceOptions) && surfaceOptions.length > 0) {
                for (const s of surfaceOptions) {
                  const opt = document.createElement('option');
                  opt.value = String(s.value);
                  opt.textContent = String(s.label || `Surf ${s.value}`);
                  control.appendChild(opt);
                }
              }
            }
          } catch (err) {
            console.warn('Failed to populate SPOT_SIZE param5 dropdown:', err);
          }
          
          control.value = String(row[field] || '');
        } else if (isEdgeDirectionParam || isAxisParam) {
          // EDGE param5: Direction dropdown (Radial/X/Y)
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          
          const options = [
            { value: '', label: isAxisParam ? '(Default)' : '(Radial)' },
            { value: 'X', label: 'X' },
            { value: 'Y', label: 'Y' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isEdgeHeightParam) {
          // EDGE param2: Height dropdown (based on semidia of selected surface)
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          
          // Get semidia from param1 (surface ID)
          const selectedSurfaceId = row.param1;
          let semidia = 10; // default fallback
          
          try {
            const opticalRows = (getOpticalSystemRows as any)(null);
            if (Array.isArray(opticalRows) && selectedSurfaceId) {
              const selectedSurf = opticalRows.find((s: any) => 
                s && String(s.id) === String(selectedSurfaceId)
              );
              
              if (selectedSurf && selectedSurf.semidia) {
                const semidiaVal = Number(selectedSurf.semidia);
                if (Number.isFinite(semidiaVal) && semidiaVal > 0) {
                  semidia = semidiaVal;
                }
              }
            }
          } catch (err) {
            console.warn('Failed to get semidia for EDGE Height:', err);
          }
          
          // Generate height options as percentages of semidia
          const heightOptions = [
            { percent: 100, label: `${semidia.toFixed(2)} mm (100%)` },
            { percent: 95, label: `${(semidia * 0.95).toFixed(2)} mm (95%)` },
            { percent: 90, label: `${(semidia * 0.90).toFixed(2)} mm (90%)` },
            { percent: 85, label: `${(semidia * 0.85).toFixed(2)} mm (85%)` },
            { percent: 80, label: `${(semidia * 0.80).toFixed(2)} mm (80%)` },
            { percent: 70, label: `${(semidia * 0.70).toFixed(2)} mm (70%)` }
          ];
          
          for (const opt of heightOptions) {
            const el = document.createElement('option');
            el.value = String(semidia * opt.percent / 100);
            el.textContent = opt.label;
            control.appendChild(el);
          }
          
          control.value = String(row[field] || semidia);
        } else if (field === 'param1' && String(row?.operand ?? '').trim() === 'CTCT') {
          // CTCT param1: Element/Gap selection (Lens, Doublet, Triplet, Gap) in Design Intent order
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          
          // Get optical system rows from Design Intent
          try {
            const opticalRows = (getOpticalSystemRows as any)(null);
            if (Array.isArray(opticalRows)) {
              // First pass: build element groups (consecutive glass = doublet/triplet)
              type ElemEntry = { surfIndex: number; label: string };
              const entries: ElemEntry[] = [];
              let singleLensCount = 0;
              let doubletCount = 0;
              let tripletCount = 0;
              let gapCount = 0;
              const skipIndices = new Set<number>();

              for (let i = 0; i < opticalRows.length; i++) {
                if (skipIndices.has(i)) continue;
                const surfRow = opticalRows[i];
                if (!surfRow) continue;
                const objType = String(surfRow['object type'] || surfRow.object || surfRow.surfType || '').trim().toLowerCase();
                const material = String(surfRow.material || '').trim().toLowerCase();
                const thickness = Number(surfRow.thickness);
                const isObject = objType === 'object';
                const isImage = objType === 'image';
                const isCT = objType === 'ct' || objType.includes('coordinate') || objType.includes('coordtrans');
                const isStop = objType === 'stop' || objType === 'sto' || objType === 'aperturestop';
                const isGlass = material && material !== 'air' && material !== '';
                const isGapType = objType === 'gap' || objType.includes('gap');
                const hasFiniteThickness = Number.isFinite(thickness);
                const gapThicknessRaw = surfRow.__cooptGapThickness;
                const hasAttachedGapThickness = gapThicknessRaw !== undefined
                  && gapThicknessRaw !== null
                  && String(gapThicknessRaw).trim() !== '';
                const isGapLike = isGapType || isStop || hasAttachedGapThickness || (!isGlass && hasFiniteThickness && Math.abs(thickness) > 1e-12);
                if (isObject || isCT || isImage) continue;

                if (isGapLike) {
                  gapCount++;
                  entries.push({ surfIndex: i, label: `Gap ${gapCount}` });
                } else if (isGlass) {
                  // Count consecutive glass surfaces starting at i
                  let consec = 1;
                  for (let j = i + 1; j < opticalRows.length; j++) {
                    const ns = opticalRows[j];
                    if (!ns) break;
                    const nm = String(ns.material || '').trim().toLowerCase();
                    const no = String(ns['object type'] || ns.object || ns.surfType || '').trim().toLowerCase();
                    if (no === 'image' || no === 'stop' || no === 'sto') break;
                    if (nm && nm !== 'air' && nm !== '') consec++; else break;
                  }
                  if (consec >= 3) {
                    tripletCount++;
                    const grpName = `Triplet ${tripletCount}`;
                    for (let k = 0; k < consec; k++) {
                      entries.push({ surfIndex: i + k, label: `${grpName}_Lens${k + 1}` });
                      skipIndices.add(i + k);
                    }
                  } else if (consec === 2) {
                    doubletCount++;
                    const grpName = doubletCount === 1 ? 'Doublet' : `Doublet ${doubletCount}`;
                    entries.push({ surfIndex: i,     label: `${grpName}_Lens1` });
                    entries.push({ surfIndex: i + 1, label: `${grpName}_Lens2` });
                    skipIndices.add(i);
                    skipIndices.add(i + 1);
                  } else {
                    singleLensCount++;
                    entries.push({ surfIndex: i, label: `Lens ${singleLensCount}` });
                    skipIndices.add(i);
                  }
                }
              }

              for (const entry of entries) {
                const surfRow = opticalRows[entry.surfIndex];
                const opt = document.createElement('option');
                opt.value = String((surfRow?.id !== undefined && surfRow?.id !== null) ? surfRow.id : (entry.surfIndex + 1));
                opt.textContent = entry.label;
                control.appendChild(opt);
              }
            }
          } catch (err) {
            console.warn('Failed to populate CTCT param1 dropdown:', err);
          }
          
          control.value = String(row[field] || '');
        } else if (field === 'param1' && String(row?.operand ?? '').trim() === 'EDGE') {
          // EDGE param1: Element selection (Lens, Doublet_LensN, Triplet_LensN - no Gap)
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          
          // Get optical system rows from Design Intent
          try {
            const opticalRows = (getOpticalSystemRows as any)(null);
            if (Array.isArray(opticalRows)) {
              // First pass: build element groups so doublets/triplets each contribute
              // individual labeled entries (e.g. Doublet_Lens1, Doublet_Lens2)
              type EdgeEntry = { surfIndex: number; label: string };
              const entries: EdgeEntry[] = [];
              let singleLensCount = 0;
              let doubletCount = 0;
              let tripletCount = 0;
              const skipIndices = new Set<number>();

              for (let i = 0; i < opticalRows.length; i++) {
                if (skipIndices.has(i)) continue;
                const surfRow = opticalRows[i];
                if (!surfRow) continue;
                const objType = String(surfRow['object type'] || surfRow.object || surfRow.surfType || '').trim().toLowerCase();
                const material = String(surfRow.material || '').trim().toLowerCase();
                const isObject = objType === 'object';
                const isImage = objType === 'image';
                const isCT = objType === 'ct' || objType.includes('coordinate') || objType.includes('coordtrans');
                const isStop = objType === 'stop' || objType === 'sto' || objType === 'aperturestop';
                const isGlass = material && material !== 'air' && material !== '';
                if (isObject || isImage || isCT || isStop) continue;
                if (!isGlass) continue;

                // Count consecutive glass surfaces
                let consec = 1;
                for (let j = i + 1; j < opticalRows.length; j++) {
                  const ns = opticalRows[j];
                  if (!ns) break;
                  const nm = String(ns.material || '').trim().toLowerCase();
                  const no = String(ns['object type'] || ns.object || ns.surfType || '').trim().toLowerCase();
                  if (no === 'image' || no === 'stop' || no === 'sto') break;
                  if (nm && nm !== 'air' && nm !== '') consec++; else break;
                }

                if (consec >= 3) {
                  tripletCount++;
                  const grpName = tripletCount === 1 ? 'Triplet' : `Triplet ${tripletCount}`;
                  for (let k = 0; k < consec; k++) {
                    entries.push({ surfIndex: i + k, label: `${grpName}_Lens${k + 1}` });
                    skipIndices.add(i + k);
                  }
                } else if (consec === 2) {
                  doubletCount++;
                  const grpName = doubletCount === 1 ? 'Doublet' : `Doublet ${doubletCount}`;
                  entries.push({ surfIndex: i,     label: `${grpName}_Lens1` });
                  entries.push({ surfIndex: i + 1, label: `${grpName}_Lens2` });
                  skipIndices.add(i);
                  skipIndices.add(i + 1);
                } else {
                  singleLensCount++;
                  entries.push({ surfIndex: i, label: `Lens ${singleLensCount}` });
                  skipIndices.add(i);
                }
              }

              for (const entry of entries) {
                const opt = document.createElement('option');
                opt.value = String(entry.surfIndex + 1); // 1-based surface index
                opt.textContent = entry.label;
                control.appendChild(opt);
              }
            }
          } catch (err) {
            console.warn('Failed to populate EDGE param1 dropdown:', err);
          }
          
          control.value = String(row[field] || '');
        } else if (isPrincipalPointZoomGroupParam) {
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const emptyOpt = document.createElement('option');
          emptyOpt.value = '';
          emptyOpt.textContent = '(select zoom group)';
          control.appendChild(emptyOpt);
          try {
            const blocks = this._getBlocksForConfigHint(row?.configId);
            const zoomGroups = getPrincipalPointZoomGroups(blocks);
            for (const group of zoomGroups) {
              const opt = document.createElement('option');
              opt.value = group;
              opt.textContent = group;
              control.appendChild(opt);
            }
          } catch (_) {}
          control.value = (row[field] === undefined || row[field] === null) ? '' : String(row[field]);
        } else if (isPrincipalPointZoomGroupUnusedParam) {
          control = document.createElement('input');
          control.type = 'text';
          control.placeholder = '(unused in Zoom Group mode)';
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          control.value = '';
          control.disabled = true;
        } else if (isScopeParam) {
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          control.dataset.isScopeParam = '1';
          const options = getRequirementScopeOptions(row?.configId);
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '0');
        } else if (isS1Param) {
          // S1 (Surface) dropdown: 0=Total, then surfaces from Design Intent
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          
          // Add "Total" option
          const totalOpt = document.createElement('option');
          totalOpt.value = '0';
          totalOpt.textContent = '0: Total';
          control.appendChild(totalOpt);
          
          // Get optical system rows from Design Intent
          try {
            const opticalRows = (getOpticalSystemRows as any)(null);
            if (Array.isArray(opticalRows)) {
              for (let i = 0; i < opticalRows.length; i++) {
                const surfRow = opticalRows[i];
                if (!surfRow) continue;
                
                // Skip Object, Coordinate Break (CT), GAP, and Image surfaces
                const objType = String(surfRow['object type'] || surfRow.object || surfRow.surfType || '').trim();
                const isObject = objType === 'Object';
                const isImage = objType === 'Image';
                const isCT = objType === 'CT' || objType.includes('Coordinate') || objType.includes('CoordTrans');
                const isGap = objType === 'GAP' || objType.toLowerCase() === 'gap';
                
                if (isObject || isImage || isCT || isGap) continue;
                
                // Use surface id (not index)
                const surfId = surfRow.id !== undefined && surfRow.id !== null ? String(surfRow.id) : String(i);
                const surfLabel = surfRow.comment || surfRow.label || `Surface ${surfId}`;
                
                const opt = document.createElement('option');
                opt.value = surfId;
                opt.textContent = `${surfId}: ${surfLabel}`;
                control.appendChild(opt);
              }
            }
          } catch (err) {
            console.warn('Failed to populate S1 dropdown:', err);
          }
          
          control.value = String(row[field] || '0');
        } else if (isNollParam) {
          // Zernike Noll index dropdown (0-37)
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          for (let i = 0; i < ZERNIKE_NOLL_NAMES.length; i++) {
            const el = document.createElement('option');
            el.value = String(i);
            el.textContent = ZERNIKE_NOLL_NAMES[i];
            control.appendChild(el);
          }
          control.value = String(row[field] || '0');
        } else if (isSamplingParam) {
          // Sampling grid size dropdown (powers of 2)
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '', label: '(default 32)' },
            { value: '32', label: '32×32' },
            { value: '64', label: '64×64' },
            { value: '128', label: '128×128' },
            { value: '256', label: '256×256' },
            { value: '512', label: '512×512' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isPrincipalPointModeParam) {
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '', label: 'Surface Range' },
            { value: 'ZG', label: 'Zoom Group' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isModeParam) {
          // Mode dropdown: Imaging or Afocal
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '0', label: 'Imaging' },
            { value: '1', label: 'Afocal' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '0');
        } else if (isMetricParam) {
          // Metric dropdown: rms or dia
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '', label: '(default rms)' },
            { value: 'rms', label: 'RMS' },
            { value: 'dia', label: 'Diameter' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isComponentParam) {
          // Component dropdown: total / meridional / sagittal
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '', label: '(default total)' },
            { value: 'total', label: 'Total' },
            { value: 'meridional', label: 'Meridional' },
            { value: 'sagittal', label: 'Sagittal' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isRaynumParam) {
          // Raynum dropdown: fixed ray counts for transverse aberration RMS
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '11', label: '11' },
            { value: '21', label: '21' },
            { value: '51', label: '51' },
            { value: '101', label: '101' },
            { value: '501', label: '501' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '51');
        } else if (isUnitParam) {
          // Unit dropdown: waves or um
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const options = [
            { value: '', label: '(default waves)' },
            { value: 'waves', label: 'waves' },
            { value: 'um', label: 'µm' }
          ];
          for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isWavelengthParam) {
          // Wavelength dropdown
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          const wavelengths = this._getWavelengthOptions();
          for (const opt of wavelengths) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
        } else if (isObjectParam) {
          // Object index dropdown
          control = document.createElement('select');
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          control.dataset.isObjectParam = '1';
          const objects = this._getObjectOptions(row?.configId);
          for (const opt of objects) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
          control.addEventListener('focus', () => {
            // Refresh options so Object count stays in sync with latest table/config state.
            populateObjectSelect(control as HTMLSelectElement, row?.configId);
          });
        } else {
          // Standard text input
          control = document.createElement('input');
          control.type = 'text';
          control.placeholder = placeholder;
          control.style.width = '100%';
          control.style.fontSize = '12px';
          control.style.height = '24px';
          control.style.lineHeight = '24px';
          control.style.padding = '2px 4px';
          control.style.boxSizing = 'border-box';
          control.value = (row[field] === undefined || row[field] === null) ? '' : String(row[field]);
        }
        
        control.dataset.role = field;
        control.addEventListener('focus', onCellFocus);
        if (field === 'param2') {
          control.addEventListener('focus', () => {
            try {
              if (String(row?.operand ?? '').trim() === 'EFL' && control.tagName === 'INPUT') {
                const blocks = this._getBlocksForConfigHint(row?.configId);
                const dlId = ensureEflBlocksDatalist(blocks);
                if (dlId) (control as HTMLInputElement).setAttribute('list', dlId);
              } else if (isPrincipalPointZoomGroupParam && control.tagName === 'INPUT') {
                const blocks = this._getBlocksForConfigHint(row?.configId);
                const dlId = ensurePrincipalPointZoomGroupsDatalist(blocks);
                if (dlId) (control as HTMLInputElement).setAttribute('list', dlId);
              }
            } catch (_) {}
          });
        }
        
        if (control.tagName === 'SELECT') {
          control.addEventListener('change', () => {
            const oldValue = row[field];
            row[field] = control.value;

            if (isPrincipalPointModeParam) {
              if (control.value === 'ZG') {
                row.param3 = '';
              }
              if (control.value !== 'ZG' && String(row.param2 ?? '').trim() !== '' && !Number.isFinite(Number(row.param2))) {
                row.param2 = '';
              }
            }
            
            // Record undo command
            try {
              if (w.undoHistory && w.SetRequirementCommand && !w.undoHistory.isExecuting && oldValue !== control.value) {
                const command = new w.SetRequirementCommand(
                  row.id,
                  field,
                  oldValue,
                  control.value
                );
                w.undoHistory.record(command);
              }
            } catch (undoError) {
            }
            
            this.saveToStorage();

            if (isPrincipalPointModeParam) {
              this.renderTable();
              this.scheduleEvaluateAndUpdate();
              return;
            }
            
            // Re-render table if EDGE param1 changes (to update Height dropdown based on new semidia)
            if (field === 'param1' && String(row?.operand ?? '').trim() === 'EDGE') {
              this.renderTable();
              this.scheduleEvaluateAndUpdate();
              return;
            }
            
            this.scheduleEvaluateAndUpdate();
          });
          control.addEventListener('blur', onCellBlur);
        } else {
          control.addEventListener('blur', () => {
            const oldValue = row[field];
            let nextVal = control.value;
            try {
              if (field === 'param2' && String(row?.operand ?? '').trim() === 'EFL') {
                const blocks = this._getBlocksForConfigHint(row?.configId);
                const displayLabelById = getEflDisplayLabelByBlockId(blocks);
                const labelToId = new Map<string, string>();
                for (const [id, label] of displayLabelById.entries()) {
                  if (label) labelToId.set(String(label), String(id));
                }
                const raw = String(nextVal ?? '').trim();
                if (/^all$/i.test(raw)) {
                  nextVal = 'ALL';
                } else if (raw) {
                  const tokens = raw.split(/[\s,]+/).map((s: string) => String(s).trim()).filter(Boolean);
                  const mapped = tokens.map((t: string) => labelToId.get(t) || t);
                  if (mapped.some((t: string) => /^all$/i.test(String(t)))) nextVal = 'ALL';
                  else nextVal = mapped.join(',');
                }
              }
            } catch (_) {}
            row[field] = nextVal;
            if (nextVal !== control.value) control.value = nextVal;
            
            // Record undo command
            try {
              if (w.undoHistory && w.SetRequirementCommand && !w.undoHistory.isExecuting && oldValue !== nextVal) {
                const command = new w.SetRequirementCommand(
                  row.id,
                  field,
                  oldValue,
                  nextVal
                );
                w.undoHistory.record(command);
              }
            } catch (undoError) {
            }
            
            this.saveToStorage();

            if (field === 'tol' || field === 'target') {
              const specEl = tr.querySelector('td[data-role="spec"]');
              if (specEl) specEl.textContent = makeSpecSummary(row);
            }

            this.scheduleEvaluateAndUpdate();
            onCellBlur();
          });
        }
        
        td.appendChild(control);
        return { td, input: control };
      };

      // Get parameter count for current operand
      const operand = String(row?.operand ?? '').trim();
      const definition = operand ? OPERAND_DEFINITIONS[operand] : null;
      const paramCount = (definition && Array.isArray(definition.parameters)) ? definition.parameters.length : 4;
      const paramDefs = (definition && Array.isArray(definition.parameters)) ? definition.parameters : [];

      const tdDetails = mkTd(detailsColumnWidth, null);
      tdDetails.dataset.role = 'details-container';

      const paramsSummary = document.createElement('div');
      paramsSummary.className = 'params-summary';
      paramsSummary.style.display = 'block';
      paramsSummary.style.fontSize = '11px';
      paramsSummary.style.color = '#666';
      paramsSummary.style.cursor = 'pointer';
      paramsSummary.style.padding = '4px';
      paramsSummary.title = 'Select row to expand details below';

      const updateSummary = (): void => {
        const values = [];
        const operandName = String(row?.operand ?? '').trim();
        const objectOptions = this._getObjectOptions(row?.configId);
        const objectCount = Math.max(0, objectOptions.length - 1); // exclude default option
        const objectLabelByValue = new Map<string, string>();
        for (const opt of objectOptions) {
          objectLabelByValue.set(String(opt.value ?? ''), String(opt.label ?? ''));
        }
        for (let i = 1; i <= paramCount; i++) {
          const val = row[`param${i}`];
          if (val !== undefined && val !== null && String(val).trim() !== '') {
            const paramDef = paramDefs[i - 1];
            const label = paramDef?.label || `P${i}`;
            let displayVal = String(val);
            if (operandName === 'CTCT' && i === 1) {
              displayVal = getCtctElementLabelBySurfaceValue(val);
            } else if (label === 'Scope') {
              displayVal = getRequirementScopeLabel(row?.configId, val);
            } else if (label.includes('Field idx') || label.includes('Object idx')) {
              const selected = String(val).trim();
              const optLabel = objectLabelByValue.get(selected);
              if (optLabel && selected !== '') {
                displayVal = objectCount > 0
                  ? `${selected}/${objectCount} (${optLabel})`
                  : optLabel;
              } else if (objectCount > 0) {
                displayVal = `${selected}/${objectCount}`;
              }
            }
            values.push(`${label}=${displayVal}`);
          }
        }
        const configLabel = String((cfgValues as any)?.[String(row?.configId ?? '')] ?? row?.configId ?? '').trim();
        const targetSummary = String(row?.target ?? '').trim();
        const weightSummary = String(row?.weight ?? '').trim();
        const opSummary = String(row?.op || '=').trim() || '=';
        const pieces = [];
        if (configLabel) pieces.push(configLabel);
        if (values.length > 0) pieces.push(values.join(', '));
        if (targetSummary) pieces.push(`${opSummary} ${targetSummary}`);
        if (weightSummary) pieces.push(`w=${weightSummary}`);
        paramsSummary.textContent = pieces.length > 0 ? pieces.join(' • ') : 'Click to edit details';
      };
      updateSummary();
      paramsSummary.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const shiftKey = !!(ev as MouseEvent).shiftKey;
        const selectionChanged = String(this._selectedId) !== String(row.id) || (shiftKey && !this._isRequirementSelected(row.id));
        setSelectedRow(row.id, { shiftKey });
        if (!shiftKey && (selectionChanged || !this._paramsExpanded)) {
          this._paramsExpanded = true;
          this.renderTable();
        } else if (shiftKey) {
          this.renderTable();
        }
      });

      cfgSel.addEventListener('change', () => {
        const oldValue = row.configId;
        row.configId = cfgSel.value;

        if (w.undoHistory && w.SetRequirementCommand && !w.undoHistory.isExecuting && oldValue !== row.configId) {
          const command = new w.SetRequirementCommand(
            row.id,
            'configId',
            oldValue,
            row.configId
          );
          w.undoHistory.record(command);
        }

        this.saveToStorage();
        updateSummary();

        try {
          if (String(row?.operand ?? '').trim() === 'EFL') {
            const blocks = this._getBlocksForConfigHint(row?.configId);
            const dlId = ensureEflBlocksDatalist(blocks);
            const detailScope = editorTr || tr.parentElement || tr;
            const p2Input = detailScope.querySelector('input[data-role="param2"]') as HTMLInputElement | null;
            if (p2Input && dlId) p2Input.setAttribute('list', dlId);
          }
        } catch (_) {}
        try {
          const detailScope = editorTr || tr.parentElement || tr;
          const objSelects = detailScope.querySelectorAll('select[data-is-object-param="1"]');
          for (const sel of objSelects) populateObjectSelect(sel as HTMLSelectElement, row.configId);
          const scopeSelects = detailScope.querySelectorAll('select[data-is-scope-param="1"]');
          for (const sel of scopeSelects) {
            const selectEl = sel as HTMLSelectElement;
            const prev = String(selectEl.value || row.param3 || '0');
            selectEl.innerHTML = '';
            const options = getRequirementScopeOptions(row.configId);
            for (const opt of options) {
              const el = document.createElement('option');
              el.value = opt.value;
              el.textContent = opt.label;
              selectEl.appendChild(el);
            }
            selectEl.value = options.some((opt) => opt.value === prev) ? prev : '0';
            row.param3 = selectEl.value;
          }
        } catch (_) {}

        this.scheduleEvaluateAndUpdate();
      });

      const paramsExpanded = document.createElement('div');
      paramsExpanded.className = 'params-expanded';
      paramsExpanded.style.display = 'flex';
      paramsExpanded.style.flexDirection = 'column';
      paramsExpanded.style.alignItems = 'stretch';
      paramsExpanded.style.width = '100%';
      paramsExpanded.style.gap = '8px';

      for (let i = 1; i <= 5; i++) {
        const field = `param${i}`;
        const paramDef = paramDefs[i - 1];
        const container = document.createElement('div');
        container.className = 'param-input-container';
        container.style.flex = '0 0 auto';
        container.style.display = i <= paramCount ? 'grid' : 'none';
        container.style.gridTemplateColumns = '88px minmax(0, 1fr)';
        container.style.columnGap = '8px';
        container.style.alignItems = 'center';
        container.style.width = '100%';

        const label = document.createElement('div');
        label.className = 'param-input-label';
        label.textContent = (paramDef && paramDef.label) ? paramDef.label : '';
        container.appendChild(label);

        const { input: control } = mkInput(field, i === 2 ? widths.param2 : widths.param, '', paramDef);
        control.style.width = '100%';
        control.addEventListener('blur', () => {
          updateSummary();
        });
        control.addEventListener('change', () => {
          updateSummary();
        });

        if (operand === 'EFL' && i === 2 && control.tagName === 'INPUT') {
          try {
            const configIdHint = row?.configId;
            const blocks = this._getBlocksForConfigHint(configIdHint);
            const dlId = ensureEflBlocksDatalist(blocks);
            if (dlId) (control as HTMLInputElement).setAttribute('list', dlId);
            (control as HTMLInputElement).placeholder = 'ALL or blockId (comma separated allowed)';
          } catch (_) {}
        } else if ((operand === 'PP1' || operand === 'PP2') && i === 2 && control.tagName === 'INPUT') {
          try {
            if (String(row?.param4 ?? '').trim().toUpperCase() === 'ZG') {
              const configIdHint = row?.configId;
              const blocks = this._getBlocksForConfigHint(configIdHint);
              const dlId = ensurePrincipalPointZoomGroupsDatalist(blocks);
              if (dlId) (control as HTMLInputElement).setAttribute('list', dlId);
              (control as HTMLInputElement).placeholder = 'Zoom Group (A-Z)';
            } else {
              (control as HTMLInputElement).placeholder = 'Start Surface';
            }
          } catch (_) {}
        }

        container.appendChild(control);
        paramsExpanded.appendChild(container);
      }

      const opSel = document.createElement('select');
      opSel.style.width = '100%';
      opSel.style.fontSize = '12px';
      opSel.style.height = '28px';
      for (const v of ['=', '<=', '>=']) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        opSel.appendChild(opt);
      }
      opSel.value = String(row.op || '=').trim() || '=';
      opSel.addEventListener('focus', onCellFocus);
      opSel.addEventListener('blur', onCellBlur);
      opSel.addEventListener('change', () => {
        const oldValue = row.op;
        row.op = opSel.value;

        if (w.undoHistory && w.SetRequirementCommand && !w.undoHistory.isExecuting && oldValue !== row.op) {
          const command = new w.SetRequirementCommand(
            row.id,
            'op',
            oldValue,
            row.op
          );
          w.undoHistory.record(command);
        }

        this.saveToStorage();
        updateSummary();
        const specEl = tr.querySelector('td[data-role="spec"]');
        if (specEl) specEl.textContent = makeSpecSummary(row);
        this.scheduleEvaluateAndUpdate();
      });

      const { input: tolInput } = mkInput('tol', widths.tol);
      tolInput.addEventListener('blur', () => updateSummary());
      tolInput.addEventListener('change', () => updateSummary());
      const { input: targetInput } = mkInput('target', widths.target);
      targetInput.addEventListener('blur', () => updateSummary());
      targetInput.addEventListener('change', () => updateSummary());
      const { input: weightInput } = mkInput('weight', widths.weight);
      weightInput.addEventListener('blur', () => updateSummary());
      weightInput.addEventListener('change', () => updateSummary());

      const ratTa = document.createElement('textarea');
      ratTa.rows = 4;
      ratTa.value = (row.rationale === undefined || row.rationale === null) ? '' : String(row.rationale);
      ratTa.style.width = '100%';
      ratTa.style.fontSize = '12px';
      ratTa.style.boxSizing = 'border-box';
      ratTa.style.minHeight = '88px';
      ratTa.style.resize = 'vertical';
      ratTa.style.overflow = 'auto';
      const normalizeRationaleHeight = (v: any): string => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 40 ? `${Math.round(n)}px` : '';
      };
      const applyRationaleHeight = (): void => {
        const h = normalizeRationaleHeight(row?.rationaleHeight);
        ratTa.style.height = h || '';
      };
      const persistRationaleHeight = (): void => {
        const h = Math.round(ratTa.offsetHeight || ratTa.clientHeight || 0);
        if (h >= 40) row.rationaleHeight = h;
      };
      applyRationaleHeight();
      ratTa.addEventListener('mouseup', () => {
        persistRationaleHeight();
      });
      ratTa.addEventListener('focus', onCellFocus);
      ratTa.addEventListener('blur', () => {
        persistRationaleHeight();
        row.rationale = ratTa.value;
        this.saveToStorage();
        onCellBlur();
      });

      tdDetails.appendChild(paramsSummary);
      tr.appendChild(tdDetails);

      const tdScore = mkTd(widths.score, null);
      tdScore.style.textAlign = 'center';
      tdScore.textContent = formatScoreCell(row._contribution);
      tdScore.dataset.role = 'score';
      tr.appendChild(tdScore);

      if (this._paramsExpanded && String(this._selectedId) === String(row.id)) {
        const makeEditorField = (labelText: string, control: HTMLElement, wide = false): HTMLDivElement => {
          const field = document.createElement('div');
          field.className = `sr-inline-field${wide ? ' sr-inline-field--wide' : ''}`;
          const label = document.createElement('div');
          label.className = 'sr-inline-field-label';
          label.textContent = labelText;
          const body = document.createElement('div');
          body.className = 'sr-inline-field-control';
          body.appendChild(control);
          field.appendChild(label);
          field.appendChild(body);
          return field;
        };

        editorTr = document.createElement('tr');
        editorTr.className = 'sr-inline-editor-row';
        const editorTd = document.createElement('td');
        editorTd.colSpan = 100;
        editorTd.className = 'sr-inline-editor-cell';
        const editorWrap = document.createElement('div');
        editorWrap.className = 'sr-inline-editor';
        const editorTitle = document.createElement('div');
        editorTitle.className = 'sr-inline-editor-title';
        editorTitle.textContent = 'Details';
        editorWrap.appendChild(editorTitle);
        editorWrap.appendChild(makeEditorField('Config', cfgSel));
        editorWrap.appendChild(makeEditorField('Parameters', paramsExpanded, true));

        const constraintsGrid = document.createElement('div');
        constraintsGrid.className = 'sr-inline-editor-grid';
        constraintsGrid.appendChild(makeEditorField('Operand', opSel));
        constraintsGrid.appendChild(makeEditorField('Tolerance', tolInput as HTMLElement));
        constraintsGrid.appendChild(makeEditorField('Target', targetInput as HTMLElement));
        constraintsGrid.appendChild(makeEditorField('Weight', weightInput as HTMLElement));
        editorWrap.appendChild(constraintsGrid);
        editorWrap.appendChild(makeEditorField('Rationale', ratTa, true));
        editorTd.appendChild(editorWrap);
        editorTr.appendChild(editorTd);
      }

      return { tr, editorTr };
    };

    this._renderBody = (specFn: any, ratPrevFn: any, ensureDl: any): void => {
      if (!this._tbody) return;
      this._tbody.innerHTML = '';
      
      // Show placeholder if no requirements
      if (this.requirements.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 100;
        td.style.textAlign = 'center';
        td.style.padding = '16px 20px';
        td.style.color = '#999';
        td.style.fontStyle = 'italic';
        td.textContent = 'No requirements defined. Click "Add Requirement" to create one.';
        tr.appendChild(td);
        this._tbody.appendChild(tr);
        return;
      }
      
      // Render all requirements
      for (const r of this.requirements) {
        const rendered = renderRow(r) as { tr: HTMLTableRowElement; editorTr: HTMLTableRowElement | null };
        this._tbody.appendChild(rendered.tr);
        if (rendered.editorTr) this._tbody.appendChild(rendered.editorTr);
      }

      // Update header labels for selected operand if any.
      const sel = this.requirements.find((x: any) => x && String(x.id) === String(this._selectedId)) || null;
      if (sel) {
        setSelectedRow(sel.id);
      }
    };

    this._renderRow = renderRow;

    table.classList.toggle('sr-params-expanded', this._paramsExpanded);
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    // ── Keyboard shortcuts (Ctrl/Cmd+C copy, +V paste, +D duplicate, Delete/Backspace delete) ──
    // Remove previous listener to prevent duplicates when initializeTable() is called again.
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Ignore when an input/select/textarea has focus (let normal editing happen)
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      // Delete / Backspace → delete all selected rows
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = this._getSelectedRequirementIds();
        if (ids.length === 0) return;
        e.preventDefault();
        const storageData = this._cloneLiveRequirementsRows();
        const idSet = new Set(ids);
        const filtered = storageData.filter((r: any) => !idSet.has(String(r?.id ?? '')));
        filtered.forEach((r: any, idx: number) => { if (r) r.id = idx + 1; });
        this._selectedId = null;
        this._selectedIds = [];
        this.persistRequirementsRows(filtered);
        this.loadFromStorage();
        this.renderTable();
        this.syncRequirementsToSystemConfigFromStorage();
        return;
      }

      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;

      if (e.key === 'c' || e.key === 'C') {
        // Copy selected rows
        const ids = this._getSelectedRequirementIds();
        if (ids.length === 0) return;
        const rows = this._cloneLiveRequirementsRows();
        this._copiedRows = ids
          .map(id => rows.find((r: any) => String(r?.id) === id))
          .filter(Boolean)
          .map((r: any) => JSON.parse(JSON.stringify(r)));
        e.preventDefault();
      } else if (e.key === 'v' || e.key === 'V') {
        // Paste copied rows after selection
        if (this._copiedRows.length === 0) return;
        e.preventDefault();
        const storageData = this._cloneLiveRequirementsRows();
        const selectedIndex = this.requirements.findIndex(
          (r: any) => r && String(r.id) === String(this._selectedId)
        );
        let insertIndex = selectedIndex !== -1 ? selectedIndex + 1 : storageData.length;
        const pastedIds: number[] = [];
        for (const src of this._copiedRows) {
          const newRow = JSON.parse(JSON.stringify(src));
          storageData.splice(insertIndex, 0, newRow);
          pastedIds.push(insertIndex + 1);
          insertIndex++;
        }
        storageData.forEach((r: any, idx: number) => { if (r) r.id = idx + 1; });
        this.persistRequirementsRows(storageData);
        this.loadFromStorage();
        this._selectedIds = pastedIds.map((id) => String(id));
        this._selectedId = pastedIds.length > 0 ? pastedIds[pastedIds.length - 1] : this._selectedId;
        this._selectionAnchorId = pastedIds.length > 0 ? String(pastedIds[0]) : this._selectionAnchorId;
        this.renderTable();
        this.syncRequirementsToSystemConfigFromStorage();
      } else if (e.key === 'd' || e.key === 'D') {
        // Duplicate: copy + paste immediately
        const ids = this._getSelectedRequirementIds();
        if (ids.length === 0) return;
        e.preventDefault();
        const storageData = this._cloneLiveRequirementsRows();
        const rowsToDup = ids
          .map(id => storageData.find((r: any) => String(r?.id) === id))
          .filter(Boolean)
          .map((r: any) => JSON.parse(JSON.stringify(r)));
        if (rowsToDup.length === 0) return;
        const selectedIndex = this.requirements.findIndex(
          (r: any) => r && String(r.id) === String(this._selectedId)
        );
        let insertIndex = selectedIndex !== -1 ? selectedIndex + 1 : storageData.length;
        const duplicatedIds: number[] = [];
        for (const src of rowsToDup) {
          const newRow = JSON.parse(JSON.stringify(src));
          storageData.splice(insertIndex, 0, newRow);
          duplicatedIds.push(insertIndex + 1);
          insertIndex++;
        }
        storageData.forEach((r: any, idx: number) => { if (r) r.id = idx + 1; });
        this.persistRequirementsRows(storageData);
        this.loadFromStorage();
        this._selectedIds = duplicatedIds.map((id) => String(id));
        this._selectedId = duplicatedIds.length > 0 ? duplicatedIds[duplicatedIds.length - 1] : this._selectedId;
        this._selectionAnchorId = duplicatedIds.length > 0 ? String(duplicatedIds[0]) : this._selectionAnchorId;
        this.renderTable();
        this.syncRequirementsToSystemConfigFromStorage();
      }
    };
    this._keydownHandler = onKeyDown;
    document.addEventListener('keydown', onKeyDown);
    // ─────────────────────────────────────────────────────────────────────────

    const applyParamsExpandedLayout = (): void => {
      if (!this._tbody) return;
      const rows = this._tbody.querySelectorAll('tr');
      for (const row of rows) {
        if ((row as HTMLElement).classList.contains('sr-inline-editor-row')) continue;
        const cells = row.querySelectorAll('td');
        for (const td of cells) {
          (td as HTMLTableCellElement).style.paddingTop = '2px';
          (td as HTMLTableCellElement).style.paddingBottom = '2px';
          (td as HTMLTableCellElement).style.verticalAlign = 'middle';
        }
      }
    };

    // Initial render
    this._renderBody(makeSpecSummary, rationalePreview, ensureEflBlocksDatalist);
    applyParamsExpandedLayout();
  }

  _getWavelengthOptions(): Array<{ value: string; label: string }> {
    try {
      // Try to get from global source first
      let sourceRows: any = null;
      try {
        const systemConfig = tryLoadSystemConfigurations() || {};
        if (systemConfig && Array.isArray(systemConfig.source)) {
          sourceRows = systemConfig.source;
        }
      } catch (_) {}
      
      // Fallback to sourceTableData
      if (!sourceRows) {
        sourceRows = loadSourceTableData();
      }
      
      const options = [{ value: '', label: '(Primary)' }];
      
      if (Array.isArray(sourceRows) && sourceRows.length > 0) {
        const isPrimaryRow = (row: any): boolean => {
          if (!row || typeof row !== 'object') return false;
          const flags = [
            row?.primary,
            row?.Primary,
            row?.['Primary Wavelength'],
            row?.isPrimary,
            row?.primaryWavelength,
            row?.primary_flag
          ];
          return flags.some((f: any) => {
            if (f === true) return true;
            if (f === 1) return true;
            const s = String(f ?? '').trim().toLowerCase();
            return s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'primary' || s === 'primary wavelength' || s.includes('primary');
          });
        };
        sourceRows.forEach((row: any, idx: number) => {
          const wl = row?.wavelength;
          const isPrimary = isPrimaryRow(row);
          const label = `${idx + 1}: ${wl}µm${isPrimary ? ' (Primary)' : ''}`;
          options.push({ value: String(idx + 1), label });
        });
      }
      
      return options;
    } catch (e) {
      console.warn('Failed to get wavelength options:', e);
      return [{ value: '', label: '(Primary)' }];
    }
  }

  _getObjectOptions(configId: any = null): Array<{ value: string; label: string }> {
    try {
      // Try to get from active config first
      let objectRows: any = null;
      try {
        const systemConfig = tryLoadSystemConfigurations() || {};
        const activeId = systemConfig?.activeConfigId;
        const desiredId = (configId !== undefined && configId !== null && String(configId).trim() !== '')
          ? String(configId)
          : String(activeId ?? '');
        const cfgList = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
        const activeConfig = cfgList.find((c: any) => String(c?.id ?? '') === desiredId);
        if (activeConfig && Array.isArray(activeConfig.object)) objectRows = activeConfig.object;
      } catch (_) {}
      
      // Fallback to objectTableData
      if (!objectRows) {
        objectRows = loadObjectTableData();
      }
      
      const options = [{ value: '', label: '(default 1)' }];

      const fmtNum = (value: any): string | null => {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        const abs = Math.abs(n);
        let s = (abs >= 1000 || (abs > 0 && abs < 1e-3)) ? n.toExponential(3) : n.toFixed(4);
        s = s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
        return s;
      };

      const buildObjectLabel = (row: any, idx: number): string => {
        if (!row || typeof row !== 'object') return `${idx + 1}`;

        const xRaw = row?.xHeightAngle ?? row?.xHeight ?? row?.x ?? row?.X ?? 0;
        const yRaw = row?.yHeightAngle ?? row?.yHeight ?? row?.y ?? row?.Y ?? 0;
        const xStr = fmtNum(xRaw);
        const yStr = fmtNum(yRaw);

        const xText = (xStr !== null) ? xStr : '0';
        const yText = (yStr !== null) ? yStr : '0';

        return `${idx + 1}: x=${xText}, y=${yText}`;
      };

      if (Array.isArray(objectRows) && objectRows.length > 0) {
        objectRows.forEach((row: any, idx: number) => {
          const label = buildObjectLabel(row, idx);
          options.push({ value: String(idx + 1), label });
        });
      }
      
      return options;
    } catch (e) {
      console.warn('Failed to get object options:', e);
      return [{ value: '', label: '(default 1)' }];
    }
  }

  renderTable(): void {
    if (typeof this._renderBody === 'function') {
      this._renderBody(() => '', () => '', () => null);
    }
  }

  async _yieldToUI(): Promise<void> {
    try {
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    } catch (_) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  _upsertSpotDiagramSettingsForConfig(configId: string, opticalRows: any[], sourceRows: any[]): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const cfgKey = String(configId ?? '').trim();
      if (!cfgKey) return;

      const isImageRow = (row: any): boolean => {
        if (!row || typeof row !== 'object') return false;
        const t1 = String(row['object type'] ?? '').trim();
        const t2 = String(row.object ?? '').trim();
        const st = String(row.surfType ?? '').trim().toLowerCase();
        if (t1 === 'Image' || t2 === 'Image') return true;
        return st === 'image' || st.includes('image');
      };

      const isCoordTransRow = (row: any): boolean => {
        if (!row || typeof row !== 'object') return false;
        const st = String(row.surfType ?? row.type ?? '').trim().toLowerCase();
        const t1 = String(row['object type'] ?? '').trim().toLowerCase();
        const t2 = String(row.object ?? '').trim().toLowerCase();
        const compact = (v: any) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
        const stc = compact(st);
        const t1c = compact(t1);
        const t2c = compact(t2);
        const isCb = (v: string) => v === 'ct' || v === 'coordtrans' || v === 'coordinatebreak';
        return isCb(stc) || isCb(t1c) || isCb(t2c) || st === 'coord trans' || st === 'coordinate transform' || t1 === 'coord trans' || t1 === 'coordinate transform' || t2 === 'coord trans' || t2 === 'coordinate transform';
      };

      const imageIdx = (() => {
        if (!Array.isArray(opticalRows) || opticalRows.length === 0) return 0;
        const i = opticalRows.findIndex((r: any) => isImageRow(r));
        return (i >= 0) ? i : Math.max(0, opticalRows.length - 1);
      })();

      const resolvedSurfaceId = (() => {
        try {
          const opts = generateSurfaceOptions(Array.isArray(opticalRows) ? opticalRows : []);
          if (Array.isArray(opts) && opts.length > 0) {
            const imageOpt = opts.find((opt: any) => {
              const label = String(opt?.label ?? '').toLowerCase();
              return label.includes('(image)') || label.includes(' image');
            });
            const preferred = imageOpt || opts[opts.length - 1];
            const numericId = Number(preferred?.surfaceId ?? preferred?.value);
            if (Number.isFinite(numericId) && numericId > 0) {
              return numericId;
            }
          }
        } catch (_) {}
        return Math.max(1, imageIdx);
      })();

      const primaryWavelengthUm = (() => {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5876;
        const isPrimaryRow = (r: any): boolean => {
          if (!r || typeof r !== 'object') return false;
          const flags = [
            r?.primary,
            r?.Primary,
            r?.['Primary Wavelength'],
            r?.isPrimary,
            r?.primaryWavelength,
            r?.primary_flag
          ];
          return flags.some((f: any) => {
            if (f === true) return true;
            if (f === 1) return true;
            const s = String(f ?? '').trim().toLowerCase();
            return s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'primary' || s === 'primary wavelength' || s.includes('primary');
          });
        };
        const primaryRow = sourceRows.find((r: any) => isPrimaryRow(r));
        const wl = Number(primaryRow ? (primaryRow.wavelength ?? primaryRow.Wavelength) : NaN);
        if (Number.isFinite(wl) && wl > 0) return wl;

        const dLine = 0.5875618;
        let bestWl = NaN;
        let bestDiff = Infinity;
        for (const row of sourceRows) {
          const candidate = Number(row?.wavelength ?? row?.Wavelength);
          if (!Number.isFinite(candidate) || candidate <= 0) continue;
          const diff = Math.abs(candidate - dLine);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestWl = candidate;
          }
        }
        return (Number.isFinite(bestWl) && bestWl > 0) ? bestWl : dLine;
      })();

      const map = loadSpotDiagramSettingsByConfigId();
      const existing = map[cfgKey];
      if (existing && typeof existing === 'object') {
        // Keep user-chosen values if present; only fill missing fields.
        // CRITICAL: If existing.surfaceId doesn't match current Image surface ID,
        // force update (e.g., CB insertion shifted surface IDs).
        const needsIdUpdate = (
          existing.surfaceId !== undefined &&
          existing.surfaceId !== null &&
          existing.surfaceId !== resolvedSurfaceId
        );
        const needsIndexUpdate = (
          existing.surfaceRowIndex !== undefined &&
          existing.surfaceRowIndex !== null &&
          Number(existing.surfaceRowIndex) !== imageIdx
        ) || (
          existing.surfaceIndex !== undefined &&
          existing.surfaceIndex !== null &&
          Number(existing.surfaceIndex) !== imageIdx
        );
        if (needsIdUpdate || needsIndexUpdate || existing.surfaceIndex === undefined || existing.surfaceIndex === null) {
          existing.surfaceIndex = imageIdx;
        }
        if (needsIdUpdate || needsIndexUpdate || existing.surfaceId === undefined || existing.surfaceId === null) {
          existing.surfaceId = resolvedSurfaceId;
        }
        if (needsIdUpdate || needsIndexUpdate || existing.surfaceRowIndex === undefined || existing.surfaceRowIndex === null) {
          existing.surfaceRowIndex = imageIdx;
        }
        if (existing.rayCount === undefined || existing.rayCount === null) existing.rayCount = 501;
        if (existing.ringCount === undefined || existing.ringCount === null) existing.ringCount = 3;
        if (existing.primaryWavelengthUm === undefined || existing.primaryWavelengthUm === null) existing.primaryWavelengthUm = primaryWavelengthUm;
        if (existing.configId === undefined || existing.configId === null) existing.configId = cfgKey;
        existing.updatedAt = Date.now();
        map[cfgKey] = existing;
      } else {
        map[cfgKey] = {
          surfaceIndex: imageIdx,
          surfaceId: resolvedSurfaceId,
          surfaceRowIndex: imageIdx,
          rayCount: 501,
          ringCount: 3,
          pattern: null,
          primaryWavelengthUm,
          configId: cfgKey,
          updatedAt: Date.now()
        };
      }
      saveSpotDiagramSettingsByConfigId(map);
      
      // CRITICAL: Also update in-memory cache so merit evaluation uses the latest settings immediately.
      // This prevents CB insertion from causing stale surfaceId resolution during the next evaluation.
      try {
        if (typeof window !== 'undefined') {
          w.__cooptSpotDiagramSettingsByConfigId = map;
        }
      } catch (_) {}
    } catch (_) {
      // ignore
    }
  }

  async updateAllConfigsAndEvaluate(): Promise<void> {
    
    // Force using UI table rows during this update cycle (blocks may be stale after CB insertion).
    let prevPreferTable: any;
    try {
      if (typeof globalThis !== 'undefined') {
        prevPreferTable = (globalThis as any).__cooptPreferTableOpticalSystemRows;
        (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
      }
    } catch (_) {}

    // CRITICAL: Clear memory caches at the start to force fresh data load.
    // Keep __cooptOpticalSystemByConfigId so non-active configs retain CB-aware rows.
    try {
      if (typeof window !== 'undefined') {
        delete w.__cooptSystemConfig;
        delete w.__cooptSpotDiagramSettingsByConfigId;
      }
    } catch (_) {}

    // Ensure each configuration has an up-to-date expanded opticalSystem snapshot
    // and has a per-config Spot Diagram settings entry.
    const editor = w.meritFunctionEditor;
    if (!editor || typeof editor.getOpticalSystemDataByConfigId !== 'function') {
      try { await this.evaluateAndUpdateNow({ reason: 'no-merit-editor' }); } catch (_) {}
      return;
    }

    let systemConfig: any = null;
    try {
      systemConfig = tryLoadSystemConfigurations() || {};
    } catch (_) {
      systemConfig = {};
    }
    const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
    if (!systemConfig || configs.length === 0) {
      await this.evaluateAndUpdateNow({ reason: 'no-configs' });
      return;
    }

    const updateBtn = document.getElementById('update-requirement-btn') as HTMLButtonElement | null;
    try { if (updateBtn) updateBtn.disabled = true; } catch (_) {}

    try {
      let globalSourceRows: any[] = [];
      try {
        const rows = loadSourceTableData();
        globalSourceRows = Array.isArray(rows) ? rows : [];
      } catch (_) {}
      
      // CRITICAL: Get active config's optical rows first (CB-aware).
      // This will be used for Spot Diagram settings across ALL configs.
      // MUST read UI table directly, bypassing blocks expansion (which may be stale after CB insertion).
      let activeConfigOpticalRows: any = null;
      const activeConfigId = (systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null)
        ? String(systemConfig.activeConfigId)
        : '';
      
      if (activeConfigId) {
        try {
          // Directly access UI table, bypassing blocks-first logic in getOpticalSystemRows
          if (w.tableOpticalSystem && typeof w.tableOpticalSystem.getData === 'function') {
            activeConfigOpticalRows = w.tableOpticalSystem.getData();
          } else if (w.opticalSystemTabulator && typeof w.opticalSystemTabulator.getData === 'function') {
            activeConfigOpticalRows = w.opticalSystemTabulator.getData();
          }
          
        } catch (_) {}
        
        // Fallback: Set temporary flag to force table reading, then call getOpticalSystemRows
        if (!Array.isArray(activeConfigOpticalRows) || activeConfigOpticalRows.length === 0) {
          try {
            if (typeof globalThis !== 'undefined') {
              (globalThis as any).__cooptPreferTableOpticalSystemRows = true;
            }
            const fn = (typeof getOpticalSystemRows === 'function') ? getOpticalSystemRows : null;
            if (fn) activeConfigOpticalRows = (fn as any)(null);
            if (typeof globalThis !== 'undefined') {
              delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
            }
          } catch (_) {}
        }
      }

      for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        const cfgId = (cfg && cfg.id !== undefined && cfg.id !== null) ? String(cfg.id) : '';
        if (!cfgId) continue;

        const isActiveCfg = activeConfigId && String(activeConfigId) === cfgId;

        const cachedRows = (() => {
          try {
            if (typeof window !== 'undefined' && w.__cooptOpticalSystemByConfigId) {
              const c = w.__cooptOpticalSystemByConfigId[cfgId];
              return (Array.isArray(c) && c.length > 0) ? c : null;
            }
          } catch (_) {}
          return null;
        })();

        let opticalRows: any = null;
        try {
          // CRITICAL: Active config must read from live UI table (CB insertion updates UI first).
          // Non-active configs should prefer cached rows if they differ from the active UI rows
          // (e.g., CB inserted in a different config), otherwise fall back to blocks expansion.
          if (isActiveCfg) {
            // Use the active config rows we already fetched
            opticalRows = activeConfigOpticalRows;
          } else if (cachedRows) {
            // Non-active: prefer cached rows to avoid mixing with active config UI rows.
            opticalRows = cachedRows;
          } else {
            // Non-active: use blocks expansion (deterministic snapshot).
            opticalRows = editor.getOpticalSystemDataByConfigId(cfgId);
          }
        } catch (_) {
          opticalRows = null;
        }
        if (Array.isArray(opticalRows) && opticalRows.length > 0) {
          cfg.opticalSystem = opticalRows;
          try {
            if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
            cfg.metadata.modified = new Date().toISOString();
          } catch (_) {}
          
          // CRITICAL: Store latest opticalRows in memory cache so merit evaluation
          // uses fresh data immediately after CB insertion (before localStorage reload).
          try {
            if (typeof window !== 'undefined') {
              if (!w.__cooptOpticalSystemByConfigId) w.__cooptOpticalSystemByConfigId = {};
              w.__cooptOpticalSystemByConfigId[cfgId] = opticalRows;
            }
          } catch (_) {}
        }

        // CRITICAL: Use active config's optical rows for ALL configs' Spot Diagram settings.
        // This ensures all configs use the CB-aware Image surface ID.
        const rowsForSpotSettings = cachedRows
          ? cachedRows
          : (Array.isArray(opticalRows) ? opticalRows : (Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : []));
        
        this._upsertSpotDiagramSettingsForConfig(
          cfgId,
          rowsForSpotSettings,
          globalSourceRows
        );

        if (i % 2 === 0) await this._yieldToUI();
      }

      // NOTE: Do not overwrite per-config Spot Diagram settings with active config values.
      // Only create missing entries.
      try {
        const activeId = (systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null)
          ? String(systemConfig.activeConfigId)
          : '';
        if (activeId) {
          const map = loadSpotDiagramSettingsByConfigId();
          const activeCfgSettings = map[activeId];

          if (activeCfgSettings && typeof activeCfgSettings === 'object' && activeCfgSettings.surfaceId) {
            const activeImageSurfaceId = activeCfgSettings.surfaceId;

            for (const cfg of configs) {
              const cfgId = (cfg && cfg.id !== undefined && cfg.id !== null) ? String(cfg.id) : '';
              if (!cfgId || cfgId === activeId) continue;
              
              let existing = map[cfgId];
              // If settings don't exist for this config, create them.
              if (!existing || typeof existing !== 'object') {
                existing = {
                  surfaceIndex: activeCfgSettings.surfaceIndex,
                  surfaceId: activeImageSurfaceId,
                  rayCount: activeCfgSettings.rayCount || 501,
                  ringCount: activeCfgSettings.ringCount || 3,
                  pattern: activeCfgSettings.pattern || null,
                  primaryWavelengthUm: activeCfgSettings.primaryWavelengthUm || 0.5876,
                  configId: cfgId,
                  updatedAt: Date.now()
                };
                map[cfgId] = existing;
              }
            }
            
            saveSpotDiagramSettingsByConfigId(map);
          }
        }
      } catch (_) {}

      try {
        trySaveSystemConfigurations(systemConfig);
        // CRITICAL: Also cache in memory so getOpticalSystemDataByConfigId
        // reads fresh data immediately after CB insertion (before localStorage sync).
        if (typeof window !== 'undefined') {
          w.__cooptSystemConfig = systemConfig;
        }
      } catch (_) {}
    } finally {
      try { if (updateBtn) updateBtn.disabled = false; } catch (_) {}
    }

    await this.evaluateAndUpdateNow({ reason: 'update-button' });

    // Restore previous preferTable flag
    try {
      if (typeof globalThis !== 'undefined') {
        if (prevPreferTable === undefined) {
          delete (globalThis as any).__cooptPreferTableOpticalSystemRows;
        } else {
          (globalThis as any).__cooptPreferTableOpticalSystemRows = prevPreferTable;
        }
      }
    } catch (_) {}
  }

  createDefaultRequirementRow(): any {
    let activeConfigId = '';
    try {
      const systemConfig = tryLoadSystemConfigurations() || {};
      if (systemConfig && systemConfig.activeConfigId) activeConfigId = String(systemConfig.activeConfigId);
    } catch (_) {}

    return {
      id: this.requirements.length + 1,
      enabled: true,
      operand: 'EFFL',
      rationale: '',
      rationaleHeight: 0,
      configId: activeConfigId,
      param1: '',
      param2: '',
      param3: '',
      param4: '',
      param5: '',
      op: '=',
      tol: 0,
      target: 0,
      weight: 1
    };
  }

  createDefaultMemoRow(): any {
    return {
      id: this.requirements.length + 1,
      rowType: 'memo',
      memo: ''
    };
  }

  addMemoRow(): void {
    const storageData = loadSystemRequirementsTableData();
    const selectedIndex = this.requirements.findIndex((r: any) => r && String(r.id) === String(this._selectedId));
    const insertIndex = selectedIndex !== -1 ? selectedIndex + 1 : storageData.length;

    const newRow = this.createDefaultMemoRow();
    newRow.id = insertIndex + 1;

    try {
      if (w.undoHistory && w.AddRowCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.AddRowCommand('requirement', JSON.parse(JSON.stringify(newRow)), insertIndex, false);
        cmd.execute();
        w.undoHistory.record(cmd);
        this.syncRequirementsToSystemConfigFromStorage();
      } else {
        storageData.splice(insertIndex, 0, JSON.parse(JSON.stringify(newRow)));
        this.persistRequirementsRows(storageData);
        this.loadFromStorage();
        this.renderTable();
      }
    } catch (_) {
      storageData.splice(insertIndex, 0, JSON.parse(JSON.stringify(newRow)));
      this.persistRequirementsRows(storageData);
      this.loadFromStorage();
      this.renderTable();
    }
  }

  addRequirement(): void {
    // Get current data from localStorage to ensure consistency
    const storageData = loadSystemRequirementsTableData();
    
    // Calculate insertIndex based on current selection in this.requirements
    const selectedIndex = this.requirements.findIndex((r: any) => r && String(r.id) === String(this._selectedId));
    let insertIndex;
    if (selectedIndex !== -1) {
      insertIndex = selectedIndex + 1;
    } else {
      insertIndex = storageData.length; // Use localStorage length, not this.requirements.length
    }
    
    // Create new row with temporary ID (will be renumbered)
    const newRow = this.createDefaultRequirementRow();
    newRow.id = insertIndex + 1; // Temporary ID based on position
    
    // Create command and execute, then record for undo
    try {
      if (w.undoHistory && w.AddRowCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.AddRowCommand('requirement', JSON.parse(JSON.stringify(newRow)), insertIndex, false);
        cmd.execute(); // Execute first (this will update localStorage and refresh UI)
        w.undoHistory.record(cmd); // Then record for undo
        this.syncRequirementsToSystemConfigFromStorage();
      } else {
        // Fallback if undo system is not available
        storageData.splice(insertIndex, 0, JSON.parse(JSON.stringify(newRow)));
        this.persistRequirementsRows(storageData);
        this.loadFromStorage();
        this.renderTable();
      }
    } catch (e) {
      // Fallback
      storageData.splice(insertIndex, 0, JSON.parse(JSON.stringify(newRow)));
      this.persistRequirementsRows(storageData);
      this.loadFromStorage();
      this.renderTable();
    }
  }

  deleteRequirement(): void {
    if (this._selectedId === null || this._selectedId === undefined || String(this._selectedId).trim() === '') {
      alert('削除する行を選択してください');
      return;
    }

    // Find index in current requirements (after any previous operations)
    const idx = this.requirements.findIndex((r: any) => r && String(r.id) === String(this._selectedId));
    if (idx === -1) return;
    
    // Get the actual data from localStorage to ensure we're deleting the right row
    const storageData = loadSystemRequirementsTableData();
    if (idx >= storageData.length) {
      return;
    }
    
    const deletedRow = JSON.parse(JSON.stringify(storageData[idx])); // Use storage data, not this.requirements
    this._selectedId = null;

    // Create command and execute, then record for undo
    try {
      if (w.undoHistory && w.DeleteRowCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.DeleteRowCommand('requirement', deletedRow, idx, false);
        cmd.execute(); // Execute first (this will update localStorage and refresh UI)
        w.undoHistory.record(cmd); // Then record for undo
        this.syncRequirementsToSystemConfigFromStorage();
        
        try {
          if (this.inspector && typeof this.inspector.hide === 'function') this.inspector.hide();
        } catch (_) {}
      } else {
        // Fallback if undo system is not available
        storageData.splice(idx, 1);
        this.persistRequirementsRows(storageData);
        this.loadFromStorage();
        this.renderTable();
        
        try {
          if (this.inspector && typeof this.inspector.hide === 'function') this.inspector.hide();
        } catch (_) {}
      }
    } catch (e) {
      // Fallback
      storageData.splice(idx, 1);
      this.persistRequirementsRows(storageData);
      this.loadFromStorage();
      this.renderTable();
      
      try {
        if (this.inspector && typeof this.inspector.hide === 'function') this.inspector.hide();
      } catch (_) {}
    }
  }

  setAllEnabled(enabled: boolean): void {
    const nextEnabled = !!enabled;
    const live = this._getLiveRequirementsData();
    this.requirements = live;
    if (!Array.isArray(live) || live.length === 0) return;

    const beforeRows = (() => {
      try {
        const rows = loadSystemRequirementsTableData();
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
      } catch (_) {
        return [];
      }
    })();

    let changed = false;
    for (const row of live) {
      if (!row || typeof row !== 'object') continue;
      const prevEnabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
      if (prevEnabled !== nextEnabled) {
        row.enabled = nextEnabled;
        changed = true;
      }
    }

    if (!changed) return;

    this.saveToStorage();

    const afterRows = (() => {
      try {
        const rows = loadSystemRequirementsTableData();
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
      } catch (_) {
        return [];
      }
    })();

    try {
      if (w.undoHistory && w.SetRequirementEnabledBulkCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.SetRequirementEnabledBulkCommand(beforeRows, afterRows, nextEnabled);
        w.undoHistory.record(cmd);
      }
    } catch (_) {}

    this.renderTable();
    this.scheduleEvaluateAndUpdate();
  }

  setAllWeights(weightValue: number): { updated: number; reason?: string } {
    const nextWeight = Number(weightValue);
    if (!Number.isFinite(nextWeight) || nextWeight < 0) {
      return { updated: 0, reason: 'invalid-weight' };
    }

    const live = this._getLiveRequirementsData();
    this.requirements = live;
    if (!Array.isArray(live) || live.length === 0) {
      return { updated: 0, reason: 'no-requirements' };
    }

    const beforeRows = (() => {
      try {
        const rows = loadSystemRequirementsTableData();
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
      } catch (_) {
        return [];
      }
    })();

    let updated = 0;
    for (const row of live) {
      if (!row || typeof row !== 'object') continue;
      const prevWeight = Number(row.weight);
      const prevComparable = Number.isFinite(prevWeight) ? prevWeight : 1;
      if (Math.abs(prevComparable - nextWeight) <= Math.max(1e-12, Math.abs(nextWeight) * 1e-12)) continue;
      row.weight = nextWeight;
      updated += 1;
    }

    if (updated <= 0) {
      return { updated: 0, reason: 'already-set' };
    }

    this.saveToStorage();

    const afterRows = (() => {
      try {
        const rows = loadSystemRequirementsTableData();
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
      } catch (_) {
        return [];
      }
    })();

    try {
      if (w.undoHistory && w.SetRequirementWeightsBulkCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.SetRequirementWeightsBulkCommand(beforeRows, afterRows, `to ${nextWeight}`);
        w.undoHistory.record(cmd);
      }
    } catch (_) {}

    this.renderTable();
    this.scheduleEvaluateAndUpdate();
    return { updated };
  }

  async normalizeWeightsForUnitScore(): Promise<{ updated: number; skipped: number; reason?: string }> {
    await this.flushPendingEdits();
    await this.evaluateAndUpdateNow({ reason: 'normalize-weight-baseline' });

    const live = this._getLiveRequirementsData();
    this.requirements = live;
    if (!Array.isArray(live) || live.length === 0) {
      return { updated: 0, skipped: 0, reason: 'no-requirements' };
    }

    const beforeRows = (() => {
      try {
        const rows = loadSystemRequirementsTableData();
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
      } catch (_) {
        return [];
      }
    })();

    let updated = 0;
    let skipped = 0;

    for (const row of live) {
      if (!row || typeof row !== 'object') {
        skipped += 1;
        continue;
      }

      const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
      const operand = String(row.operand || '').trim();
      const score = Number(row._contribution);
      const prevWeight = Number(row.weight);

      if (!enabled || !operand) {
        skipped += 1;
        continue;
      }
      if (!Number.isFinite(score) || score <= 0) {
        skipped += 1;
        continue;
      }
      if (!Number.isFinite(prevWeight) || prevWeight <= 0) {
        skipped += 1;
        continue;
      }

      const nextWeight = Number((prevWeight / score).toPrecision(12));
      if (!Number.isFinite(nextWeight) || nextWeight <= 0) {
        skipped += 1;
        continue;
      }
      if (Math.abs(nextWeight - prevWeight) <= Math.max(1e-12, Math.abs(prevWeight) * 1e-12)) {
        skipped += 1;
        continue;
      }

      row.weight = nextWeight;
      updated += 1;
    }

    if (updated <= 0) {
      return { updated: 0, skipped, reason: 'no-positive-scores' };
    }

    this.saveToStorage();

    const afterRows = (() => {
      try {
        const rows = loadSystemRequirementsTableData();
        return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
      } catch (_) {
        return [];
      }
    })();

    try {
      if (w.undoHistory && w.SetRequirementWeightsBulkCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.SetRequirementWeightsBulkCommand(beforeRows, afterRows, `normalized (${updated})`);
        w.undoHistory.record(cmd);
      }
    } catch (_) {}

    this.renderTable();
    await this.evaluateAndUpdateNow({ reason: 'normalize-weight-apply' });
    return { updated, skipped };
  }

  transferSelectedToEvaluation(): void {
    alert('System Evaluation は廃止されました。Requirements が仕様（合否）です。');
  }

  computeViolationAmount(op: string, current: any, target: number, tol: number): number {
    if (current === null || current === undefined) return NaN;
    if (typeof current === 'string' && current.trim() === '') return NaN;
    const c = Number(current);
    const t = Number(target);
    const z = Math.max(0, Number(tol));
    if (!Number.isFinite(c) || !Number.isFinite(t)) return NaN;
    if (op === '<=') return Math.max(0, c - (t + z));
    if (op === '>=') return Math.max(0, (t - z) - c);
    return Math.max(0, Math.abs(c - t) - z);
  }

  _sanitizeCurrentForUI(rawCurrent: any): { current: any; ok: boolean } {
    // Preserve non-empty string diagnostics (e.g. explicit failure labels)
    // rather than collapsing them to an empty cell.
    if (typeof rawCurrent === 'string' && rawCurrent.trim() !== '') {
      const asNum = Number(rawCurrent);
      if (!Number.isFinite(asNum)) return { current: rawCurrent.trim(), ok: false };
    }

    const v = Number(rawCurrent);
    if (!Number.isFinite(v)) return { current: 'FAIL', ok: false };

    // Many operands historically returned ~1e9 on ray-trace failure.
    // Hiding it entirely is confusing in System Requirements, so show a marker.
    if (Math.abs(v) >= 1e8) return { current: 'FAIL', ok: false };

    return { current: v, ok: true };
  }

  applyOptimizerRequirementSnapshot(snapshotRows: any[]): boolean {
    const live = this._getLiveRequirementsData();
    this.requirements = live;
    if (!Array.isArray(live) || live.length === 0) return false;
    if (!Array.isArray(snapshotRows) || snapshotRows.length === 0) return false;

    const byId = new Map<string, any>();
    for (const row of snapshotRows) {
      if (!row || row.id === undefined || row.id === null) continue;
      byId.set(String(row.id), row);
    }
    if (byId.size === 0) return false;

    const updates: any[] = [];
    for (const row of live) {
      if (!row || row.id === undefined || row.id === null) continue;
      const snap = byId.get(String(row.id));
      if (!snap) continue;

      const sanitized = this._sanitizeCurrentForUI(snap.current);
      const amountRaw = Number(snap.amount);
      const amount = Number.isFinite(amountRaw) ? Math.max(0, amountRaw) : Number.POSITIVE_INFINITY;
      const weight = Math.max(0, Number.isFinite(Number(row?.weight)) ? Number(row.weight) : 1);
      const contributionRaw = Number(snap.contribution);
      const contribution = Number.isFinite(contributionRaw)
        ? contributionRaw
        : (sanitized.ok && Number.isFinite(amount) ? weight * amount : null);

      let status = 'OK';
      if (weight <= 0) {
        status = 'OFF';
      } else if (!sanitized.ok) {
        status = 'NG';
      } else if (!Number.isFinite(amount)) {
        status = '—';
      } else if (amount > 0) {
        status = 'NG';
      }

      row.current = sanitized.current;
      row.status = status;
      row._violation = sanitized.ok && Number.isFinite(amount) ? amount : null;
      row._contribution = sanitized.ok && Number.isFinite(Number(contribution)) ? Number(contribution) : null;
      updates.push({
        id: row.id,
        current: row.current,
        status: row.status,
        _violation: row._violation,
        _contribution: row._contribution,
      });
    }

    if (updates.length === 0) return false;

    try {
      if (this._tbody) {
        for (const u of updates) {
          const tr = this._tbody.querySelector(`tr[data-id="${String(u.id)}"]`);
          if (!tr) continue;
          const curEl = tr.querySelector('td[data-role="current"]');
          const stEl = tr.querySelector('td[data-role="status"]');
          const scoreEl = tr.querySelector('td[data-role="score"]');
          if (curEl) {
            const v = u.current;
            const n = Number(v);
            curEl.textContent = (v === null || v === undefined) ? '' : (Number.isFinite(n) ? n.toFixed(6) : String(v));
          }
          if (stEl) stEl.textContent = String(u.status ?? '').trim();
          if (scoreEl) {
            const v = u._contribution;
            const n = Number(v);
            scoreEl.textContent = (v === null || v === undefined) ? '' : (Number.isFinite(n) ? n.toFixed(6) : String(v));
          }
        }
      }
    } catch (_) {}

    try {
      w.__cooptLastRequirementsEval = { at: Date.now(), stage: 'optimizer-snapshot', updated: updates.length };
    } catch (_) {}

    try {
      const syncedAt = Date.now();
      let syncedScore = Number.NaN;
      let contributionCount = 0;
      for (const row of live) {
        const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
        const operand = String(row?.operand ?? '').trim();
        const weight = Number(row?.weight ?? 1);
        if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
        const contribution = Number(row?._contribution);
        if (!Number.isFinite(contribution)) continue;
        if (contribution > 0) {
          syncedScore = Number.isFinite(syncedScore) ? (syncedScore + contribution) : contribution;
        } else if (!Number.isFinite(syncedScore)) {
          syncedScore = 0;
        }
        contributionCount += 1;
      }

      if (contributionCount > 0 && Number.isFinite(syncedScore)) {
        try {
          localStorage.setItem('coopt.requirementScoreSync', JSON.stringify({
            ts: syncedAt,
            score: syncedScore,
            source: 'system-requirements-editor/optimizer-snapshot'
          }));
        } catch (_) {}
        try {
          window.dispatchEvent(new CustomEvent('coopt:requirements-updated', {
            detail: {
              ts: syncedAt,
              score: syncedScore,
              source: 'system-requirements-editor/optimizer-snapshot'
            }
          }));
        } catch (_) {}
      }
    } catch (_) {}

    return true;
  }

  async evaluateAndUpdateNow(options: any = null): Promise<void> {
    if (this._isEvaluating) {
      this._pendingEvalRequested = true;
      await (this._evaluationPromise || Promise.resolve());
      return;
    }
    this._isEvaluating = true;
    this._evaluationPromise = (async () => {

    try {
      w.__cooptLastRequirementsEval = { at: Date.now(), stage: 'enter' };
    } catch (_) {}

    if (this._isEditingCell) {
      this._pendingEvalAfterEdit = true;
      try {
        w.__cooptLastRequirementsEval = { at: Date.now(), stage: 'deferred-edit' };
      } catch (_) {}
      this._isEvaluating = false;
      return;
    }

    const editor = w.meritFunctionEditor;
    if (!editor || typeof editor.calculateOperandValue !== 'function') {
      try { w.__cooptLastRequirementsEval = { at: Date.now(), stage: 'no-merit-editor' }; } catch (_) {}
      this._isEvaluating = false;
      return;
    }

    try {
      w.__cooptLastRequirementsEval = { at: Date.now(), stage: 'running' };
    } catch (_) {}

    let systemConfig: any = null;
    try {
      systemConfig = tryLoadSystemConfigurations() || {};
    } catch (_) {
      systemConfig = {};
    }
    const activeConfigId = systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null
      ? String(systemConfig.activeConfigId)
      : '';

    const live = this._getLiveRequirementsData();
    this.requirements = live;

    const isOptimizerRunning = (() => {
      try {
        return !!(typeof globalThis !== 'undefined' && (globalThis as any).__cooptOptimizerIsRunning);
      } catch (_) {
        return false;
      }
    })();
    const yieldEvery = isOptimizerRunning ? 32 : 2;

    // Requirements are a pass/fail spec. They should reflect the same semantics as the UI analyses
    // (e.g., Spot Diagram) rather than any optimization/fast-mode heuristics.
    const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
    const prevFast = g ? g.__cooptMeritFastMode : null;
    const prevReqFlag = g ? g.__COOPT_EVALUATING_REQUIREMENTS : undefined;
    try {
      if (g && prevFast && typeof prevFast === 'object') {
        g.__cooptMeritFastMode = { ...prevFast, enabled: false };
      }
      if (g) {
        g.__COOPT_EVALUATING_REQUIREMENTS = true;
      }
    } catch (_) {}

    const updates: any[] = [];
    try {
    for (let i = 0; i < live.length; i++) {
      const row = live[i];
      if (!row || typeof row !== 'object') continue;

      // Skip memo-only rows entirely
      if (row.rowType === 'memo') continue;

      const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
      const operand = String(row.operand || '').trim();
      const op = String(row.op || '=').trim();
      const tol = (row.tol === undefined || row.tol === null || String(row.tol).trim() === '') ? 0 : Number(row.tol);
      const target = (row.target === undefined || row.target === null || String(row.target).trim() === '') ? 0 : Number(row.target);
      const weight = (row.weight === undefined || row.weight === null || String(row.weight).trim() === '') ? 1 : Number(row.weight);

      const configId = this._normalizeConfigId(row.configId, systemConfig, activeConfigId);

      if (!enabled || !operand) {
        updates.push({ id: row.id, current: null, status: '—' });
        continue;
      }

      const opObj = {
        operand,
        configId,
        __reqRowId: row.id,
        __reqRowIndex: i,
        __reqOp: op,
        __reqTarget: target,
        __reqTol: tol,
        __reqWeight: weight,
        __reqEnabled: enabled,
        param1: row.param1,
        param2: row.param2,
        param3: row.param3,
        param4: row.param4,
        param5: row.param5,
        target,
        weight
      };

      let current: any = null;
      try {
        if (editor && typeof editor.calculateOperandValueAsync === 'function') {
          current = await editor.calculateOperandValueAsync(opObj);
        } else {
          current = editor.calculateOperandValue(opObj);
        }

        // If this is a Spot Size operand, capture its debug snapshot keyed by requirement row id.
        // This prevents "last debug wins" confusion when multiple configs/rows are evaluated.
        try {
          if (typeof window !== 'undefined') {
            const opName = String(operand || '').trim();
            if (opName.startsWith('SPOT_SIZE')) {
              const sd = (w.__cooptLastSpotSizeDebug && typeof w.__cooptLastSpotSizeDebug === 'object')
                ? w.__cooptLastSpotSizeDebug
                : null;
              const rid = row.id;
              if (sd && rid !== undefined && rid !== null && Number(sd.reqRowId) === Number(rid)) {
                const map = (w.__cooptSpotSizeDebugByReqRowId && typeof w.__cooptSpotSizeDebugByReqRowId === 'object')
                  ? w.__cooptSpotSizeDebugByReqRowId
                  : {};
                let snap = sd;
                try {
                  snap = (typeof structuredClone === 'function') ? structuredClone(sd) : JSON.parse(JSON.stringify(sd));
                } catch (_) {}
                map[String(rid)] = snap;
                w.__cooptSpotSizeDebugByReqRowId = map;
              }
            }
          }
        } catch (_) {}
      } catch (_) {
        current = null;
      }

      const sanitized = this._sanitizeCurrentForUI(current);
      current = sanitized.current;

      // Violation amount (hinge with tol/op). Used for Status.
      // Keep optimizer-aligned diagnostics in hidden fields, but show raw operand value in the UI.
      const amount = sanitized.ok ? this.computeViolationAmount(op, current, target, tol) : Number.POSITIVE_INFINITY;
      const wEff = Math.max(0, Number.isFinite(weight) ? weight : 1);
      const contribution = Number.isFinite(amount) ? (wEff * Math.max(0, amount)) : null;

      let status = 'OK';

      // IMPORTANT: The optimizer treats weight<=0 as disabled (it filters those requirements out).
      // To avoid confusing mismatches like "Status NG but Optimize Score 0", reflect that here.
      if (wEff <= 0) {
        status = 'OFF';
      } else if (!sanitized.ok) {
        status = 'NG';
      } else if (!Number.isFinite(amount)) {
        status = '—';
      } else if (amount > 0) {
        status = 'NG';
      }

      // Current: raw operand value (e.g., Spot size in µm).
      // _violation/_contribution are available for debugging/consistency checks.
      updates.push({ id: row.id, current, status, _violation: sanitized.ok ? amount : null, _contribution: sanitized.ok ? contribution : null });

      if (yieldEvery > 0 && i % yieldEvery === 0) await this._yieldToUI();
    }
    } finally {
      try {
        if (g) g.__cooptMeritFastMode = prevFast;
        if (g) g.__COOPT_EVALUATING_REQUIREMENTS = prevReqFlag;
      } catch (_) {}

    }

    try {
      if (Array.isArray(updates) && updates.length > 0) {
        for (const u of updates) {
          const r = this.requirements.find((x: any) => x && x.id === u.id);
          if (r) {
            r.current = u.current;
            r.status = u.status;
            r._violation = u._violation;
            r._contribution = u._contribution;
          }
        }

        // Patch DOM for Current/Status/Score only to preserve focus.
        if (this._tbody) {
          for (const u of updates) {
            const tr = this._tbody.querySelector(`tr[data-id="${String(u.id)}"]`);
            if (!tr) continue;
            const curEl = tr.querySelector('td[data-role="current"]');
            const stEl = tr.querySelector('td[data-role="status"]');
            const scoreEl = tr.querySelector('td[data-role="score"]');
            if (curEl) {
              const v = u.current;
              const n = Number(v);
              curEl.textContent = (v === null || v === undefined) ? '' : (Number.isFinite(n) ? n.toFixed(6) : String(v));
            }
            if (stEl) stEl.textContent = String(u.status ?? '').trim();
            if (scoreEl) {
              const v = u._contribution;
              const n = Number(v);
              scoreEl.textContent = (v === null || v === undefined) ? '' : (Number.isFinite(n) ? n.toFixed(6) : String(v));
            }
          }
        }
      }
    } catch (_) {
      // ignore
    }

    try {
      const syncedAt = Date.now();
      w.__cooptLastRequirementsEval = { at: syncedAt, stage: 'done', updated: Array.isArray(updates) ? updates.length : 0 };

      let syncedScore = Number.NaN;
      let contributionCount = 0;
      const currentRows = Array.isArray(this.requirements) ? this.requirements : [];
      for (const row of currentRows) {
        const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
        const operand = String(row?.operand ?? '').trim();
        const weight = Number(row?.weight ?? 1);
        if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
        this._normalizeConfigId(row?.configId, systemConfig, activeConfigId);
        const contribution = Number.isFinite(Number(row?._contribution))
          ? Number(row?._contribution)
          : Number(row?.score);
        if (!Number.isFinite(contribution)) continue;
        if (contribution > 0) {
          syncedScore = Number.isFinite(syncedScore) ? (syncedScore + contribution) : contribution;
        } else if (!Number.isFinite(syncedScore)) {
          syncedScore = 0;
        }
        contributionCount += 1;
      }

      if (contributionCount > 0 && Number.isFinite(syncedScore)) {
        try {
          localStorage.setItem('coopt.requirementScoreSync', JSON.stringify({
            ts: syncedAt,
            score: syncedScore,
            activeConfigId,
            source: 'system-requirements-editor'
          }));
        } catch (_) {}
        try {
          window.dispatchEvent(new CustomEvent('coopt:requirements-updated', {
            detail: {
              ts: syncedAt,
              score: syncedScore,
              activeConfigId,
              source: 'system-requirements-editor'
            }
          }));
        } catch (_) {}
      }
    } catch (_) {}

    this._isEvaluating = false;
    if (this._pendingEvalRequested) {
      this._pendingEvalRequested = false;
      try { await this.evaluateAndUpdateNow({ reason: 'pending' }); } catch (_) {}
    }
    })();

    try {
      await this._evaluationPromise;
    } finally {
      this._evaluationPromise = null;
    }
  }

  async flushPendingEdits(): Promise<void> {
    try {
      const activeEl = document.activeElement as HTMLElement | null;
      const insideEditor = !!(
        activeEl
        && (
          (this._tableRoot && this._tableRoot.contains(activeEl))
          || activeEl.closest('#requirement-inspector')
        )
      );
      if (insideEditor && typeof activeEl?.blur === 'function') {
        activeEl.blur();
      }
    } catch (_) {}

    await this._yieldToUI();

    if (this._isEditingCell) {
      this._isEditingCell = false;
      if (this._pendingEvalAfterEdit) {
        this._pendingEvalAfterEdit = false;
        this.scheduleEvaluateAndUpdate();
      }
    }

    try {
      this.saveToStorage();
    } catch (_) {}
  }

  scheduleEvaluateAndUpdate(): void {
    try {
      if (this._evalTimer) clearTimeout(this._evalTimer);
    } catch (_) {}
    this._evalTimer = setTimeout(() => {
      try {
        // Fire-and-forget; evaluation is async.
        const p = this.evaluateAndUpdateNow({ reason: 'scheduled' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }, 50);
  }

  installMeritHook(): void {
    if (this._meritHookInstalled) return;
    const tryInstall = (): boolean => {
      const editor = w.meritFunctionEditor;
      if (!editor || typeof editor.calculateMerit !== 'function') return false;
      if (editor.__cooptRequirementsHooked) {
        // Hook already installed (possibly by a previous cached load).
        // Still ensure we compute Current/Status at least once.
        try {
          if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            w.systemRequirementsEditor.scheduleEvaluateAndUpdate();
          }
        } catch (_) {}
        return true;
      }

      const original = editor.calculateMerit.bind(editor);
      editor.calculateMerit = (...args: any[]) => {
        const out = original(...args);
        try {
          if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            w.systemRequirementsEditor.scheduleEvaluateAndUpdate();
          }
        } catch (_) {}
        return out;
      };

      editor.__cooptRequirementsHooked = true;
      // Ensure we compute Current/Status at least once after the editor becomes ready.
      try {
        if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
          w.systemRequirementsEditor.scheduleEvaluateAndUpdate();
        }
      } catch (_) {}
      return true;
    };

    if (tryInstall()) {
      this._meritHookInstalled = true;
      return;
    }

    // Merit editor might initialize later; retry briefly.
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (tryInstall() || tries > 60) {
        try { clearInterval(timer); } catch (_) {}
        this._meritHookInstalled = true;

        // If we managed to install (or the editor appeared late), schedule an eval now.
        try {
          if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            w.systemRequirementsEditor.scheduleEvaluateAndUpdate();
          }
        } catch (_) {}
      }
    }, 100);
  }

  updateRowNumbers(): void {
    this.requirements.forEach((r: any, index: number) => {
      r.id = index + 1;
    });
  }

  _serializeRequirements(rows: any[]): any[] {
    return (Array.isArray(rows) ? rows : []).map((r: any) => {
      if (!r || typeof r !== 'object') return r;
      if (r.rowType === 'memo') {
        const { id, rowType, memo } = r;
        return { id, rowType, memo };
      }
      const {
        id,
        enabled,
        operand,
        rationale,
        rationaleHeight,
        configId,
        param1,
        param2,
        param3,
        param4,
        param5,
        op,
        tol,
        target,
        weight
      } = r;
      return { id, enabled, operand, rationale, rationaleHeight, configId, param1, param2, param3, param4, param5, op, tol, target, weight };
    });
  }

  persistRequirementsRows(rows: any[]): void {
    const toSave = this._serializeRequirements(rows);
    saveSystemRequirementsTableData(toSave as any);

    try {
      const systemConfig = tryLoadSystemConfigurations() || {};
      systemConfig.systemRequirements = JSON.parse(JSON.stringify(toSave));
      trySaveSystemConfigurations(systemConfig);
      if (typeof window !== 'undefined') {
        w.__cooptSystemConfig = systemConfig;
      }
    } catch (_) {}
  }

  syncRequirementsToSystemConfigFromStorage(): void {
    try {
      const rows = loadSystemRequirementsTableData();
      this.persistRequirementsRows(Array.isArray(rows) ? rows : []);
    } catch (_) {}
  }

  getData(): any[] {
    return this.requirements;
  }

  setData(data: any[]): void {
    if (!Array.isArray(data)) {
      console.warn('System Requirements setData: invalid data');
      return;
    }

    let systemConfig: any = null;
    try {
      systemConfig = tryLoadSystemConfigurations() || {};
    } catch (_) {
      systemConfig = {};
    }
    const activeConfigId = systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null
      ? String(systemConfig.activeConfigId)
      : '';

    this.requirements = data.map((row: any) => {
      const r = row && typeof row === 'object' ? { ...row } : {};

      if (r.rowType === 'memo') {
        if (typeof r.memo !== 'string') r.memo = String(r.memo ?? '');
        return r;
      }

      // Migration: Type (severity) removed.
      try { delete r.severity; } catch (_) {}

      // Migration: SPOT_SIZE was replaced by explicit sampling variants.
      if (typeof r.operand === 'string' && r.operand.trim() === 'SPOT_SIZE') {
        r.operand = 'SPOT_SIZE_ANNULAR';
      }

      // Migration: SPOT_SIZE_CURRENT was removed; map to Annular for compatibility.
      if (typeof r.operand === 'string' && r.operand.trim() === 'SPOT_SIZE_CURRENT') {
        r.operand = 'SPOT_SIZE_ANNULAR';
      }

      // Migration: OPD RMS operand was renamed to explicit wavelength unit id.
      if (typeof r.operand === 'string' && r.operand.trim() === 'OPD_RMS_UM') {
        r.operand = 'OPD_RMS_WAVES';
      }

      // Migration: configId may have been saved as a config name (e.g. "Wide").
      // Normalize to a real id so merit evaluation can load the intended config.
      r.configId = this._normalizeConfigId(r.configId, systemConfig, activeConfigId);

      return r;
    });
    this.updateRowNumbers();
    if (typeof this._renderBody === 'function') this._renderBody(() => '', () => '', () => null);
  }

  loadFromStorage(): void {
    try {
      const data = loadSystemRequirementsTableData();
      if (!Array.isArray(data) || data.length === 0) return;

      const systemConfig: any = tryLoadSystemConfigurations() || {};
      const activeConfigId = (systemConfig && systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null)
        ? String(systemConfig.activeConfigId)
        : '';

      this.requirements = (Array.isArray(data) ? data : []).map((row: any) => {
        const r = row && typeof row === 'object' ? { ...row } : {};

        if (r.rowType === 'memo') {
          if (typeof r.memo !== 'string') r.memo = String(r.memo ?? '');
          return r;
        }

        // Migration: Type (severity) removed.
        try { delete r.severity; } catch (_) {}

        // Migration: SPOT_SIZE was replaced by explicit sampling variants.
        if (typeof r.operand === 'string' && r.operand.trim() === 'SPOT_SIZE') {
          r.operand = 'SPOT_SIZE_ANNULAR';
        }

        // Migration: SPOT_SIZE_CURRENT was removed; map to Annular for compatibility.
        if (typeof r.operand === 'string' && r.operand.trim() === 'SPOT_SIZE_CURRENT') {
          r.operand = 'SPOT_SIZE_ANNULAR';
        }

        // Migration: OPD RMS operand was renamed to explicit wavelength unit id.
        if (typeof r.operand === 'string' && r.operand.trim() === 'OPD_RMS_UM') {
          r.operand = 'OPD_RMS_WAVES';
        }

        r.configId = this._normalizeConfigId(r.configId, systemConfig, activeConfigId);

        // Defaults for new fields (backward compatible)
        if (r.enabled === undefined || r.enabled === null) r.enabled = true;
        if (!r.op) r.op = '=';
        if (r.tol === undefined || r.tol === null || String(r.tol).trim() === '') r.tol = 0;
        if (r.param5 === undefined || r.param5 === null) r.param5 = '';
        if (!Number.isFinite(Number(r.rationaleHeight)) || Number(r.rationaleHeight) < 40) r.rationaleHeight = 0;

        if (r && (r.configId === undefined || r.configId === null)) {
          r.configId = activeConfigId;
        } else {
          r.configId = String(r.configId);
        }
        return r;
      });

      this.updateRowNumbers();
    } catch (e) {
      console.warn('System Requirements loadFromStorage failed:', e);
    }
  }

  saveToStorage(): void {
    try {
      const live = this._getLiveRequirementsData();
      this.requirements = live;
      this.persistRequirementsRows(live);
    } catch (e) {
      console.warn('System Requirements saveToStorage failed:', e);
    }
  }

  getConfigurationList(): Record<string, string> {
    try {
      const systemConfig = tryLoadSystemConfigurations() || {};
      if (!systemConfig || !systemConfig.configurations) return { '': 'Current' };

      const activeConfig = systemConfig.configurations.find((c: any) => c.id === systemConfig.activeConfigId);
      const activeName = activeConfig ? activeConfig.name : '';

      const list: Record<string, string> = { '': `Current (${activeName})` };
      systemConfig.configurations.forEach((cfg: any) => {
        list[String(cfg.id)] = cfg.name;
      });
      return list;
    } catch (_) {
      return { '': 'Current' };
    }
  }

  getConfigName(configId: any): string {
    if (!configId && configId !== 0) {
      try {
        const systemConfig = tryLoadSystemConfigurations() || {};
        if (systemConfig && systemConfig.configurations) {
          const activeConfig = systemConfig.configurations.find((c: any) => c.id === systemConfig.activeConfigId);
          if (activeConfig) return `Current (${activeConfig.name})`;
        }
      } catch (_) {}
      return 'Current';
    }

    try {
      const systemConfig = tryLoadSystemConfigurations() || {};
      if (!systemConfig || !systemConfig.configurations) return 'Current';
      const cfg = systemConfig.configurations.find((c: any) => String(c.id) === String(configId));
      return cfg ? cfg.name : 'Current';
    } catch (_) {
      return 'Current';
    }
  }
}

const __cooptInitSystemRequirementsEditor = (): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    
    const container = document.getElementById('table-system-requirements');
    if (!container) {
      return false;
    }
    
    if (w.systemRequirementsEditor) {
      // Clear cached elements
      w.systemRequirementsEditor._tableRoot = null;
      w.systemRequirementsEditor._tbody = null;
      
      // Re-initialize table to render content
      w.systemRequirementsEditor.initializeTable();
      
      return true;
    }
    
    w.systemRequirementsEditor = new SystemRequirementsEditor();
    return true;
  } catch (e) {
    console.error('❌ System Requirements Editor init failed:', e);
    console.error('Stack:', e instanceof Error ? e.stack : 'N/A');
    return false;
  }
};

// Expose initializer for React fallback (GitHub Pages can miss auto-init timing).
try {
  if (typeof window !== 'undefined') {
    (window as any).__cooptInitSystemRequirementsEditor = __cooptInitSystemRequirementsEditor;

    (window as any).__cooptRecheckRustFirstRequirements = async (options: any = null) => {
      const ed = (window as any).systemRequirementsEditor;
      if (!ed || typeof ed.evaluateAndUpdateNow !== 'function') {
        const out = { ok: false, reason: 'systemRequirementsEditor is not ready' };
        try { (window as any).__cooptLastRustFirstRequirementRecheck = out; } catch (_) {}
        return out;
      }

      const modeRaw = String((options && options.mode) || 'rust-first').trim().toLowerCase();
      const mode = (modeRaw === 'js-only') ? 'js-only' : 'rust-first';
      const useRustFirst = mode !== 'js-only';
      const includeSpotCurrent = !!(options && options.includeSpotCurrent === true);
      const targets = includeSpotCurrent
        ? new Set(['SPOT_SIZE_RECT', 'SPOT_SIZE_ANNULAR', 'SPOT_SIZE_CURRENT', 'TA_RMS_UM', 'OPD_RMS_WAVES', 'OPD_RMS_UM'])
        : new Set(['SPOT_SIZE_RECT', 'SPOT_SIZE_ANNULAR', 'TA_RMS_UM', 'OPD_RMS_WAVES', 'OPD_RMS_UM']);

      let prevDisableRustFirst: any = undefined;
      try {
        prevDisableRustFirst = (window as any).__cooptDisableRequirementRustFirst;
        (window as any).__cooptDisableRequirementRustFirst = !useRustFirst;
      } catch (_) {}

      try {
        await ed.evaluateAndUpdateNow({ reason: 'manual-rust-first-recheck' });
      } catch (_) {}
      finally {
        try {
          if (prevDisableRustFirst === undefined) {
            delete (window as any).__cooptDisableRequirementRustFirst;
          } else {
            (window as any).__cooptDisableRequirementRustFirst = prevDisableRustFirst;
          }
        } catch (_) {}
      }

      const rows = (typeof ed.getData === 'function') ? ed.getData() : (Array.isArray(ed.requirements) ? ed.requirements : []);
      const filtered = (Array.isArray(rows) ? rows : [])
        .filter((r: any) => r && targets.has(String(r.operand || '').trim()))
        .map((r: any) => ({
          id: r.id,
          enabled: (r.enabled === undefined || r.enabled === null) ? true : !!r.enabled,
          operand: r.operand,
          configId: r.configId,
          param1: r.param1,
          param2: r.param2,
          param3: r.param3,
          param4: r.param4,
          param5: r.param5,
          status: r.status,
          current: r.current,
          target: r.target,
          tol: r.tol,
          op: r.op,
          weight: r.weight
        }));

      const enabledRows = filtered.filter((r: any) => r.enabled !== false);
      const failRows = enabledRows.filter((r: any) => String(r.status || '').trim().toUpperCase() === 'NG');

      const report = {
        ok: true,
        mode,
        checkedOperands: Array.from(targets),
        totalMatchedRows: filtered.length,
        enabledMatchedRows: enabledRows.length,
        failedCount: failRows.length,
        passed: failRows.length === 0,
        rows: filtered
      };

      try {
        if (typeof console !== 'undefined' && typeof console.table === 'function') {
          console.table(filtered);
        }
      } catch (_) {}

      try { (window as any).__cooptLastRustFirstRequirementRecheck = report; } catch (_) {}
      return report;
    };

    (window as any).__cooptDiagnoseFailedRequirements = async (options: any = null) => {
      const ed = (window as any).systemRequirementsEditor;
      const merit = (window as any).meritFunctionEditor;
      if (!ed || typeof ed.evaluateAndUpdateNow !== 'function' || !merit || typeof merit.calculateOperandValue !== 'function') {
        const out = { ok: false, reason: 'editors are not ready' };
        try { (window as any).__cooptLastFailedRequirementDiagnostics = out; } catch (_) {}
        return out;
      }

      const includeSpotCurrent = !!(options && options.includeSpotCurrent === true);
      const recheck = await (window as any).__cooptRecheckRustFirstRequirements({ includeSpotCurrent, mode: 'rust-first' });
      const failedRows = Array.isArray(recheck?.rows)
        ? recheck.rows.filter((r: any) => r && r.enabled !== false && String(r.status || '').trim().toUpperCase() === 'NG')
        : [];

      const diagnostics: any[] = [];
      const prevCapture = (window as any).__COOPT_CAPTURE_RAYTRACE_FAILURE;

      try {
        (window as any).__COOPT_CAPTURE_RAYTRACE_FAILURE = true;

        for (const row of failedRows) {
          try {
            delete (window as any).__cooptLastRayTraceFailure;
            delete (window as any).__cooptLastSpotSizeDebug;
          } catch (_) {}

          const opObj = {
            operand: row.operand,
            configId: row.configId,
            param1: row.param1,
            param2: row.param2,
            param3: row.param3,
            param4: row.param4,
            param5: row.param5,
            target: row.target,
            weight: row.weight,
            __reqRowId: row.id
          };

          let value: any = null;
          let error: any = null;
          try {
            value = merit.calculateOperandValue(opObj, getOpticalSystemRows(null));
          } catch (e: any) {
            error = String(e?.message || e);
          }

          diagnostics.push({
            id: row.id,
            operand: row.operand,
            configId: row.configId,
            params: {
              param1: row.param1,
              param2: row.param2,
              param3: row.param3,
              param4: row.param4,
              param5: row.param5
            },
            evaluatedValue: value,
            target: row.target,
            status: row.status,
            error,
            lastRayTraceFailure: (window as any).__cooptLastRayTraceFailure || null,
            lastSpotSizeDebug: (window as any).__cooptLastSpotSizeDebug || null
          });
        }
      } finally {
        try {
          if (prevCapture === undefined) {
            delete (window as any).__COOPT_CAPTURE_RAYTRACE_FAILURE;
          } else {
            (window as any).__COOPT_CAPTURE_RAYTRACE_FAILURE = prevCapture;
          }
        } catch (_) {}
      }

      const out = {
        ok: true,
        failedCount: failedRows.length,
        diagnostics
      };

      try {
        if (typeof console !== 'undefined' && typeof console.table === 'function') {
          console.table(diagnostics.map((d: any) => ({
            id: d.id,
            operand: d.operand,
            configId: d.configId,
            value: d.evaluatedValue,
            target: d.target,
            status: d.status,
            rayFailKind: d.lastRayTraceFailure?.kind || ''
          })));
        }
      } catch (_) {}

      try { (window as any).__cooptLastFailedRequirementDiagnostics = out; } catch (_) {}
      return out;
    };

    (window as any).__cooptCompareTaChiefRaySearch = async (options: any = null) => {
      const ed = (window as any).systemRequirementsEditor;
      const merit = (window as any).meritFunctionEditor;
      if (!ed || !merit || typeof merit.getConfigTablesByConfigId !== 'function') {
        const out = { ok: false, reason: 'required editors/methods are not ready' };
        try { (window as any).__cooptLastTaChiefRayCompare = out; } catch (_) {}
        return out;
      }

      try { await ed.evaluateAndUpdateNow({ reason: 'chief-ray-compare' }); } catch (_) {}

      const rows = (typeof ed.getData === 'function') ? ed.getData() : (Array.isArray(ed.requirements) ? ed.requirements : []);
      const taRows = (Array.isArray(rows) ? rows : [])
        .filter((r: any) => r && (r.enabled === undefined || r.enabled === null || !!r.enabled) && String(r.operand || '').trim() === 'TA_RMS_UM');

      const opticalSystemRows = getOpticalSystemRows(null);
      const isInfiniteSystem = (() => {
        const t = opticalSystemRows?.[0]?.thickness;
        if (t === Infinity) return true;
        const s = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
        return (s === 'INF' || s === 'INFINITY');
      })();

      const pickFirstFinite = (values: any[], fallback = 0): number => {
        for (const value of values) {
          const n = Number(value);
          if (Number.isFinite(n)) return n;
        }
        return fallback;
      };

      const buildFieldSetting = (objRow: any, objectIndex0: number) => {
        const fieldX = pickFirstFinite([
          objRow?.xHeightAngle,
          objRow?.xFieldAngle,
          objRow?.xHeight,
          objRow?.x,
          objRow?.angleX,
          objRow?.Hx
        ], 0);
        const fieldY = pickFirstFinite([
          objRow?.yHeightAngle,
          objRow?.yFieldAngle,
          objRow?.fieldAngle,
          objRow?.yHeight,
          objRow?.y,
          objRow?.angleY,
          objRow?.Hy
        ], 0);

        const objectIndex1 = objectIndex0 + 1;
        const displayName = String(objRow?.comment || objRow?.name || `Object ${objectIndex1}`);
        if (isInfiniteSystem) {
          return {
            position: 'Angle',
            fieldType: 'Angle',
            objectIndex: objectIndex1,
            displayName,
            x: fieldX,
            y: fieldY,
            xFieldAngle: fieldX,
            yFieldAngle: fieldY,
            xHeightAngle: fieldX,
            yHeightAngle: fieldY
          };
        }
        return {
          position: 'Rectangle',
          fieldType: 'Rectangle',
          objectIndex: objectIndex1,
          displayName,
          x: fieldX,
          y: fieldY,
          xHeight: fieldX,
          yHeight: fieldY
        };
      };

      const setMode = (mode: 'rust' | 'js') => {
        if (mode === 'rust') {
          (window as any).__cooptTraceOptionsOverride = {
            useRustWasm: true,
            requireRustWasm: false,
            requireForwardHit: true
          };
        } else {
          delete (window as any).__cooptTraceOptionsOverride;
        }
      };

      const prevOverride = (window as any).__cooptTraceOptionsOverride;
      const details: any[] = [];

      try {
        for (const row of taRows) {
          const configId = row?.configId;
          const tables = merit.getConfigTablesByConfigId(configId, { preferConfigTables: true }) || {};
          const sourceRows = Array.isArray(tables.source) ? tables.source : [];
          const objectRows = Array.isArray(tables.object) ? tables.object : [];

          const objectIndex1 = Math.max(1, Math.floor(Number(row?.param2 || 1)));
          const objectIndex0 = objectIndex1 - 1;
          const objRow = objectRows[objectIndex0] || null;
          if (!objRow) {
            details.push({
              id: row?.id,
              configId,
              objectIndex1,
              error: 'object-row-not-found'
            });
            continue;
          }

          let wavelength = 0.5876;
          try {
            const param1Raw = (row?.param1 !== undefined && row?.param1 !== null) ? String(row.param1).trim() : '';
            wavelength = (param1Raw === '')
              ? merit.getPrimaryWavelengthFromSourceRows(sourceRows)
              : merit.getSystemWavelengthFromOperandOrPrimary(row, sourceRows);
          } catch (_) {}

          let rayCount = 51;
          try {
            const raw = (row?.param4 !== undefined && row?.param4 !== null) ? String(row.param4).trim() : '';
            const parsed = Math.floor(Number(raw));
            if (Number.isFinite(parsed) && parsed >= 3) rayCount = Math.min(5000, parsed);
          } catch (_) {}

          const fieldSetting = buildFieldSetting(objRow, objectIndex0);

          let rustRes: any = null;
          let jsRes: any = null;
          let rustError: any = null;
          let jsError: any = null;

          try {
            setMode('rust');
            rustRes = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength, 'unified', { rayCount });
          } catch (e: any) {
            rustError = String(e?.message || e);
          }

          try {
            setMode('js');
            jsRes = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength, 'unified', { rayCount });
          } catch (e: any) {
            jsError = String(e?.message || e);
          }

          const summarize = (res: any, err: any) => ({
            success: !!(res && (res.success === true || res.convergence === true)),
            error: err || res?.finalError || null,
            pathLen: Array.isArray(res?.rayData?.segments) ? res.rayData.segments.length : (Array.isArray(res?.ray?.path) ? res.ray.path.length : null),
            rayGroups: Array.isArray(res?.rayGroups) ? res.rayGroups.length : null
          });

          const rust = summarize(rustRes, rustError);
          const js = summarize(jsRes, jsError);
          details.push({
            id: row?.id,
            configId,
            objectIndex1,
            wavelength,
            rayCount,
            fieldSetting,
            rust,
            js,
            changed: JSON.stringify(rust) !== JSON.stringify(js)
          });
        }
      } finally {
        try {
          if (prevOverride === undefined) {
            delete (window as any).__cooptTraceOptionsOverride;
          } else {
            (window as any).__cooptTraceOptionsOverride = prevOverride;
          }
        } catch (_) {}
      }

      const changedRows = details.filter((d: any) => d?.changed);
      const out = {
        ok: true,
        total: details.length,
        changedCount: changedRows.length,
        changedRows,
        details
      };

      try {
        if (typeof console !== 'undefined' && typeof console.table === 'function') {
          console.table(details.map((d: any) => ({
            id: d.id,
            cfg: d.configId,
            obj: d.objectIndex1,
            wl: d.wavelength,
            rayCount: d.rayCount,
            rustSuccess: d.rust?.success,
            jsSuccess: d.js?.success,
            rustErr: d.rust?.error || '',
            jsErr: d.js?.error || ''
          })));
        }
      } catch (_) {}

      try { (window as any).__cooptLastTaChiefRayCompare = out; } catch (_) {}
      return out;
    };

    (window as any).__cooptCompareRustVsJsRequirements = async (options: any = null) => {
      const baseOptions = { ...(options || {}) };
      const rust = await (window as any).__cooptRecheckRustFirstRequirements({ ...baseOptions, mode: 'rust-first' });
      const js = await (window as any).__cooptRecheckRustFirstRequirements({ ...baseOptions, mode: 'js-only' });

      const indexByKey = (rows: any[]) => {
        const m = new Map<string, any>();
        for (const r of (Array.isArray(rows) ? rows : [])) {
          const key = [String(r?.id ?? ''), String(r?.operand ?? ''), String(r?.configId ?? '')].join('|');
          m.set(key, r);
        }
        return m;
      };

      const rm = indexByKey(rust?.rows || []);
      const jm = indexByKey(js?.rows || []);
      const keys = new Set<string>([...rm.keys(), ...jm.keys()]);
      const diffRows: any[] = [];

      for (const k of keys) {
        const rr = rm.get(k) || null;
        const jr = jm.get(k) || null;
        const statusRust = String(rr?.status ?? '');
        const statusJs = String(jr?.status ?? '');
        const currentRust = rr?.current;
        const currentJs = jr?.current;
        const changed = (statusRust !== statusJs) || (String(currentRust) !== String(currentJs));
        if (!changed) continue;

        diffRows.push({
          id: rr?.id ?? jr?.id ?? null,
          operand: rr?.operand ?? jr?.operand ?? null,
          configId: rr?.configId ?? jr?.configId ?? null,
          rustStatus: statusRust,
          jsStatus: statusJs,
          rustCurrent: currentRust,
          jsCurrent: currentJs
        });
      }

      const out = {
        ok: true,
        rustFailedCount: Number(rust?.failedCount) || 0,
        jsFailedCount: Number(js?.failedCount) || 0,
        changedRowCount: diffRows.length,
        changedRows: diffRows,
        rust,
        js
      };

      try {
        if (typeof console !== 'undefined' && typeof console.table === 'function' && diffRows.length > 0) {
          console.table(diffRows);
        }
      } catch (_) {}

      try { (window as any).__cooptLastRustVsJsRequirementCompare = out; } catch (_) {}
      return out;
    };

    (window as any).__cooptDiagnoseTaComponentSwitch = async (options: any = null) => {
      const ed = (window as any).systemRequirementsEditor;
      const merit = (window as any).meritFunctionEditor;
      if (!ed || typeof ed.evaluateAndUpdateNow !== 'function' || !merit || typeof merit.calculateOperandValue !== 'function') {
        const out = { ok: false, reason: 'required editors/methods are not ready' };
        try { (window as any).__cooptLastTaComponentSwitchDiagnosis = out; } catch (_) {}
        return out;
      }

      const modeRaw = String(options?.mode || 'rust-first').trim().toLowerCase();
      const mode = modeRaw === 'js-only' ? 'js-only' : 'rust-first';

      let prevDisableRustFirst: any;
      try {
        prevDisableRustFirst = (window as any).__cooptDisableRequirementRustFirst;
        (window as any).__cooptDisableRequirementRustFirst = (mode === 'js-only');
      } catch (_) {}

      try { await ed.evaluateAndUpdateNow({ reason: 'ta-component-switch-diagnose' }); } catch (_) {}

      const rows = (typeof ed.getData === 'function') ? ed.getData() : (Array.isArray(ed.requirements) ? ed.requirements : []);
      const taRows = (Array.isArray(rows) ? rows : []).filter((r: any) => {
        if (!r || (r.enabled !== undefined && r.enabled !== null && !r.enabled)) return false;
        return String(r.operand || '').trim() === 'TA_RMS_UM';
      });

      const requestedRowId = (options?.rowId !== undefined && options?.rowId !== null)
        ? String(options.rowId)
        : '';
      const requestedConfigId = (options?.configId !== undefined && options?.configId !== null)
        ? String(options.configId)
        : '';

      const targetRows = taRows.filter((r: any) => {
        if (requestedRowId && String(r.id) !== requestedRowId) return false;
        if (requestedConfigId && String(r.configId || '') !== requestedConfigId) return false;
        return true;
      });

      const opticalSystemRows = getOpticalSystemRows(null);
      const components = ['total', 'meridional', 'sagittal'];
      const diagnostics: any[] = [];

      for (const row of targetRows) {
        const valuesByComponent: Record<string, number> = {};
        const errorsByComponent: Record<string, string> = {};

        for (const comp of components) {
          const opObj = {
            operand: 'TA_RMS_UM',
            configId: row.configId,
            param1: row.param1,
            param2: row.param2,
            param3: comp,
            param4: row.param4,
            param5: row.param5,
            target: row.target,
            weight: row.weight,
            __reqRowId: row.id,
          };

          try {
            const v = merit.calculateOperandValue(opObj, opticalSystemRows);
            const n = Number(v);
            valuesByComponent[comp] = Number.isFinite(n) ? n : Number.NaN;
          } catch (e: any) {
            valuesByComponent[comp] = Number.NaN;
            errorsByComponent[comp] = String(e?.message || e || 'calculateOperandValue failed');
          }
        }

        const totalVal = valuesByComponent.total;
        const meridionalVal = valuesByComponent.meridional;
        const sagittalVal = valuesByComponent.sagittal;

        const deltas = {
          totalMinusMeridional: (Number.isFinite(totalVal) && Number.isFinite(meridionalVal)) ? (totalVal - meridionalVal) : Number.NaN,
          totalMinusSagittal: (Number.isFinite(totalVal) && Number.isFinite(sagittalVal)) ? (totalVal - sagittalVal) : Number.NaN,
          meridionalMinusSagittal: (Number.isFinite(meridionalVal) && Number.isFinite(sagittalVal)) ? (meridionalVal - sagittalVal) : Number.NaN,
        };

        const componentSwitchEffective = Object.values(deltas).some((d: any) => Number.isFinite(d) && Math.abs(Number(d)) > 1e-12);

        diagnostics.push({
          id: row.id,
          configId: row.configId,
          params: {
            param1: row.param1,
            param2: row.param2,
            param4: row.param4,
            param5: row.param5,
          },
          valuesByComponent,
          deltas,
          componentSwitchEffective,
          errorsByComponent,
        });
      }

      const out = {
        ok: true,
        mode,
        totalTaRows: taRows.length,
        checkedRows: diagnostics.length,
        unchangedRows: diagnostics.filter((d: any) => d.componentSwitchEffective === false).length,
        diagnostics,
      };

      try {
        if (typeof console !== 'undefined' && typeof console.table === 'function') {
          console.table(diagnostics.map((d: any) => ({
            id: d.id,
            configId: d.configId,
            total: d.valuesByComponent?.total,
            meridional: d.valuesByComponent?.meridional,
            sagittal: d.valuesByComponent?.sagittal,
            d_tm: d.deltas?.totalMinusMeridional,
            d_ts: d.deltas?.totalMinusSagittal,
            d_ms: d.deltas?.meridionalMinusSagittal,
            effective: d.componentSwitchEffective,
          })));
        }
      } catch (_) {}

      try { (window as any).__cooptLastTaComponentSwitchDiagnosis = out; } catch (_) {}

      try {
        if (prevDisableRustFirst === undefined) {
          delete (window as any).__cooptDisableRequirementRustFirst;
        } else {
          (window as any).__cooptDisableRequirementRustFirst = prevDisableRustFirst;
        }
      } catch (_) {}

      return out;
    };
  }
} catch (_) {}

const __cooptScheduleSystemRequirementsInit = (): void => {
  const shouldSkipForPopup = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_analysis_window') === '1';
    } catch (_) {
      return false;
    }
  })();
  if (shouldSkipForPopup) {
    return;
  }

  if (__cooptInitSystemRequirementsEditor()) {
    return;
  }
  
  if (typeof window !== 'undefined') {
    if (w.__cooptReactMounted) {
      setTimeout(() => __cooptInitSystemRequirementsEditor(), 50);
      return;
    }
    window.addEventListener('coopt:react-mounted', () => {
      // Give React a moment to fully render the DOM
      setTimeout(() => {
        __cooptInitSystemRequirementsEditor();
      }, 100);
    }, { once: true });
    
    // Fallback: retry multiple times
    let retryCount = 0;
    const maxRetries = 20;
    const retryInterval = setInterval(() => {
      retryCount++;
      if (__cooptInitSystemRequirementsEditor() || retryCount >= maxRetries) {
        clearInterval(retryInterval);
        if (retryCount >= maxRetries) {
          console.warn('[Requirements] Failed to initialize after max retries');
        }
      }
    }, 100);
  }
};

if (typeof document !== 'undefined' && document?.addEventListener) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __cooptScheduleSystemRequirementsInit);
  } else {
    __cooptScheduleSystemRequirementsInit();
  }
}

export { SystemRequirementsEditor };
