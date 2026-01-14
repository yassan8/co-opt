/**
 * System Requirements Editor (Tabulator)
 * - Requirements are the source of truth (pass/fail constraints)
 * - System Evaluation UI is deprecated (no transfer)
 */

import { OPERAND_DEFINITIONS, InspectorManager } from './merit-function-inspector.js?v=2026-01-06c';

class SystemRequirementsEditor {
  constructor() {
    this.requirements = [];
    this.table = null;
    this._evalTimer = null;
    this._meritHookInstalled = false;
    this.inspector = new InspectorManager('requirement-inspector', 'requirement-inspector-content');

    this.loadFromStorage();
    this.initializeTable();
    this.initializeEventListeners();

    // Auto-update status when Merit is recalculated
    this.installMeritHook();
    this.scheduleEvaluateAndUpdate();
  }

  _getBlocksForConfigHint(configIdValue) {
    try {
      const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
      const sys = raw ? JSON.parse(raw) : null;
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
      return blocks
        .map(b => String(b?.blockId ?? '').trim())
        .filter(Boolean);
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
    try {
      if (this.table && typeof this.table.getData === 'function') {
        const d = this.table.getData();
        if (Array.isArray(d)) return d;
      }
    } catch (_) {}
    return Array.isArray(this.requirements) ? this.requirements : [];
  }

  initializeTable() {
    const operandKeys = (() => {
      try {
        const keys = InspectorManager.getAvailableOperands?.();
        return Array.isArray(keys) ? keys : Object.keys(OPERAND_DEFINITIONS);
      } catch (_) {
        return Object.keys(OPERAND_DEFINITIONS);
      }
    })();

    const ensureEflBlocksDatalist = (blockIds) => {
      try {
        const id = 'coopt-efl-blocks-datalist';
        let dl = document.getElementById(id);
        if (!dl) {
          dl = document.createElement('datalist');
          dl.id = id;
          document.body.appendChild(dl);
        }
        dl.innerHTML = '';
        const addOpt = (v) => {
          const o = document.createElement('option');
          o.value = v;
          dl.appendChild(o);
        };
        addOpt('ALL');
        for (const bid of blockIds || []) addOpt(bid);
        return id;
      } catch (_) {
        return null;
      }
    };

    const param2Editor = (cell, onRendered, success, cancel) => {
      const row = cell?.getRow?.() ? cell.getRow().getData() : null;
      const operand = String(row?.operand ?? '').trim();

      // Default: plain input
      const input = document.createElement('input');
      input.type = 'text';
      input.style.width = '100%';
      input.style.boxSizing = 'border-box';
      input.value = (cell.getValue() === undefined || cell.getValue() === null) ? '' : String(cell.getValue());

      // EFL: attach block list suggestions (datalist)
      if (operand === 'EFL') {
        const configIdHint = row?.configId;
        const blockIds = this._getBlocksForConfigHint(configIdHint);
        const dlId = ensureEflBlocksDatalist(blockIds);
        if (dlId) input.setAttribute('list', dlId);
        input.placeholder = 'ALL or blockId (comma separated allowed)';
      }

      onRendered(() => {
        try {
          input.focus();
          input.select();
        } catch (_) {}
      });

      const finish = () => success(input.value);
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      });

      return input;
    };

    const columns = [
      { title: 'Num', field: 'id', width: 80, hozAlign: 'center', headerSort: true },
      {
        title: 'On',
        field: 'enabled',
        width: 70,
        hozAlign: 'center',
        editor: 'tickCross',
        formatter: 'tickCross',
        cellEdited: () => this.saveToStorage()
      },
      {
        title: 'Type',
        field: 'severity',
        width: 90,
        hozAlign: 'center',
        editor: 'list',
        editorParams: { values: { hard: 'hard', soft: 'soft' } },
        cellEdited: () => this.saveToStorage()
      },
      {
        title: 'Requirement',
        field: 'operand',
        width: 200,
        editor: 'list',
        editorParams: {
          values: operandKeys.reduce((acc, key) => {
            acc[key] = OPERAND_DEFINITIONS[key].name;
            return acc;
          }, {})
        },
        formatter: (cell) => {
          const value = cell.getValue();
          return OPERAND_DEFINITIONS[value]?.name || value;
        },
        cellEdited: () => this.saveToStorage()
      },
      {
        title: 'Rationale',
        field: 'rationale',
        width: 260,
        editor: 'textarea',
        formatter: (cell) => {
          const v = cell.getValue();
          if (v === null || v === undefined) return '';
          return String(v);
        },
        cellEdited: () => this.saveToStorage()
      },
      {
        title: 'Config',
        field: 'configId',
        width: 120,
        editor: 'list',
        editorParams: () => ({ values: this.getConfigurationList() }),
        formatter: (cell) => {
          const configId = cell.getValue();
          if (configId === null || configId === undefined) return '';
          return this.getConfigName(configId) || 'Current';
        },
        hozAlign: 'center',
        cellEdited: () => this.saveToStorage()
      },
      { title: '-', field: 'param1', width: 100, editor: 'input', hozAlign: 'center' },
      { title: '-', field: 'param2', width: 100, editor: param2Editor, hozAlign: 'center' },
      { title: '-', field: 'param3', width: 100, editor: 'input', hozAlign: 'center' },
      { title: '-', field: 'param4', width: 100, editor: 'input', hozAlign: 'center' },
      {
        title: 'Op',
        field: 'op',
        width: 80,
        editor: 'list',
        editorParams: { values: { '=': '=', '<=': '<=', '>=': '>=' } },
        hozAlign: 'center',
        cellEdited: () => this.saveToStorage()
      },
      { title: 'Tol', field: 'tol', width: 90, editor: 'input', hozAlign: 'center' },
      { title: 'Target', field: 'target', width: 100, editor: 'input', hozAlign: 'center' },
      { title: 'Weight', field: 'weight', width: 100, editor: 'input', hozAlign: 'center' },
      {
        title: 'Current',
        field: 'current',
        width: 120,
        hozAlign: 'center',
        formatter: (cell) => {
          const v = cell.getValue();
          if (v === null || v === undefined) return '';
          const n = Number(v);
          return Number.isFinite(n) ? n.toFixed(6) : String(v);
        }
      },
      {
        title: 'Status',
        field: 'status',
        width: 100,
        hozAlign: 'center',
        formatter: (cell) => {
          const v = String(cell.getValue() ?? '').trim();
          if (!v) return '';
          return v;
        }
      }
    ];

    this.table = new Tabulator('#table-system-requirements', {
      data: this.requirements,
      columns,
      layout: 'fitColumns',
      height: '300px',
      selectable: true
    });

    // Make selection single, similar to other tables
    this.table.on('rowClick', (_e, row) => {
      try {
        this.table.deselectRow();
        row.select();
      } catch (_) {}
    });

    // Mirror System Evaluation: update param headers based on selected operand
    this.table.on('rowSelected', (row) => {
      try {
        this.updateParameterHeaders(row.getData());
      } catch (_) {}

      try {
        if (this.inspector && typeof this.inspector.show === 'function') {
          this.inspector.show(row.getData());
        }
      } catch (_) {}
    });

    this.table.on('rowDeselected', () => {
      try {
        this.resetParameterHeaders();
      } catch (_) {}

      try {
        if (this.inspector && typeof this.inspector.hide === 'function') {
          this.inspector.hide();
        }
      } catch (_) {}
    });

    // Persist on any edit
    this.table.on('cellEdited', (cell) => {
      try {
        if (cell && typeof cell.getField === 'function' && cell.getField() === 'operand') {
          const row = cell.getRow && cell.getRow();
          if (row && typeof row.isSelected === 'function' && row.isSelected()) {
            this.updateParameterHeaders(row.getData());
          }
        }
      } catch (_) {}
      this.saveToStorage();
      this.scheduleEvaluateAndUpdate();
    });
  }

  updateParameterHeaders(rowData) {
    const operand = rowData?.operand;
    const definition = operand ? OPERAND_DEFINITIONS[operand] : null;

    // If operand is unset/unknown, keep all as '-'
    if (!operand || !definition || !definition.parameters) {
      this.resetParameterHeaders();
      return;
    }

    const paramFields = ['param1', 'param2', 'param3', 'param4'];
    paramFields.forEach((field) => {
      const column = (this.table && typeof this.table.getColumn === 'function') ? this.table.getColumn(field) : null;
      if (!column || typeof column.getElement !== 'function') return;

      const el = column.getElement();
      if (!el || typeof el.querySelector !== 'function') return;
      const headerElement = el.querySelector('.tabulator-col-title');
      if (!headerElement) return;

      const paramDef = Array.isArray(definition.parameters)
        ? definition.parameters.find(p => p && p.key === field)
        : null;

      headerElement.textContent = (paramDef && paramDef.label) ? paramDef.label : '-';
    });
  }

  resetParameterHeaders() {
    const defaultTitles = {
      param1: '-',
      param2: '-',
      param3: '-',
      param4: '-'
    };

    Object.entries(defaultTitles).forEach(([field, title]) => {
      const column = (this.table && typeof this.table.getColumn === 'function') ? this.table.getColumn(field) : null;
      if (!column || typeof column.getElement !== 'function') return;
      const el = column.getElement();
      if (!el || typeof el.querySelector !== 'function') return;
      const headerElement = el.querySelector('.tabulator-col-title');
      if (headerElement) headerElement.textContent = title;
    });
  }

  initializeEventListeners() {
    const addBtn = document.getElementById('add-requirement-btn');
    if (addBtn) addBtn.addEventListener('click', () => this.addRequirement());

    const delBtn = document.getElementById('delete-requirement-btn');
    if (delBtn) delBtn.addEventListener('click', () => this.deleteRequirement());

    const updateBtn = document.getElementById('update-requirement-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        try {
          this.evaluateAndUpdateNow();
        } catch (_) {}
      });
    }
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
      severity: 'hard',
      operand: 'EFFL',
      rationale: '',
      configId: activeConfigId,
      param1: '',
      param2: '',
      param3: '',
      param4: '',
      op: '=',
      tol: 0,
      target: 0,
      weight: 1
    };
  }

  addRequirement() {
    const newRow = this.createDefaultRequirementRow();

    const selectedRows = this.table ? this.table.getSelectedRows() : [];
    if (selectedRows.length > 0) {
      const selected = selectedRows[0];
      const selectedIndex = this.requirements.findIndex(r => r.id === selected.getData().id);
      if (selectedIndex !== -1) {
        this.requirements.splice(selectedIndex + 1, 0, newRow);
        this.updateRowNumbers();
        this.table.addRow(newRow, false, selected);
        this.saveToStorage();
        return;
      }
    }

    this.requirements.push(newRow);
    this.updateRowNumbers();
    this.table.addRow(newRow);
    this.saveToStorage();
  }

  deleteRequirement() {
    if (!this.table) return;
    const selectedRows = this.table.getSelectedRows();
    if (selectedRows.length === 0) {
      alert('削除する行を選択してください');
      return;
    }

    selectedRows.forEach(row => {
      const idx = this.requirements.findIndex(r => r.id === row.getData().id);
      if (idx !== -1) this.requirements.splice(idx, 1);
    });

    this.updateRowNumbers();
    this.table.setData(this.requirements);
    this.saveToStorage();
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
    const v = Number(rawCurrent);
    if (!Number.isFinite(v)) return { current: null, ok: false };
    // Many operands historically returned ~1e9 on ray-trace failure.
    // Showing that number as a measured “Current” is misleading.
    if (Math.abs(v) >= 1e8) return { current: null, ok: false };
    return { current: v, ok: true };
  }

  evaluateAndUpdateNow() {
    try {
      window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'enter' };
    } catch (_) {}

    if (!this.table) {
      try { window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'no-table' }; } catch (_) {}
      return;
    }
    const editor = window.meritFunctionEditor;
    if (!editor || typeof editor.calculateOperandValue !== 'function') {
      try { window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'no-merit-editor' }; } catch (_) {}
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

    const updates = [];
    for (const row of live) {
      if (!row || typeof row !== 'object') continue;

      const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
      const severity = (String(row.severity || '').trim().toLowerCase() === 'soft') ? 'soft' : 'hard';
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
        param1: row.param1,
        param2: row.param2,
        param3: row.param3,
        param4: row.param4,
        target,
        weight
      };

      let current = null;
      try {
        current = editor.calculateOperandValue(opObj);
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
        status = (severity === 'soft') ? 'SOFT' : 'NG';
      } else if (!Number.isFinite(amount)) {
        status = '—';
      } else if (amount > 0) {
        status = (severity === 'soft') ? 'SOFT' : 'NG';
      }

      // Current: raw operand value (e.g., Spot size in µm).
      // _violation/_contribution are available for debugging/consistency checks.
      updates.push({ id: row.id, current, status, _violation: sanitized.ok ? amount : null, _contribution: sanitized.ok ? contribution : null });
    }

    try {
      if (Array.isArray(updates) && updates.length > 0) {
        this.table.updateData(updates);
      }
    } catch (_) {
      // Fallback (older Tabulator versions)
      try {
        for (const u of updates) {
          const r = this.requirements.find(x => x && x.id === u.id);
          if (r) {
            r.current = u.current;
            r.status = u.status;
          }
        }
        this.table.setData(this.requirements);
      } catch (_) {}
    }

    try {
      window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'done', updated: Array.isArray(updates) ? updates.length : 0 };
    } catch (_) {}
  }

  scheduleEvaluateAndUpdate() {
    try {
      if (this._evalTimer) clearTimeout(this._evalTimer);
    } catch (_) {}
    this._evalTimer = setTimeout(() => {
      try { this.evaluateAndUpdateNow(); } catch (_) {}
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
    if (this.table) this.table.setData(this.requirements);
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
        if (!r.severity) r.severity = 'hard';
        if (!r.op) r.op = '=';
        if (r.tol === undefined || r.tol === null || String(r.tol).trim() === '') r.tol = 0;

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
          severity,
          operand,
          rationale,
          configId,
          param1,
          param2,
          param3,
          param4,
          op,
          tol,
          target,
          weight
        } = r;
        return { id, enabled, severity, operand, rationale, configId, param1, param2, param3, param4, op, tol, target, weight };
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
