// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

import { getOrCreateCooptWindowSyncSenderId } from '../core/window-facade.ts';

// メモ　物体高だけでなく画角も扱えるようにする

interface SourceRow {
  id: number;
  wavelength: number | string;
  weight: number | string;
  primary: string;
  angle?: number;
}

interface RowWrapper {
  getData: () => SourceRow;
  delete: () => void;
  select: () => void;
  _setSelected: (selected: boolean) => void;
}

interface CellEvent {
  getField: () => string;
  getValue: () => any;
  getRow: () => { getData: () => SourceRow };
}

interface TableSourceAPI {
  on: (eventName: string, handler: (...args: any[]) => void) => void;
  getData: () => SourceRow[];
  setData: (rows: SourceRow[]) => Promise<void>;
  replaceData: (rows: SourceRow[]) => Promise<void>;
  getDataCount: () => number;
  getSelectedRows: () => RowWrapper[];
  getRows: () => RowWrapper[];
  addRow: (row: Partial<SourceRow>, addToTop?: boolean, position?: number | RowWrapper | null) => Promise<void>;
  deselectRow: () => void;
  redraw: () => void;
  blockRedraw: () => void;
  restoreRedraw: () => void;
  __cooptIsDom?: boolean;
  __cooptContainer?: HTMLElement;
}

// 初期データ (g-C線の色収差評価用)
const initialTableData: SourceRow[] = [
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

// データの保存・復元用キー
const STORAGE_KEY = "sourceTableData";

// ローカルストレージからデータを取得
export function loadTableData(): SourceRow[] {
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

// localStorage に実データがある場合のみ読み込む（無い場合は null）
// Migration/初期化判定に使う。デフォルト値 (initialTableData) を返さない点が重要。
export function tryLoadPersistedTableData(): SourceRow[] | null {
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
export function saveTableData(data: SourceRow[]): void {
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
export function addRow(data: SourceRow[], newRow: SourceRow): void {
  data.push(newRow);
}

// 行削除
export function deleteRow(data: SourceRow[], rowId: number): void {
  const idx = data.findIndex(row => row.id === rowId);
  if (idx !== -1) data.splice(idx, 1);
}

// idを1から振り直す
export function renumberIds(data: SourceRow[]): void {
  data.forEach((row, idx) => {
    row.id = idx + 1;
  });
}

// 初期データをローカルストレージから取得
const initialData = loadTableData();

const hasDocument = (typeof document !== 'undefined') && document && typeof document.getElementById === 'function';
let tableContainer = hasDocument ? document.getElementById('table-source') : null;

// 表の構成
export let tableSource: TableSourceAPI;

// ---- Pure DOM Source table (Tabulator-free) --------------------------------

const safeCloneRows = (rows: SourceRow[]): SourceRow[] => (Array.isArray(rows) ? rows.map(r => ({ ...r })) : []);

const createCellEvent = (field: string, value: any, rowData: SourceRow): CellEvent => {
  const rowObj = {
    getData: () => ({ ...rowData }),
  };
  return {
    getField: () => field,
    getValue: () => value,
    getRow: () => rowObj,
  };
};

const createDOMTableSource = (container: HTMLElement | null, initialRows: SourceRow[]): TableSourceAPI => {
  let data = safeCloneRows(initialRows);
  let selectedRowId: number | null = null;
  let draggedSourceRowId: string | null = null;
  let rowWrappers: RowWrapper[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();

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
        console.debug('⚠️ [TableSource] listener error:', e);
      }
    });
  };

  const normalizePrimarySelection = (): void => {
    const primaryIndices = data
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row?.primary === 'Primary Wavelength')
      .map(({ index }) => index);

    if (primaryIndices.length <= 1) return;

    const keepIndex = primaryIndices[primaryIndices.length - 1];
    data.forEach((row, index) => {
      if (!row) return;
      row.primary = index === keepIndex ? 'Primary Wavelength' : '';
    });
  };

  const syncDataFromDom = (): void => {
    if (!container) return;
    const bodyRows = Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
    if (bodyRows.length === 0) return;

    bodyRows.forEach((tr, index) => {
      const rowData = data[index];
      if (!rowData) return;

      const cells = tr.querySelectorAll('td');
      const wavelengthInput = cells[1]?.querySelector('input') as HTMLInputElement | null;
      const weightInput = cells[2]?.querySelector('input') as HTMLInputElement | null;
      const primaryRadio = cells[3]?.querySelector('input[type="radio"]') as HTMLInputElement | null;

      if (wavelengthInput) {
        const raw = wavelengthInput.value;
        rowData.wavelength = raw === '' ? '' : Number(raw);
        if (raw !== '' && Number.isNaN(rowData.wavelength as number)) rowData.wavelength = raw;
      }

      if (weightInput) {
        const raw = weightInput.value;
        rowData.weight = raw === '' ? '' : Number(raw);
        if (raw !== '' && Number.isNaN(rowData.weight as number)) rowData.weight = raw;
      }

      if (primaryRadio) {
        rowData.primary = primaryRadio.checked ? 'Primary Wavelength' : '';
      }
    });

    normalizePrimarySelection();
  };

  const getData = (): SourceRow[] => {
    syncDataFromDom();
    return safeCloneRows(data);
  };

  const getDataCount = (): number => data.length;

  const getRows = (): RowWrapper[] => rowWrappers.slice();

  const deselectRow = (): void => {
    selectedRowId = null;
    rowWrappers.forEach(w => w._setSelected(false));
  };

  const selectRowById = (rowId: number): void => {
    selectedRowId = rowId;
    rowWrappers.forEach(w => w._setSelected(w.getData().id === rowId));
  };

  const getSelectedRows = (): RowWrapper[] => {
    if (selectedRowId == null) return [];
    const w = rowWrappers.find(r => r.getData().id === selectedRowId);
    return w ? [w] : [];
  };

  const clearDropIndicator = (rowEl: HTMLTableRowElement | null): void => {
    if (!rowEl) return;
    rowEl.style.boxShadow = '';
  };

  const moveSourceRow = (fromId: string, toId: string, position: 'before' | 'after'): void => {
    const beforeRows = getData();
    if (!Array.isArray(beforeRows) || beforeRows.length < 2) return;

    const fromIndex = beforeRows.findIndex(row => String(row?.id) === String(fromId));
    const toIndex = beforeRows.findIndex(row => String(row?.id) === String(toId));
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const afterRows = beforeRows.slice();
    const [movedRow] = afterRows.splice(fromIndex, 1);
    if (!movedRow) return;

    let insertIndex = toIndex;
    if (position === 'after') insertIndex += 1;
    if (fromIndex < insertIndex) insertIndex -= 1;
    insertIndex = Math.max(0, Math.min(afterRows.length, insertIndex));
    afterRows.splice(insertIndex, 0, movedRow);

    const selectedRow = selectedRowId == null
      ? null
      : afterRows.find(row => String(row?.id) === String(selectedRowId)) || null;

    afterRows.forEach((row, index) => {
      if (row && typeof row === 'object') row.id = index + 1;
    });

    try {
      if (w.undoHistory && w.ReorderTableRowsCommand && !w.undoHistory.isExecuting) {
        const command = new w.ReorderTableRowsCommand('source', beforeRows, afterRows);
        w.undoHistory.record(command);
      }
    } catch (_) {}

    data = safeCloneRows(afterRows);
    selectedRowId = selectedRow ? Number(selectedRow.id) : null;
    rerender();
    saveTableData(getData());
  };

  const normalizeRow = (row: Partial<SourceRow>, fallbackId: number): SourceRow => {
    const normalized: any = { ...row };
    normalized.id = (normalized.id === '' || normalized.id == null)
      ? fallbackId
      : Number(normalized.id);
    if (Number.isNaN(normalized.id)) normalized.id = fallbackId;
    if (typeof normalized.primary !== 'string') normalized.primary = normalized.primary ? String(normalized.primary) : '';
    if (!('angle' in normalized)) normalized.angle = 0;
    if (!('wavelength' in normalized)) normalized.wavelength = '';
    if (!('weight' in normalized)) normalized.weight = '';
    return normalized as SourceRow;
  };

  const rerender = (): void => {
    if (!container) return;
    normalizePrimarySelection();
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

      const wrapper: RowWrapper = {
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
              if (w.undoHistory && w.DeleteRowCommand && !w.undoHistory.isExecuting) {
                const cmd = new w.DeleteRowCommand('source', deletedRow, index);
                w.undoHistory.record(cmd);
              }
            } catch (e) {
            }
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

      if (data.length > 1) {
        tr.addEventListener('dragover', (e: DragEvent) => {
          if (!draggedSourceRowId || draggedSourceRowId === String(rowData.id)) return;
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
          clearDropIndicator(tr);
        });

        tr.addEventListener('drop', (e: DragEvent) => {
          if (!draggedSourceRowId || draggedSourceRowId === String(rowData.id)) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = tr.getBoundingClientRect();
          const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          clearDropIndicator(tr);
          moveSourceRow(draggedSourceRowId, String(rowData.id), position);
        });
      }

      // id
      const tdId = document.createElement('td');
      const idWrap = document.createElement('div');
      idWrap.style.display = 'flex';
      idWrap.style.alignItems = 'center';
      idWrap.style.gap = '6px';

      const dragHandle = document.createElement('span');
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to reorder';
      dragHandle.className = 'glass-search-drag-handle';
      dragHandle.draggable = data.length > 1;

      const idLabel = document.createElement('span');
      idLabel.textContent = String(rowData.id ?? '');

      idWrap.appendChild(dragHandle);
      idWrap.appendChild(idLabel);
      tdId.appendChild(idWrap);
      tr.appendChild(tdId);

      if (data.length > 1) {
        dragHandle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        dragHandle.addEventListener('dragstart', (e: DragEvent) => {
          draggedSourceRowId = String(rowData.id);
          tr.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(rowData.id));
          }
          e.stopPropagation();
        });

        dragHandle.addEventListener('dragend', () => {
          draggedSourceRowId = null;
          tr.classList.remove('dragging');
          clearDropIndicator(tr);
        });
      }

      // wavelength
      const tdWl = document.createElement('td');
      const inputWl = document.createElement('input');
      inputWl.type = 'text';
      inputWl.value = (rowData.wavelength ?? '') === 0 ? '0' : (rowData.wavelength ?? '').toString();
      inputWl.style.width = '100%';
      let lastCommittedWavelength = rowData.wavelength;
      let primaryWavelengthPreviewTimer: number | null = null;
      const syncEditingWavelengthValue = (): void => {
        const raw = inputWl.value;
        rowData.wavelength = raw === '' ? '' : Number(raw);
        if (raw !== '' && Number.isNaN(rowData.wavelength as number)) rowData.wavelength = raw;
      };
      const commitWavelengthChange = () => {
        const oldValue = lastCommittedWavelength;
        syncEditingWavelengthValue();

        // Record undo command
        if (w.undoHistory && !w.undoHistory.isExecuting && oldValue !== rowData.wavelength) {
          const cfg = w.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new w.SetSourceFieldCommand(
              cfg.id,
              rowData.id,
              'wavelength',
              oldValue,
              rowData.wavelength
            );
            w.undoHistory.record(cmd);
          }
        }

        saveTableData(getData());
        emit('cellEdited', createCellEvent('wavelength', rowData.wavelength, rowData));
        lastCommittedWavelength = rowData.wavelength;

        if (rowData.primary === 'Primary Wavelength') {
          notifyPrimaryWavelengthChanged();
        }
      };
      inputWl.addEventListener('input', () => {
        syncEditingWavelengthValue();
        if (rowData.primary !== 'Primary Wavelength') return;
        if (primaryWavelengthPreviewTimer !== null) {
          window.clearTimeout(primaryWavelengthPreviewTimer);
        }
        primaryWavelengthPreviewTimer = window.setTimeout(() => {
          primaryWavelengthPreviewTimer = null;
          notifyPrimaryWavelengthChanged();
        }, 80);
      });
      inputWl.addEventListener('change', commitWavelengthChange);
      inputWl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        inputWl.blur();
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
        if (raw !== '' && Number.isNaN(rowData.weight as number)) rowData.weight = raw;

        // Record undo command
        if (w.undoHistory && !w.undoHistory.isExecuting && oldValue !== rowData.weight) {
          const cfg = w.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new w.SetSourceFieldCommand(
              cfg.id,
              rowData.id,
              'weight',
              oldValue,
              rowData.weight
            );
            w.undoHistory.record(cmd);
          }
        }

        saveTableData(getData());
        emit('cellEdited', createCellEvent('weight', rowData.weight, rowData));
      });
      tdWeight.appendChild(inputWeight);
      tr.appendChild(tdWeight);

      // primary
      const tdPrimary = document.createElement('td');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'source-primary-wavelength';
      radio.checked = rowData.primary === 'Primary Wavelength';
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const oldValue = rowData.primary;
        data.forEach(r => {
          if (Number(r.id) === Number(rowData.id)) r.primary = 'Primary Wavelength';
          else r.primary = '';
        });
        notifyPrimaryWavelengthChanged();

        // Record undo command
        if (w.undoHistory && !w.undoHistory.isExecuting && oldValue !== rowData.primary) {
          const cfg = w.getActiveConfiguration?.();
          if (cfg) {
            const cmd = new w.SetSourceFieldCommand(
              cfg.id,
              rowData.id,
              'primary',
              oldValue,
              rowData.primary
            );
            w.undoHistory.record(cmd);
          }
        }

        saveTableData(getData());
        rerender();
        emit('cellEdited', createCellEvent('primary', rowData.primary, rowData));
      });
      tdPrimary.appendChild(radio);
      tr.appendChild(tdPrimary);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  };

  const replaceData = async (rows: SourceRow[]): Promise<void> => {
    data = safeCloneRows(rows);
    // Keep ids as-is; callers may intentionally preserve them.
    rerender();
    return Promise.resolve();
  };

  const setData = async (rows: SourceRow[]): Promise<void> => replaceData(rows);

  const addRowFn = (row: Partial<SourceRow> | undefined, _addToTop: boolean = false, position: number | RowWrapper | null = null): Promise<void> => {
    const newRow = normalizeRow(row || {}, data.length + 1);

    let insertIndex = data.length;
    if (typeof position === 'number' && Number.isFinite(position)) {
      insertIndex = Math.max(0, Math.min(data.length, Math.floor(position)));
    } else if (position && typeof (position as RowWrapper).getData === 'function') {
      const posId = (position as RowWrapper).getData()?.id;
      const idx = data.findIndex(r => Number(r.id) === Number(posId));
      if (idx !== -1) insertIndex = idx + 1;
    }

    data.splice(insertIndex, 0, newRow);
    renumberIds(data);
    rerender();
    saveTableData(getData());
    
    // Record undo
    try {
      if (w.undoHistory && w.AddRowCommand && !w.undoHistory.isExecuting) {
        const cmd = new w.AddRowCommand('source', JSON.parse(JSON.stringify(newRow)), insertIndex);
        w.undoHistory.record(cmd);
      }
    } catch (e) {
    }
    
    return Promise.resolve();
  };

  rerender();

  const api: TableSourceAPI = {
    on,
    getData,
    setData,
    replaceData,
    getDataCount,
    getSelectedRows,
    getRows,
    addRow: addRowFn,
    deselectRow,
    redraw: () => {},
    blockRedraw: () => {},
    restoreRedraw: () => {},
  };

  // Back-compat: some code probes DOM element for a tabulator instance.
  try {
    if (container) (container as any).tabulator = api;
  } catch (_) {}

  // Inform any listeners that the table is ready.
  setTimeout(() => emit('tableBuilt'), 0);

  return api;
};

if (hasDocument && tableContainer) {
  tableSource = createDOMTableSource(tableContainer, initialData);
  tableSource.__cooptIsDom = true;
  tableSource.__cooptContainer = tableContainer;
} else {
  // Headless fallback (Node/tests)
  let _data = safeCloneRows(initialData);
  tableSource = {
    on() {},
    getData: () => safeCloneRows(_data),
    setData: async (d: SourceRow[]) => { _data = safeCloneRows(d); return Promise.resolve(); },
    replaceData: async (d: SourceRow[]) => { _data = safeCloneRows(d); return Promise.resolve(); },
    getDataCount: () => _data.length,
    getSelectedRows: () => [],
    getRows: () => [],
    addRow: async (row: Partial<SourceRow>) => { _data.push({ ...row } as SourceRow); renumberIds(_data); return Promise.resolve(); },
    deselectRow: () => {},
    redraw: () => {},
    blockRedraw: () => {},
    restoreRedraw: () => {},
  };
  tableSource.__cooptIsDom = false;
}

// Expose to global scope for legacy callers
if (typeof window !== 'undefined') {
  w.tableSource = tableSource;
}

const bindSourceControls = (): void => {
  if (!hasDocument) return;
  const addSourceBtn = document.getElementById("add-source-btn");
  if (addSourceBtn && (addSourceBtn as any).dataset.cooptBound !== '1') {
    (addSourceBtn as any).dataset.cooptBound = '1';
    addSourceBtn.addEventListener("click", function(){
      if (!tableSource || typeof tableSource.getSelectedRows !== 'function') return;
      const selectedRows = tableSource.getSelectedRows();
      let insertIndex = (typeof tableSource.getDataCount === 'function') ? tableSource.getDataCount() : 0;

      if(selectedRows.length > 0){
        const selectedRow = selectedRows[0];
        if (typeof tableSource.getRows === 'function') {
          insertIndex = tableSource.getRows().indexOf(selectedRow) + 1;
        }
      }

      Promise.resolve(tableSource.addRow({
        id: (typeof tableSource.getDataCount === 'function') ? (tableSource.getDataCount() + 1) : 1,
        wavelength: "",
        weight: "",
        primary: ""
      }, false, insertIndex)).then(() => {
        const data = tableSource.getData();
        renumberIds(data);
        if (data.length === 1) {
          data[0].primary = "Primary Wavelength";
          console.log('✅ Auto-set primary wavelength for single source entry');
        } else {
          const primaryExists = data.some(row => row.primary === "Primary Wavelength");
          if (!primaryExists) {
            console.log('⚠️ Multiple sources exist but no primary wavelength is set. Please select one manually.');
          }
        }
        tableSource.replaceData(data);
        saveTableData(data);
      });
    });
  }

  const deleteSourceBtn = document.getElementById("delete-source-btn");
  if (deleteSourceBtn && (deleteSourceBtn as any).dataset.cooptBound !== '1') {
    (deleteSourceBtn as any).dataset.cooptBound = '1';
    deleteSourceBtn.addEventListener("click", function(){
      if (!tableSource || typeof tableSource.getSelectedRows !== 'function') return;
      const selectedRows = tableSource.getSelectedRows();
      if(selectedRows.length > 0){
        const deletedRowData = selectedRows[0].getData();
        const wasPrimary = deletedRowData.primary === "Primary Wavelength";
        selectedRows[0].delete();
        setTimeout(() => {
          const data = tableSource.getData();
          renumberIds(data);
          if (data.length === 1) {
            data[0].primary = "Primary Wavelength";
            console.log('✅ Auto-set primary wavelength for remaining single source entry');
          } else if (data.length > 1 && wasPrimary) {
            console.log('⚠️ Primary wavelength entry was deleted. Please select a new primary wavelength manually.');
          }
          tableSource.replaceData(data);
          saveTableData(data);
          if (data.length === 1 || wasPrimary) {
            notifyPrimaryWavelengthChanged();
          }
        }, 0);
      } else {
        alert("削除する行を選択してください。");
      }
    });
  }
};

export function mountTableSourceIfReady(): boolean {
  if (!hasDocument) return false;
  tableContainer = document.getElementById('table-source');
  if (!tableContainer) return false;
  if (tableSource && tableSource.__cooptIsDom && tableSource.__cooptContainer === tableContainer) {
    bindSourceControls();
    return true;
  }
  const rows = (tableSource && typeof tableSource.getData === 'function') ? tableSource.getData() : safeCloneRows(initialData);
  tableSource = createDOMTableSource(tableContainer, rows);
  tableSource.__cooptIsDom = true;
  tableSource.__cooptContainer = tableContainer;
  try { (tableContainer as any).tabulator = tableSource; } catch (_) {}
  if (typeof window !== 'undefined') {
    w.tableSource = tableSource;
  }
  bindSourceControls();
  return true;
}

bindSourceControls();

if (hasDocument && !tableContainer && typeof window !== 'undefined') {
  window.addEventListener('coopt:react-mounted', () => {
    try { mountTableSourceIfReady(); } catch (_) {}
  }, { once: true });
  setTimeout(() => {
    try { mountTableSourceIfReady(); } catch (_) {}
  }, 0);
}

// 主波長を取得する関数
function getPrimaryWavelength(): number {
  try {
    const prefersPersistedSourceData = (() => {
      try {
        const url = new URL(window.location.href);
        return url.searchParams.get('coopt_analysis_window') === '1'
          || url.searchParams.get('coopt_render_window') === '1';
      } catch (_) {
        return false;
      }
    })();

    const readPrimaryWavelengthFromRows = (sourceData: SourceRow[] | null | undefined): number | null => {
      if (!Array.isArray(sourceData) || sourceData.length === 0) return null;

      const isPrimaryRow = (raw: any): boolean => {
        if (raw === true || raw === 1) return true;
        const s = String(raw ?? '').trim().toLowerCase();
        return s === 'primary wavelength' || s === 'primary' || s === 'true' || s === 'yes' || s === '1';
      };

      const primaryEntries = sourceData.filter(row => isPrimaryRow(row?.primary));
      const primaryEntry = primaryEntries.length > 0 ? primaryEntries[primaryEntries.length - 1] : null;
      if (!primaryEntry) return null;

      const wavelength = parseFloat(String(primaryEntry.wavelength));
      return Number.isFinite(wavelength) ? wavelength : null;
    };

    if (prefersPersistedSourceData) {
      const persistedRows = tryLoadPersistedTableData();
      const persistedWavelength = readPrimaryWavelengthFromRows(persistedRows);
      if (persistedWavelength && persistedWavelength > 0) {
        return persistedWavelength;
      }
    }

    const activeContainer = tableContainer || (hasDocument ? document.getElementById('table-source') : null);
    if (activeContainer) {
      const checkedRadio = activeContainer.querySelector('tbody input[type="radio"][name="source-primary-wavelength"]:checked') as HTMLInputElement | null;
      const checkedRow = checkedRadio?.closest('tr') as HTMLTableRowElement | null;
      const wavelengthInput = checkedRow?.querySelectorAll('td')[1]?.querySelector('input') as HTMLInputElement | null;
      const rawCheckedValue = wavelengthInput?.value?.trim() ?? '';
      if (rawCheckedValue !== '') {
        const checkedWavelength = Number(rawCheckedValue);
        if (Number.isFinite(checkedWavelength) && checkedWavelength > 0) {
          return checkedWavelength;
        }
      }
    }

    if (tableSource && typeof tableSource.getData === 'function') {
      const sourceData = tableSource.getData();
      const liveWavelength = readPrimaryWavelengthFromRows(sourceData);
      if (liveWavelength && liveWavelength > 0) {
        return liveWavelength;
      }
      
      // 見つからない場合はデフォルト値（d線）
      return 0.5876;
    }
  } catch (error) {
    console.warn('❌ Error getting primary wavelength (table-source.ts):', error);
  }
  
  // エラーの場合もデフォルト値
  return 0.5876;
}

// 主波長変更通知関数
function notifyPrimaryWavelengthChanged(): void {
  // 光学システムの屈折率を更新
  if (typeof w.updateAllRefractiveIndices === 'function') {
    w.updateAllRefractiveIndices();
  }

  // System Data テキストを更新（タイミング問題回避のため少し遅延させて実行）
  try {
    setTimeout(() => {
      try {
        if (typeof w.outputParaxialDataToDebug === 'function') {
          const ta = typeof document !== 'undefined'
            ? (document.getElementById('system-data') as HTMLTextAreaElement | null)
            : null;
          if (ta) ta.value = '';
          w.outputParaxialDataToDebug(w.tableOpticalSystem ?? null);
        }
      } catch (_) {}
    }, 0);
  } catch (_) {}

  try {
    w.dispatchEvent?.(new CustomEvent('coopt:primary-wavelength-updated'));
  } catch (_) {}

  // Render uses getPrimaryWavelength() at draw time, so changing the primary
  // source wavelength must trigger a redraw to pick up the new value.
  try {
    if (typeof w.drawOpticalSystem === 'function') {
      w.drawOpticalSystem();
    }
  } catch (_) {}

  try {
    if (typeof w.__cooptRenderWindowRedraw === 'function') {
      void Promise.resolve(w.__cooptRenderWindowRedraw());
    }
  } catch (_) {}

  try {
    const popup = w.popup3DWindow;
    if (popup && !popup.closed && typeof popup.__cooptRenderWindowRedraw === 'function') {
      void Promise.resolve(popup.__cooptRenderWindowRedraw());
    }
  } catch (_) {}

  // Keep standalone/Tauri render windows in sync even when we do not have
  // direct access to their window handles.
  try {
    const payloadToken = `${Date.now()}-primary-wavelength`;
    const payload = { ts: payloadToken, token: payloadToken, rows: [], senderId: getOrCreateCooptWindowSyncSenderId() };
    localStorage.setItem('coopt.renderSyncRequest', JSON.stringify(payload));
  } catch (_) {}

  try {
    if (typeof w.__TAURI_INTERNALS__ !== 'undefined') {
      void (async () => {
        try {
          const mod = await import('@tauri-apps/api/event');
          if (mod && typeof (mod as any).emit === 'function') {
            const payloadToken = `${Date.now()}-primary-wavelength`;
            await (mod as any).emit('coopt-render-sync-request', {
              ts: payloadToken,
              token: payloadToken,
              rows: [],
            });
          }
        } catch (_) {}
      })();
    }
  } catch (_) {}
}

/**
 * Image面のSemi Dia自動計算を再実行（optimizeSemiDia="A"の場合）
 */
function recalculateAutoSemiDiaIfAvailable(): void {
  // Defer to next task to avoid blocking the main thread during wavelength change.
  setTimeout(() => {
    try {
      if (typeof w.autoSetBlockAperturesFromLargestObjectCondition === 'function') {
        w.autoSetBlockAperturesFromLargestObjectCondition();
      }
      if (typeof (w as any).scheduleAutoImageSemiDiaFromChiefRays === 'function') {
        (w as any).scheduleAutoImageSemiDiaFromChiefRays(180);
      } else if (typeof w.calculateImageSemiDiaFromChiefRays === 'function') {
        w.calculateImageSemiDiaFromChiefRays();
      }
    } catch (error: any) {
      console.debug('Semi Dia自動計算スキップ:', error.message);
    }
  }, 0);
}

// デバッグ用：主波長変更のテスト関数
function testPrimaryWavelengthUpdate(): void {
  console.log('🧪 Testing primary wavelength update...');
  
  // 現在の主波長を表示
  const currentWavelength = getPrimaryWavelength();
  console.log(`📏 Current primary wavelength: ${currentWavelength} μm`);
  
  // window.tableSourceの状態を確認
  console.log('🔍 window.tableSource:', w.tableSource ? 'available' : 'not available');
  
  if (w.tableSource) {
    const sourceData = w.tableSource.getData();
    console.log('📊 Source table data:', sourceData);
    
    const primaryEntry = sourceData.find((row: SourceRow) => row.primary === "Primary Wavelength");
    console.log('🎯 Primary entry:', primaryEntry);
  }
  
  // 屈折率更新関数が利用可能かチェック
  console.log('🔧 updateAllRefractiveIndices available:', typeof w.updateAllRefractiveIndices);
  
  // 実際に屈折率更新を実行
  if (typeof w.updateAllRefractiveIndices === 'function') {
    console.log('▶️ Calling updateAllRefractiveIndices...');
    w.updateAllRefractiveIndices();
  }
}

// Export functions to global scope (browser only)
if (typeof window !== 'undefined') {
  if (typeof getPrimaryWavelength === 'function') {
    w.getPrimaryWavelength = getPrimaryWavelength;
  }

  if (typeof notifyPrimaryWavelengthChanged === 'function') {
    w.notifyPrimaryWavelengthChanged = notifyPrimaryWavelengthChanged;
  }
}

// デバッグ用テスト関数をグローバルに公開（browser only）
if (typeof window !== 'undefined') {
  if (typeof testPrimaryWavelengthUpdate === 'function') {
    w.testPrimaryWavelengthUpdate = testPrimaryWavelengthUpdate;
  }
}
