/**
 * System Requirements Editor (DOM)
 * - Requirements are the source of truth (pass/fail constraints)
 * - System Evaluation UI is deprecated (no transfer)
 */

import { OPERAND_DEFINITIONS, InspectorManager } from './merit-function-inspector.js';
import { getOpticalSystemRows } from './utils/data-utils.js';

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
    this._selectedTr = null;
    this._paramHeaderEls = { param1: null, param2: null, param3: null, param4: null };
    this._operandKeys = [];
    this._isEvaluating = false;
    this._pendingEvalRequested = false;
    this._progressEls = null;
    this.inspector = new InspectorManager('requirement-inspector', 'requirement-inspector-content');

    this.loadFromStorage();
    this.initializeTable();
    this.initializeEventListeners();
    this._ensureProgressUI();

    // Auto-update status when Merit is recalculated
    this.installMeritHook();
    this.scheduleEvaluateAndUpdate();
  }

  _getBlocksForConfigHint(configIdValue) {
    try {
      let sys = null;
      try {
        if (typeof loadSystemConfigurationsFromTableConfig === 'function') {
          sys = loadSystemConfigurationsFromTableConfig();
        } else if (typeof window !== 'undefined' && window.ConfigurationManager && typeof window.ConfigurationManager.loadSystemConfigurations === 'function') {
          sys = window.ConfigurationManager.loadSystemConfigurations();
        } else if (typeof loadSystemConfigurations === 'function') {
          sys = loadSystemConfigurations();
        }
      } catch (_) {
        sys = null;
      }
      if (!sys) {
        const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
        sys = raw ? JSON.parse(raw) : null;
      }
      const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
      const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null)
        ? String(sys.activeConfigId)
        : '';

      const hint = (configIdValue === undefined || configIdValue === null) ? '' : String(configIdValue).trim();
      let cfg = null;
      if (hint) {
        cfg = configs.find(c => c && String(c.id) === hint) || configs.find(c => c && String(c.name).trim() === hint) || null;
      }
      if (!cfg && activeId) {
        cfg = configs.find(c => c && String(c.id) === activeId) || null;
      }
      if (!cfg) cfg = configs[0] || null;

      const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : [];
      return Array.isArray(blocks) ? blocks : [];
    } catch (_) {
      return [];
    }
  }

  _normalizeConfigId(configIdValue, systemConfig, activeConfigId) {
    const raw = (configIdValue === undefined || configIdValue === null) ? '' : String(configIdValue).trim();
    if (!raw) return activeConfigId;

    const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
    // Already a valid id?
    const byId = configs.find(c => c && String(c.id) === raw);
    if (byId) return String(byId.id);

    // Backward compatibility: allow specifying config by name (e.g. "Wide")
    const byName = configs.find(c => c && String(c.name).trim() === raw);
    if (byName) return String(byName.id);

    return activeConfigId;
  }

  _getLiveRequirementsData() {
    return Array.isArray(this.requirements) ? this.requirements : [];
  }

  initializeTable() {
    this._operandKeys = (() => {
      try {
        const keys = InspectorManager.getAvailableOperands?.();
        return Array.isArray(keys) ? keys : Object.keys(OPERAND_DEFINITIONS);
      } catch (_) {
        return Object.keys(OPERAND_DEFINITIONS);
      }
    })();

    const escapeHtml = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const formatNumberShort = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).trim();
      if (!s) return '';
      const n = Number(s);
      if (!Number.isFinite(n)) return s;
      if (n !== 0 && Math.abs(n) < 1e-6) return n.toExponential(3);
      if (Math.abs(n) >= 1e6) return n.toExponential(3);
      return String(n);
    };

    const makeSpecSummary = (row) => {
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

    const rationalePreview = (v, maxLen = 64) => {
      const s = (v === null || v === undefined) ? '' : String(v);
      const oneLine = s.split(/\r?\n/)[0].trim();
      if (!oneLine) return '';
      if (oneLine.length <= maxLen) return oneLine;
      return oneLine.slice(0, Math.max(0, maxLen - 1)) + '…';
    };

    const getEflDisplayLabelByBlockId = (blocks) => {
      const labelById = new Map();
      try {
        const counts = new Map();
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

    const ensureEflBlocksDatalist = (blocks) => {
      try {
        const id = 'coopt-efl-blocks-datalist';
        let dl = document.getElementById(id);
        if (!dl) {
          dl = document.createElement('datalist');
          dl.id = id;
          document.body.appendChild(dl);
        }
        dl.innerHTML = '';
        const displayLabelById = getEflDisplayLabelByBlockId(blocks || []);
        const addOpt = (value) => {
          const o = document.createElement('option');
          o.value = value;
          dl.appendChild(o);
        };
        addOpt('ALL');
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

    const container = document.getElementById('table-system-requirements');
    if (!container) return;
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'sr-table-wrap';
    wrap.style.height = '300px';
    wrap.style.overflow = 'auto';
    wrap.style.resize = 'vertical';
    wrap.style.boxSizing = 'border-box';

    const table = document.createElement('table');
    table.className = 'sr-table';
    table.style.borderCollapse = 'collapse';
    table.style.width = 'max-content';
    table.style.minWidth = '100%';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const mkTh = (text, widthPx, stickyLeftPx = null) => {
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
      id: 30,
      enabled: 60,
      operand: 200,
      spec: 50,
      current: 120,
      status: 90,
      rationale: 220,
      configId: 120,
      param: 100,
      param2: 120,
      op: 80,
      tol: 90,
      target: 100,
      weight: 100
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
    headRow.appendChild(mkTh('Config', widths.configId, null));
    
    // Parameters column with toggle button (support up to 5 params)
    const thParams = mkTh('Parameters', widths.param * 5 + widths.param2, null);
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = '▼';
    toggleBtn.style.marginLeft = '8px';
    toggleBtn.style.fontSize = '10px';
    toggleBtn.style.padding = '2px 6px';
    toggleBtn.style.cursor = 'pointer';
    toggleBtn.style.border = '1px solid #ccc';
    toggleBtn.style.borderRadius = '3px';
    toggleBtn.style.background = '#f5f5f5';
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.title = 'Toggle parameter visibility';
    thParams.appendChild(toggleBtn);
    headRow.appendChild(thParams);
    
    this._paramsExpanded = true;
    this._paramToggleBtn = toggleBtn;
    
    headRow.appendChild(mkTh('Op', widths.op, null));
    headRow.appendChild(mkTh('Tol', widths.tol, null));
    headRow.appendChild(mkTh('Target', widths.target, null));
    headRow.appendChild(mkTh('Weight', widths.weight, null));
    headRow.appendChild(mkTh('Rationale', widths.rationale, null));

    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    this._tbody = tbody;
    this._tableRoot = table;

    const setEditing = (editing) => {
      this._isEditingCell = !!editing;
      if (!editing && this._pendingEvalAfterEdit) {
        this._pendingEvalAfterEdit = false;
        this.scheduleEvaluateAndUpdate();
      }
    };

    const onCellFocus = () => setEditing(true);
    const onCellBlur = () => setEditing(false);

    const formatCurrentCell = (v) => {
      if (v === null || v === undefined) return '';
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(6) : String(v);
    };

    const setSelectedRow = (rowId) => {
      this._selectedId = rowId;
      if (!this._tbody) return;

      if (this._selectedTr) this._selectedTr.classList.remove('sr-selected');
      const tr = this._tbody.querySelector(`tr[data-id="${String(rowId)}"]`);
      if (tr) {
        tr.classList.add('sr-selected');
        this._selectedTr = tr;
      } else {
        this._selectedTr = null;
      }

      const row = this.requirements.find(r => r && String(r.id) === String(rowId)) || null;
      if (row) {
        try {
          if (this.inspector && typeof this.inspector.show === 'function') this.inspector.show(row);
        } catch (_) {}
      }
    };

    const renderRow = (row) => {
      const tr = document.createElement('tr');
      tr.dataset.id = String(row.id);
      if (String(this._selectedId) === String(row.id)) tr.classList.add('sr-selected');

      const mkTd = (widthPx, stickyLeftPx = null) => {
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
        // Keep selection behavior but don't break inline edits.
        const t = e?.target;
        if (t && typeof t.closest === 'function' && t.closest('input,select,textarea')) {
          if (String(this._selectedId) !== String(row.id)) setSelectedRow(row.id);
          return;
        }
        setSelectedRow(row.id);
      });

      // Sticky cells
      let leftPx = 0;
      const tdId = mkTd(widths.id, leftPx);
      tdId.textContent = String(row.id);
      tr.appendChild(tdId);
      leftPx += widths.id;

      const tdOn = mkTd(widths.enabled, leftPx);
      const onCb = document.createElement('input');
      onCb.type = 'checkbox';
      onCb.checked = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
      onCb.addEventListener('change', () => {
        row.enabled = !!onCb.checked;
        this.saveToStorage();
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
      for (const key of this._operandKeys) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = OPERAND_DEFINITIONS[key]?.name || key;
        operandSel.appendChild(opt);
      }
      operandSel.value = String(row.operand || '').trim();
      operandSel.addEventListener('change', () => {
        row.operand = operandSel.value;
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

      // Non-sticky cells
      const tdCfg = mkTd(widths.configId, null);
      tdCfg.style.textAlign = 'center';
      const cfgSel = document.createElement('select');
      cfgSel.style.width = '100%';
      cfgSel.style.fontSize = '12px';
      cfgSel.addEventListener('focus', onCellFocus);
      cfgSel.addEventListener('blur', onCellBlur);
      const cfgValues = this.getConfigurationList();
      for (const [val, label] of Object.entries(cfgValues || {})) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        cfgSel.appendChild(opt);
      }
      cfgSel.value = (row.configId === undefined || row.configId === null) ? '' : String(row.configId);
      cfgSel.addEventListener('change', () => {
        row.configId = cfgSel.value;
        this.saveToStorage();

        // If operand is EFL, refresh param2 datalist options.
        try {
          if (String(row?.operand ?? '').trim() === 'EFL') {
            const blocks = this._getBlocksForConfigHint(row?.configId);
            const dlId = ensureEflBlocksDatalist(blocks);
            const p2Input = tr.querySelector('input[data-role="param2"]');
            if (p2Input && dlId) p2Input.setAttribute('list', dlId);
          }
        } catch (_) {}
        this.scheduleEvaluateAndUpdate();
      });
      tdCfg.appendChild(cfgSel);
      tr.appendChild(tdCfg);

      const mkInput = (field, widthPx, placeholder = '', paramDef = null) => {
        const td = mkTd(widthPx, null);
        td.style.textAlign = 'center';
        td.dataset.paramField = field; // Mark for dynamic visibility
        
        let control = null;
        const paramLabel = paramDef?.label || '';
        const paramDesc = paramDef?.description || '';
        
        // Determine if this should be a dropdown
        const isWavelengthParam = paramLabel.includes('λ') || paramDesc.toLowerCase().includes('source row');
        const isObjectParam = paramLabel.includes('Field idx') || paramLabel.includes('Object idx');
        const isMetricParam = paramLabel === 'Metric';
        const isUnitParam = paramLabel === 'Unit';
        const isModeParam = paramLabel === 'Mode' || paramDesc.includes('0=Imaging, 1=Afocal');
        const isNollParam = paramLabel === 'n (Noll)';
        const isSamplingParam = paramLabel === 'Sampling';
        
        if (isNollParam) {
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
          const objects = this._getObjectOptions();
          for (const opt of objects) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            control.appendChild(el);
          }
          control.value = String(row[field] || '');
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
        
        if (control.tagName === 'SELECT') {
          control.addEventListener('change', () => {
            row[field] = control.value;
            this.saveToStorage();
            this.scheduleEvaluateAndUpdate();
          });
          control.addEventListener('blur', onCellBlur);
        } else {
          control.addEventListener('blur', () => {
            let nextVal = control.value;
            try {
              if (field === 'param2' && String(row?.operand ?? '').trim() === 'EFL') {
                const blocks = this._getBlocksForConfigHint(row?.configId);
                const displayLabelById = getEflDisplayLabelByBlockId(blocks);
                const labelToId = new Map();
                for (const [id, label] of displayLabelById.entries()) {
                  if (label) labelToId.set(String(label), String(id));
                }
                const raw = String(nextVal ?? '').trim();
                if (/^all$/i.test(raw)) {
                  nextVal = 'ALL';
                } else if (raw) {
                  const tokens = raw.split(/[\s,]+/).map(s => String(s).trim()).filter(Boolean);
                  const mapped = tokens.map(t => labelToId.get(t) || t);
                  if (mapped.some(t => /^all$/i.test(String(t)))) nextVal = 'ALL';
                  else nextVal = mapped.join(',');
                }
              }
            } catch (_) {}
            row[field] = nextVal;
            if (nextVal !== control.value) control.value = nextVal;
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

      // Parameters cell (combined, collapsible) - support up to 5 params
      const tdParams = mkTd(widths.param * 5 + widths.param2, null);
      tdParams.dataset.role = 'params-container';
      
      // Collapsed view: summary
      const paramsSummary = document.createElement('div');
      paramsSummary.className = 'params-summary';
      paramsSummary.style.display = 'none';
      paramsSummary.style.fontSize = '11px';
      paramsSummary.style.color = '#666';
      paramsSummary.style.cursor = 'pointer';
      paramsSummary.style.padding = '4px';
      
      const updateSummary = () => {
        const values = [];
        for (let i = 1; i <= paramCount; i++) {
          const val = row[`param${i}`];
          if (val !== undefined && val !== null && String(val).trim() !== '') {
            const paramDef = paramDefs[i - 1];
            const label = paramDef?.label || `P${i}`;
            values.push(`${label}=${val}`);
          }
        }
        paramsSummary.textContent = values.length > 0 ? values.join(', ') : `${paramCount} param${paramCount !== 1 ? 's' : ''}`;
      };
      updateSummary();
      
      // Expanded view: individual inputs
      const paramsExpanded = document.createElement('div');
      paramsExpanded.className = 'params-expanded';
      paramsExpanded.style.display = 'flex';
      paramsExpanded.style.gap = '4px';
      
      const paramInputs = [];
      for (let i = 1; i <= 5; i++) {
        const field = `param${i}`;
        const paramDef = paramDefs[i - 1];
        const container = document.createElement('div');
        container.style.flex = i === 2 ? '1.2' : '1';
        container.style.display = i <= paramCount ? '' : 'none';
        
        // Label
        if (paramDef && paramDef.label) {
          const label = document.createElement('div');
          label.textContent = paramDef.label;
          label.style.fontSize = '9px';
          label.style.color = '#888';
          label.style.height = '12px';
          label.style.lineHeight = '12px';
          label.style.marginBottom = '1px';
          container.appendChild(label);
        }
        
        const { td: _, input: control } = mkInput(field, i === 2 ? widths.param2 : widths.param, '', paramDef);
        control.style.width = '100%';
        
        // Override blur to update summary
        const origOnBlur = control.onblur;
        control.addEventListener('blur', () => {
          updateSummary();
        });
        
        // For EFL param2
        if (operand === 'EFL' && i === 2 && control.tagName === 'INPUT') {
          try {
            const configIdHint = row?.configId;
            const blocks = this._getBlocksForConfigHint(configIdHint);
            const dlId = ensureEflBlocksDatalist(blocks);
            if (dlId) control.setAttribute('list', dlId);
            control.placeholder = 'ALL or blockId (comma separated allowed)';
          } catch (_) {}
        }
        
        container.appendChild(control);
        paramsExpanded.appendChild(container);
        paramInputs.push({ container, control });
      }
      
      tdParams.appendChild(paramsSummary);
      tdParams.appendChild(paramsExpanded);
      tr.appendChild(tdParams);

      const tdOp = mkTd(widths.op, null);
      tdOp.style.textAlign = 'center';
      const opSel = document.createElement('select');
      opSel.style.width = '100%';
      opSel.style.fontSize = '12px';
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
        row.op = opSel.value;
        this.saveToStorage();
        const specEl = tr.querySelector('td[data-role="spec"]');
        if (specEl) specEl.textContent = makeSpecSummary(row);
        this.scheduleEvaluateAndUpdate();
      });
      tdOp.appendChild(opSel);
      tr.appendChild(tdOp);

      tr.appendChild(mkInput('tol', widths.tol).td);
      tr.appendChild(mkInput('target', widths.target).td);
      tr.appendChild(mkInput('weight', widths.weight).td);

      // Rationale is the right-most column
      const tdRat = mkTd(widths.rationale, null);

      const ratPreview = document.createElement('div');
      ratPreview.textContent = rationalePreview(row.rationale);
      ratPreview.title = (row.rationale === undefined || row.rationale === null) ? '' : String(row.rationale);
      ratPreview.style.cursor = 'text';
      ratPreview.style.height = '22px';
      ratPreview.style.display = 'flex';
      ratPreview.style.alignItems = 'center';
      ratPreview.style.overflow = 'hidden';

      const ratTa = document.createElement('textarea');
      ratTa.rows = 4;
      ratTa.value = (row.rationale === undefined || row.rationale === null) ? '' : String(row.rationale);
      ratTa.style.width = '100%';
      ratTa.style.fontSize = '12px';
      ratTa.style.boxSizing = 'border-box';
      ratTa.style.display = 'none';
      ratTa.addEventListener('focus', onCellFocus);
      ratTa.addEventListener('blur', () => {
        row.rationale = ratTa.value;
        ratPreview.textContent = rationalePreview(row.rationale);
        ratPreview.title = (row.rationale === undefined || row.rationale === null) ? '' : String(row.rationale);
        ratTa.style.display = 'none';
        ratPreview.style.display = 'flex';
        this.saveToStorage();
        onCellBlur();
      });

      ratPreview.addEventListener('click', () => {
        setSelectedRow(row.id);
        ratTa.value = (row.rationale === undefined || row.rationale === null) ? '' : String(row.rationale);
        ratPreview.style.display = 'none';
        ratTa.style.display = 'block';
        try { ratTa.focus(); } catch (_) {}
      });

      tdRat.appendChild(ratPreview);
      tdRat.appendChild(ratTa);
      tr.appendChild(tdRat);

      return tr;
    };

    this._renderBody = (specFn, ratPrevFn, ensureDl) => {
      if (!this._tbody) return;
      this._tbody.innerHTML = '';
      
      // Render all requirements
      for (const r of this.requirements) {
        const tr = renderRow(r);
        this._tbody.appendChild(tr);
      }

      // Update header labels for selected operand if any.
      const sel = this.requirements.find(x => x && String(x.id) === String(this._selectedId)) || null;
      if (sel) {
        setSelectedRow(sel.id);
      }
    };

    this._renderRow = renderRow;

    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    // Parameter toggle functionality
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._paramsExpanded = !this._paramsExpanded;
        toggleBtn.textContent = this._paramsExpanded ? '▼' : '▶';
        toggleBtn.setAttribute('aria-expanded', this._paramsExpanded ? 'true' : 'false');
        
        // Toggle all parameter containers
        const allParamContainers = this._tbody.querySelectorAll('[data-role="params-container"]');
        for (const container of allParamContainers) {
          const summary = container.querySelector('.params-summary');
          const expanded = container.querySelector('.params-expanded');
          if (summary && expanded) {
            summary.style.display = this._paramsExpanded ? 'none' : 'block';
            expanded.style.display = this._paramsExpanded ? 'flex' : 'none';
          }
        }
      });
    }

    // Initial render
    this._renderBody(makeSpecSummary, rationalePreview, ensureEflBlocksDatalist);
  }

  _getWavelengthOptions() {
    try {
      // Try to get from global source first
      let sourceRows = null;
      try {
        const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
        if (systemConfig && Array.isArray(systemConfig.source)) {
          sourceRows = systemConfig.source;
        }
      } catch (_) {}
      
      // Fallback to sourceTableData
      if (!sourceRows) {
        sourceRows = JSON.parse(localStorage.getItem('sourceTableData') || '[]');
      }
      
      const options = [{ value: '', label: '(Primary)' }];
      
      if (Array.isArray(sourceRows) && sourceRows.length > 0) {
        sourceRows.forEach((row, idx) => {
          const wl = row?.wavelength;
          const isPrimary = row?.primary;
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

  _getObjectOptions() {
    try {
      // Try to get from active config first
      let objectRows = null;
      try {
        const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
        const activeId = systemConfig?.activeConfigId;
        const activeConfig = systemConfig?.configurations?.find(c => c.id === activeId);
        if (activeConfig && Array.isArray(activeConfig.object)) {
          objectRows = activeConfig.object;
        }
      } catch (_) {}
      
      // Fallback to objectTableData
      if (!objectRows) {
        objectRows = JSON.parse(localStorage.getItem('objectTableData') || '[]');
      }
      
      const options = [{ value: '', label: '(default 1)' }];
      
      if (Array.isArray(objectRows) && objectRows.length > 0) {
        objectRows.forEach((row, idx) => {
          const y = row?.y || 0;
          const angle = row?.angle || 0;
          const label = `${idx + 1}: y=${y}, angle=${angle}°`;
          options.push({ value: String(idx + 1), label });
        });
      }
      
      return options;
    } catch (e) {
      console.warn('Failed to get object options:', e);
      return [{ value: '', label: '(default 1)' }];
    }
  }

  initializeEventListeners() {
    const addBtn = document.getElementById('add-requirement-btn');
    if (addBtn) addBtn.addEventListener('click', () => this.addRequirement());

    const delBtn = document.getElementById('delete-requirement-btn');
    if (delBtn) delBtn.addEventListener('click', () => this.deleteRequirement());

    const updateBtn = document.getElementById('update-requirement-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', async () => {
        try {
          await this.updateAllConfigsAndEvaluate();
        } catch (_) {}
      });
    }
  }

  renderTable() {
    if (typeof this._renderBody === 'function') {
      this._renderBody(() => '', () => '', () => null);
    }
  }

  _ensureProgressUI() {
    try {
      if (this._progressEls) return this._progressEls;
      const btns = document.querySelector('.merit-function-buttons-container');
      if (!btns || !btns.parentElement) return null;

      const wrap = document.createElement('div');
      wrap.id = 'requirements-progress-wrap';
      wrap.style.display = 'none';
      wrap.style.marginTop = '6px';

      const label = document.createElement('div');
      label.id = 'requirements-progress-label';
      label.className = 'merit-function-help';
      label.textContent = '';

      const prog = document.createElement('progress');
      prog.id = 'requirements-progress';
      prog.max = 1;
      prog.value = 0;
      prog.style.width = '320px';

      wrap.appendChild(label);
      wrap.appendChild(prog);

      btns.parentElement.insertBefore(wrap, btns.nextSibling);
      this._progressEls = { wrap, label, prog };
      return this._progressEls;
    } catch (_) {
      return null;
    }
  }

  _setProgressVisible(visible) {
    try {
      const els = this._ensureProgressUI();
      if (!els || !els.wrap) return;
      els.wrap.style.display = visible ? 'block' : 'none';
    } catch (_) {}
  }

  _setProgress(labelText, value, max) {
    try {
      const els = this._ensureProgressUI();
      if (!els) return;
      if (els.label) els.label.textContent = String(labelText ?? '');
      if (els.prog) {
        const m = Number(max);
        els.prog.max = (Number.isFinite(m) && m > 0) ? m : 1;
        const v = Number(value);
        els.prog.value = (Number.isFinite(v) && v >= 0) ? v : 0;
      }
    } catch (_) {}
  }

  async _yieldToUI() {
    try {
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  _upsertSpotDiagramSettingsForConfig(configId, opticalRows, sourceRows) {
    try {
      if (typeof localStorage === 'undefined') return;
      const cfgKey = String(configId ?? '').trim();
      if (!cfgKey) return;

      const isImageRow = (row) => {
        if (!row || typeof row !== 'object') return false;
        const t1 = String(row['object type'] ?? '').trim();
        const t2 = String(row.object ?? '').trim();
        const st = String(row.surfType ?? '').trim().toLowerCase();
        if (t1 === 'Image' || t2 === 'Image') return true;
        return st === 'image' || st.includes('image');
      };

      const isCoordTransRow = (row) => {
        if (!row || typeof row !== 'object') return false;
        const st = String(row.surfType ?? row.type ?? '').trim().toLowerCase();
        const t1 = String(row['object type'] ?? '').trim().toLowerCase();
        const t2 = String(row.object ?? '').trim().toLowerCase();
        const compact = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
        const stc = compact(st);
        const t1c = compact(t1);
        const t2c = compact(t2);
        const isCb = (v) => v === 'ct' || v === 'coordtrans' || v === 'coordinatebreak';
        return isCb(stc) || isCb(t1c) || isCb(t2c) || st === 'coord break' || st === 'coordinate break' || t1 === 'coord break' || t1 === 'coordinate break' || t2 === 'coord break' || t2 === 'coordinate break';
      };

      const imageIdx = (() => {
        if (!Array.isArray(opticalRows) || opticalRows.length === 0) return 0;
        const i = opticalRows.findIndex(r => isImageRow(r));
        return (i >= 0) ? i : Math.max(0, opticalRows.length - 1);
      })();

      const imageSurfaceIdRaw = (() => {
        if (!Array.isArray(opticalRows) || opticalRows.length === 0) return 1;
        let sid = 0;
        let foundImageAt = -1;
        for (let i = 0; i < opticalRows.length; i++) {
          const r = opticalRows[i];
          const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
          // Only skip the true Object row (typically index 0). Count everything else,
          // even if object type is mislabeled, so CB rows are not skipped.
          if (i === 0 && ot === 'object') continue;
          sid++;
          if (isImageRow(r)) {
            foundImageAt = i;
            try {
              console.log(`🎯 Image面検出: rowIndex=${i}, surfaceId=${sid}, config=${cfgKey}`);
              console.log(`   surfType=${r?.surfType}, object type=${ot}`);
            } catch (_) {}
            return sid;
          }
        }
        try {
          console.warn(`⚠️ Image面が見つかりません: config=${cfgKey}, rows=${opticalRows.length}, returning sid=${Math.max(1, sid)}`);
        } catch (_) {}
        return Math.max(1, sid);
      })();

      // If the first row is Object, surfaceId should equal imageIdx (1-based on non-object rows).
      // Guard against mislabeled rows by aligning surfaceId to imageIdx when they disagree.
      let resolvedSurfaceId = imageSurfaceIdRaw;
      try {
        const row0 = opticalRows && opticalRows.length > 0 ? opticalRows[0] : null;
        const row0Type = String(row0?.['object type'] ?? row0?.object ?? '').trim().toLowerCase();
        if (row0Type === 'object' && Number.isInteger(imageIdx) && imageIdx > 0) {
          if (resolvedSurfaceId !== imageIdx) {
            resolvedSurfaceId = imageIdx;
          }
        }
      } catch (_) {}

      try {
        const dbg = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_DEBUG_REQUIREMENTS : false;
        if (dbg) {
          console.log(`🧪 [ReqDebug] surfaceIdRaw=${imageSurfaceIdRaw} resolvedSurfaceId=${resolvedSurfaceId} imageIdx=${imageIdx} cfg=${cfgKey}`);
        }
      } catch (_) {}

      const primaryWavelengthUm = (() => {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5876;
        const primaryRow = sourceRows.find(r => r && r.primary && String(r.primary).toLowerCase().includes('primary'));
        const wl = Number(primaryRow ? primaryRow.wavelength : sourceRows[0]?.wavelength);
        return (Number.isFinite(wl) && wl > 0) ? wl : 0.5876;
      })();

      const rawMap = localStorage.getItem('spotDiagramSettingsByConfigId');
      const map = rawMap ? (JSON.parse(rawMap) || {}) : {};
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
        if (needsIdUpdate) {
          try {
            console.log(`🔧 Updating Spot Diagram settings for config ${cfgKey}:`);
            console.log(`   surfaceId: ${existing.surfaceId} → ${imageSurfaceId}`);
            console.log(`   surfaceIndex: ${existing.surfaceIndex} → ${imageIdx}`);
            console.log(`   Image row found at index ${imageIdx} with surfaceId ${imageSurfaceId}`);
          } catch (_) {}
        }
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
      localStorage.setItem('spotDiagramSettingsByConfigId', JSON.stringify(map));
      
      // CRITICAL: Also update in-memory cache so merit evaluation uses the latest settings immediately.
      // This prevents CB insertion from causing stale surfaceId resolution during the next evaluation.
      try {
        if (typeof window !== 'undefined') {
          window.__cooptSpotDiagramSettingsByConfigId = map;
        }
      } catch (_) {}
    } catch (_) {
      // ignore
    }
  }

  async updateAllConfigsAndEvaluate() {
    // Force using UI table rows during this update cycle (blocks may be stale after CB insertion).
    let prevPreferTable = undefined;
    try {
      if (typeof globalThis !== 'undefined') {
        prevPreferTable = globalThis.__cooptPreferTableOpticalSystemRows;
        globalThis.__cooptPreferTableOpticalSystemRows = true;
      }
    } catch (_) {}

    // CRITICAL: Clear memory caches at the start to force fresh data load.
    // Keep __cooptOpticalSystemByConfigId so non-active configs retain CB-aware rows.
    try {
      if (typeof window !== 'undefined') {
        delete window.__cooptSystemConfig;
        delete window.__cooptSpotDiagramSettingsByConfigId;
      }
    } catch (_) {}

    // Ensure each configuration has an up-to-date expanded opticalSystem snapshot
    // and has a per-config Spot Diagram settings entry.
    const editor = window.meritFunctionEditor;
    if (!editor || typeof editor.getOpticalSystemDataByConfigId !== 'function') {
      try { await this.evaluateAndUpdateNow({ reason: 'no-merit-editor' }); } catch (_) {}
      return;
    }

    let systemConfig = null;
    try {
      systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
    } catch (_) {}
    const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
    if (!systemConfig || configs.length === 0) {
      await this.evaluateAndUpdateNow({ reason: 'no-configs' });
      return;
    }

    const updateBtn = document.getElementById('update-requirement-btn');
    try { if (updateBtn) updateBtn.disabled = true; } catch (_) {}

    // Show progress during the refresh, then reuse the same bar for evaluation.
    let showTimer = null;
    try {
      showTimer = setTimeout(() => {
        try {
          this._setProgressVisible(true);
          this._setProgress('Updating config snapshots…', 0, Math.max(1, configs.length));
        } catch (_) {}
      }, 150);
    } catch (_) {}

    try {
      let globalSourceRows = [];
      try {
        const json = localStorage.getItem('sourceTableData');
        const parsed = json ? JSON.parse(json) : null;
        globalSourceRows = Array.isArray(parsed) ? parsed : [];
      } catch (_) {}
      
      // CRITICAL: Get active config's optical rows first (CB-aware).
      // This will be used for Spot Diagram settings across ALL configs.
      // MUST read UI table directly, bypassing blocks expansion (which may be stale after CB insertion).
      let activeConfigOpticalRows = null;
      const activeConfigId = (systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null)
        ? String(systemConfig.activeConfigId)
        : '';
      
      if (activeConfigId) {
        try {
          // Directly access UI table, bypassing blocks-first logic in getOpticalSystemRows
          if (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function') {
            activeConfigOpticalRows = window.tableOpticalSystem.getData();
          } else if (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.getData === 'function') {
            activeConfigOpticalRows = window.opticalSystemTabulator.getData();
          }
          
          if (Array.isArray(activeConfigOpticalRows) && activeConfigOpticalRows.length > 0) {
            console.log(`✅ Got ${activeConfigOpticalRows.length} rows from active config UI table (CB-aware, bypassing blocks)`);
          }
        } catch (_) {}
        
        // Fallback: Set temporary flag to force table reading, then call getOpticalSystemRows
        if (!Array.isArray(activeConfigOpticalRows) || activeConfigOpticalRows.length === 0) {
          try {
            if (typeof globalThis !== 'undefined') {
              globalThis.__cooptPreferTableOpticalSystemRows = true;
            }
            const fn = (typeof getOpticalSystemRows === 'function') ? getOpticalSystemRows : null;
            if (fn) activeConfigOpticalRows = fn();
            if (typeof globalThis !== 'undefined') {
              delete globalThis.__cooptPreferTableOpticalSystemRows;
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
            if (typeof window !== 'undefined' && window.__cooptOpticalSystemByConfigId) {
              const c = window.__cooptOpticalSystemByConfigId[cfgId];
              return (Array.isArray(c) && c.length > 0) ? c : null;
            }
          } catch (_) {}
          return null;
        })();

        let opticalRows = null;
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
              if (!window.__cooptOpticalSystemByConfigId) window.__cooptOpticalSystemByConfigId = {};
              window.__cooptOpticalSystemByConfigId[cfgId] = opticalRows;
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

        try {
          const debugFlag = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_DEBUG_REQUIREMENTS : false;
          if (debugFlag) {
            console.log(`🧪 [ReqDebug] cfg=${cfgId} active=${isActiveCfg} rowsForSpot=${Array.isArray(rowsForSpotSettings) ? rowsForSpotSettings.length : 'null'}`);
          }
        } catch (_) {}

        try {
          this._setProgress('Updating config snapshots…', i + 1, Math.max(1, configs.length));
        } catch (_) {}

        if (i % 2 === 0) await this._yieldToUI();
      }

      // NOTE: Do not overwrite per-config Spot Diagram settings with active config values.
      // Only create missing entries.
      try {
        const activeId = (systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null)
          ? String(systemConfig.activeConfigId)
          : '';
        if (activeId) {
          const rawMap = localStorage.getItem('spotDiagramSettingsByConfigId');
          const map = rawMap ? (JSON.parse(rawMap) || {}) : {};
          const activeCfgSettings = map[activeId];
          
          try {
            console.log(`🔍 Checking active config (${activeId}) settings:`, activeCfgSettings);
          } catch (_) {}
          
          if (activeCfgSettings && typeof activeCfgSettings === 'object' && activeCfgSettings.surfaceId) {
            const activeImageSurfaceId = activeCfgSettings.surfaceId;
            
            try {
              console.log(`🎯 Active config Image surfaceId: ${activeImageSurfaceId}`);
            } catch (_) {}
            
            for (const cfg of configs) {
              const cfgId = (cfg && cfg.id !== undefined && cfg.id !== null) ? String(cfg.id) : '';
              if (!cfgId || cfgId === activeId) continue;
              
              let existing = map[cfgId];
              // If settings don't exist for this config, create them.
              if (!existing || typeof existing !== 'object') {
                try {
                  console.log(`✨ Creating Spot Diagram settings for config ${cfgId} (synced from active)`);
                } catch (_) {}
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
            
            localStorage.setItem('spotDiagramSettingsByConfigId', JSON.stringify(map));
            if (typeof window !== 'undefined') {
              window.__cooptSpotDiagramSettingsByConfigId = map;
            }
          }
        }
      } catch (_) {}

      try {
        localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
        // CRITICAL: Also cache in memory so getOpticalSystemDataByConfigId
        // reads fresh data immediately after CB insertion (before localStorage sync).
        if (typeof window !== 'undefined') {
          window.__cooptSystemConfig = systemConfig;
        }
      } catch (_) {}
    } finally {
      try { if (showTimer) clearTimeout(showTimer); } catch (_) {}
      try { if (updateBtn) updateBtn.disabled = false; } catch (_) {}
    }

    await this.evaluateAndUpdateNow({ reason: 'update-button' });

    // Restore previous preferTable flag
    try {
      if (typeof globalThis !== 'undefined') {
        if (prevPreferTable === undefined) {
          delete globalThis.__cooptPreferTableOpticalSystemRows;
        } else {
          globalThis.__cooptPreferTableOpticalSystemRows = prevPreferTable;
        }
      }
    } catch (_) {}
  }

  createDefaultRequirementRow() {
    let activeConfigId = '';
    try {
      const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
      if (systemConfig && systemConfig.activeConfigId) activeConfigId = String(systemConfig.activeConfigId);
    } catch (_) {}

    return {
      id: this.requirements.length + 1,
      enabled: true,
      operand: 'EFFL',
      rationale: '',
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

  addRequirement() {
    const newRow = this.createDefaultRequirementRow();

    const selectedIndex = this.requirements.findIndex(r => r && String(r.id) === String(this._selectedId));
    if (selectedIndex !== -1) {
      this.requirements.splice(selectedIndex + 1, 0, newRow);
    } else {
      this.requirements.push(newRow);
    }
    this.updateRowNumbers();
    this.saveToStorage();
    if (typeof this._renderBody === 'function') this._renderBody(() => '', () => '', () => null);
  }

  deleteRequirement() {
    if (this._selectedId === null || this._selectedId === undefined || String(this._selectedId).trim() === '') {
      alert('削除する行を選択してください');
      return;
    }

    const idx = this.requirements.findIndex(r => r && String(r.id) === String(this._selectedId));
    if (idx !== -1) this.requirements.splice(idx, 1);
    this._selectedId = null;

    this.updateRowNumbers();
    this.saveToStorage();
    if (typeof this._renderBody === 'function') this._renderBody(() => '', () => '', () => null);

    try {
      if (this.inspector && typeof this.inspector.hide === 'function') this.inspector.hide();
    } catch (_) {}
  }

  transferSelectedToEvaluation() {
    alert('System Evaluation は廃止されました。Requirements が仕様（合否）です。');
  }

  computeViolationAmount(op, current, target, tol) {
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

  _sanitizeCurrentForUI(rawCurrent) {
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

  async evaluateAndUpdateNow(options = null) {
    if (this._isEvaluating) {
      this._pendingEvalRequested = true;
      return;
    }
    this._isEvaluating = true;

    try {
      window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'enter' };
    } catch (_) {}

    if (this._isEditingCell) {
      this._pendingEvalAfterEdit = true;
      try {
        window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'deferred-edit' };
      } catch (_) {}
      this._isEvaluating = false;
      return;
    }

    const editor = window.meritFunctionEditor;
    if (!editor || typeof editor.calculateOperandValue !== 'function') {
      try { window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'no-merit-editor' }; } catch (_) {}
      this._isEvaluating = false;
      return;
    }

    try {
      window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'running' };
    } catch (_) {}

    let systemConfig = null;
    try {
      systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
    } catch (_) {}
    const activeConfigId = systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null
      ? String(systemConfig.activeConfigId)
      : '';

    const live = this._getLiveRequirementsData();
    this.requirements = live;

    // Progress bar (only show if evaluation takes noticeable time)
    let showTimer = null;
    let progressVisible = false;
    try {
      showTimer = setTimeout(() => {
        try {
          progressVisible = true;
          this._setProgressVisible(true);
          this._setProgress('Evaluating requirements…', 0, Math.max(1, live.length));
        } catch (_) {}
      }, 150);
    } catch (_) {}

    // Requirements are a pass/fail spec. They should reflect the same semantics as the UI analyses
    // (e.g., Spot Diagram) rather than any optimization/fast-mode heuristics.
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
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

    const updates = [];
    try {
    for (let i = 0; i < live.length; i++) {
      const row = live[i];
      if (!row || typeof row !== 'object') continue;

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

      let current = null;
      try {
        current = editor.calculateOperandValue(opObj);

        // If this is a Spot Size operand, capture its debug snapshot keyed by requirement row id.
        // This prevents "last debug wins" confusion when multiple configs/rows are evaluated.
        try {
          if (typeof window !== 'undefined') {
            const opName = String(operand || '').trim();
            if (opName.startsWith('SPOT_SIZE')) {
              const sd = (window.__cooptLastSpotSizeDebug && typeof window.__cooptLastSpotSizeDebug === 'object')
                ? window.__cooptLastSpotSizeDebug
                : null;
              const rid = row.id;
              if (sd && rid !== undefined && rid !== null && Number(sd.reqRowId) === Number(rid)) {
                const map = (window.__cooptSpotSizeDebugByReqRowId && typeof window.__cooptSpotSizeDebugByReqRowId === 'object')
                  ? window.__cooptSpotSizeDebugByReqRowId
                  : {};
                let snap = sd;
                try {
                  snap = (typeof structuredClone === 'function') ? structuredClone(sd) : JSON.parse(JSON.stringify(sd));
                } catch (_) {}
                map[String(rid)] = snap;
                window.__cooptSpotSizeDebugByReqRowId = map;
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

      if (progressVisible) {
        try {
          this._setProgress('Evaluating requirements…', i + 1, Math.max(1, live.length));
        } catch (_) {}
      }
      if (i % 2 === 0) await this._yieldToUI();
    }
    } finally {
      try {
        if (g) g.__cooptMeritFastMode = prevFast;
        if (g) g.__COOPT_EVALUATING_REQUIREMENTS = prevReqFlag;
      } catch (_) {}

      try { if (showTimer) clearTimeout(showTimer); } catch (_) {}
      try { this._setProgressVisible(false); } catch (_) {}
    }

    try {
      if (Array.isArray(updates) && updates.length > 0) {
        for (const u of updates) {
          const r = this.requirements.find(x => x && x.id === u.id);
          if (r) {
            r.current = u.current;
            r.status = u.status;
            r._violation = u._violation;
            r._contribution = u._contribution;
          }
        }

        // Patch DOM for Current/Status only to preserve focus.
        if (this._tbody) {
          for (const u of updates) {
            const tr = this._tbody.querySelector(`tr[data-id="${String(u.id)}"]`);
            if (!tr) continue;
            const curEl = tr.querySelector('td[data-role="current"]');
            const stEl = tr.querySelector('td[data-role="status"]');
            if (curEl) {
              const v = u.current;
              const n = Number(v);
              curEl.textContent = (v === null || v === undefined) ? '' : (Number.isFinite(n) ? n.toFixed(6) : String(v));
            }
            if (stEl) stEl.textContent = String(u.status ?? '').trim();
          }
        }
      }
    } catch (_) {
      // ignore
    }

    try {
      window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'done', updated: Array.isArray(updates) ? updates.length : 0 };
    } catch (_) {}

    this._isEvaluating = false;
    if (this._pendingEvalRequested) {
      this._pendingEvalRequested = false;
      try { await this.evaluateAndUpdateNow({ reason: 'pending' }); } catch (_) {}
    }
  }

  scheduleEvaluateAndUpdate() {
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

  installMeritHook() {
    if (this._meritHookInstalled) return;
    const tryInstall = () => {
      const editor = window.meritFunctionEditor;
      if (!editor || typeof editor.calculateMerit !== 'function') return false;
      if (editor.__cooptRequirementsHooked) {
        // Hook already installed (possibly by a previous cached load).
        // Still ensure we compute Current/Status at least once.
        try {
          if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            window.systemRequirementsEditor.scheduleEvaluateAndUpdate();
          }
        } catch (_) {}
        return true;
      }

      const original = editor.calculateMerit.bind(editor);
      editor.calculateMerit = (...args) => {
        const out = original(...args);
        try {
          if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            window.systemRequirementsEditor.scheduleEvaluateAndUpdate();
          }
        } catch (_) {}
        return out;
      };

      editor.__cooptRequirementsHooked = true;
      // Ensure we compute Current/Status at least once after the editor becomes ready.
      try {
        if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
          window.systemRequirementsEditor.scheduleEvaluateAndUpdate();
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
          if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            window.systemRequirementsEditor.scheduleEvaluateAndUpdate();
          }
        } catch (_) {}
      }
    }, 100);
  }

  updateRowNumbers() {
    this.requirements.forEach((r, index) => {
      r.id = index + 1;
    });
  }

  getData() {
    return this.requirements;
  }

  setData(data) {
    if (!Array.isArray(data)) {
      console.warn('System Requirements setData: invalid data');
      return;
    }

    let systemConfig = null;
    try {
      systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
    } catch (_) {}
    const activeConfigId = systemConfig?.activeConfigId !== undefined && systemConfig?.activeConfigId !== null
      ? String(systemConfig.activeConfigId)
      : '';

    this.requirements = data.map(row => {
      const r = row && typeof row === 'object' ? { ...row } : {};

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

      // Migration: configId may have been saved as a config name (e.g. "Wide").
      // Normalize to a real id so merit evaluation can load the intended config.
      r.configId = this._normalizeConfigId(r.configId, systemConfig, activeConfigId);

      return r;
    });
    this.updateRowNumbers();
    if (typeof this._renderBody === 'function') this._renderBody(() => '', () => '', () => null);
  }

  loadFromStorage() {
    try {
      const saved = localStorage.getItem('systemRequirementsData');
      if (!saved) return;
      const data = JSON.parse(saved);

      let activeConfigId = '';
      try {
        const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
        if (systemConfig && systemConfig.activeConfigId) activeConfigId = String(systemConfig.activeConfigId);
      } catch (_) {}

      let systemConfig = null;
      try {
        systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
      } catch (_) {}

      this.requirements = (Array.isArray(data) ? data : []).map(row => {
        const r = row && typeof row === 'object' ? { ...row } : {};

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

        r.configId = this._normalizeConfigId(r.configId, systemConfig, activeConfigId);

        // Defaults for new fields (backward compatible)
        if (r.enabled === undefined || r.enabled === null) r.enabled = true;
        if (!r.op) r.op = '=';
        if (r.tol === undefined || r.tol === null || String(r.tol).trim() === '') r.tol = 0;
        if (r.param5 === undefined || r.param5 === null) r.param5 = '';

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

  saveToStorage() {
    try {
      const live = this._getLiveRequirementsData();
      this.requirements = live;

      // Do not persist derived fields (current/status)
      const toSave = (Array.isArray(live) ? live : []).map(r => {
        if (!r || typeof r !== 'object') return r;
        const {
          id,
          enabled,
          operand,
          rationale,
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
        return { id, enabled, operand, rationale, configId, param1, param2, param3, param4, param5, op, tol, target, weight };
      });
      localStorage.setItem('systemRequirementsData', JSON.stringify(toSave));
    } catch (e) {
      console.warn('System Requirements saveToStorage failed:', e);
    }
  }

  getConfigurationList() {
    try {
      const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
      if (!systemConfig || !systemConfig.configurations) return { '': 'Current' };

      const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
      const activeName = activeConfig ? activeConfig.name : '';

      const list = { '': `Current (${activeName})` };
      systemConfig.configurations.forEach(cfg => {
        list[String(cfg.id)] = cfg.name;
      });
      return list;
    } catch (_) {
      return { '': 'Current' };
    }
  }

  getConfigName(configId) {
    if (!configId && configId !== 0) {
      try {
        const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
        if (systemConfig && systemConfig.configurations) {
          const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
          if (activeConfig) return `Current (${activeConfig.name})`;
        }
      } catch (_) {}
      return 'Current';
    }

    try {
      const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
      if (!systemConfig || !systemConfig.configurations) return 'Current';
      const cfg = systemConfig.configurations.find(c => String(c.id) === String(configId));
      return cfg ? cfg.name : 'Current';
    } catch (_) {
      return 'Current';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    window.systemRequirementsEditor = new SystemRequirementsEditor();

  } catch (e) {
    console.error('❌ System Requirements Editor init failed:', e);
  }
});

export { SystemRequirementsEditor };
