// データの保存・復元用キー
const STORAGE_KEY = "objectTableData";

// 初期データ
const initialTableData = [
  {
    id: 1,
    xHeightAngle: 0,
    yHeightAngle: 0,
    position: "Rectangle",
    angle: 0
  },
  {
    id: 2,
    xHeightAngle: 0,
    yHeightAngle: 5,
    position: "Rectangle",
    angle: 5
  },
  {
    id: 3,
    xHeightAngle: 0,
    yHeightAngle: 10,
    position: "Rectangle",
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
      console.warn('⚠️ [TableObject] Parse error:', e);
      console.warn("保存データの読み込みに失敗しました。初期データを使用します。");
    }
  }
  console.log('🔵 [TableObject] Using initial data, length:', initialTableData.length);
  return initialTableData;
}

// テーブルデータをローカルストレージに保存
export function saveTableData(data) {
  console.log('🔵 [TableObject] Saving data to localStorage...');
  console.log('🔵 [TableObject] Data is array:', Array.isArray(data));
  console.log('🔵 [TableObject] Data length:', data ? data.length : 'null');
  if (typeof localStorage === 'undefined' || !localStorage) {
    console.log('🔵 [TableObject] localStorage unavailable; skipping save');
    return;
  }
  if (data && Array.isArray(data)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    console.log(`💾 [TableObject] Saved ${data.length} entries to localStorage key: ${STORAGE_KEY}`);
    // Verify save
    const verify = localStorage.getItem(STORAGE_KEY);
    console.log('🔵 [TableObject] Verification - data saved:', !!verify);
  } else {
    console.warn('⚠️ [TableObject] Invalid data, not saving:', data);
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

// 初期データをローカルストレージから取得
const initialData = loadTableData();

const hasDocument = (typeof document !== 'undefined') && document && typeof document.getElementById === 'function';
const hasWindow = (typeof window !== 'undefined') && window;
const tableContainer = hasDocument ? document.getElementById('table-object') : null;

// 表の構成
export let tableObject;

// ---- Pure DOM Object table (Tabulator-free) --------------------------------

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

const normalizeNumberLike = (v) => {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

const normalizeRow = (row, fallbackId) => {
  const normalized = { ...row };
  normalized.id = (normalized.id === '' || normalized.id == null) ? fallbackId : Number(normalized.id);
  if (Number.isNaN(normalized.id)) normalized.id = fallbackId;
  normalized.xHeightAngle = normalizeNumberLike(normalized.xHeightAngle);
  normalized.yHeightAngle = normalizeNumberLike(normalized.yHeightAngle);
  if (typeof normalized.position !== 'string') normalized.position = normalized.position ? String(normalized.position) : 'Angle';
  if (!normalized.position) normalized.position = 'Angle';
  // Spec: Position should be Angle or Rectangle only. Migrate legacy Point -> Angle.
  if (normalized.position === 'Point') normalized.position = 'Angle';
  if (!('angle' in normalized)) normalized.angle = 0;
  return normalized;
};

const createDOMTableObject = (container, initialRows) => {
  let data = safeCloneRows(initialRows);
  let selectedRowId = null;
  let rowWrappers = [];
  const listeners = new Map();

  let xTitle = 'X value';
  let yTitle = 'Y value';

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
        console.debug('⚠️ [TableObject] listener error:', e);
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
    rowWrappers.forEach(w => w._setSelected(Number(w.getData().id) === Number(rowId)));
  };

  const getSelectedRows = () => {
    if (selectedRowId == null) return [];
    const w = rowWrappers.find(r => Number(r.getData().id) === Number(selectedRowId));
    return w ? [w] : [];
  };

  const setColumnTitles = (nextXTitle, nextYTitle) => {
    if (typeof nextXTitle === 'string') xTitle = nextXTitle;
    if (typeof nextYTitle === 'string') yTitle = nextYTitle;
    rerender();
  };

  const applyGlobalPosition = (positionValue) => {
    const rows = getData();
    rows.forEach(r => {
      r.position = positionValue;
      if (positionValue === 'Angle') {
        r.angle = (r.yHeightAngle === '' || r.yHeightAngle == null) ? '' : r.yHeightAngle;
      }
    });
    replaceData(rows);
  };

  const rerender = () => {
    if (!container) return;
    container.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'glass-search-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['Object', xTitle, yTitle, 'Position'];
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
      if (Number(rowData.id) === Number(selectedRowId)) tr.classList.add('selected');

      const wrapper = {
        getData: () => ({ ...rowData }),
        delete: () => {
          const index = data.findIndex(r => Number(r.id) === Number(rowData.id));
          if (index !== -1) {
            data.splice(index, 1);
            renumberIds(data);
            if (Number(selectedRowId) === Number(rowData.id)) selectedRowId = null;
            rerender();
            saveTableData(getData());
            emit('rowDeleted');
            emit('dataChanged');
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

      // xHeightAngle
      const tdX = document.createElement('td');
      const inputX = document.createElement('input');
      inputX.type = 'text';
      inputX.value = (rowData.xHeightAngle ?? '') === 0 ? '0' : (rowData.xHeightAngle ?? '').toString();
      inputX.style.width = '100%';
      inputX.addEventListener('change', () => {
        rowData.xHeightAngle = normalizeNumberLike(inputX.value);
        saveTableData(getData());
        emit('cellEdited', createCellEvent('xHeightAngle', rowData.xHeightAngle, rowData));
        emit('dataChanged');
      });
      tdX.appendChild(inputX);
      tr.appendChild(tdX);

      // yHeightAngle
      const tdY = document.createElement('td');
      const inputY = document.createElement('input');
      inputY.type = 'text';
      inputY.value = (rowData.yHeightAngle ?? '') === 0 ? '0' : (rowData.yHeightAngle ?? '').toString();
      inputY.style.width = '100%';
      inputY.addEventListener('change', () => {
        rowData.yHeightAngle = normalizeNumberLike(inputY.value);
        if (rowData.position === 'Angle') {
          rowData.angle = rowData.yHeightAngle;
        }
        saveTableData(getData());
        emit('cellEdited', createCellEvent('yHeightAngle', rowData.yHeightAngle, rowData));
        emit('dataChanged');
      });
      tdY.appendChild(inputY);
      tr.appendChild(tdY);

      // position
      const tdPos = document.createElement('td');
      const selectPos = document.createElement('select');
      ['Angle', 'Rectangle'].forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        selectPos.appendChild(opt);
      });
      selectPos.value = rowData.position;
      selectPos.style.width = '100%';
      selectPos.addEventListener('change', () => {
        rowData.position = selectPos.value;
        if (rowData.position === 'Angle') {
          rowData.angle = rowData.yHeightAngle;
        }
        saveTableData(getData());
        emit('cellEdited', createCellEvent('position', rowData.position, rowData));
        emit('dataChanged');
      });
      tdPos.appendChild(selectPos);
      tr.appendChild(tdPos);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  };

  const replaceData = (rows) => {
    data = safeCloneRows(rows).map((r, idx) => normalizeRow(r, idx + 1));
    renumberIds(data);
    rerender();
    saveTableData(getData());
    emit('dataChanged');
    return Promise.resolve();
  };

  const setData = (rows) => replaceData(rows);

  const addRowAt = (row, _top = false, index = null) => {
    const insertIndex = (typeof index === 'number' && index >= 0) ? index : data.length;
    const next = normalizeRow(row, data.length + 1);
    data.splice(insertIndex, 0, next);
    renumberIds(data);
    rerender();
    saveTableData(getData());
    emit('rowAdded');
    emit('dataChanged');
    return Promise.resolve();
  };

  // Initial render
  rerender();

  return {
    on,
    getData,
    setData,
    replaceData,
    getDataCount,
    getRows,
    getSelectedRows,
    addRow: addRowAt,
    deselectRow,
    _setColumnTitles: setColumnTitles,
    _applyGlobalPosition: applyGlobalPosition,
  };
};

const createNoopObjectTable = (initialRows) => {
  let data = safeCloneRows(initialRows);
  const listeners = new Map();
  const on = (eventName, handler) => {
    if (!eventName || typeof handler !== 'function') return;
    if (!listeners.has(eventName)) listeners.set(eventName, []);
    listeners.get(eventName).push(handler);
  };
  const emit = (eventName, ...args) => {
    const handlers = listeners.get(eventName);
    if (!handlers) return;
    handlers.forEach(fn => { try { fn(...args); } catch (_) {} });
  };
  const getData = () => safeCloneRows(data);
  const replaceData = (rows) => { data = safeCloneRows(rows); emit('dataChanged'); return Promise.resolve(); };
  return {
    on,
    getData,
    setData: replaceData,
    replaceData,
    getDataCount: () => data.length,
    getRows: () => [],
    getSelectedRows: () => [],
    addRow: () => Promise.resolve(),
    deselectRow: () => {},
    _setColumnTitles: () => {},
    _applyGlobalPosition: () => {},
  };
};

tableObject = tableContainer
  ? createDOMTableObject(tableContainer, initialData)
  : createNoopObjectTable(initialData);

if (hasWindow) {
  window.tableObject = tableObject;
  window.objectTabulator = tableObject; // legacy name
  window.objectTable = tableObject;
}

if (tableContainer) {
  // Back-compat: some code probes the element for .tabulator
  tableContainer.tabulator = tableObject;
}

// 行追加
const addObjectBtn = hasDocument ? document.getElementById("add-object-btn") : null;
if (addObjectBtn) addObjectBtn.addEventListener("click", function(){
  if (!tableObject || typeof tableObject.addRow !== 'function') return;

  const selectedRows = (typeof tableObject.getSelectedRows === 'function') ? tableObject.getSelectedRows() : [];
  let insertIndex = (typeof tableObject.getDataCount === 'function') ? tableObject.getDataCount() : 0;
  if (selectedRows.length > 0 && typeof tableObject.getRows === 'function') {
    const selectedRow = selectedRows[0];
    insertIndex = tableObject.getRows().indexOf(selectedRow) + 1;
    if (!Number.isFinite(insertIndex) || insertIndex < 0) insertIndex = (typeof tableObject.getDataCount === 'function') ? tableObject.getDataCount() : 0;
  }

  Promise.resolve(tableObject.addRow({
    id: (typeof tableObject.getDataCount === 'function') ? (tableObject.getDataCount() + 1) : 1,
    xHeightAngle: "",
    yHeightAngle: "",
    position: "Angle"
  }, false, insertIndex)).catch(() => {});
});

// 行削除
const deleteObjectBtn = hasDocument ? document.getElementById("delete-object-btn") : null;
if (deleteObjectBtn) deleteObjectBtn.addEventListener("click", function(){
  if (!tableObject || typeof tableObject.getSelectedRows !== 'function') return;
  const selectedRows = tableObject.getSelectedRows();
  if (selectedRows.length > 0 && selectedRows[0] && typeof selectedRows[0].delete === 'function') {
    selectedRows[0].delete();
  } else {
    alert("削除する行を選択してください。");
  }
});

// タイトル変更用関数
function setAngleTitles() {
  if (!tableObject) return;
  try {
    if (typeof tableObject._setColumnTitles === 'function') {
      tableObject._setColumnTitles('X angle (deg)', 'Y angle (deg)');
    }
    if (typeof tableObject._applyGlobalPosition === 'function') {
      tableObject._applyGlobalPosition('Angle');
    }
  } catch (_) {}
}

// function setHeightCircleTitles() {
//   tableObject.getColumn("xHeightAngle").updateDefinition({ title: "X height circle (mm)" });
//   tableObject.getColumn("yHeightAngle").updateDefinition({ title: "Y height circle (mm)" });
//   // すべての行のpositionを"Circle"にする
//   const data = tableObject.getData();
//   data.forEach(row => {
//     row.position = "Circle";
//   });
//   tableObject.replaceData(data);
//   saveTableData(data);

// }

function setHeightRectTitles() {
  if (!tableObject) return;
  try {
    if (typeof tableObject._setColumnTitles === 'function') {
      tableObject._setColumnTitles('X height rect (mm)', 'Y height rect (mm)');
    }
    if (typeof tableObject._applyGlobalPosition === 'function') {
      tableObject._applyGlobalPosition('Rectangle');
    }
  } catch (_) {}
}

// PSF選択肢更新機能
function updatePSFObjectSelectIfAvailable() {
  // main.jsでPSF機能が利用可能かチェック
  if (typeof window.updatePSFObjectSelect === 'function') {
    window.updatePSFObjectSelect();
  }
}

// テーブルデータ変更時のコールバック
if (tableObject && typeof tableObject.on === 'function') {
  tableObject.on("dataChanged", function() {
    updatePSFObjectSelectIfAvailable();
    updateWavefrontObjectOptionsIfAvailable();
  });

  tableObject.on("rowAdded", function() {
    updatePSFObjectSelectIfAvailable();
    updateWavefrontObjectOptionsIfAvailable();
  });

  tableObject.on("rowDeleted", function() {
    updatePSFObjectSelectIfAvailable();
    updateWavefrontObjectOptionsIfAvailable();
  });

  tableObject.on("cellEdited", function() {
    updatePSFObjectSelectIfAvailable();
    updateWavefrontObjectOptionsIfAvailable();
    recalculateAutoSemiDiaIfAvailable();
  });
}

/**
 * 波面収差図のObject選択オプションを更新（安全版）
 */
function updateWavefrontObjectOptionsIfAvailable() {
  try {
    if (typeof window.updateWavefrontObjectSelect === 'function') {
      window.updateWavefrontObjectSelect();
    }
  } catch (error) {
    console.debug('波面収差図Object選択更新スキップ（関数未定義）');
  }
}

/**
 * Image面のSemi Dia自動計算を再実行（optimizeSemiDia="A"の場合）
 */
function recalculateAutoSemiDiaIfAvailable() {
  try {
    if (typeof window.calculateImageSemiDiaFromChiefRays === 'function') {
      console.log('🔄 Object変更検知: Image面のSemi Dia自動計算を再実行');
      window.calculateImageSemiDiaFromChiefRays();
    }
  } catch (error) {
    console.debug('Semi Dia自動計算スキップ:', error.message);
  }
}

// ボタンイベント
const objectAngleBtn = hasDocument ? document.getElementById("object-angle-btn") : null;
if (objectAngleBtn) objectAngleBtn.addEventListener("click", setAngleTitles);
// const objectHeightCircleBtn = hasDocument ? document.getElementById("object-height-circle-btn") : null;
// if (objectHeightCircleBtn) objectHeightCircleBtn.addEventListener("click", setHeightCircleTitles);
const objectHeightRectBtn = hasDocument ? document.getElementById("object-height-rect-btn") : null;
if (objectHeightRectBtn) objectHeightRectBtn.addEventListener("click", setHeightRectTitles);
