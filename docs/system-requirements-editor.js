/**
 * System Requirements Editor (DOM)
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
    this._isEditingCell = false;
    this._pendingEvalAfterEdit = false;
    this._tableRoot = null;
    this._tbody = null;
    this._selectedId = null;
    this._selectedTr = null;
    this._paramHeaderEls = { param1: null, param2: null, param3: null, param4: null };
    this._operandKeys = [];
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
      id: 70,
      enabled: 60,
      operand: 220,
      spec: 190,
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
    const thP1 = mkTh('-', widths.param, null);
    const thP2 = mkTh('-', widths.param2, null);
    const thP3 = mkTh('-', widths.param, null);
    const thP4 = mkTh('-', widths.param, null);
    this._paramHeaderEls = { param1: thP1, param2: thP2, param3: thP3, param4: thP4 };
    headRow.appendChild(thP1);
    headRow.appendChild(thP2);
    headRow.appendChild(thP3);
    headRow.appendChild(thP4);
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
        try { this.updateParameterHeaders(row); } catch (_) {}
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
        try { this.updateParameterHeaders(row); } catch (_) {}

        // Update Spec cell inline.
        const specEl = tr.querySelector('td[data-role="spec"]');
        if (specEl) specEl.textContent = makeSpecSummary(row);

        // Update EFL datalist suggestion for param2 if needed.
        try {
          const p2Input = tr.querySelector('input[data-role="param2"]');
          if (p2Input) {
            if (String(row?.operand ?? '').trim() === 'EFL') {
              const blockIds = this._getBlocksForConfigHint(row?.configId);
              const dlId = ensureEflBlocksDatalist(blockIds);
              if (dlId) p2Input.setAttribute('list', dlId);
              p2Input.placeholder = 'ALL or blockId (comma separated allowed)';
            } else {
              p2Input.removeAttribute('list');
              p2Input.placeholder = '';
            }
          }
        } catch (_) {}
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
            const blockIds = this._getBlocksForConfigHint(row?.configId);
            const dlId = ensureEflBlocksDatalist(blockIds);
            const p2Input = tr.querySelector('input[data-role="param2"]');
            if (p2Input && dlId) p2Input.setAttribute('list', dlId);
          }
        } catch (_) {}
        this.scheduleEvaluateAndUpdate();
      });
      tdCfg.appendChild(cfgSel);
      tr.appendChild(tdCfg);

      const mkInput = (field, widthPx, placeholder = '') => {
        const td = mkTd(widthPx, null);
        td.style.textAlign = 'center';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = (row[field] === undefined || row[field] === null) ? '' : String(row[field]);
        inp.placeholder = placeholder;
        inp.style.width = '100%';
        inp.style.fontSize = '12px';
        inp.style.boxSizing = 'border-box';
        inp.dataset.role = field;
        inp.addEventListener('focus', onCellFocus);
        inp.addEventListener('blur', () => {
          row[field] = inp.value;
          this.saveToStorage();

          if (field === 'tol' || field === 'target') {
            const specEl = tr.querySelector('td[data-role="spec"]');
            if (specEl) specEl.textContent = makeSpecSummary(row);
          }

          this.scheduleEvaluateAndUpdate();
          onCellBlur();
        });
        td.appendChild(inp);
        return { td, input: inp };
      };

      const p1 = mkInput('param1', widths.param);
      tr.appendChild(p1.td);
      const p2 = mkInput('param2', widths.param2);
      // EFL: attach datalist
      try {
        const operand = String(row?.operand ?? '').trim();
        if (operand === 'EFL') {
          const configIdHint = row?.configId;
          const blockIds = this._getBlocksForConfigHint(configIdHint);
          const dlId = ensureEflBlocksDatalist(blockIds);
          if (dlId) p2.input.setAttribute('list', dlId);
          p2.input.placeholder = 'ALL or blockId (comma separated allowed)';
        }
      } catch (_) {}
      tr.appendChild(p2.td);
      const p3 = mkInput('param3', widths.param);
      tr.appendChild(p3.td);
      const p4 = mkInput('param4', widths.param);
      tr.appendChild(p4.td);

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
      for (const r of this.requirements) {
        const tr = renderRow(r);
        this._tbody.appendChild(tr);
      }

      // Update header labels for selected operand if any.
      const sel = this.requirements.find(x => x && String(x.id) === String(this._selectedId)) || null;
      if (sel) {
        setSelectedRow(sel.id);
      } else {
        try { this.resetParameterHeaders(); } catch (_) {}
      }
    };

    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    // Initial render
    this._renderBody(makeSpecSummary, rationalePreview, ensureEflBlocksDatalist);
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
      const headerElement = this._paramHeaderEls ? this._paramHeaderEls[field] : null;
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
      const headerElement = this._paramHeaderEls ? this._paramHeaderEls[field] : null;
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

    try { this.resetParameterHeaders(); } catch (_) {}
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

    if (this._isEditingCell) {
      this._pendingEvalAfterEdit = true;
      try {
        window.__cooptLastRequirementsEval = { at: Date.now(), stage: 'deferred-edit' };
      } catch (_) {}
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
        status = 'NG';
      } else if (!Number.isFinite(amount)) {
        status = '—';
      } else if (amount > 0) {
        status = 'NG';
      }

      // Current: raw operand value (e.g., Spot size in µm).
      // _violation/_contribution are available for debugging/consistency checks.
      updates.push({ id: row.id, current, status, _violation: sanitized.ok ? amount : null, _contribution: sanitized.ok ? contribution : null });
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
          op,
          tol,
          target,
          weight
        } = r;
        return { id, enabled, operand, rationale, configId, param1, param2, param3, param4, op, tol, target, weight };
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
