import { miscellaneousDB, oharaGlassDB, schottGlassDB, calculateRefractiveIndex, getGlassDataWithSellmeier, getAllGlassDatabases, getPrimaryWavelength } from './glass.ts';
import { loadSystemConfigurations, saveSystemConfigurations, loadActiveConfigurationToTables, getActiveConfiguration } from './table-configuration.ts';
import { configurationHasBlocks, validateBlocksConfiguration, expandBlocksToOpticalSystemRows, deriveBlocksFromLegacyOpticalSystemRows } from './block-schema.ts';
import { requestUpdateSurfaceNumberSelect } from '../core/window-facade.ts';

function shouldDisableExpandedOpticalSystemUI() {
  try {
    // Blocks are canonical. When present, do not generate Expanded Optical System UI.
    // This prevents surface-table drift and enforces the Design Intent workflow.
    const cfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
    return !!cfg && configurationHasBlocks(cfg);
  } catch {
    return false;
  }
}

function createNoopOpticalSystemTable() {
  let _data = [];
  const self = {
    on() { return self; },
    off() { return self; },
    getData() { return Array.isArray(_data) ? _data : []; },
    getRows() {
      return (Array.isArray(_data) ? _data : []).map((row, idx) => {
        const rowData = row && typeof row === 'object' ? { ...row } : {};
        return {
          getData: () => rowData,
          getIndex: () => idx,
          getCell: (field) => ({
            setValue: (val) => {
              rowData[field] = val;
              try {
                const idNum = Number(rowData.id);
                if (Number.isFinite(idNum)) {
                  const di = Array.isArray(_data) ? _data.findIndex(r => Number(r?.id) === idNum) : -1;
                  if (di >= 0) { _data[di] = { ..._data[di], [field]: val }; }
                }
              } catch (_) {}
            }
          })
        };
      });
    },
    setData(d) { _data = Array.isArray(d) ? d : []; return Promise.resolve(); },
    replaceData(d) { _data = Array.isArray(d) ? d : []; return Promise.resolve(); },
    updateRow(rowId, patch) {
      try {
        const idNum = (typeof rowId === 'number') ? rowId : Number(rowId);
        const idx = Array.isArray(_data) ? _data.findIndex(r => Number(r?.id) === idNum) : -1;
        if (idx >= 0) {
          const cur = _data[idx] && typeof _data[idx] === 'object' ? _data[idx] : {};
          const p = (patch && typeof patch === 'object') ? patch : {};
          _data[idx] = { ...cur, ...p };
        }
      } catch (_) {}
      return Promise.resolve();
    },
    updateData(rows) {
      try {
        if (!Array.isArray(rows)) return Promise.resolve();
        for (const r of rows) {
          const idNum = Number(r?.id);
          if (!Number.isFinite(idNum)) continue;
          const idx = Array.isArray(_data) ? _data.findIndex(x => Number(x?.id) === idNum) : -1;
          if (idx >= 0) {
            const cur = _data[idx] && typeof _data[idx] === 'object' ? _data[idx] : {};
            _data[idx] = { ...cur, ...(r && typeof r === 'object' ? r : {}) };
          }
        }
      } catch (_) {}
      return Promise.resolve();
    },
    updateColumnDefinition() { return; },
    addRow() { return Promise.resolve(); },
    deleteRow() { return Promise.resolve(); },
    deselectRow() { return; },
    getSelectedCells() { return []; },
    getSelectedRows() { return []; },
    getSelectedData() { return []; },
    getElement() {
      try {
        return document.getElementById('table-optical-system') || null;
      } catch {
        return null;
      }
    }
  };
  return self;
}

// cellEdited ハンドラ内で参照されるフラグ（重複削除の副作用で未宣言になっていた）
let isUpdatingFromCellEdit = false;

function withCellEditSuppressed(fn) {
  const prev = isUpdatingFromCellEdit;
  isUpdatingFromCellEdit = true;
  try {
    return fn();
  } finally {
    isUpdatingFromCellEdit = prev;
  }
}

function runWithCellEditSuppressed(fn) {
  try {
    return (typeof withCellEditSuppressed === 'function') ? withCellEditSuppressed(fn) : fn();
  } catch (_) {
    return fn();
  }
}

function getGlassPropertiesUpdatesMap() {
  const existing = (window as any)['glassPropertiesUpdates'];
  if (existing instanceof Map) return existing;
  const created = new Map();
  (window as any)['glassPropertiesUpdates'] = created;
  return created;
}

let cachedLocalCoordsState = null;
let showLocalCoordsState = false;

function setCachedLocalCoordsState(value) {
  cachedLocalCoordsState = value ?? null;
  try {
    if (typeof window !== 'undefined') {
      (window as any)['_cachedLocalCoords'] = cachedLocalCoordsState;
    }
  } catch (_) {}
}

function getCachedLocalCoordsState() {
  if (cachedLocalCoordsState) return cachedLocalCoordsState;
  try {
    if (typeof window === 'undefined') return null;
    return (window as any)['_cachedLocalCoords'] ?? null;
  } catch (_) {
    return null;
  }
}

function setShowLocalCoordsState(value) {
  showLocalCoordsState = value === true;
  try {
    if (typeof window !== 'undefined') {
      (window as any)['_showLocalCoords'] = showLocalCoordsState;
    }
  } catch (_) {}
}

function clearLocalCoordsState() {
  setCachedLocalCoordsState(null);
  setShowLocalCoordsState(false);
}

function makePendingSurfaceEditKey(surfaceId, field) {
  const sid = (surfaceId === null || surfaceId === undefined) ? '' : String(surfaceId);
  const f = (field === null || field === undefined) ? '' : String(field);
  return `${sid}:${f}`;
}

function valuesEquivalentForApply(oldValue, newValue) {
  // Conservative equivalence: prevents noisy no-op edits from becoming Apply targets.
  if (oldValue === newValue) return true;

  const normalize = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v).trim();
    if (s === '') return '';
    // keep INF/AUTO tokens as-is
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    if (/^(a|auto|u)$/i.test(s)) return s.toUpperCase();
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    return s;
  };

  const a = normalize(oldValue);
  const b = normalize(newValue);
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-12;
  }
  return a === b;
}

// セル編集時のスクロール位置保存/復元（未定義参照で落ちないよう安全実装）
let __savedOpticalSystemScrollTop = 0;
let __savedOpticalSystemScrollLeft = 0;

const getOpticalSystemTableScrollHolder = () => {
  try {
    if (typeof document === 'undefined') return null;

    const rootEl = (typeof tableOpticalSystem?.getElement === 'function')
      ? tableOpticalSystem.getElement()
      : (document.getElementById('table-optical-system') || document.querySelector('#table-optical-system'));

    if (!rootEl) return null;
    return rootEl.querySelector('.tabulator-tableholder') || rootEl;
  } catch (_) {
    return null;
  }
};

function saveScrollPosition() {
  const holder = getOpticalSystemTableScrollHolder();
  if (!holder) return;
  __savedOpticalSystemScrollTop = holder.scrollTop || 0;
  __savedOpticalSystemScrollLeft = holder.scrollLeft || 0;
}

function restoreScrollPosition() {
  const holder = getOpticalSystemTableScrollHolder();
  if (!holder) return;
  try {
    holder.scrollTop = __savedOpticalSystemScrollTop || 0;
    holder.scrollLeft = __savedOpticalSystemScrollLeft || 0;
  } catch (_) {
    // ignore
  }
}


// 初期データ
const initialTableData = [
  {
    id: 0,
    "object type": "Object",
    surfType: "Spherical",
    comment: "",
    radius: "INF",
    thickness: 100,
    semidia: "10",
    material: "AIR",
    rindex: "",
    abbe: "",
    conic: "",
    coef1: "",
    coef2: "",
    coef3: "",
    coef4: "",
    coef5: "",
    coef6: "",
    coef7: "",
    coef8: "",
    coef9: "",
    coef10: "",
    apertureShape: "",
    apertureWidth: "",
    apertureHeight: ""
  },
  {
    id: 1,
    "object type": "Stop",
    surfType: "Spherical",
    comment: "",
    radius: "50",
    thickness: 5,
    semidia: "10",
    material: "N-BK7",
    rindex: "1.5168",
    abbe: "64.17",
    conic: "",
    coef1: "",
    coef2: "",
    coef3: "",
    coef4: "",
    coef5: "",
    coef6: "",
    coef7: "",
    coef8: "",
    coef9: "",
    coef10: "",
    apertureShape: "",
    apertureWidth: "",
    apertureHeight: ""
  },
  {
    id: 2,
    "object type": "",
    surfType: "Spherical",
    comment: "",
    radius: "-50",
    thickness: 95,
    semidia: "10",
    material: "AIR",
    rindex: "",
    abbe: "",
    conic: "",
    coef1: "",
    coef2: "",
    coef3: "",
    coef4: "",
    coef5: "",
    coef6: "",
    coef7: "",
    coef8: "",
    coef9: "",
    coef10: "",
    apertureShape: "",
    apertureWidth: "",
    apertureHeight: ""
  },
  {
    id: 3,
    "object type": "Image",
    surfType: "Spherical",
    comment: "",
    radius: "INF",
    thickness: "",
    semidia: "",
    material: "",
    rindex: "",
    abbe: "",
    conic: "",
    coef1: "",
    coef2: "",
    coef3: "",
    coef4: "",
    coef5: "",
    coef6: "",
    coef7: "",
    coef8: "",
    coef9: "",
    coef10: "",
    apertureShape: "",
    apertureWidth: "",
    apertureHeight: ""
  }
];

// ローカルストレージからデータを取得
export function loadTableData() {
  const json = localStorage.getItem(STORAGE_KEY);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      return parsed;
    } catch (e) {
      console.warn('⚠️ [TableOpticalSystem] Parse error:', e);
      console.warn("保存データの読み込みに失敗しました。初期データを使用します。");
    }
  }

  return initialTableData;
}

// localStorage に実データがある場合のみ読み込む（無い場合は null）
// Migration/初期化判定に使う。デフォルト値 (initialTableData) を返さない点が重要。
export function tryLoadPersistedTableData() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// テーブルデータをローカルストレージに保存
export function saveTableData(data) {
  if (data && Array.isArray(data)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    // Verify save
    const verify = localStorage.getItem(STORAGE_KEY);
  } else {
    console.warn('⚠️ [TableOpticalSystem] Invalid data, not saving:', data);
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

// idを0から振り直す
export function renumberIds(data) {
  data.forEach((row, idx) => {
    row.id = idx;
  });
}

// Object typeを自動設定する（1行目="Object", 最終行="Image"）
export function updateObjectTypes(data) {
  data.forEach((row, idx) => {
    if (idx === 0) {
      row["object type"] = "Object";
    } else if (idx === data.length - 1) {
      row["object type"] = "Image";
    }
    // 中間行は変更しない（既存の値を保持）
  });
}

// データの保存・復元用キー
const STORAGE_KEY = "OpticalSystemTableData";

// 初期データをローカルストレージから取得
const initialData = loadTableData();

// 初期データのObject typeを適切に設定
updateObjectTypes(initialData);

// 表の構成
export let tableOpticalSystem;

const __DISABLE_EXPANDED_OPTICAL_SYSTEM_UI = shouldDisableExpandedOpticalSystemUI();

if (__DISABLE_EXPANDED_OPTICAL_SYSTEM_UI) {
  try {

  } catch (_) {}
}

// --- Dynamic column header support (surfType-dependent) ---
// Some UI paths (row/cell selection, surfType edit) call updateCoefTitles()/updateTitlesForCoordTrans().
// These functions were missing, which made header switching a no-op.

const DEFAULT_COLUMN_TITLES = Object.freeze({
  thickness: 'Thickness',
  semidia: 'Semi Dia',
  material: 'Material',
  rindex: 'Ref Index',
  abbe: 'Abbe',
  conic: 'Conic',
  coef1: 'Coef1',
  coef2: 'Coef2',
  coef3: 'Coef3',
  coef4: 'Coef4',
  coef5: 'Coef5',
  coef6: 'Coef6',
  coef7: 'Coef7',
  coef8: 'Coef8',
  coef9: 'Coef9',
  coef10: 'Coef10',
  apertureShape: 'Aperture Shape',
  apertureWidth: 'Aperture Width',
  apertureHeight: 'Aperture Height',
});

const COORDTRANS_COLUMN_TITLES = Object.freeze({
  // In this UI, Coord Break reuses these numeric fields to store decenter/tilt.
  semidia: 'Decenter X',
  material: 'Decenter Y',
  thickness: 'Decenter Z',
  rindex: 'Tilt X',
  abbe: 'Tilt Y',
  conic: 'Tilt Z',
  // coef1 is used as an order flag in the ray tracing implementation.
  coef1: 'Order',
});

function setTabulatorColumnTitle(field, title) {
  try {
    const f = String(field || '').trim();
    if (!f) return false;
    const t = String(title ?? '');

    // During cell editing/click-to-edit, changing column definitions or forcing redraw
    // can interrupt Tabulator's editor creation and make cells uneditable.
    // In that case, do a DOM-only header label update.
    const avoidTabulatorUpdates = !!globalThis.__cooptAvoidTabulatorHeaderUpdates;

    if (avoidTabulatorUpdates) {
      try {
        const root = tableOpticalSystem?.element || document;
        const safeField = (globalThis.CSS && typeof globalThis.CSS.escape === 'function') ? globalThis.CSS.escape(f) : f;
        const colEl = root?.querySelector?.(`.tabulator-col[tabulator-field="${safeField}"] .tabulator-col-title`);
        if (colEl) {
          colEl.textContent = t;
          return true;
        }
      } catch (_) {
        // ignore
      }
      return false;
    }

    // Prefer Tabulator APIs when available.
    try {
      if (tableOpticalSystem && typeof tableOpticalSystem.updateColumnDefinition === 'function') {
        tableOpticalSystem.updateColumnDefinition(f, { title: t });
        return true;
      }
    } catch (_) {
      // fall through
    }

    try {
      if (tableOpticalSystem && typeof tableOpticalSystem.getColumn === 'function') {
        const col = tableOpticalSystem.getColumn(f);
        if (col && typeof col.updateDefinition === 'function') {
          col.updateDefinition({ title: t });
          return true;
        }
      }
    } catch (_) {
      // fall through
    }

    // DOM fallback: update the header label text directly.
    try {
      const root = tableOpticalSystem?.element || document;
      const safeField = (globalThis.CSS && typeof globalThis.CSS.escape === 'function') ? globalThis.CSS.escape(f) : f;
      const colEl = root?.querySelector?.(`.tabulator-col[tabulator-field="${safeField}"] .tabulator-col-title`);
      if (colEl) {
        colEl.textContent = t;
        return true;
      }
    } catch (_) {
      // ignore
    }
  } catch (_) {
    // ignore
  }
  return false;
}

function updateTitlesForCoordTrans(enabled) {
  const isCoordTrans = !!enabled;
  const titles = isCoordTrans ? COORDTRANS_COLUMN_TITLES : DEFAULT_COLUMN_TITLES;

  // Only touch the columns whose semantics change.
  setTabulatorColumnTitle('semidia', titles.semidia);
  setTabulatorColumnTitle('material', titles.material);
  setTabulatorColumnTitle('thickness', titles.thickness);
  setTabulatorColumnTitle('rindex', titles.rindex);
  setTabulatorColumnTitle('abbe', titles.abbe);
  setTabulatorColumnTitle('conic', titles.conic);

  // Keep coef1 consistent if caller doesn't also invoke updateCoefTitles('coordtrans').
  setTabulatorColumnTitle('coef1', titles.coef1);
}

function updateCoefTitles(mode) {
  const m = String(mode ?? '').trim().toLowerCase();

  /** @type {Record<string, string>} */
  const titles = {};
  if (m === 'even') {
    // Even asphere: coef1*r^2 + coef2*r^4 + ...
    for (let i = 1; i <= 10; i++) {
      titles[`coef${i}`] = `A${2 * i}`;
    }
  } else if (m === 'odd') {
    // Odd asphere: coef1*r^3 + coef2*r^5 + ...
    for (let i = 1; i <= 10; i++) {
      titles[`coef${i}`] = `A${2 * i + 1}`;
    }
  } else if (m === 'coordtrans') {
    // Coord Break uses coef1 as an order flag; other coefs are not used.
    titles.coef1 = COORDTRANS_COLUMN_TITLES.coef1;
    for (let i = 2; i <= 10; i++) {
      titles[`coef${i}`] = DEFAULT_COLUMN_TITLES[`coef${i}`];
    }
  } else {
    // Default surface: keep Coef1..Coef10
    for (let i = 1; i <= 10; i++) {
      titles[`coef${i}`] = DEFAULT_COLUMN_TITLES[`coef${i}`];
    }
  }

  for (let i = 1; i <= 10; i++) {
    const key = `coef${i}`;
    setTabulatorColumnTitle(key, titles[key] ?? DEFAULT_COLUMN_TITLES[key]);
  }
}

let tabulatorOptions = {
  data: initialData,
  layout: "fitColumns",
  selectable: 1, // 行選択を有効化（Find Glass / Del Surf などが getSelectedRows() に依存）
  scrollHorizontal: true, // ← 水平スクロールを有効化
  validationMode: "manual", // バリデーションモードを手動に設定
  editTriggerEvent: "click", // 編集トリガーをクリックに限定
  tabEndNewRow: false, // タブでの新行作成を無効化
  columns: [
    { title: "Surface", field: "id", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for surface id:", e);
          return value;
        }
      }},
    { title: "Object", 
      field: "object type",
      editor: "list",
          editorParams: {
            values: [
              {value: "", label: "Null"},
              {value: "Object", label: "Object"},
              {value: "Stop", label: "Stop"},
              {value: "Image", label: "Image"}
            ]
          },
          width: 150,
          headerSort: false
        },
    {
      title: "Surface Type",
      field: "surfType",
      editor: "list",
          editorParams: {
            values: [
              {value: "Spherical", label: "Spherical"},
              {value: "Aspheric even", label: "Aspheric even"},
              {value: "Aspheric odd", label: "Aspheric odd"},
              {value: "Toric", label: "Toric"},
              {value: "Coord Break", label: "Coord Break"}
            ]
          },
          width: 150,
          headerSort: false
        },
    { title: "Comment", field: "comment", editor: "input", width: 150, headerSort: false },
    { title: "Radius", field: "radius", editor: "input", width: 100, headerSort: false , 
      // 数値変換のためのmutatorを追加　文字列(数値)-> 数値　文字列 -> 文字列
      mutator: function(value) {
        try {
          if (value === "" || value === null || value === undefined) return "";
          // INF や Infinity の文字列を処理
          const valueStr = String(value).toUpperCase();
          if (valueStr === "INF" || valueStr === "INFINITY") {
            return "INF";
          }
          // 数値変換を試行
          const num = Number(value);
          return !isNaN(num) ? num : value;
        } catch (e) {
          console.warn("Mutator error for radius:", e);
          return value;
        }
      }},
    { title: "Thickness", field: "thickness", editor: "input", width: 100, headerSort: false , mutator: function(value) {
        try {
          if (value === "" || value === null || value === undefined) return "";
          // INF や Infinity の文字列を処理
          const valueStr = String(value).toUpperCase();
          if (valueStr === "INF" || valueStr === "INFINITY") {
            return "INF";
          }
          // 数値変換を試行
          const num = Number(value);
          return !isNaN(num) ? num : value;
        } catch (e) {
          console.warn("Mutator error for thickness:", e);
          return value;
        }
      }},
    { title: "Local X", field: "_localX", width: 110, headerSort: false, editor: false,
      visible: function() {
        // Temporarily always visible for debugging
        return true;
        // try {
        //   return typeof window !== 'undefined' && window._showLocalCoords === true;
        // } catch (_) {
        //   return false;
        // }
      },
      formatter: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          const localData = getCachedLocalCoordsState();
          
          // Debug every call to see if formatter is being invoked
          console.log(`[Local X Formatter] Row ${rowData.id}:`, {
            rowId: rowData.id,
            rowIdType: typeof rowData.id,
            hasLocalData: !!localData,
            hasSurfaces: !!localData?.surfaces,
            surfaceKeys: localData?.surfaces ? Object.keys(localData.surfaces) : [],
            surfData: localData?.surfaces?.[rowData.id],
            surfDataString: localData?.surfaces?.[String(rowData.id)]
          });
          
          if (!localData || !localData.surfaces) {
            console.log(`[Local X Formatter] Row ${rowData.id}: No local data, returning '-'`);
            return '-';
          }
          
          // Try both numeric and string id
          const surfData = localData.surfaces[rowData.id] || localData.surfaces[String(rowData.id)];
          if (!surfData) {
            console.log(`[Local X Formatter] Row ${rowData.id}: No surface data found, returning '-'`);
            return '-';
          }
          
          const prefix = surfData.transformType === 'chief' ? 'Chief: ' : '@Surf' + surfData.targetSurface + ': ';
          const result = prefix + surfData.localDecenterX.toFixed(3);
          console.log(`[Local X Formatter] Row ${rowData.id}: Returning '${result}'`);
          return result;
        } catch (err) {
          console.error('Local X formatter error:', err);
          return '-';
        }
      }
    },
    { 
      title: "Semi Dia", 
      field: "semidia", 
      width: 120, 
      headerSort: false,
      editor: "input",
      mutator: function(value) {
        // 文字列"A", "a", "Auto"はそのまま保持
        if (value === 'A' || value === 'a' || value === 'Auto' || value === '') {
          return value;
        }
        // 数値に変換を試みる
        try {
          const num = Number(value);
          return isNaN(num) ? value : num;
        } catch (e) {
          return value;
        }
      }
    },
    { 
      title: "Optimize", 
      field: "optimizeSemiDia", 
      width: 100, 
      headerSort: false,
      editor: "select",
      editorParams: {
        values: { "": "(None)", "M": "Manual", "A": "Auto" }
      },
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData["object type"] === "Image" || rowData.object === "Image";
        } catch (e) {
          return false;
        }
      }
    },
    { title: "Material", field: "material", editor: "input", width: 100, headerSort: false },
    { title: "Radius X", field: "radiusX", editor: "input", width: 100, headerSort: false,
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData.surfType === 'Toric';
        } catch (e) {
          return false;
        }
      },
      mutator: function(value) {
        try {
          if (value === "" || value === null || value === undefined) return "";
          const valueStr = String(value).toUpperCase();
          if (valueStr === "INF" || valueStr === "INFINITY") return "INF";
          const num = Number(value);
          return !isNaN(num) ? num : value;
        } catch (e) {
          return value;
        }
      }},
    { title: "Radius Y", field: "radiusY", editor: "input", width: 100, headerSort: false,
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData.surfType === 'Toric';
        } catch (e) {
          return false;
        }
      },
      mutator: function(value) {
        try {
          if (value === "" || value === null || value === undefined) return "";
          const valueStr = String(value).toUpperCase();
          if (valueStr === "INF" || valueStr === "INFINITY") return "INF";
          const num = Number(value);
          return !isNaN(num) ? num : value;
        } catch (e) {
          return value;
        }
      }},
    { title: "Axis", field: "axis", editor: "input", width: 80, headerSort: false,
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData.surfType === 'Toric';
        } catch (e) {
          return false;
        }
      },
      mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          return value;
        }
      }},
    { title: "Local Y", field: "_localY", width: 110, headerSort: false, editor: false,
      visible: function() {
        return true; // Temporarily always visible for debugging
      },
      formatter: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          const localData = getCachedLocalCoordsState();
          if (!localData || !localData.surfaces) return '-';
          const surfData = localData.surfaces[rowData.id] || localData.surfaces[String(rowData.id)];
          if (!surfData) return '-';
          const prefix = surfData.transformType === 'chief' ? 'Chief: ' : '@Surf' + surfData.targetSurface + ': ';
          return prefix + surfData.localDecenterY.toFixed(3);
        } catch (_) {
          return '-';
        }
      }
    },
    { title: "Local Z", field: "_localZ", width: 110, headerSort: false, editor: false,
      visible: function() {
        return true; // Temporarily always visible for debugging
      },
      formatter: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          const localData = getCachedLocalCoordsState();
          if (!localData || !localData.surfaces) return '-';
          const surfData = localData.surfaces[rowData.id] || localData.surfaces[String(rowData.id)];
          if (!surfData) return '-';
          const prefix = surfData.transformType === 'chief' ? 'Chief: ' : '@Surf' + surfData.targetSurface + ': ';
          return prefix + surfData.localDecenterZ.toFixed(3);
        } catch (_) {
          return '-';
        }
      }
    },
    { title: "Ref Index", field: "rindex", editor: "input", width: 100, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for rindex:", e);
          return value;
        }
      }},
    { title: "Local TiltX", field: "_localTiltX", width: 110, headerSort: false, editor: false,
      visible: function() {
        return true; // Temporarily always visible for debugging
      },
      formatter: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          const localData = getCachedLocalCoordsState();
          if (!localData || !localData.surfaces) return '-';
          const surfData = localData.surfaces[rowData.id] || localData.surfaces[String(rowData.id)];
          if (!surfData) return '-';
          const prefix = surfData.transformType === 'chief' ? 'Chief: ' : '@Surf' + surfData.targetSurface + ': ';
          return prefix + surfData.localTiltX.toFixed(3);
        } catch (_) {
          return '-';
        }
      }
    },
    { title: "Abbe", field: "abbe", editor: "input", width: 100, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for abbe:", e);
          return value;
        }
      }},
    { title: "Local TiltY", field: "_localTiltY", width: 110, headerSort: false, editor: false,
      visible: function() {
        return true; // Temporarily always visible for debugging
      },
      formatter: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          const localData = getCachedLocalCoordsState();
          if (!localData || !localData.surfaces) return '-';
          const surfData = localData.surfaces[rowData.id] || localData.surfaces[String(rowData.id)];
          if (!surfData) return '-';
          const prefix = surfData.transformType === 'chief' ? 'Chief: ' : '@Surf' + surfData.targetSurface + ': ';
          return prefix + surfData.localTiltY.toFixed(3);
        } catch (_) {
          return '-';
        }
      }
    },
    { title: "Conic", field: "conic", editor: "input", width: 100, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for conic:", e);
          return value;
        }
      }},
    { title: "Local TiltZ", field: "_localTiltZ", width: 110, headerSort: false, editor: false,
      visible: function() {
        return true; // Temporarily always visible for debugging
      },
      formatter: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          const localData = getCachedLocalCoordsState();
          if (!localData || !localData.surfaces) return '-';
          const surfData = localData.surfaces[rowData.id] || localData.surfaces[String(rowData.id)];
          if (!surfData) return '-';
          const prefix = surfData.transformType === 'chief' ? 'Chief: ' : '@Surf' + surfData.targetSurface + ': ';
          return prefix + surfData.localTiltZ.toFixed(3);
        } catch (_) {
          return '-';
        }
      }
    },
    // 各面typeごとの係数
    { title: "Coef1", field: "coef1", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef1:", e);
          return value;
        }
      }},
    { title: "Coef2", field: "coef2", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef2:", e);
          return value;
        }
      }},
    { title: "Coef3", field: "coef3", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef3:", e);
          return value;
        }
      }},
    { title: "Coef4", field: "coef4", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef4:", e);
          return value;
        }
      }},
    { title: "Coef5", field: "coef5", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef5:", e);
          return value;
        }
      }},
    { title: "Coef6", field: "coef6", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef6:", e);
          return value;
        }
      }},
    { title: "Coef7", field: "coef7", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef7:", e);
          return value;
        }
      }},
    { title: "Coef8", field: "coef8", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef8:", e);
          return value;
        }
      }},
    { title: "Coef9", field: "coef9", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef9:", e);
          return value;
        }
      }},
    { title: "Coef10", field: "coef10", editor: "input", width: 80, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for coef10:", e);
          return value;
        }
      }},
    { title: "Aperture Shape", field: "apertureShape", editor: "list", width: 120, headerSort: false,
      editorParams: {
        values: [
          {value: "", label: "(None)"},
          {value: "Circular", label: "Circular"},
          {value: "Square", label: "Square"},
          {value: "Rectangular", label: "Rectangular"}
        ]
      },
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData["object type"] === "Image" || rowData.object === "Image";
        } catch (e) {
          return false;
        }
      }
    },
    { title: "Aperture Width", field: "apertureWidth", editor: "input", width: 110, headerSort: false,
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData["object type"] === "Image" || rowData.object === "Image";
        } catch (e) {
          return false;
        }
      },
      mutator: function(value) {
        try {
          if (value === "" || value === null || value === undefined) return "";
          const num = Number(value);
          return !isNaN(num) ? num : value;
        } catch (e) {
          return value;
        }
      }
    },
    { title: "Aperture Height", field: "apertureHeight", editor: "input", width: 110, headerSort: false,
      visible: function(cell) {
        try {
          const rowData = cell.getRow().getData();
          return rowData["object type"] === "Image" || rowData.object === "Image";
        } catch (e) {
          return false;
        }
      },
      mutator: function(value) {
        try {
          if (value === "" || value === null || value === undefined) return "";
          const num = Number(value);
          return !isNaN(num) ? num : value;
        } catch (e) {
          return value;
        }
      }
    }
    ]
  }; // ←columns配列の直後はオプションオブジェクトの終端

  // Tabulatorインスタンスを作成 (disabled when Blocks exist)
  if (__DISABLE_EXPANDED_OPTICAL_SYSTEM_UI) {
    tableOpticalSystem = createNoopOpticalSystemTable();
  } else {
    try {
      tableOpticalSystem = new Tabulator('#table-optical-system', tabulatorOptions);
    } catch (error) {
      console.warn('Tabulator initialization failed. Falling back to noop table.', error);
      tableOpticalSystem = createNoopOpticalSystemTable();
    }
  }

  // In Blocks-only mode, the optical system table is a no-op UI, but downstream
  // evaluation (chief ray / PSF) still expects tableOpticalSystem.getData() to
  // return the expanded surface rows. Seed it here so it is never empty.
  if (__DISABLE_EXPANDED_OPTICAL_SYSTEM_UI) {
    try {
      let rows = Array.isArray(initialData) ? initialData : [];
      const cfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
      if (cfg && configurationHasBlocks(cfg) && Array.isArray(cfg.blocks)) {
        const expanded = expandBlocksToOpticalSystemRows(cfg.blocks);
        const fatals = Array.isArray(expanded?.issues) ? expanded.issues.filter(i => i && i.severity === 'fatal') : [];
        if (Array.isArray(expanded?.rows) && fatals.length === 0) {
          rows = expanded.rows;
        }
      }
      // Ensure ids exist for updateRow().
      try { renumberIds(rows); } catch (_) {}
      try { updateObjectTypes(rows); } catch (_) {}
      if (typeof tableOpticalSystem.setData === 'function') {
        tableOpticalSystem.setData(rows);
      }
    } catch (_) {
      // ignore
    }
  }

  try {
    // Keep the historical global reference stable.
    if (typeof window !== 'undefined') window['tableOpticalSystem'] = tableOpticalSystem;
  } catch (_) {}

  // console.log(tableOpticalSystem); // Tabulatorインスタンスが出力されるか確認

  // Tabulatorエラーハンドリング
  if (!__DISABLE_EXPANDED_OPTICAL_SYSTEM_UI) {
    tableOpticalSystem.on("error", function(error) {
      console.warn("Tabulator error:", error);
    });
  }

  // 初期化完了後にイベントリスナーを設定
  if (!__DISABLE_EXPANDED_OPTICAL_SYSTEM_UI) tableOpticalSystem.on("tableBuilt", function(){
    // console.log("Optical System Tabulator initialized successfully");

    const updateDynamicHeadersForSurfType = (surfTypeValue) => {
      try {
        const st = String(surfTypeValue ?? '').trim();
        if (st === 'Coord Break') {
          updateTitlesForCoordTrans(true);
          updateCoefTitles('coordtrans');
        } else if (st === 'Aspheric even') {
          updateTitlesForCoordTrans(false);
          updateCoefTitles('even');
        } else if (st === 'Aspheric odd') {
          updateTitlesForCoordTrans(false);
          updateCoefTitles('odd');
        } else {
          updateTitlesForCoordTrans(false);
          updateCoefTitles();
        }
      } catch (_) {
        // ignore
      }
    };

    // クリックで確実に単一行選択できるようにする（セル編集とも共存）
    try {
      tableOpticalSystem.on('rowClick', function(_e, row) {
        try {
          const already = typeof row?.isSelected === 'function' ? row.isSelected() : false;
          tableOpticalSystem.deselectRow();
          if (!already) {
            row.select();
          }

          // Update dynamic column headers based on the clicked row's surfType.
          try {
            const data = row?.getData?.() ?? null;
            updateDynamicHeadersForSurfType(data?.surfType);
          } catch (_) {}
        } catch (_) {
          // ignore
        }
      });
    } catch (_) {
      // ignore
    }

    // Also update headers on cell click (selecting a cell is a common UX path).
    try {
      tableOpticalSystem.on('cellClick', function(_e, cell) {
        try {
          // Avoid interrupting click-to-edit: do DOM-only header updates in this interaction.
          globalThis.__cooptAvoidTabulatorHeaderUpdates = true;
          setTimeout(() => { globalThis.__cooptAvoidTabulatorHeaderUpdates = false; }, 0);

          const row = cell?.getRow?.();
          const data = row?.getData?.() ?? null;
          updateDynamicHeadersForSurfType(data?.surfType);
        } catch (_) {
          // ignore
        }
      });
    } catch (_) {
      // ignore
    }

    // When editTriggerEvent is "click", clicking a cell often goes straight into editing.
    // Ensure headers update even if cellClick doesn't fire in some Tabulator versions.
    try {
      tableOpticalSystem.on('cellMouseDown', function(_e, cell) {
        try {
          globalThis.__cooptAvoidTabulatorHeaderUpdates = true;
          setTimeout(() => { globalThis.__cooptAvoidTabulatorHeaderUpdates = false; }, 0);
          const row = cell?.getRow?.();
          const data = row?.getData?.() ?? null;
          updateDynamicHeadersForSurfType(data?.surfType);
        } catch (_) {}
      });
    } catch (_) {
      // ignore
    }

    // And on selection changes (covers programmatic selection / keyboard selection).
    try {
      tableOpticalSystem.on('rowSelected', function(row) {
        try {
          const data = row?.getData?.() ?? null;
          updateDynamicHeadersForSurfType(data?.surfType);
        } catch (_) {
          // ignore
        }
      });
    } catch (_) {
      // ignore
    }

    const isNumericFieldForSelectAll = (field) => {
      const f = String(field || '');
      if (!f) return false;
      if (f === 'radius' || f === 'thickness' || f === 'semidia' || f === 'rindex' || f === 'abbe' || f === 'conic') return true;
      if (/^coef\d+$/i.test(f)) return true;
      return false;
    };

    const trySelectEditorText = (cell, { selectAll }) => {
      try {
        const cellEl = cell?.getElement?.();
        if (!cellEl) return false;

        const doc = cellEl.ownerDocument || document;
        /** @type {any} */
        let editorEl = cellEl.querySelector('input, textarea, select');
        const ae = doc && doc.activeElement;
        if (!editorEl && ae && cellEl.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) {
          editorEl = ae;
        }
        if (!editorEl) return false;

        // Stop keydown propagation once (prevents Tabulator shortcuts from eating input).
        try {
          if (!editorEl.__cooptKeydownHooked) {
            editorEl.__cooptKeydownHooked = true;
            editorEl.addEventListener('keydown', function(e) {
              e.stopPropagation();
            }, { once: false });
          }
        } catch (_) {}

        if (selectAll) {
          try { editorEl.focus(); } catch (_) {}
          try { if (typeof editorEl.select === 'function') editorEl.select(); } catch (_) {}
        }
        return true;
      } catch (_) {
        return false;
      }
    };
    
    // セル編集開始時にスクロール位置を保存
    tableOpticalSystem.on("cellEditing", function(cell){
      try {
        saveScrollPosition();

        const field = (typeof cell?.getField === 'function') ? cell.getField() : '';
        const wantSelectAll = isNumericFieldForSelectAll(field);

        // Capture a stable oldValue snapshot for Apply-to-Design-Intent.
        // Tabulator versions/configs can omit cell.getOldValue(); this fills the gap.
        try {
          const rowData = cell?.getRow?.()?.getData?.() ?? null;
          const surfaceId = (rowData && typeof rowData.id === 'number') ? rowData.id : null;
          if (surfaceId !== null && field) {
            globalThis.__cooptLastCellEditStart = {
              surfaceId,
              field: String(field),
              oldValue: (typeof cell?.getValue === 'function') ? cell.getValue() : rowData?.[field],
              at: Date.now(),
            };
          }
        } catch (_) {}

        // Tabulator may create/attach the editor element after cellEditing fires.
        // Retry a few times and also use activeElement fallback.
        const attempt = () => trySelectEditorText(cell, { selectAll: wantSelectAll });
        if (!attempt()) {
          setTimeout(attempt, 0);
          setTimeout(attempt, 10);
          setTimeout(attempt, 50);
        }
      } catch (error) {
        console.warn("Cell editing scroll save error:", error);
      }
    });

    // セル編集完了時にスクロール位置を復元
    tableOpticalSystem.on("cellEdited", function(){
      try {
        setTimeout(restoreScrollPosition, 0);
      } catch (error) {
        console.warn("Cell edited scroll restore error:", error);
      }
    });

    // セル編集キャンセル時にスクロール位置を復元
    tableOpticalSystem.on("cellEditCancelled", function(){
      try {
        setTimeout(restoreScrollPosition, 0);
      } catch (error) {
        console.warn("Cell edit cancelled scroll restore error:", error);
      }
    });
  });

try {
  // Initialization code is above, but if needed, add here
} catch (error) {
  console.error("❌ Failed to initialize Optical System Tabulator:", error);
  console.error("❌ Stack trace:", error.stack);
  console.error("❌ Tabulator available?", typeof Tabulator);
  console.error("❌ DOM element:", document.getElementById('table-optical-system'));
  console.error("❌ Initial data:", initialData);
  // フォールバック処理
  tableOpticalSystem = null;
}

// グローバルに公開（Node実行ではwindowが無いのでガード）
if (typeof window !== 'undefined') {
  window['calculateImageSemiDiaFromChiefRays'] = calculateImageSemiDiaFromChiefRays;
}

/**
 * 硝材名から主波長での屈折率とアッベ数を計算してテーブルに反映
 * @param {number} rowIndex - テーブル行のインデックス
 * @param {string} materialName - 硝材名
 */
export function updateOpticalPropertiesFromMaterial(rowIndex, materialName) {
    try {
        console.log(`🔧 updateOpticalPropertiesFromMaterial: rowIndex=${rowIndex}, material="${materialName}"`);
        
        // 1. 表Sourceから主波長を取得する
        const primaryWavelength = getPrimaryWavelength();
        console.log(`📏 Primary wavelength: ${primaryWavelength} μm`);
        
        // 2. 表System dataから硝材を取得する（すでに引数で受け取っている）
        const cleanMaterialName = materialName ? materialName.trim() : "";
        if (!cleanMaterialName) {
            console.log('⚠️ Material name is empty, skipping calculation');
            return;
        }
        
        // 3. glass.jsからその硝材の屈折率とアッべ数、セルマイヤ係数を検索、取得する
        const glassData = getGlassDataWithSellmeier(cleanMaterialName);
        if (!glassData) {
            console.log(`⚠️ Glass data not found for material: ${cleanMaterialName}`);
            return;
        }
        
        console.log(`✅ Glass data found: ${glassData.name}`);
        console.log(`   d-line RI: ${glassData.nd}, Abbe: ${glassData.vd}`);
        
        // 現在の屈折率をチェック
        const allData = tableOpticalSystem.getData();
        if (rowIndex >= 0 && rowIndex < allData.length) {
            const currentData = allData[rowIndex];
            const currentRindex = parseFloat(currentData.rindex);
            const objectType = currentData["object type"];
            
            console.log(`🔍 Checking row ${rowIndex + 1} (Surf ${currentData.id}): objectType=${objectType}, rindex=${currentRindex}, material="${cleanMaterialName}"`);
            
            // Object行やImage行はスキップ
            if (objectType === "Object" || objectType === "Image") {
                console.log(`🔄 行${rowIndex + 1} (Surf ${currentData.id}): ${objectType}行のため更新をスキップ`);
                return;
            }
            
            // 屈折率が1.0の場合はスキップ（ただし、有効なMaterial名が設定されている場合は例外）
            if (!isNaN(currentRindex) && Math.abs(currentRindex - 1.0) < 0.000001) {
                // 数値のMaterial名かどうかチェック
                const numericValue = parseFloat(cleanMaterialName);
                const isNumericMaterial = !isNaN(numericValue) && numericValue > 0 && numericValue < 4;
                
                // Material名が有効なガラス名または数値の場合は、屈折率が1.0でも更新する
                const isValidMaterial = cleanMaterialName && cleanMaterialName !== "AIR" && (
                    isNumericMaterial ||
                    miscellaneousDB.some(g => g.name === cleanMaterialName) ||
                    oharaGlassDB.some(g => g.name === cleanMaterialName) ||
                    schottGlassDB.some(g => g.name === cleanMaterialName)
                );
                
                if (!isValidMaterial) {
                    console.log(`🔄 行${rowIndex + 1} (Surf ${currentData.id}): 屈折率が1.0で有効なMaterial名がないため更新をスキップ`);
                    return;
                } else {
                    console.log(`✅ 行${rowIndex + 1} (Surf ${currentData.id}): 屈折率は1.0だが有効なMaterial名"${cleanMaterialName}"があるため更新を続行`);
                }
            }
        } else {
            console.error(`❌ Invalid rowIndex: ${rowIndex}`);
            return;
        }
        
        // 4. 主波長に対する屈折率をセルマイヤ式で算出する
        let calculatedRI = glassData.nd; // デフォルトはd線の屈折率
        
        if (glassData.sellmeier) {
            calculatedRI = calculateRefractiveIndex(glassData.sellmeier, primaryWavelength);
            console.log(`🧮 Calculated RI at ${primaryWavelength}μm: ${calculatedRI.toFixed(6)}`);
        } else {
            console.log(`⚠️ Sellmeier coefficients not available for ${cleanMaterialName}, using d-line RI`);
        }
        
        // 5. 算出した屈折率をRef Indexカラムに出力する
        // 6. 取得したアッベ数をAbbeカラムに出力する
        // 特定のセルのみを更新（他のフィールドを変更しない）
        const allRows = (tableOpticalSystem && typeof tableOpticalSystem.getRows === 'function')
          ? tableOpticalSystem.getRows()
          : (tableOpticalSystem && typeof tableOpticalSystem.getData === 'function')
            ? tableOpticalSystem.getData().map((row, idx) => {
              const rowData = row && typeof row === 'object' ? { ...row } : {};
              return {
                getData: () => rowData,
                getIndex: () => idx,
                getCell: (field) => ({
                  setValue: (val) => {
                    rowData[field] = val;
                    try {
                      if (typeof tableOpticalSystem.updateRow === 'function') {
                        tableOpticalSystem.updateRow(rowData.id ?? idx, { [field]: val });
                      }
                    } catch (_) {}
                  }
                })
              };
            })
            : [];
        if (rowIndex >= 0 && rowIndex < allRows.length) {
            const targetRow = allRows[rowIndex];
            const targetData = targetRow.getData();

            const desiredRindexStr = calculatedRI.toFixed(6);
            const desiredAbbeStr = (glassData.vd !== undefined && glassData.vd !== null)
              ? String(glassData.vd)
              : null;

            const currentRindexNum = parseFloat(targetData.rindex);
            const desiredRindexNum = parseFloat(desiredRindexStr);
            const currentAbbeNum = parseFloat(targetData.abbe);
            const desiredAbbeNum = desiredAbbeStr !== null ? parseFloat(desiredAbbeStr) : null;

            const rindexEquivalent =
              (!Number.isNaN(currentRindexNum) && !Number.isNaN(desiredRindexNum) && Math.abs(currentRindexNum - desiredRindexNum) < 5e-7) ||
              String(targetData.rindex ?? '').trim() === desiredRindexStr;

            const abbeEquivalent =
              desiredAbbeStr === null
                ? true
                : (
                    (!Number.isNaN(currentAbbeNum) && desiredAbbeNum !== null && !Number.isNaN(desiredAbbeNum) && Math.abs(currentAbbeNum - desiredAbbeNum) < 1e-9) ||
                    String(targetData.abbe ?? '').trim() === desiredAbbeStr
                  );

            if (rindexEquivalent && abbeEquivalent) {
              console.log(`✅ Row ${rowIndex + 1} (Surf ${targetData.id}) optical properties already up-to-date; skipping setValue`);
              return;
            }

            console.log(`🎯 Updating row ${rowIndex + 1} (Surf ${targetData.id})`);

            runWithCellEditSuppressed(() => {
              if (!rindexEquivalent) {
                targetRow.getCell("rindex").setValue(desiredRindexStr);
              }

              // Abbe数が有効な値の場合のみ更新（数値屈折率の場合はundefinedのためスキップ）
              if (desiredAbbeStr !== null && !abbeEquivalent) {
                targetRow.getCell("abbe").setValue(desiredAbbeStr);
              }
            });

            if (glassData.vd !== undefined && glassData.vd !== null) {
                console.log(`✅ Updated optical properties for row ${rowIndex + 1} (Surf ${targetData.id}):`);
                console.log(`   Material: ${cleanMaterialName}`);
                console.log(`   Ref Index (at ${primaryWavelength}μm): ${calculatedRI.toFixed(6)}`);
                console.log(`   Abbe Number: ${glassData.vd}`);
            } else {
                console.log(`✅ Updated optical properties for row ${rowIndex + 1} (Surf ${targetData.id}):`);
                console.log(`   Material: ${cleanMaterialName}`);
                console.log(`   Ref Index (at ${primaryWavelength}μm): ${calculatedRI.toFixed(6)}`);
                console.log(`   Abbe Number: (not applicable for numeric refractive index)`);
            }
            
            // Avoid save storms during bulk material validation; dataChanged will persist once.
            try {
              if (typeof isValidatingMaterials === 'undefined' || !isValidatingMaterials) {
                saveTableData(tableOpticalSystem.getData());
              }
            } catch (_) {
              saveTableData(tableOpticalSystem.getData());
            }
        } else {
            console.error(`❌ Invalid rowIndex for update: ${rowIndex}`);
        }
        
    } catch (error) {
        console.error('❌ Error updating optical properties from material:', error);
    }
}

// テーブル全行の屈折率/アッベ数を現在の主波長で更新
// (main.js / table-source.js から呼ばれる)
export function updateAllRefractiveIndices() {
  try {
    if (!tableOpticalSystem || typeof tableOpticalSystem.getData !== 'function') {
      return;
    }
    const allData = tableOpticalSystem.getData();
    if (!Array.isArray(allData)) {
      return;
    }

    for (let rowIndex = 0; rowIndex < allData.length; rowIndex++) {
      const row = allData[rowIndex];
      const material = row?.material;
      if (typeof material === 'string' && material.trim() !== '') {
        updateOpticalPropertiesFromMaterial(rowIndex, material);
      }
    }
  } catch (error) {
    console.error('❌ updateAllRefractiveIndices error:', error);
  }
}

// ガラス名変更時に自動で屈折率とアッベ数を更新
// 屈折率・Abbe数変更時に自動でガラスを検索・設定
tableOpticalSystem.on("cellEdited", function(cell){
  try {
    // When we programmatically update cells (e.g. rindex/abbe derived from material),
    // Tabulator still fires cellEdited. Those events must NOT overwrite the user's
    // pending edit used by Apply-to-Design-Intent.
    if (isUpdatingFromCellEdit) {
      return;
    }

    // Special-case: editing Material triggers an automatic update of Ref Index / Abbe.
    // Those derived updates can arrive as separate cellEdited events and must not
    // become the "last edit" for Apply gating.
    try {
      const f = String(cell?.getField?.() ?? '');
      if (f === 'rindex' || f === 'abbe') {
        const lastF = String(globalThis.__lastUserOpticalSystemEditField ?? '');
        const lastAt = Number(globalThis.__lastUserOpticalSystemEditAt ?? 0);
        if (lastF === 'material' && lastAt && (Date.now() - lastAt) < 1200) {
          return;
        }
      }
    } catch (_) {}

    // Step2: show/update Apply Reason panel immediately after an edit.
    try { updateApplyReasonPanelFromCell(cell, 'edited'); } catch (_) {}

    // Clear local coordinate cache on data change
    try {
      clearLocalCoordsState();
    } catch (_) {}

    // System Constraints (BFL): update on edits (read-only; no table mutations).
    try { requestSystemConstraintsUpdate('cell-edited'); } catch (_) {}

    // Capture last edit for explicit Apply-to-Design-Intent gate.
    try {
      const field = cell.getField();
      const rowData = cell.getRow()?.getData?.() ?? null;
      const newValue = cell.getValue();
      let oldValue = typeof cell.getOldValue === 'function' ? cell.getOldValue() : undefined;
      if (oldValue === undefined) {
        try {
          const snap = globalThis.__cooptLastCellEditStart;
          const sid = rowData && typeof rowData.id === 'number' ? rowData.id : null;
          if (snap && sid !== null && snap.surfaceId === sid && String(snap.field) === String(field)) {
            const age = Date.now() - Number(snap.at || 0);
            if (Number.isFinite(age) && age >= 0 && age < 10000) {
              oldValue = snap.oldValue;
            }
          }
        } catch (_) {}
      }

      // Always treat the edited cell as the current Apply target, even for no-op edits.
      // Otherwise Apply can fall back to a previously selected neighboring cell (e.g. coef2)
      // and appear as if the coefficient index is shifted.
      if (rowData && typeof rowData.id === 'number') {
        globalThis.__lastSelectedSurfaceCell = {
          surfaceId: rowData.id,
          field,
        };
        globalThis.__lastActiveSurfaceCell = {
          surfaceId: rowData.id,
          field,
        };
      }

      // Avoid noisy no-op edits (often triggered by formatting/mutators).
      if (valuesEquivalentForApply(oldValue, newValue)) {
        try { updateApplyToDesignIntentButtonState(); } catch (_) {}
        return;
      }
      globalThis.__lastSurfaceEdit = { row: rowData, field, oldValue, newValue };

      // Record undo command for this surface edit
      try {
        if (window.undoHistory && window.SetSurfaceFieldCommand && !window.undoHistory.isExecuting) {
          const sysConfig = window.loadSystemConfigurations();
          const activeConfigId = sysConfig.activeConfiguration;
          const command = new window.SetSurfaceFieldCommand(
            activeConfigId,
            rowData.id,
            field,
            oldValue,
            newValue
          );
          window.undoHistory.record(command);
        }
      } catch (undoError) {
      }

      // Also track per-cell pending edits so Apply can fall back to the currently selected cell.
      // This stays in-memory only and is cleared after Apply triggers re-expand.
      if (rowData && typeof rowData.id === 'number') {
        if (!globalThis.__pendingSurfaceEdits || typeof globalThis.__pendingSurfaceEdits !== 'object') {
          globalThis.__pendingSurfaceEdits = Object.create(null);
        }
        const key = makePendingSurfaceEditKey(rowData.id, field);
        globalThis.__pendingSurfaceEdits[key] = { oldValue, newValue };
      }

      // Update Apply button state after capturing a meaningful pending edit.
      try { updateApplyToDesignIntentButtonState(); } catch (_) {}
    } catch (_) {
      // ignore
    }

    // フラグを設定してdataChangedとの競合を防ぐ
    isUpdatingFromCellEdit = true;
    
    const field = cell.getField();
    // Track last user edit field to avoid expensive whole-table material validation on unrelated edits.
    globalThis.__lastUserOpticalSystemEditField = field;
    globalThis.__lastUserOpticalSystemEditAt = Date.now();
    const row = cell.getRow();
    const rowData = row.getData();
    const value = cell.getValue();

    // If a user switches an existing surface to Coord Break, the row often already has
    // semidia/material/etc from a refractive surface. Because Coord Break reuses these
    // fields (semidia->decenterX, material->decenterY, ...), keeping the old values
    // causes an immediate unintended decenter (e.g., 4-5mm). Normalize defaults here.
    try {
      if (field === 'surfType' && rowData && typeof rowData === 'object') {
        const oldSurfType = String((typeof cell.getOldValue === 'function' ? cell.getOldValue() : '') ?? '').trim();
        const newSurfType = String(value ?? '').trim();

        const isOldCB = oldSurfType === 'Coord Break';
        const isNewCB = newSurfType === 'Coord Break';

        // Fields to preserve/restore when toggling CB on/off.
        const LENS_FIELDS = [
          'radius', 'thickness', 'semidia', 'material', 'rindex', 'abbe', 'conic',
          'coef1', 'coef2', 'coef3', 'coef4', 'coef5', 'coef6', 'coef7', 'coef8', 'coef9', 'coef10'
        ];

        if (!isOldCB && isNewCB) {
          // Stash previous refractive values so the user can switch back without losing data.
          const saved = {};
          for (const k of LENS_FIELDS) saved[k] = rowData[k];

          const patch = {
            __cooptSavedBeforeCoordTrans: saved,
            radius: 'INF',
            semidia: 0,
            material: 0,
            thickness: 0,
            rindex: 0,
            abbe: 0,
            conic: 0,
            coef1: 0,
            // Dedicated CoordTrans storage (stop reusing lens fields in core math)
            decenterX: 0,
            decenterY: 0,
            tiltX: 0,
            tiltY: 0,
            tiltZ: 0,
            order: 0,
            coef2: '',
            coef3: '',
            coef4: '',
            coef5: '',
            coef6: '',
            coef7: '',
            coef8: '',
            coef9: '',
            coef10: ''
          };

          try {
            const rid = (typeof rowData.id === 'number') ? rowData.id : Number(rowData.id);
            if (Number.isFinite(rid)) tableOpticalSystem.updateRow(rid, patch);
          } catch (e) {
            console.warn('⚠️ Failed to normalize Coord Break defaults:', e);
          }
        } else if (isOldCB && !isNewCB) {
          // Restore previous refractive values if we have them.
          const saved = rowData.__cooptSavedBeforeCoordTrans;
          if (saved && typeof saved === 'object') {
            const patch = { __cooptSavedBeforeCoordTrans: null };
            for (const k of LENS_FIELDS) {
              if (Object.prototype.hasOwnProperty.call(saved, k)) patch[k] = saved[k];
            }
            try {
              const rid = (typeof rowData.id === 'number') ? rowData.id : Number(rowData.id);
              if (Number.isFinite(rid)) tableOpticalSystem.updateRow(rid, patch);
            } catch (e) {
              console.warn('⚠️ Failed to restore values after leaving Coord Break:', e);
            }
          }
        }
      }
    } catch (_) {}

    // Root fix: even if the UI continues to show CB values in legacy columns,
    // always mirror edits into dedicated CB fields so ray-tracing/rendering
    // never depend on semidia/material/thickness for Coord Break behavior.
    try {
      const st = String(rowData?.surfType ?? '').trim();
      if (st === 'Coord Break') {
        const FIELD_TO_EXPLICIT = {
          semidia: 'decenterX',
          material: 'decenterY',
          rindex: 'tiltX',
          abbe: 'tiltY',
          conic: 'tiltZ',
          coef1: 'order'
        };

        const targetKey = FIELD_TO_EXPLICIT[String(field)];
        if (targetKey) {
          const rid = (typeof rowData.id === 'number') ? rowData.id : Number(rowData.id);
          if (Number.isFinite(rid)) {
            let v = cell.getValue();
            const s = String(v ?? '').trim();
            const n = (s === '') ? 0 : Number(s);
            if (targetKey === 'order') {
              const o = (n === 1) ? 1 : 0;
              tableOpticalSystem.updateRow(rid, { order: o });
            } else {
              tableOpticalSystem.updateRow(rid, { [targetKey]: Number.isFinite(n) ? n : 0 });
            }
          }
        }
      }
    } catch (_) {}

    // Surface Type edits should refresh dynamic headers immediately.
    // (rowSelected won't fire if the row was already selected.)
    try {
      if (field === 'surfType') {
        const st = String(value ?? '').trim();
        if (st === 'Coord Break') {
          updateTitlesForCoordTrans(true);
          updateCoefTitles('coordtrans');
        } else if (st === 'Aspheric even') {
          updateTitlesForCoordTrans(false);
          updateCoefTitles('even');
        } else if (st === 'Aspheric odd') {
          updateTitlesForCoordTrans(false);
          updateCoefTitles('odd');
        } else {
          updateTitlesForCoordTrans(false);
          updateCoefTitles();
        }

        // Keep Spot Diagram Surf dropdown in sync (CB insert/delete/toggle can shift numbering).
        try {
          setTimeout(() => {
            try {
              requestUpdateSurfaceNumberSelect();
            } catch (_) {}
          }, 0);
        } catch (_) {}
      }
    } catch (_) {}
    
    // データ配列内での正しいインデックスを取得
    const allData = tableOpticalSystem.getData();
    const rowIndex = allData.findIndex(data => data.id === rowData.id);
    
    console.log(`🔧 Cell edited: field=${field}, rowIndex=${rowIndex}, surfId=${rowData.id}, value=${value}`);
    
    // optimizeSemiDia フィールドで Auto が選択された場合、主光線追跡を実行
    if (field === "optimizeSemiDia" && (value === "A" || value === "a" || value === "Auto")) {
      console.log(`🎯 optimizeSemiDia に Auto が選択されました (rowIndex=${rowIndex}, surfId=${rowData.id})`);
      
      setTimeout(async () => {
        try {
          // Image面を見つける
          const allData = tableOpticalSystem.getData();
          const imageSurfaceIndex = allData.findIndex(data => 
            data["object type"] === "Image" || data.object === "Image"
          );
          
          if (imageSurfaceIndex === -1 || imageSurfaceIndex !== rowIndex) {
            alert('optimizeSemiDia の Auto はImage面でのみ使用できます。');
            cell.setValue('');
            isUpdatingFromCellEdit = false;
            return;
          }

          // Delegate to the unified implementation so this code path stays
          // consistent with other triggers (Blocks-only mode, INF normalization, etc.).
          await calculateImageSemiDiaFromChiefRays();

        } catch (error) {
          console.error('❌ Semi Dia 自動計算エラー:', error);
          alert('主光線追跡に失敗しました: ' + (error?.message ?? String(error)));
        } finally {
          isUpdatingFromCellEdit = false;
        }
      }, 100);

      // 処理を継続（他のイベント処理を妨げない）
      return;
    }


// 屈折率またはAbbe数に基づいて最も近いガラスを検索する関数
// Note: この機能は無効化されました
/*
function findClosestGlassByProperties(targetRindex, targetVd, maxResults = 20) {
    console.log(`🔍 Searching for glass with RI=${targetRindex}, Abbe=${targetVd}`);
    
    let bestMatch = null;
    let minError = Infinity;
    
    // 全データベースを検索
    const allGlasses = [
        ...miscellaneousDB.map(g => ({...g, source: 'miscellaneous'})),
        ...oharaGlassDB.map(g => ({...g, source: 'OHARA'})),
        ...schottGlassDB.map(g => ({...g, source: 'SCHOTT'}))
    ];
    
    console.log(`🔍 Total glasses in database: ${allGlasses.length}`);
    
    for (const glass of allGlasses) {
        // 屈折率とAbbe数の両方が定義されている場合のみ計算
        if (glass.nd && glass.vd) {
            const rindexError = Math.abs(glass.nd - targetRindex);
            const abbeError = Math.abs(glass.vd - targetVd);
            
            // 重み付き誤差（屈折率とAbbe数を同等に扱う）
            const totalError = rindexError + (abbeError * 0.01); // Abbe数の重みを調整
            
            if (totalError < minError) {
                minError = totalError;
                bestMatch = glass;
                console.log(`🎯 New best match: ${glass.name} (error: ${totalError.toFixed(4)})`);
            }
        }
    }
    
    if (bestMatch) {
        console.log(`✅ Found closest glass: ${bestMatch.name} (${bestMatch.source})`);
        console.log(`   RI: ${bestMatch.nd}, Abbe: ${bestMatch.vd}, Error: ${minError.toFixed(4)}`);
        return bestMatch;
    }
    
    console.log('❌ No suitable glass found');
    return null;
}
*/

  } catch (error) {
    console.warn("Cell edited error:", error);
  } finally {
    // フラグを解除（非同期処理を考慮して少し遅延）
    setTimeout(() => {
      isUpdatingFromCellEdit = false;
    }, 100);
  }
});


// 屈折率またはAbbe数入力時にガラスを自動検索・設定する関数
// Note: この機能は無効化されました
/*
function autoSetGlassByProperties(rowIndex, field, value) {
    try {
        const allData = tableOpticalSystem.getData();
        if (rowIndex < 0 || rowIndex >= allData.length) {
            console.error(`❌ Invalid rowIndex: ${rowIndex}`);
            return;
        }
        
        const rowData = allData[rowIndex];
        const currentMaterial = rowData.material?.trim();
        const objectType = rowData["object type"];
        
        // Object行やImage行はスキップ
        if (objectType === "Object" || objectType === "Image") {
            console.log(`⚠️ ${objectType}行のため自動検索をスキップ (row ${rowIndex + 1})`);
            return;
        }
        
        // Material列に値が既に設定されている場合はスキップ（AIRは除く）
        if (currentMaterial && currentMaterial !== "" && currentMaterial !== "AIR") {
            console.log(`⚠️ Material already set (${currentMaterial}) in row ${rowIndex + 1}, skipping auto-search`);
            return;
        }
        
        console.log(`🔍 Auto-searching glass for row ${rowIndex + 1} based on ${field}=${value}`);
        
        let targetRindex = null;
        let targetVd = null;
        
        if (field === 'rindex') {
            targetRindex = parseFloat(value);
            targetVd = parseFloat(rowData.abbe);
        } else if (field === 'abbe') {
            targetRindex = parseFloat(rowData.rindex);
            targetVd = parseFloat(value);
        }
        
        console.log(`🔍 Target values: RI=${targetRindex}, Abbe=${targetVd}`);
        
        // 両方の値が有効な数値の場合のみ検索
        if (!isNaN(targetRindex) && !isNaN(targetVd) && targetRindex > 0 && targetVd > 0) {
            console.log(`🔍 Starting glass search for RI=${targetRindex}, Abbe=${targetVd}`);
            const closestGlass = findClosestGlassByProperties(targetRindex, targetVd);
            
            if (closestGlass) {
                // 主波長を取得
                const primaryWavelength = getPrimaryWavelength();
                console.log(`🔍 Primary wavelength: ${primaryWavelength} μm`);
                
                // セルマイヤー係数を取得して屈折率を再計算
                const glassDataWithSellmeier = getGlassDataWithSellmeier(closestGlass.name);
                let calculatedRI = closestGlass.nd; // デフォルトはd線の屈折率
                
                if (glassDataWithSellmeier && glassDataWithSellmeier.sellmeier) {
                    calculatedRI = calculateRefractiveIndex(glassDataWithSellmeier.sellmeier, primaryWavelength);
                    console.log(`✅ Calculated RI for ${primaryWavelength}μm: ${calculatedRI.toFixed(6)}`);
                }
                
                // グローバルな更新状態を記録
                const glassPropertiesUpdates = getGlassPropertiesUpdatesMap();
                glassPropertiesUpdates.set(rowIndex, {
                    material: closestGlass.name,
                    rindex: calculatedRI,
                    abbe: closestGlass.vd
                });
                
                console.log(`✅ Auto-selected glass for row ${rowIndex + 1}:`);
                console.log(`   Material: ${closestGlass.name} (${closestGlass.source})`);
                console.log(`   Calculated RI: ${calculatedRI.toFixed(6)}`);
                console.log(`   Abbe Number: ${closestGlass.vd}`);
                
                // テーブルのセルを実際に更新
                const allRows = tableOpticalSystem.getRows();
                if (rowIndex >= 0 && rowIndex < allRows.length) {
                    const targetRow = allRows[rowIndex];
                    
                    // Material、屈折率、Abbe数を更新
                  runWithCellEditSuppressed(() => {
                    targetRow.getCell("material").setValue(closestGlass.name);
                    targetRow.getCell("rindex").setValue(calculatedRI.toFixed(6));
                    targetRow.getCell("abbe").setValue(closestGlass.vd.toString());
                  });
                    
                    console.log(`🔄 Updated table cells for row ${rowIndex + 1}`);
                    
                    // データを保存
                    saveTableData(tableOpticalSystem.getData());
                } else {
                    console.error(`❌ Invalid rowIndex for cell update: ${rowIndex}`);
                }
            } else {
                console.log(`❌ No suitable glass found for RI=${targetRindex}, Abbe=${targetVd}`);
            }
        } else {
            console.log(`⚠️ Invalid target values for glass search: RI=${targetRindex}, Abbe=${targetVd}`);
        }
      } catch (error) {
        console.error('❌ Error in auto glass selection:', error);
    }
}
*/

// グローバルに公開(テスト用)
// Note: nearest-glass helper functions are disabled in this path
if (typeof window !== 'undefined') {
  // findClosestGlassByProperties global export is intentionally removed
  // legacy global helper export was intentionally removed
  window['updateOpticalPropertiesFromMaterial'] = updateOpticalPropertiesFromMaterial;
  window['updateAllRefractiveIndices'] = updateAllRefractiveIndices;
  
  // Material名検証機能をテスト用に公開
  if (typeof validateMaterialNames === 'function') {
    window['validateMaterialNames'] = validateMaterialNames;
  }
  if (typeof showSimilarGlassNamesDialog === 'function') {
    window['showSimilarGlassNamesDialog'] = showSimilarGlassNamesDialog;
  }
  
  // テスト用の手動検証関数
  window['testMaterialValidation'] = function() {
    console.log('🧪 Manual material validation test');
    const data = tableOpticalSystem.getData();
    if (typeof validateMaterialNames === 'function') {
      validateMaterialNames(data);
    } else {
      console.warn('⚠️ validateMaterialNames is not available');
    }
  };
}

/**
 * 数値Materialに近いガラスを検索する
 * @param {number} targetNd - 目標屈折率
 * @param {number} targetVd - 目標Abbe数
 * @param {number} maxResults - 最大結果数
 * @returns {Array} ランキング順のガラスリスト
 */
function findSimilarGlasses(targetNd, targetVd, maxResults = 20) {
    const allGlasses = [];
    
    // すべてのガラスデータベースから取得
    const databases = getAllGlassDatabases();
    databases.forEach(db => {
        db.forEach(glass => {
            if (glass.name && glass.nd && glass.vd) {
                allGlasses.push(glass);
            }
        });
    });
    
    // 各ガラスとの差を計算
    const glassesWithDiff = allGlasses.map(glass => {
        // 屈折率の差（重み: 10倍）
        const ndDiff = Math.abs(glass.nd - targetNd) * 10;
        // Abbe数の差
        const vdDiff = Math.abs(glass.vd - targetVd);
        // 総合スコア（小さいほど類似）
        const totalDiff = ndDiff + vdDiff;
        
        return {
            name: glass.name,
            nd: glass.nd,
            vd: glass.vd,
            manufacturer: glass.manufacturer || 'Unknown',
            ndDiff: glass.nd - targetNd,
            vdDiff: glass.vd - targetVd,
            totalDiff: totalDiff
        };
    });
    
    // 差が小さい順にソート
    glassesWithDiff.sort((a, b) => a.totalDiff - b.totalDiff);
    
    // 上位maxResults件を返す
    return glassesWithDiff.slice(0, maxResults);
}

/**
 * ガラス検索ダイアログを表示
 * @param {object} rowData - 選択された行のデータ
 * @param {number} rowIndex - 行インデックス
 */
function showGlassSearchDialog(rowData, rowIndex) {
    const material = rowData.material ? rowData.material.trim() : "";
    
    if (!material) {
        alert('Materialが設定されていません。');
        return;
    }
    
    let currentNd, currentVd;
    let isNumericMaterial = false;
    
    // 数値Materialかチェック
    const numericValue = parseFloat(material);
    if (!isNaN(numericValue) && numericValue > 0 && numericValue < 4) {
        // 数値Material
        isNumericMaterial = true;
        currentNd = parseFloat(rowData.rindex) || numericValue;
        currentVd = parseFloat(rowData.abbe) || 50; // デフォルト値
        console.log(`🔍 ガラス検索開始 (数値Material): nd=${currentNd}, vd=${currentVd}`);
    } else {
        // ガラス名Material
        const glassData = getGlassDataWithSellmeier(material);
        if (!glassData || !glassData.nd || glassData.vd === undefined || glassData.vd === null) {
            alert(`ガラス "${material}" のデータが見つかりません。\nMaterialに有効なガラス名または数値の屈折率を設定してください。`);
            return;
        }
        currentNd = glassData.nd;
        currentVd = glassData.vd;
        console.log(`🔍 ガラス検索開始 (ガラス名Material): ${material}, nd=${currentNd}, vd=${currentVd}`);
    }
    
    // 類似ガラスを検索
    let similarGlasses = findSimilarGlasses(currentNd, currentVd, 50);
    
    // ガラス名Materialの場合、現在のガラス自身を結果から除外
    if (!isNumericMaterial) {
        similarGlasses = similarGlasses.filter(g => g.name !== material);
    }
    
    // 上位20件に絞る
    similarGlasses = similarGlasses.slice(0, 20);
    
    if (similarGlasses.length === 0) {
        alert('類似するガラスが見つかりませんでした。');
        return;
    }
    
    // ダイアログHTML作成
    const overlay = document.createElement('div');
    overlay.className = 'glass-search-overlay';
    
    const dialog = document.createElement('div');
    dialog.className = 'glass-search-dialog';
    
    // ヘッダー
    const header = document.createElement('div');
    header.className = 'glass-search-header';
    
    const materialDisplay = isNumericMaterial 
        ? `Material="${material}" (数値屈折率)`
        : `Material="${material}" (ガラス名)`;
    
    header.innerHTML = `
        <h3>🔍 類似ガラス検索</h3>
        <div class="glass-search-current">
            <strong>現在の値:</strong> ${materialDisplay}<br>
            <strong>屈折率 (nd):</strong> ${currentNd.toFixed(6)} / <strong>Abbe数 (vd):</strong> ${currentVd.toFixed(2)}
        </div>
    `;
    
    // ボディ（テーブル）
    const body = document.createElement('div');
    body.className = 'glass-search-body';
    
    const table = document.createElement('table');
    table.className = 'glass-search-table';
    
    let tableHTML = `
        <thead>
            <tr>
                <th>順位</th>
                <th>ガラス名</th>
                <th>メーカー</th>
                <th>nd (屈折率)</th>
                <th>Δnd</th>
                <th>vd (Abbe数)</th>
                <th>Δvd</th>
                <th>総合スコア</th>
            </tr>
        </thead>
        <tbody>
    `;
    
    similarGlasses.forEach((glass, index) => {
        const ndDiffClass = Math.abs(glass.ndDiff) < 0.001 ? 'glass-diff-good' : 
                           Math.abs(glass.ndDiff) < 0.01 ? 'glass-diff-fair' : 'glass-diff-poor';
        const vdDiffClass = Math.abs(glass.vdDiff) < 1 ? 'glass-diff-good' : 
                           Math.abs(glass.vdDiff) < 5 ? 'glass-diff-fair' : 'glass-diff-poor';
        
        tableHTML += `
            <tr data-glass-name="${glass.name}" data-glass-nd="${glass.nd}" data-glass-vd="${glass.vd}">
                <td class="glass-rank">${index + 1}</td>
                <td class="glass-name">${glass.name}</td>
                <td class="glass-manufacturer">${glass.manufacturer || 'Unknown'}</td>
                <td>${glass.nd.toFixed(6)}</td>
                <td class="glass-diff ${ndDiffClass}">${glass.ndDiff >= 0 ? '+' : ''}${glass.ndDiff.toFixed(6)}</td>
                <td>${glass.vd.toFixed(2)}</td>
                <td class="glass-diff ${vdDiffClass}">${glass.vdDiff >= 0 ? '+' : ''}${glass.vdDiff.toFixed(2)}</td>
                <td>${glass.totalDiff.toFixed(4)}</td>
            </tr>
        `;
    });
    
    tableHTML += '</tbody>';
    table.innerHTML = tableHTML;
    body.appendChild(table);
    
    // フッター（ボタン）
    const footer = document.createElement('div');
    footer.className = 'glass-search-footer';
    
    const selectBtn = document.createElement('button');
    selectBtn.className = 'btn-select';
    selectBtn.textContent = '選択したガラスに置き換え';
    selectBtn.disabled = true;
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'キャンセル';
    
    footer.appendChild(selectBtn);
    footer.appendChild(cancelBtn);
    
    // ダイアログ組み立て
    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    
    // イベントリスナー
    let selectedGlass = null;
    
    table.querySelectorAll('tbody tr').forEach(tr => {
        tr.addEventListener('click', () => {
            // 既存の選択を解除
            table.querySelectorAll('tbody tr').forEach(r => r.classList.remove('selected'));
            // 新しい選択
            tr.classList.add('selected');
            selectedGlass = {
                name: tr.dataset.glassName,
                nd: parseFloat(tr.dataset.glassNd),
                vd: parseFloat(tr.dataset.glassVd)
            };
            selectBtn.disabled = false;
        });
    });
    
    // 選択ボタン
    selectBtn.addEventListener('click', () => {
        if (selectedGlass) {
            console.log(`✅ ガラス選択: ${selectedGlass.name}`);
            
            // Materialを置き換え
            const allRows = tableOpticalSystem.getRows();
            if (rowIndex >= 0 && rowIndex < allRows.length) {
                const targetRow = allRows[rowIndex];
                targetRow.getCell('material').setValue(selectedGlass.name);
                
                // 屈折率とAbbe数も更新
                updateOpticalPropertiesFromMaterial(rowIndex, selectedGlass.name);
                
                console.log(`✅ Material更新完了: ${material} → ${selectedGlass.name}`);
            }
            
            document.body.removeChild(overlay);
        }
    });
    
    // キャンセルボタン
    cancelBtn.addEventListener('click', () => {
        console.log('🚫 ガラス検索キャンセル');
        document.body.removeChild(overlay);
    });
    
    // オーバーレイクリックで閉じる
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
    
    // ダイアログ表示
    document.body.appendChild(overlay);
}

// ガラス検索ボタンのイベントリスナー
setTimeout(() => {
  if (typeof document === 'undefined') return;
  const addSurfBtn = document.getElementById('add-optical-system-btn');
  if (addSurfBtn) {
    addSurfBtn.addEventListener('click', () => {
      try {
        if (!tableOpticalSystem) {
          alert('テーブルが初期化されていません。ページを再読み込みしてください。');
          return;
        }

        const selectedRows = tableOpticalSystem.getSelectedRows();
        const allRows = tableOpticalSystem.getRows();
        const allData = tableOpticalSystem.getData();

        // Default: insert before Image row if present; otherwise append.
        let insertIndex = allData.findIndex(r => (r && (r["object type"] === 'Image' || r.object === 'Image')));
        if (insertIndex < 0) insertIndex = tableOpticalSystem.getDataCount();

        if (selectedRows.length > 0) {
          const selectedRow = selectedRows[0];
          const idx = allRows.indexOf(selectedRow);
          if (idx >= 0) {
            const selectedData = selectedRow.getData?.() ?? null;
            const selectedIsImage = selectedData && (selectedData["object type"] === 'Image' || selectedData.object === 'Image');
            // If Image row is selected, insert *before* it.
            insertIndex = selectedIsImage ? idx : (idx + 1);
          }
        }

        const newRow = {
          id: tableOpticalSystem.getDataCount() + 1,
          "object type": "",
          surfType: "Spherical",
          comment: "",
          radius: "",
          thickness: "",
          semidia: "",
          optimizeSemiDia: "",
          material: "AIR",
          rindex: "",
          abbe: "",
          conic: "",
          coef1: "",
          coef2: "",
          coef3: "",
          coef4: "",
          coef5: "",
          coef6: "",
          coef7: "",
          coef8: "",
          coef9: "",
          coef10: "",
        };

        tableOpticalSystem.addRow(newRow, false, insertIndex).then(() => {
          const data = tableOpticalSystem.getData();
          renumberIds(data);
          updateObjectTypes(data);
          tableOpticalSystem.replaceData(data);
          saveTableData(data);

          // Refresh Surf dropdown immediately (otherwise it only updates after reload).
          try {
            setTimeout(() => {
              try {
                requestUpdateSurfaceNumberSelect();
              } catch (_) {}
            }, 0);
          } catch (_) {}
        }).catch((e) => {
          console.error('❌ Failed to add optical system row:', e);
        });
      } catch (e) {
        console.error('❌ Add Surf error:', e);
      }
    });
  }

  const deleteSurfBtn = document.getElementById('delete-optical-system-row-btn');
  if (deleteSurfBtn) {
    deleteSurfBtn.addEventListener('click', () => {
      try {
        if (!tableOpticalSystem) {
          alert('テーブルが初期化されていません。ページを再読み込みしてください。');
          return;
        }

        const selectedRows = tableOpticalSystem.getSelectedRows();
        if (!selectedRows || selectedRows.length === 0) {
          alert('削除する行を選択してください。');
          return;
        }

        const row = selectedRows[0];
        const rowData = row.getData?.() ?? null;
        const objectType = rowData ? (rowData["object type"] ?? rowData.object ?? '') : '';
        if (objectType === 'Object' || objectType === 'Image') {
          alert('Object 行 / Image 行は削除できません。');
          return;
        }

        row.delete();
        setTimeout(() => {
          const data = tableOpticalSystem.getData();
          renumberIds(data);
          updateObjectTypes(data);
          tableOpticalSystem.replaceData(data);
          saveTableData(data);

          // Refresh Surf dropdown immediately (otherwise it only updates after reload).
          try {
            setTimeout(() => {
              try {
                requestUpdateSurfaceNumberSelect();
              } catch (_) {}
            }, 0);
          } catch (_) {}
        }, 0);
      } catch (e) {
        console.error('❌ Del Surf error:', e);
      }
    });
  }

    const findGlassBtn = document.getElementById('find-glass-btn');
    if (findGlassBtn) {
        findGlassBtn.addEventListener('click', () => {
            const selectedRows = tableOpticalSystem.getSelectedRows();
            
            if (selectedRows.length === 0) {
                alert('行を選択してください。');
                return;
            }
            
            const row = selectedRows[0];
            const rowData = row.getData();
            const rowIndex = tableOpticalSystem.getRows().indexOf(row);
            
            showGlassSearchDialog(rowData, rowIndex);
        });
    }
}, 100);

/**
 * Image面のSemi Diaを主光線追跡により自動計算
 * optimizeSemiDia="A"の場合に呼び出される
 */
async function calculateImageSemiDiaFromChiefRays() {
    try {
    const emitChiefRayDiag = (reason, details = {}) => {
      const payload = {
        reason,
        ...details
      };
      try {
        if (typeof window !== 'undefined') {
          window.__LAST_CHIEF_RAY_DIAG = {
            at: new Date().toISOString(),
            source: 'calculateImageSemiDiaFromChiefRays',
            ...payload
          };

          const openerRef = (window as any).opener;
          if (openerRef && !openerRef.closed) {
            const mirrored = {
              at: new Date().toISOString(),
              source: 'calculateImageSemiDiaFromChiefRays',
              ...payload
            };
            try {
              openerRef.__LAST_CHIEF_RAY_DIAG = mirrored;
            } catch (_) {}
            try {
              openerRef.postMessage?.({ type: 'COOPT_CHIEF_RAY_DIAG', payload: mirrored }, '*');
            } catch (_) {}
          }
        }
      } catch (_) {}
    };

    // Blocks-first / Blocks-only を含め、常に「評価系と同じ rows」を使う。
    // Expanded table は Blocks-only だと no-op / stale になり得るため。
    const opticalSystemRows = (typeof window !== 'undefined' && typeof window.getOpticalSystemRows === 'function')
      ? window.getOpticalSystemRows(tableOpticalSystem)
      : tableOpticalSystem.getData();

    // Image面を見つける
    const imageSurfaceIndex = opticalSystemRows.findIndex(data =>
      data["object type"] === "Image" || data.object === "Image"
    );
        if (imageSurfaceIndex === -1) {
            console.warn('⚠️ Image面が見つかりません');
            emitChiefRayDiag('image-surface-not-found', {
              opticalSystemRowsCount: Array.isArray(opticalSystemRows) ? opticalSystemRows.length : null
            });
            return false;
        }
    const imageSurface = opticalSystemRows[imageSurfaceIndex];
        // optimizeSemiDia gate:
        // In Blocks-first / Blocks-only mode, the canonical state lives in Design Intent blocks.
        // The expanded table row may not have synced optimizeSemiDia yet, so check blocks too.
        const rowOpt = String(imageSurface.optimizeSemiDia ?? '').trim();
        let shouldAuto = (rowOpt === 'A' || rowOpt === 'a');

        if (!shouldAuto) {
          try {
            if (typeof loadSystemConfigurations === 'function') {
              const systemConfig = loadSystemConfigurations();
              const activeId = systemConfig?.activeConfigId;
              const cfg = Array.isArray(systemConfig?.configurations)
                ? systemConfig.configurations.find(c => c && c.id === activeId)
                : null;
              const blocks = Array.isArray(cfg?.blocks) ? cfg.blocks : null;
              const imgBlock = blocks ? [...blocks].reverse().find(b => b && String(b.blockType ?? '') === 'ImageSurface') : null;
              const blkOptRaw = imgBlock?.parameters?.optimizeSemiDia;
              const blkOpt = String(blkOptRaw ?? '').trim();
              if (blkOpt === 'A' || blkOpt === 'a' || blkOpt.toUpperCase() === 'AUTO') {
                shouldAuto = true;
                // Best-effort: keep table row consistent for later checks.
                const imageId = imageSurface?.id;
                if (imageId !== null && imageId !== undefined) {
                  try { tableOpticalSystem.updateRow(imageId, { optimizeSemiDia: 'A' }); } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }

        if (!shouldAuto) {
          return false;
        }
        // 光学系データとObjectデータを取得
        const objectRows = (typeof window !== 'undefined' && typeof window.getObjectRows === 'function')
          ? window.getObjectRows(window.tableObject)
          : (window.tableObject ? window.tableObject.getData() : []);
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ Objectが設定されていません');
          emitChiefRayDiag('object-rows-empty');
            return false;
        }
        // 主波長を取得
        const primaryWavelength = (typeof window.getPrimaryWavelength === 'function') 
            ? Number(window.getPrimaryWavelength()) || 0.5876 
            : 0.5876;
        const toNumber = (value) => {
          const parsed = parseFloat(String(value ?? ''));
          return Number.isFinite(parsed) ? parsed : 0;
        };
        const normalizeObjectSampleForTrace = (row, isInfinite) => {
          const posNorm = String(row?.position ?? '').trim().toLowerCase();
          if (posNorm === 'imageheight' && typeof window.convertImageHeightToEffectiveObject === 'function') {
            try {
              const effective = window.convertImageHeightToEffectiveObject(
                row,
                opticalSystemRows,
                primaryWavelength,
                isInfinite ? 'infinite' : 'finite'
              );
              if (effective && typeof effective === 'object') {
                return {
                  x: toNumber(effective?.xHeightAngle ?? effective?.x),
                  y: toNumber(effective?.yHeightAngle ?? effective?.y),
                  z: 0
                };
              }
            } catch (error) {
              console.warn('[calculateImageSemiDiaFromChiefRays] ImageHeight conversion failed, using raw value:', error);
            }
          }
          return {
            x: toNumber(row?.xHeightAngle ?? row?.x ?? row?.height ?? row?.heightX),
            y: toNumber(row?.yHeightAngle ?? row?.y ?? row?.height ?? row?.heightY),
            z: 0
          };
        };
        // 主光線のみを生成（光線数=1）
        const objectSurface = opticalSystemRows[0];
        const objectThickness = objectSurface?.thickness;
        const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
        const allObjectPositions = objectRows.map(obj => normalizeObjectSampleForTrace(obj, isInfiniteSystem));
        let crossBeamResult;
        if (isInfiniteSystem) {
          // In Blocks-only mode, ObjectSurface with mode=INF expands to Object row thickness='INF'.
          // That token is useful as a mode marker, but it breaks ray tracing because it makes
          // the next surface effectively unreachable. For infinite-system tracing, use a
          // normalized copy with a finite object-to-first-surface distance.
          const tracingRows = opticalSystemRows.map((r, idx) => {
            if (idx !== 0) return r;
            const o = (r && typeof r === 'object') ? r : {};
            return { ...o, thickness: 0 };
          });
          const objectAngles = allObjectPositions.map(pos => ({ x: pos.x || 0, y: pos.y || 0 }));
          crossBeamResult = await window.generateInfiniteSystemCrossBeam(tracingRows, objectAngles, {
            rayCount: 1,
            debugMode: false,
            wavelength: primaryWavelength,
            crossType: 'both',
            targetSurfaceIndex: imageSurfaceIndex,
            angleUnit: 'deg',
            chiefZ: -20
          });
        } else {
            crossBeamResult = await window.generateCrossBeam(opticalSystemRows, allObjectPositions, {
                rayCount: 1,
                debugMode: false,
                wavelength: primaryWavelength,
                crossType: 'both'
            });
        }

        if (!crossBeamResult) {
          emitChiefRayDiag('crossbeam-result-null', {
            isInfiniteSystem,
            imageSurfaceIndex,
            objectCount: allObjectPositions.length,
            wavelength: primaryWavelength
          });
        }
        // 主光線のImage面での最大高さを計算
        let rays = [];
        if (crossBeamResult) {
            if (Array.isArray(crossBeamResult.allTracedRays) && crossBeamResult.allTracedRays.length > 0) {
                rays = crossBeamResult.allTracedRays;
            } else if (crossBeamResult.objectResults && crossBeamResult.objectResults.length > 0) {
                // 無限系/有限系ともに tracedRays を優先（raw rays は rayPath を持たない場合がある）
                crossBeamResult.objectResults.forEach(obj => {
                  const traced = Array.isArray(obj?.tracedRays) ? obj.tracedRays : [];
                  for (const r of traced) {
                    if (r && (Array.isArray(r.rayPath) || Array.isArray(r.rayPathToTarget) || Array.isArray(r.path))) {
                      rays.push(r);
                    }
                  }
                });
            } else if (crossBeamResult.rays && crossBeamResult.rays.length > 0) {
                rays = crossBeamResult.rays;
            }
        }
        if (rays.length > 0) {
            let maxHeight = 0;
            let computedAny = false;

            // traceRay() rayPath convention:
            // rayPath[0] = start point; then hit points for each non-Object, non-CB surface.
            const __isCoordTransRow = (row) => {
              const st = String(row?.surfType ?? row?.['surf type'] ?? '').trim().toLowerCase();
              return st === 'coord trans' || st === 'coordinate break' || st === 'ct' || st === 'coordtrans';
            };
            const __isObjectRow = (row) => {
              const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
              return t === 'object';
            };
            const __isGapRow = (row) => {
              const blockType = String(row?._blockType ?? '').trim();
              return blockType === 'Gap';
            };
            const __rayPathPointIndexForSurfaceIndex = (rows, surfaceIndex0) => {
              if (!Array.isArray(rows)) return null;
              const sIdx = Number(surfaceIndex0);
              if (!Number.isInteger(sIdx) || sIdx < 0 || sIdx >= rows.length) return null;
              const row = rows[sIdx];
              if (__isObjectRow(row) || __isCoordTransRow(row) || __isGapRow(row)) return null;
              let count = 0;
              for (let i = 0; i <= sIdx; i++) {
                const r = rows[i];
                if (__isObjectRow(r) || __isCoordTransRow(r) || __isGapRow(r)) continue;
                count++;
              }
              return count > 0 ? count : null;
            };
            const imageRayPathIndex = __rayPathPointIndexForSurfaceIndex(opticalSystemRows, imageSurfaceIndex);
            const __pickImagePointFromRay = (ray) => {
              const candidatePaths = [ray?.rayPath, ray?.rayPathToTarget, ray?.path, ray?.originalRay?.rayPath];
              for (const path of candidatePaths) {
                if (!Array.isArray(path) || path.length === 0) continue;

                if (imageRayPathIndex !== null && imageRayPathIndex >= 0 && imageRayPathIndex < path.length) {
                  const direct = path[imageRayPathIndex];
                  if (direct && Number.isFinite(Number(direct.x)) && Number.isFinite(Number(direct.y))) {
                    return direct;
                  }
                }

                for (let i = path.length - 1; i >= 0; i--) {
                  const p = path[i];
                  const pSurfaceIndex = Number(p?.surfaceIndex ?? p?.surface ?? p?.surfaceIdx);
                  if (Number.isInteger(pSurfaceIndex) && pSurfaceIndex === imageSurfaceIndex) {
                    if (Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y))) {
                      return p;
                    }
                  }
                }

                for (let i = path.length - 1; i >= 0; i--) {
                  const p = path[i];
                  if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
                    return p;
                  }
                }
              }
              return null;
            };

            // Build Image surface transformation info inline to convert global coordinates back to local
            let imageSurfaceInfo = null;
            try {
              // Helper functions
              const vec3 = (x, y, z) => ({ x, y, z });
              const createIdentityMatrix = () => [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 0, 1, 0],
                [0, 0, 0, 1]
              ];
              const multiplyMatrices = (a, b) => {
                const result = Array(4).fill(null).map(() => Array(4).fill(0));
                for (let i = 0; i < 4; i++) {
                  for (let j = 0; j < 4; j++) {
                    for (let k = 0; k < 4; k++) {
                      result[i][j] += a[i][k] * b[k][j];
                    }
                  }
                }
                return result;
              };
              const applyMatrixToVector = (matrix, vector) => {
                const x = matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z;
                const y = matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z;
                const z = matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z;
                return { x, y, z };
              };
              const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
              const scale = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });
              const isCoordTransRow = (r) => {
                const st = String(r?.surfType ?? r?.['surf type'] ?? '').trim().toLowerCase();
                return st === 'coord trans' || st === 'coordinate break' || st === 'ct' || st === 'coordtrans';
              };
              const createRotationMatrix = (tiltX, tiltY, tiltZ, order = 1) => {
                const rx = tiltX * Math.PI / 180;
                const ry = tiltY * Math.PI / 180;
                const rz = tiltZ * Math.PI / 180;
                const Rx = [[1,0,0,0],[0,Math.cos(rx),-Math.sin(rx),0],[0,Math.sin(rx),Math.cos(rx),0],[0,0,0,1]];
                const Ry = [[Math.cos(ry),0,Math.sin(ry),0],[0,1,0,0],[-Math.sin(ry),0,Math.cos(ry),0],[0,0,0,1]];
                const Rz = [[Math.cos(rz),-Math.sin(rz),0,0],[Math.sin(rz),Math.cos(rz),0,0],[0,0,1,0],[0,0,0,1]];
                if (order === 0) return multiplyMatrices(multiplyMatrices(Rx, Ry), Rz);
                return multiplyMatrices(multiplyMatrices(Rz, Ry), Rx);
              };
              
              // Calculate surface origins
              let currentOrigin = vec3(0, 0, 0);
              let currentRotMatrix = createIdentityMatrix();
              const ex = vec3(1, 0, 0), ey = vec3(0, 1, 0), ez = vec3(0, 0, 1);
              
              for (let s = 0; s <= imageSurfaceIndex; s++) {
                const surface = opticalSystemRows[s];
                const previousSurface = s > 0 ? opticalSystemRows[s - 1] : null;
                let surfaceOrigin, surfaceRotMatrix;
                
                if (isCoordTransRow(surface)) {
                  const decenterX = Number(surface.decenterX ?? surface['Decenter X'] ?? 0) || 0;
                  const decenterY = Number(surface.decenterY ?? surface['Decenter Y'] ?? 0) || 0;
                  const decenterZ = Number(surface.thickness ?? 0) || 0;
                  const tiltX = Number(surface.tiltX ?? surface['Tilt X'] ?? 0) || 0;
                  const tiltY = Number(surface.tiltY ?? surface['Tilt Y'] ?? 0) || 0;
                  const tiltZ = Number(surface.tiltZ ?? surface['Tilt Z'] ?? 0) || 0;
                  const transformOrder = Number(surface.transformOrder ?? surface['Transform Order'] ?? 1);
                  let thickness = previousSurface ? (Number(previousSurface.__cooptGapThickness ?? previousSurface.thickness) || 0) : 0;
                  if (!isFinite(thickness)) thickness = 0;
                  
                  const previousRotMatrix = currentRotMatrix;
                  const singleRotMatrix = createRotationMatrix(tiltX, tiltY, tiltZ, transformOrder);
                  const newRotMatrix = multiplyMatrices(singleRotMatrix, currentRotMatrix);
                  
                  if (transformOrder === 0) {
                    const dx_term = scale(applyMatrixToVector(previousRotMatrix, ex), decenterX);
                    const dy_term = scale(applyMatrixToVector(previousRotMatrix, ey), decenterY);
                    const dz_term = scale(applyMatrixToVector(previousRotMatrix, ez), decenterZ);
                    const tz_term = scale(applyMatrixToVector(previousRotMatrix, ez), thickness);
                    surfaceOrigin = add(add(add(add(currentOrigin, dx_term), dy_term), dz_term), tz_term);
                  } else {
                    const dx_term = scale(applyMatrixToVector(newRotMatrix, ex), decenterX);
                    const dy_term = scale(applyMatrixToVector(newRotMatrix, ey), decenterY);
                    const dz_term = scale(applyMatrixToVector(newRotMatrix, ez), decenterZ);
                    const tz_term = scale(applyMatrixToVector(previousRotMatrix, ez), thickness);
                    surfaceOrigin = add(add(add(add(currentOrigin, dx_term), dy_term), dz_term), tz_term);
                  }
                  surfaceRotMatrix = newRotMatrix;
                } else {
                  let thickness = previousSurface ? (Number(previousSurface.__cooptGapThickness ?? previousSurface.thickness) || 0) : 0;
                  if (!isFinite(thickness)) thickness = 0;
                  const tz_term = scale(applyMatrixToVector(currentRotMatrix, ez), thickness);
                  surfaceOrigin = add(currentOrigin, tz_term);
                  surfaceRotMatrix = currentRotMatrix;
                }
                
                if (s === imageSurfaceIndex) {
                  imageSurfaceInfo = { origin: surfaceOrigin, rotationMatrix: surfaceRotMatrix };
                }
                
                currentOrigin = surfaceOrigin;
                currentRotMatrix = surfaceRotMatrix;
              }
            } catch (err) {
              console.warn('⚠️ Failed to build surface data:', err);
            }

            rays.forEach((ray, rayIndex) => {
              const imagePoint = __pickImagePointFromRay(ray);
              if (imagePoint) {
                // Transform from global coordinates to Image surface local coordinates
                let localX = imagePoint.x;
                let localY = imagePoint.y;
                if (imageSurfaceInfo && imageSurfaceInfo.origin && imageSurfaceInfo.rotationMatrix) {
                  // Translate to surface origin
                  const dx = imagePoint.x - imageSurfaceInfo.origin.x;
                  const dy = imagePoint.y - imageSurfaceInfo.origin.y;
                  const dz = imagePoint.z - imageSurfaceInfo.origin.z;
                  
                  // Apply inverse rotation (transpose of rotation matrix)
                  const R = imageSurfaceInfo.rotationMatrix;
                  localX = R[0][0] * dx + R[1][0] * dy + R[2][0] * dz;
                  localY = R[0][1] * dx + R[1][1] * dy + R[2][1] * dz;
                }
                
                if (isFinite(localX) && isFinite(localY)) {
                  computedAny = true;
                  // X, Y両方を考慮した高さを計算（二次元の距離）
                  const height = Math.sqrt(localX * localX + localY * localY);
                  if (height > maxHeight) {
                    maxHeight = height;
                  }
                }
              }
            });
            if (computedAny) {
              const imageId = imageSurface?.id;

              // Also persist into Blocks (Design Intent canonical) when available.
              try {
                if (typeof loadSystemConfigurations === 'function') {
                  const systemConfig = loadSystemConfigurations();
                  const activeId = systemConfig?.activeConfigId;
                  const cfgIdx = Array.isArray(systemConfig?.configurations)
                    ? systemConfig.configurations.findIndex(c => c && c.id === activeId)
                    : -1;
                  const activeCfg = cfgIdx >= 0 ? systemConfig.configurations[cfgIdx] : null;
                  if (activeCfg && Array.isArray(activeCfg.blocks)) {
                    const imgBlock = [...activeCfg.blocks].reverse().find(b => b && String(b.blockType ?? '') === 'ImageSurface');
                    if (imgBlock) {
                      if (!imgBlock.parameters || typeof imgBlock.parameters !== 'object') imgBlock.parameters = {};
                      imgBlock.parameters.semidia = maxHeight;
                      if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                      activeCfg.metadata.modified = new Date().toISOString();
                      saveSystemConfigurations(systemConfig);
                    }
                  }
                }
              } catch (e) {
                console.warn('⚠️ Failed to persist auto semidia into blocks:', e);
              }

              // isUpdatingFromCellEditフラグをオフにして更新
              isUpdatingFromCellEdit = false;

              // 更新前の全データを確認
              const beforeData = tableOpticalSystem.getData();

              // tableOpticalSystem.updateRowを使って確実に更新（optimizeSemiDiaは"A"のまま残す）
              if (imageId !== null && imageId !== undefined) {
                tableOpticalSystem.updateRow(imageId, { semidia: maxHeight });
              }

              // 更新後の全データを確認
              const afterData = tableOpticalSystem.getData();

              // テーブルを保存
              if (typeof saveTableData === 'function') {
                saveTableData(tableOpticalSystem.getData());
              }

                try {
                  if (typeof w.autoSetBlockAperturesFromLargestObjectCondition === 'function') {
                    w.autoSetBlockAperturesFromLargestObjectCondition();
                  }
                } catch (e) {
                  console.warn('⚠️ Failed to auto-sync block apertures from largest object condition:', e);
                }
            } else {
              emitChiefRayDiag('image-hit-computation-failed', {
                raysCount: rays.length,
                imageSurfaceIndex,
                imageRayPathIndex
              });
              alert('主光線の高さを計算できませんでした。');
            }
          } else {
            emitChiefRayDiag('no-rays-from-crossbeam', {
              isInfiniteSystem,
              hasRays: !!crossBeamResult?.rays,
              raysLength: Array.isArray(crossBeamResult?.rays) ? crossBeamResult.rays.length : null,
              hasAllTracedRays: !!crossBeamResult?.allTracedRays,
              allTracedRaysLength: Array.isArray(crossBeamResult?.allTracedRays) ? crossBeamResult.allTracedRays.length : null,
              hasObjectResults: !!crossBeamResult?.objectResults,
              objectResultsLength: Array.isArray(crossBeamResult?.objectResults) ? crossBeamResult.objectResults.length : null
            });
            alert('主光線追跡に失敗しました。');
          }
        }
    catch (error) {
      console.error('❌ Semi Dia 自動計算エラー:', error);
      emitChiefRayDiag('exception', {
        message: error?.message ?? String(error)
      });
      alert('主光線追跡に失敗しました: ' + error.message);
    } finally {
      // フラグを解除（非同期処理を考慮して少し遅延）
      setTimeout(() => {
        isUpdatingFromCellEdit = false;
      }, 100);
    }

    return true;
}

// 屈折率またはAbbe数に基づいて最も近いガラスを検索する関数
// Note: この機能は無効化されました
/*
function findClosestGlassByProperties(targetRindex, targetVd, maxResults = 20) {
    console.log(`🔍 Searching for glass with RI=${targetRindex}, Abbe=${targetVd}`);
    
    let bestMatch = null;
    let minError = Infinity;
    
    // 全データベースを検索
    const allGlasses = [
        ...miscellaneousDB.map(g => ({...g, source: 'miscellaneous'})),
        ...oharaGlassDB.map(g => ({...g, source: 'OHARA'})),
        ...schottGlassDB.map(g => ({...g, source: 'SCHOTT'}))
    ];
    
    console.log(`🔍 Total glasses in database: ${allGlasses.length}`);
    
    for (const glass of allGlasses) {
        // 屈折率とAbbe数の両方が定義されている場合のみ計算
        if (glass.nd && glass.vd) {
            const rindexError = Math.abs(glass.nd - targetRindex);
            const abbeError = Math.abs(glass.vd - targetVd);
            
            // 重み付き誤差（屈折率とAbbe数を同等に扱う）
            const totalError = rindexError + (abbeError * 0.01); // Abbe数の重みを調整
            
            if (totalError < minError) {
                minError = totalError;
                bestMatch = glass;
                console.log(`🎯 New best match: ${glass.name} (error: ${totalError.toFixed(4)})`);
            }
        }
    }
    
    if (bestMatch) {
        console.log(`✅ Found closest glass: ${bestMatch.name} (${bestMatch.source})`);
        console.log(`   RI: ${bestMatch.nd}, Abbe: ${bestMatch.vd}, Error: ${minError.toFixed(4)}`);
        return bestMatch;
    }
    
    console.log('❌ No suitable glass found');
    return null;
}
*/

// 屈折率またはAbbe数入力時にガラスを自動検索・設定する関数
// Note: この機能は無効化されました
/*
function autoSetGlassByProperties(rowIndex, field, value) {
    try {
        const allData = tableOpticalSystem.getData();
        if (rowIndex < 0 || rowIndex >= allData.length) {
            console.error(`❌ Invalid rowIndex: ${rowIndex}`);
            return;
        }
        
        const rowData = allData[rowIndex];
        const currentMaterial = rowData.material?.trim();
        const objectType = rowData["object type"];
        
        // Object行やImage行はスキップ
        if (objectType === "Object" || objectType === "Image") {
            console.log(`⚠️ ${objectType}行のため自動検索をスキップ (row ${rowIndex + 1})`);
            return;
        }
        
        // Material列に値が既に設定されている場合はスキップ（AIRは除く）
        if (currentMaterial && currentMaterial !== "" && currentMaterial !== "AIR") {
            console.log(`⚠️ Material already set (${currentMaterial}) in row ${rowIndex + 1}, skipping auto-search`);
            return;
        }
        
        console.log(`🔍 Auto-searching glass for row ${rowIndex + 1} based on ${field}=${value}`);
        
        let targetRindex = null;
        let targetVd = null;
        
        if (field === 'rindex') {
            targetRindex = parseFloat(value);
            targetVd = parseFloat(rowData.abbe);
        } else if (field === 'abbe') {
            targetRindex = parseFloat(rowData.rindex);
            targetVd = parseFloat(value);
        }
        
        console.log(`🔍 Target values: RI=${targetRindex}, Abbe=${targetVd}`);
        
        // 両方の値が有効な数値の場合のみ検索
        if (!isNaN(targetRindex) && !isNaN(targetVd) && targetRindex > 0 && targetVd > 0) {
            console.log(`🔍 Starting glass search for RI=${targetRindex}, Abbe=${targetVd}`);
            const closestGlass = findClosestGlassByProperties(targetRindex, targetVd);
            
            if (closestGlass) {
                // 主波長を取得
                const primaryWavelength = getPrimaryWavelength();
                console.log(`🔍 Primary wavelength: ${primaryWavelength} μm`);
                
                // セルマイヤー係数を取得して屈折率を再計算
                const glassDataWithSellmeier = getGlassDataWithSellmeier(closestGlass.name);
                let calculatedRI = closestGlass.nd; // デフォルトはd線の屈折率
                
                if (glassDataWithSellmeier && glassDataWithSellmeier.sellmeier) {
                    calculatedRI = calculateRefractiveIndex(glassDataWithSellmeier.sellmeier, primaryWavelength);
                    console.log(`✅ Calculated RI for ${primaryWavelength}μm: ${calculatedRI.toFixed(6)}`);
                }
                
                // グローバルな更新状態を記録
                const glassPropertiesUpdates = getGlassPropertiesUpdatesMap();
                glassPropertiesUpdates.set(rowIndex, {
                    material: closestGlass.name,
                    rindex: calculatedRI,
                    abbe: closestGlass.vd
                });
                
                console.log(`✅ Auto-selected glass for row ${rowIndex + 1}:`);
                console.log(`   Material: ${closestGlass.name} (${closestGlass.source})`);
                console.log(`   Calculated RI: ${calculatedRI.toFixed(6)}`);
                console.log(`   Abbe Number: ${closestGlass.vd}`);
                
                // テーブルのセルを実際に更新
                const allRows = tableOpticalSystem.getRows();
                if (rowIndex >= 0 && rowIndex < allRows.length) {
                    const targetRow = allRows[rowIndex];
                    
                    // Material、屈折率、Abbe数を更新
                  runWithCellEditSuppressed(() => {
                    targetRow.getCell("material").setValue(closestGlass.name);
                    targetRow.getCell("rindex").setValue(calculatedRI.toFixed(6));
                    targetRow.getCell("abbe").setValue(closestGlass.vd.toString());
                  });
                    
                    console.log(`🔄 Updated table cells for row ${rowIndex + 1}`);
                    
                    // データを保存
                    saveTableData(tableOpticalSystem.getData());
                } else {
                    console.error(`❌ Invalid rowIndex for cell update: ${rowIndex}`);
                }
            } else {
                console.log(`❌ No suitable glass found for RI=${targetRindex}, Abbe=${targetVd}`);
            }
        } else {
            console.log(`⚠️ Invalid target values for glass search: RI=${targetRindex}, Abbe=${targetVd}`);
        }
    } catch (error) {
        console.error('❌ Error in auto glass selection:', error);
    }
}
*/

// Mount function for table initialization
export function mountTableOpticalSystemIfReady(): boolean {
  try {
    const container = document.getElementById('optical-system-table');
    if (!container) return false;
    
    if (shouldDisableExpandedOpticalSystemUI()) {
      tableOpticalSystem = createNoopOpticalSystemTable();
      return true;
    }
    
    // Table mounting logic would go here
    return true;
  } catch (e) {
    console.error('Failed to mount optical system table:', e);
    return false;
  }
}
