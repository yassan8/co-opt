// メモ　物体高だけでなく画角も扱えるようにする

// 初期データ (g-C線の色収差評価用)
const initialTableData = [
  {
    id: 1,
    wavelength: 0.4358343,  // g線 (mercury spectral line 435.8 nm)
    weight: 1.0,
    primary: "",
    angle: 0
  },
  {
    id: 2,
    wavelength: 0.5875618,
    weight: 1.0,
    primary: "Primary Wavelength",
    angle: 5
  },
  {
    id: 3,
    wavelength: 0.6562725,  // C線
    weight: 1.0,
    primary: "",
    angle: 10
  }
];

// ローカルストレージからデータを取得
export function loadTableData() {
  if (typeof localStorage === 'undefined' || !localStorage) {
    return initialTableData;
  }
  const json = localStorage.getItem(STORAGE_KEY);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      return parsed;
    } catch (e) {
      console.warn('⚠️ [TableSource] Parse error:', e);
      console.warn("保存データの読み込みに失敗しました。初期データを使用します。");
    }
  }
  return initialTableData;
}

// テーブルデータをローカルストレージに保存
export function saveTableData(data) {
  if (typeof localStorage === 'undefined' || !localStorage) {
    return;
  }
  if (data && Array.isArray(data)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } else {
    console.warn('⚠️ [TableSource] Invalid data, not saving:', data);
  }
}

// 行追加
export function addRow(data, newRow) {
  data.push(newRow);
}

// 行削除
export function deleteRow(data, rowId) {
  const idx = data.findIndex(row => row.id === rowId);
  if (idx !== -1) data.splice(idx, 1);
}

// idを1から振り直す
export function renumberIds(data) {
  data.forEach((row, idx) => {
    row.id = idx + 1;
  });
}

// データの保存・復元用キー
const STORAGE_KEY = "sourceTableData";

// 初期データをローカルストレージから取得
const initialData = loadTableData();

const hasDocument = (typeof document !== 'undefined') && document && typeof document.getElementById === 'function';
const tableContainer = hasDocument ? document.getElementById('table-source') : null;

// 表の構成
export let tableSource;

// ---- Pure DOM Source table (Tabulator-free) --------------------------------

const safeCloneRows = (rows) => (Array.isArray(rows) ? rows.map(r => ({ ...r })) : []);

const createCellEvent = (field, value, rowData) => {
  const rowObj = {
    getData: () => ({ ...rowData }),
  };
  return {
    getField: () => field,
    getValue: () => value,
    getRow: () => rowObj,
  };
};

const createDOMTableSource = (container, initialRows) => {
  let data = safeCloneRows(initialRows);
  let selectedRowId = null;
  let rowWrappers = [];
  const listeners = new Map();

  const on = (eventName, handler) => {
    if (!eventName || typeof handler !== 'function') return;
    if (!listeners.has(eventName)) listeners.set(eventName, []);
    listeners.get(eventName).push(handler);
  };

  const emit = (eventName, ...args) => {
    const handlers = listeners.get(eventName);
    if (!handlers || handlers.length === 0) return;
    handlers.forEach(fn => {
      try {
        fn(...args);
      } catch (e) {
        console.debug('⚠️ [TableSource] listener error:', e);
      }
    });
  };

  const getData = () => safeCloneRows(data);

  const getDataCount = () => data.length;

  const getRows = () => rowWrappers.slice();

  const deselectRow = () => {
    selectedRowId = null;
    rowWrappers.forEach(w => w._setSelected(false));
  };

  const selectRowById = (rowId) => {
    selectedRowId = rowId;
    rowWrappers.forEach(w => w._setSelected(w.getData().id === rowId));
  };

  const getSelectedRows = () => {
    if (selectedRowId == null) return [];
    const w = rowWrappers.find(r => r.getData().id === selectedRowId);
    return w ? [w] : [];
  };

  const normalizeRow = (row, fallbackId) => {
    const normalized = { ...row };
    normalized.id = (normalized.id === '' || normalized.id == null)
      ? fallbackId
      : Number(normalized.id);
    if (Number.isNaN(normalized.id)) normalized.id = fallbackId;
    if (typeof normalized.primary !== 'string') normalized.primary = normalized.primary ? String(normalized.primary) : '';
    if (!('angle' in normalized)) normalized.angle = 0;
    if (!('wavelength' in normalized)) normalized.wavelength = '';
    if (!('weight' in normalized)) normalized.weight = '';
    return normalized;
  };

  const rerender = () => {
    if (!container) return;
    container.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'glass-search-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['Source', 'Wavelength (μm)', 'Weight', 'Primary Wavelength'];
    headers.forEach(text => {
      const th = document.createElement('th');
      th.textContent = text;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rowWrappers = [];

    data.forEach((rawRow, idx) => {
      const rowData = normalizeRow(rawRow, idx + 1);
      data[idx] = rowData;

      const tr = document.createElement('tr');
      if (rowData.id === selectedRowId) tr.classList.add('selected');

      const wrapper = {
        getData: () => ({ ...rowData }),
        delete: () => {
          const index = data.findIndex(r => Number(r.id) === Number(rowData.id));
          if (index !== -1) {
            const deletedRow = JSON.parse(JSON.stringify(rowData));
            data.splice(index, 1);
            renumberIds(data);
            if (selectedRowId === rowData.id) selectedRowId = null;
            rerender();
            saveTableData(getData());
            
            // Record undo
            try {
              if (window.undoHistory && window.DeleteRowCommand && !window.undoHistory.isExecuting) {
                const cmd = new window.DeleteRowCommand('source', deletedRow, index);
                window.undoHistory.record(cmd);
              }
            } catch (e) {
              console.warn('[Undo] Failed to record source delete:', e);
            }
          }
        },
        select: () => {
          deselectRow();
          selectRowById(rowData.id);
        },
        _setSelected: (selected) => {
          if (selected) tr.classList.add('selected');
          else tr.classList.remove('selected');
        },
      };
      rowWrappers.push(wrapper);

      tr.addEventListener('click', (e) => {
        deselectRow();
        selectRowById(rowData.id);
        emit('rowClick', e, wrapper);
      });

      // id
      const tdId = document.createElement('td');
      tdId.textContent = String(rowData.id ?? '');
      tr.appendChild(tdId);

      // wavelength
      const tdWl = document.createElement('td');
      const inputWl = document.createElement('input');
      inputWl.type = 'text';
      inputWl.value = (rowData.wavelength ?? '') === 0 ? '0' : (rowData.wavelength ?? '').toString();
      inputWl.style.width = '100%';
      inputWl.addEventListener('change', () => {
        const oldValue = rowData.wavelength;
        const raw = inputWl.value;
        rowData.wavelength = raw === '' ? '' : Number(raw);
        if (raw !== '' && Number.isNaN(rowData.wavelength)) rowData.wavelength = raw;

        // Record undo command
        if (window.undoHistory && !window.undoHistory.isExecuting && oldValue !== rowData.wavelength) {
          const cfg = window.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new window.SetSourceFieldCommand(
              cfg.id,
              rowData.id,
              'wavelength',
              oldValue,
              rowData.wavelength
            );
            window.undoHistory.record(cmd);
            console.log(`[Undo] Recorded: Set Source ${rowData.id}.wavelength from ${oldValue} to ${rowData.wavelength}`);
          }
        }

        saveTableData(getData());
        emit('cellEdited', createCellEvent('wavelength', rowData.wavelength, rowData));

        if (rowData.primary === 'Primary Wavelength') {
          console.log(`🔧 Primary wavelength value changed to: ${rowData.wavelength} μm`);
          notifyPrimaryWavelengthChanged();
          recalculateAutoSemiDiaIfAvailable();
        }
      });
      tdWl.appendChild(inputWl);
      tr.appendChild(tdWl);

      // weight
      const tdWeight = document.createElement('td');
      const inputWeight = document.createElement('input');
      inputWeight.type = 'text';
      inputWeight.value = (rowData.weight ?? '') === 0 ? '0' : (rowData.weight ?? '').toString();
      inputWeight.style.width = '100%';
      inputWeight.addEventListener('change', () => {
        const oldValue = rowData.weight;
        const raw = inputWeight.value;
        rowData.weight = raw === '' ? '' : Number(raw);
        if (raw !== '' && Number.isNaN(rowData.weight)) rowData.weight = raw;

        // Record undo command
        if (window.undoHistory && !window.undoHistory.isExecuting && oldValue !== rowData.weight) {
          const cfg = window.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new window.SetSourceFieldCommand(
              cfg.id,
              rowData.id,
              'weight',
              oldValue,
              rowData.weight
            );
            window.undoHistory.record(cmd);
            console.log(`[Undo] Recorded: Set Source ${rowData.id}.weight from ${oldValue} to ${rowData.weight}`);
          }
        }

        saveTableData(getData());
        emit('cellEdited', createCellEvent('weight', rowData.weight, rowData));
      });
      tdWeight.appendChild(inputWeight);
      tr.appendChild(tdWeight);

      // primary
      const tdPrimary = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = rowData.primary === 'Primary Wavelength';
      checkbox.addEventListener('change', () => {
        const oldValue = rowData.primary;
        if (checkbox.checked) {
          console.log('🔧 Primary Wavelength selected, clearing other primary entries');
          data.forEach(r => {
            if (Number(r.id) === Number(rowData.id)) r.primary = 'Primary Wavelength';
            else r.primary = '';
          });
          notifyPrimaryWavelengthChanged();
          recalculateAutoSemiDiaIfAvailable();
        } else {
          rowData.primary = '';
          notifyPrimaryWavelengthChanged();
          recalculateAutoSemiDiaIfAvailable();
        }

        // Record undo command
        if (window.undoHistory && !window.undoHistory.isExecuting && oldValue !== rowData.primary) {
          const cfg = window.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new window.SetSourceFieldCommand(
              cfg.id,
              rowData.id,
              'primary',
              oldValue,
              rowData.primary
            );
            window.undoHistory.record(cmd);
            console.log(`[Undo] Recorded: Set Source ${rowData.id}.primary from ${oldValue} to ${rowData.primary}`);
          }
        }

        saveTableData(getData());
        rerender();
        emit('cellEdited', createCellEvent('primary', rowData.primary, rowData));
      });
      tdPrimary.appendChild(checkbox);
      tr.appendChild(tdPrimary);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  };

  const replaceData = async (rows) => {
    data = safeCloneRows(rows);
    // Keep ids as-is; callers may intentionally preserve them.
    rerender();
    return Promise.resolve();
  };

  const setData = async (rows) => replaceData(rows);

  const addRow = (row, _addToTop = false, position = null) => {
    const newRow = normalizeRow(row || {}, data.length + 1);

    let insertIndex = data.length;
    if (typeof position === 'number' && Number.isFinite(position)) {
      insertIndex = Math.max(0, Math.min(data.length, Math.floor(position)));
    } else if (position && typeof position.getData === 'function') {
      const posId = position.getData()?.id;
      const idx = data.findIndex(r => Number(r.id) === Number(posId));
      if (idx !== -1) insertIndex = idx + 1;
    }

    data.splice(insertIndex, 0, newRow);
    renumberIds(data);
    rerender();
    saveTableData(getData());
    
    // Record undo
    try {
      if (window.undoHistory && window.AddRowCommand && !window.undoHistory.isExecuting) {
        const cmd = new window.AddRowCommand('source', JSON.parse(JSON.stringify(newRow)), insertIndex);
        window.undoHistory.record(cmd);
      }
    } catch (e) {
      console.warn('[Undo] Failed to record source add:', e);
    }
    
    return Promise.resolve();
  };

  rerender();

  const api = {
    on,
    getData,
    setData,
    replaceData,
    getDataCount,
    getSelectedRows,
    getRows,
    addRow,
    deselectRow,
    redraw: () => {},
    blockRedraw: () => {},
    restoreRedraw: () => {},
  };

  // Back-compat: some code probes DOM element for a tabulator instance.
  try {
    if (container) container.tabulator = api;
  } catch (_) {}

  // Inform any listeners that the table is ready.
  setTimeout(() => emit('tableBuilt'), 0);

  return api;
};

if (hasDocument && tableContainer) {
  tableSource = createDOMTableSource(tableContainer, initialData);
} else {
  // Headless fallback (Node/tests)
  let _data = safeCloneRows(initialData);
  tableSource = {
    on() {},
    getData: () => safeCloneRows(_data),
    setData: async (d) => { _data = safeCloneRows(d); return Promise.resolve(); },
    replaceData: async (d) => { _data = safeCloneRows(d); return Promise.resolve(); },
    getDataCount: () => _data.length,
    getSelectedRows: () => [],
    getRows: () => [],
    addRow: async (row) => { _data.push({ ...row }); renumberIds(_data); return Promise.resolve(); },
    deselectRow: () => {},
    redraw: () => {},
    blockRedraw: () => {},
    restoreRedraw: () => {},
  };
}

// Expose to global scope for legacy callers
if (typeof window !== 'undefined') {
  window.tableSource = tableSource;
}

// 面を追加
const addSourceBtn = hasDocument ? document.getElementById("add-source-btn") : null;
if (addSourceBtn && tableSource) addSourceBtn.addEventListener("click", function(){
  const selectedRows = tableSource.getSelectedRows();
  let insertIndex = tableSource.getDataCount(); // デフォルトは末尾

  if(selectedRows.length > 0){
    // 選択行の直後に挿入
    const selectedRow = selectedRows[0];
    insertIndex = tableSource.getRows().indexOf(selectedRow) + 1;
  }

  tableSource.addRow({
    id: tableSource.getDataCount() + 1,
    wavelength: "",
    weight: "",
    primary: ""
  }, false, insertIndex).then(() => {
    const data = tableSource.getData();
    renumberIds(data);
    
    // 新規行追加後、1行しかない場合は自動的に主波長に設定
    if (data.length === 1) {
      data[0].primary = "Primary Wavelength";
      console.log('✅ Auto-set primary wavelength for single source entry');
    } else {
      // 複数行がある場合、既存の主波長設定をチェック
      const primaryExists = data.some(row => row.primary === "Primary Wavelength");
      if (!primaryExists) {
        console.log('⚠️ Multiple sources exist but no primary wavelength is set. Please select one manually.');
      }
    }
    
    tableSource.replaceData(data);
    saveTableData(data);
  });
});

// 選択行を削除
const deleteSourceBtn = hasDocument ? document.getElementById("delete-source-btn") : null;
if (deleteSourceBtn && tableSource) deleteSourceBtn.addEventListener("click", function(){
  const selectedRows = tableSource.getSelectedRows();
  if(selectedRows.length > 0){
    const deletedRowData = selectedRows[0].getData();
    const wasPrimary = deletedRowData.primary === "Primary Wavelength";
    
    selectedRows[0].delete();
    setTimeout(() => {
      const data = tableSource.getData();
      renumberIds(data);
      
      // 削除後の処理
      if (data.length === 1) {
        // 残り1行の場合、自動的に主波長に設定
        data[0].primary = "Primary Wavelength";
        console.log('✅ Auto-set primary wavelength for remaining single source entry');
      } else if (data.length > 1 && wasPrimary) {
        // 主波長が設定されていた行が削除され、複数行残っている場合
        console.log('⚠️ Primary wavelength entry was deleted. Please select a new primary wavelength manually.');
      }
      
      tableSource.replaceData(data);
      saveTableData(data);
      
      // 主波長が変更された可能性があるので通知
      if (data.length === 1 || wasPrimary) {
        notifyPrimaryWavelengthChanged();
      }
    }, 0);
  } else {
    alert("削除する行を選択してください。");
  }
});

// 主波長を取得する関数
function getPrimaryWavelength() {
  console.log('🔍 getPrimaryWavelength called from table-source.js');
  try {
    if (tableSource && typeof tableSource.getData === 'function') {
      const sourceData = tableSource.getData();
      console.log('📊 Source data:', sourceData);
      
      // Primary Wavelengthに設定されているエントリを探す
      const primaryEntry = sourceData.find(row => row.primary === "Primary Wavelength");
      console.log('🎯 Primary entry found:', primaryEntry);
      
      if (primaryEntry && primaryEntry.wavelength) {
        const wavelength = parseFloat(primaryEntry.wavelength);
        if (!isNaN(wavelength)) {
          console.log(`✅ Primary wavelength found (table-source.js): ${wavelength} μm`);
          return wavelength;
        }
      }
      
      // 見つからない場合はデフォルト値（d線）
      console.log('⚠️ Primary wavelength not found (table-source.js), using default: 0.5876 μm');
      return 0.5876;
    }
  } catch (error) {
    console.warn('❌ Error getting primary wavelength (table-source.js):', error);
  }
  
  // エラーの場合もデフォルト値
  return 0.5876;
}

// 主波長変更通知関数
function notifyPrimaryWavelengthChanged() {
  console.log('🔄 Primary wavelength changed, updating optical system refractive indices');
  console.log('🔍 Current window.tableSource:', window.tableSource ? 'available' : 'not available');
  
  // 現在の主波長を確認
  const currentWavelength = getPrimaryWavelength();
  console.log(`📏 Current primary wavelength: ${currentWavelength} μm`);
  
  // 光学システムの屈折率を更新
  if (typeof updateAllRefractiveIndices === 'function') {
    updateAllRefractiveIndices();
  } else {
    console.warn('⚠️ updateAllRefractiveIndices function not found');
  }
}

/**
 * Image面のSemi Dia自動計算を再実行（optimizeSemiDia="A"の場合）
 */
function recalculateAutoSemiDiaIfAvailable() {
  try {
    if (typeof window.calculateImageSemiDiaFromChiefRays === 'function') {
      console.log('🔄 Source変更検知: Image面のSemi Dia自動計算を再実行');
      window.calculateImageSemiDiaFromChiefRays();
    }
  } catch (error) {
    console.debug('Semi Dia自動計算スキップ:', error.message);
  }
}

// デバッグ用：主波長変更のテスト関数
function testPrimaryWavelengthUpdate() {
  console.log('🧪 Testing primary wavelength update...');
  
  // 現在の主波長を表示
  const currentWavelength = getPrimaryWavelength();
  console.log(`📏 Current primary wavelength: ${currentWavelength} μm`);
  
  // window.tableSourceの状態を確認
  console.log('🔍 window.tableSource:', window.tableSource ? 'available' : 'not available');
  
  if (window.tableSource) {
    const sourceData = window.tableSource.getData();
    console.log('📊 Source table data:', sourceData);
    
    const primaryEntry = sourceData.find(row => row.primary === "Primary Wavelength");
    console.log('🎯 Primary entry:', primaryEntry);
  }
  
  // 屈折率更新関数が利用可能かチェック
  console.log('🔧 updateAllRefractiveIndices available:', typeof updateAllRefractiveIndices);
  
  // 実際に屈折率更新を実行
  if (typeof updateAllRefractiveIndices === 'function') {
    console.log('▶️ Calling updateAllRefractiveIndices...');
    updateAllRefractiveIndices();
  }
}

// Export functions to global scope (browser only)
if (typeof window !== 'undefined') {
  if (typeof getPrimaryWavelength === 'function') {
    window.getPrimaryWavelength = getPrimaryWavelength;
  }

  if (typeof notifyPrimaryWavelengthChanged === 'function') {
    window.notifyPrimaryWavelengthChanged = notifyPrimaryWavelengthChanged;
  }
}

// デバッグ用テスト関数をグローバルに公開（browser only）
if (typeof window !== 'undefined') {
  if (typeof testPrimaryWavelengthUpdate === 'function') {
    window.testPrimaryWavelengthUpdate = testPrimaryWavelengthUpdate;
  }
}