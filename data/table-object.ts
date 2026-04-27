// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

// データの保存・復元用キー
const STORAGE_KEY = "objectTableData";

interface ObjectRow {
  id: number;
  xHeightAngle: number | string;
  yHeightAngle: number | string;
  position: string;
  angle?: number | string;
}

interface RowWrapper {
  getData: () => ObjectRow;
  delete: () => void;
  select: () => void;
  _setSelected: (selected: boolean) => void;
}

interface CellEvent {
  getField: () => string;
  getValue: () => any;
  getRow: () => { getData: () => ObjectRow };
}

interface TableObjectAPI {
  on: (eventName: string, handler: (...args: any[]) => void) => void;
  getData: () => ObjectRow[];
  setData: (rows: ObjectRow[]) => Promise<void>;
  replaceData: (rows: ObjectRow[]) => Promise<void>;
  getDataCount: () => number;
  getRows: () => RowWrapper[];
  getSelectedRows: () => RowWrapper[];
  addRow: (row: Partial<ObjectRow>, top?: boolean, index?: number | null) => Promise<void>;
  deselectRow: () => void;
  _setColumnTitles: (xTitle: string, yTitle: string) => void;
  _applyGlobalPosition: (positionValue: string) => void;
  __cooptIsDom?: boolean;
  __cooptContainer?: HTMLElement | null;
  __cooptListenersBound?: boolean;
}

// 初期データ
const initialTableData: ObjectRow[] = [
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
export function loadTableData(): ObjectRow[] {
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
  return initialTableData;
}

// localStorage に実データがある場合のみ読み込む（無い場合は null）
// Migration/初期化判定に使う。デフォルト値 (initialTableData) を返さない点が重要。
export function tryLoadPersistedTableData(): ObjectRow[] | null {
  if (typeof localStorage === 'undefined' || !localStorage) {
    return null;
  }
  const json = localStorage.getItem(STORAGE_KEY);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// テーブルデータをローカルストレージに保存
export function saveTableData(data: ObjectRow[]): void {
  if (typeof localStorage === 'undefined' || !localStorage) {
    return;
  }
  if (data && Array.isArray(data)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } else {
    console.warn('⚠️ [TableObject] Invalid data, not saving:', data);
  }
}

// 行追加
export function addRow(data: ObjectRow[], newRow: ObjectRow): void {
  data.push(newRow);
}

// 行削除
export function deleteRow(data: ObjectRow[], rowId: number): void {
  const idx = data.findIndex(row => row.id === rowId);
  if (idx !== -1) data.splice(idx, 1);
}

// idを1から振り直す
export function renumberIds(data: ObjectRow[]): void {
  data.forEach((row, idx) => {
    row.id = idx + 1;
  });
}

// 初期データをローカルストレージから取得
const initialData = loadTableData();

const hasDocument = (typeof document !== 'undefined') && document && typeof document.getElementById === 'function';
const hasWindow = (typeof window !== 'undefined') && window;
let tableContainer = hasDocument ? document.getElementById('table-object') : null;

// 表の構成
export let tableObject: TableObjectAPI;

// ---- Pure DOM Object table (Tabulator-free) --------------------------------

const safeCloneRows = (rows: ObjectRow[]): ObjectRow[] => (Array.isArray(rows) ? rows.map(r => ({ ...r })) : []);

const createCellEvent = (field: string, value: any, rowData: ObjectRow): CellEvent => {
  const rowObj = {
    getData: () => ({ ...rowData }),
  };
  return {
    getField: () => field,
    getValue: () => value,
    getRow: () => rowObj,
  };
};

const normalizeNumberLike = (v: any): number | string => {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

const normalizeRow = (row: Partial<ObjectRow>, fallbackId: number): ObjectRow => {
  const normalized: any = { ...row };
  normalized.id = (normalized.id === '' || normalized.id == null) ? fallbackId : Number(normalized.id);
  if (Number.isNaN(normalized.id)) normalized.id = fallbackId;
  normalized.xHeightAngle = normalizeNumberLike(normalized.xHeightAngle);
  normalized.yHeightAngle = normalizeNumberLike(normalized.yHeightAngle);
  if (typeof normalized.position !== 'string') normalized.position = normalized.position ? String(normalized.position) : 'Angle';
  if (!normalized.position) normalized.position = 'Angle';
  // Spec: Position should be Angle, Rectangle, or ImageHeight. Migrate legacy Point -> Angle.
  if (normalized.position === 'Point') normalized.position = 'Angle';
  if (!['Angle', 'Rectangle', 'ImageHeight'].includes(normalized.position)) normalized.position = 'Angle';
  if (!('angle' in normalized)) normalized.angle = 0;
  return normalized as ObjectRow;
};

const createDOMTableObject = (container: HTMLElement | null, initialRows: ObjectRow[]): TableObjectAPI => {
  let data = safeCloneRows(initialRows);
  let selectedRowId: number | null = null;
  let rowWrappers: RowWrapper[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();

  let xTitle = 'X value';
  let yTitle = 'Y value';

  const on = (eventName: string, handler: (...args: any[]) => void): void => {
    if (!eventName || typeof handler !== 'function') return;
    if (!listeners.has(eventName)) listeners.set(eventName, []);
    listeners.get(eventName)!.push(handler);
  };

  const emit = (eventName: string, ...args: any[]): void => {
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

  const getData = (): ObjectRow[] => safeCloneRows(data);
  const getDataCount = (): number => data.length;
  const getRows = (): RowWrapper[] => rowWrappers.slice();

  const deselectRow = (): void => {
    selectedRowId = null;
    rowWrappers.forEach(w => w._setSelected(false));
  };

  const selectRowById = (rowId: number): void => {
    selectedRowId = rowId;
    rowWrappers.forEach(w => w._setSelected(Number(w.getData().id) === Number(rowId)));
  };

  const getSelectedRows = (): RowWrapper[] => {
    if (selectedRowId == null) return [];
    const w = rowWrappers.find(r => Number(r.getData().id) === Number(selectedRowId));
    return w ? [w] : [];
  };

  const setColumnTitles = (nextXTitle: string, nextYTitle: string): void => {
    if (typeof nextXTitle === 'string') xTitle = nextXTitle;
    if (typeof nextYTitle === 'string') yTitle = nextYTitle;
    rerender();
  };

  const applyGlobalPosition = (positionValue: string): void => {
    const rows = getData();
    rows.forEach(r => {
      r.position = positionValue;
      if (positionValue === 'Angle') {
        r.angle = (r.yHeightAngle === '' || r.yHeightAngle == null) ? '' : r.yHeightAngle;
      }
    });
    replaceData(rows);
  };

  const rerender = (): void => {
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

      const wrapper: RowWrapper = {
        getData: () => ({ ...rowData }),
        delete: () => {
          const index = data.findIndex(r => Number(r.id) === Number(rowData.id));
          if (index !== -1) {
            const deletedRow = JSON.parse(JSON.stringify(rowData));
            data.splice(index, 1);
            renumberIds(data);
            if (Number(selectedRowId) === Number(rowData.id)) selectedRowId = null;
            rerender();
            saveTableData(getData());
            
            // Record undo
            try {
              if (w.undoHistory && w.DeleteRowCommand && !w.undoHistory.isExecuting) {
                const cmd = new w.DeleteRowCommand('object', deletedRow, index);
                w.undoHistory.record(cmd);
              }
            } catch (e) {
            }
            
            emit('rowDeleted');
            emit('dataChanged');
          }
        },
        select: () => {
          deselectRow();
          selectRowById(rowData.id);
        },
        _setSelected: (selected: boolean) => {
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
        const oldValue = rowData.xHeightAngle;
        rowData.xHeightAngle = normalizeNumberLike(inputX.value);
        
        // Record undo command
        if (w.undoHistory && !w.undoHistory.isExecuting && oldValue !== rowData.xHeightAngle) {
          const cfg = w.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new w.SetObjectFieldCommand(
              cfg.id,
              rowData.id,
              'xHeightAngle',
              oldValue,
              rowData.xHeightAngle
            );
            w.undoHistory.record(cmd);
          }
        }
        
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
        const oldValue = rowData.yHeightAngle;
        rowData.yHeightAngle = normalizeNumberLike(inputY.value);
        if (rowData.position === 'Angle') {
          rowData.angle = rowData.yHeightAngle;
        }
        
        // Record undo command
        if (w.undoHistory && !w.undoHistory.isExecuting && oldValue !== rowData.yHeightAngle) {
          const cfg = w.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new w.SetObjectFieldCommand(
              cfg.id,
              rowData.id,
              'yHeightAngle',
              oldValue,
              rowData.yHeightAngle
            );
            w.undoHistory.record(cmd);
          }
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
      [['Angle', 'Angle'], ['Rectangle', 'Height Rect'], ['ImageHeight', 'Image Height']].forEach(([v, label]) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = label;
        selectPos.appendChild(opt);
      });
      selectPos.value = rowData.position;
      selectPos.style.width = '100%';
      selectPos.addEventListener('change', () => {
        const oldValue = rowData.position;
        rowData.position = selectPos.value;
        if (rowData.position === 'Angle') {
          rowData.angle = rowData.yHeightAngle;
        }
        
        // Record undo command
        if (w.undoHistory && !w.undoHistory.isExecuting && oldValue !== rowData.position) {
          const cfg = w.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new w.SetObjectFieldCommand(
              cfg.id,
              rowData.id,
              'position',
              oldValue,
              rowData.position
            );
            w.undoHistory.record(cmd);
          }
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

  const replaceData = (rows: ObjectRow[]): Promise<void> => {
    data = safeCloneRows(rows).map((r, idx) => normalizeRow(r, idx + 1));
    renumberIds(data);
    rerender();
    saveTableData(getData());
    emit('dataChanged');
    return Promise.resolve();
  };

  const setData = (rows: ObjectRow[]): Promise<void> => replaceData(rows);

  const addRowAt = (row: Partial<ObjectRow>, _top: boolean = false, index: number | null = null): Promise<void> => {
    const insertIndex = (typeof index === 'number' && index >= 0) ? index : data.length;
    const next = normalizeRow(row, data.length + 1);
    data.splice(insertIndex, 0, next);
    renumberIds(data);
    rerender();
    saveTableData(getData());
    
    // Record undo
    try {
      if (w.undoHistory && w.AddRowCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.AddRowCommand('object', JSON.parse(JSON.stringify(next)), insertIndex);
        w.undoHistory.record(cmd);
      }
    } catch (e) {
    }
    
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

const createNoopObjectTable = (initialRows: ObjectRow[]): TableObjectAPI => {
  let data = safeCloneRows(initialRows);
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const on = (eventName: string, handler: (...args: any[]) => void): void => {
    if (!eventName || typeof handler !== 'function') return;
    if (!listeners.has(eventName)) listeners.set(eventName, []);
    listeners.get(eventName)!.push(handler);
  };
  const emit = (eventName: string, ...args: any[]): void => {
    const handlers = listeners.get(eventName);
    if (!handlers) return;
    handlers.forEach(fn => { try { fn(...args); } catch (_) {} });
  };
  const getData = (): ObjectRow[] => safeCloneRows(data);
  const replaceData = (rows: ObjectRow[]): Promise<void> => { data = safeCloneRows(rows); emit('dataChanged'); return Promise.resolve(); };
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
tableObject.__cooptIsDom = !!tableContainer;
tableObject.__cooptContainer = tableContainer;

if (hasWindow) {
  w.tableObject = tableObject;
  w.objectTabulator = tableObject; // legacy name
  w.objectTable = tableObject;
}

if (tableContainer) {
  // Back-compat: some code probes the element for .tabulator
  (tableContainer as any).tabulator = tableObject;
}

const attachObjectTableListeners = (): void => {
  if (!tableObject || typeof tableObject.on !== 'function') return;
  if (tableObject.__cooptListenersBound) return;
  tableObject.__cooptListenersBound = true;

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
};

const bindObjectControls = (): void => {
  if (!hasDocument) return;
  const addObjectBtn = document.getElementById("add-object-btn");
  if (addObjectBtn && (addObjectBtn as any).dataset.cooptBound !== '1') {
    (addObjectBtn as any).dataset.cooptBound = '1';
    addObjectBtn.addEventListener("click", function(){
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
  }

  const deleteObjectBtn = document.getElementById("delete-object-btn");
  if (deleteObjectBtn && (deleteObjectBtn as any).dataset.cooptBound !== '1') {
    (deleteObjectBtn as any).dataset.cooptBound = '1';
    deleteObjectBtn.addEventListener("click", function(){
      if (!tableObject || typeof tableObject.getSelectedRows !== 'function') return;
      const selectedRows = tableObject.getSelectedRows();
      if (selectedRows.length > 0 && selectedRows[0] && typeof selectedRows[0].delete === 'function') {
        selectedRows[0].delete();
      } else {
        alert("削除する行を選択してください。");
      }
    });
  }

  const objectAngleBtn = document.getElementById("object-angle-btn");
  if (objectAngleBtn && (objectAngleBtn as any).dataset.cooptBound !== '1') {
    (objectAngleBtn as any).dataset.cooptBound = '1';
    objectAngleBtn.addEventListener("click", setAngleTitles);
  }
  const objectHeightRectBtn = document.getElementById("object-height-rect-btn");
  if (objectHeightRectBtn && (objectHeightRectBtn as any).dataset.cooptBound !== '1') {
    (objectHeightRectBtn as any).dataset.cooptBound = '1';
    objectHeightRectBtn.addEventListener("click", setHeightRectTitles);
  }
  const objectImageHeightBtn = document.getElementById("object-image-height-btn");
  if (objectImageHeightBtn && (objectImageHeightBtn as any).dataset.cooptBound !== '1') {
    (objectImageHeightBtn as any).dataset.cooptBound = '1';
    objectImageHeightBtn.addEventListener("click", setImageHeightTitles);
  }
};

// タイトル変更用関数
function setAngleTitles(): void {
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

function setHeightRectTitles(): void {
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

function setImageHeightTitles(): void {
  if (!tableObject) return;
  try {
    if (typeof tableObject._setColumnTitles === 'function') {
      tableObject._setColumnTitles('X image height (mm)', 'Y image height (mm)');
    }
    if (typeof tableObject._applyGlobalPosition === 'function') {
      tableObject._applyGlobalPosition('ImageHeight');
    }
  } catch (_) {}
}

// PSF選択肢更新機能
function updatePSFObjectSelectIfAvailable(): void {
  // main.jsでPSF機能が利用可能かチェック
  if (typeof w.updatePSFObjectSelect === 'function') {
    w.updatePSFObjectSelect();
  }
}

attachObjectTableListeners();

/**
 * 波面収差図のObject選択オプションを更新（安全版）
 */
function updateWavefrontObjectOptionsIfAvailable(): void {
  try {
    if (typeof w.updateWavefrontObjectSelect === 'function') {
      w.updateWavefrontObjectSelect();
    }
  } catch (error) {
    console.debug('波面収差図Object選択更新スキップ（関数未定義）');
  }
}

/**
 * Image面のSemi Dia自動計算を再実行（optimizeSemiDia="A"の場合）
 */
function recalculateAutoSemiDiaIfAvailable(): void {
  try {
    if (typeof w.autoSetBlockAperturesFromLargestObjectCondition === 'function') {
      w.autoSetBlockAperturesFromLargestObjectCondition();
    }
    if (typeof w.calculateImageSemiDiaFromChiefRays === 'function') {
      w.calculateImageSemiDiaFromChiefRays();
    }
  } catch (error: any) {
    console.debug('Semi Dia自動計算スキップ:', error.message);
  }
}

bindObjectControls();

export function mountTableObjectIfReady(): boolean {
  if (!hasDocument) return false;
  tableContainer = document.getElementById('table-object');
  if (!tableContainer) return false;
  if (tableObject && tableObject.__cooptIsDom && tableObject.__cooptContainer === tableContainer) {
    bindObjectControls();
    attachObjectTableListeners();
    return true;
  }
  const rows = (tableObject && typeof tableObject.getData === 'function') ? tableObject.getData() : safeCloneRows(initialData);
  tableObject = createDOMTableObject(tableContainer, rows);
  tableObject.__cooptIsDom = true;
  tableObject.__cooptContainer = tableContainer;
  try { (tableContainer as any).tabulator = tableObject; } catch (_) {}
  if (hasWindow) {
    w.tableObject = tableObject;
    w.objectTabulator = tableObject;
    w.objectTable = tableObject;
  }
  attachObjectTableListeners();
  bindObjectControls();
  return true;
}

if (hasDocument && !tableContainer && hasWindow) {
  window.addEventListener('coopt:react-mounted', () => {
    try { mountTableObjectIfReady(); } catch (_) {}
  }, { once: true });
  setTimeout(() => {
    try { mountTableObjectIfReady(); } catch (_) {}
  }, 0);
}
