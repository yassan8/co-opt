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

// In non-browser environments (Node/tests) or when Tabulator isn't loaded yet,
// skip table initialization rather than throwing at import time.
const canInitTabulator = hasDocument && tableContainer && (typeof Tabulator !== 'undefined');

if (!canInitTabulator) {
  tableSource = null;
}

try {
  if (!canInitTabulator) {
    throw new Error('Tabulator or DOM container is not available');
  }
  
  tableSource = new Tabulator("#table-source", {
    data: initialData,
    layout: "fitColumns",
    selectable: 1, // 1行のみ選択可能
    validationMode: "manual", // バリデーションモードを手動に設定
    editTriggerEvent: "click", // 編集トリガーをクリックに限定
    tabEndNewRow: false, // タブでの新行作成を無効化
    columns: [
    { title: "Source", field: "id", width: 80, headerSort: false, mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          // console.warn("Mutator error for source id:", e);
          return value;
        }
      }},
    { title: "Wavelength (μm)", field: "wavelength", editor: "input", width: 150, headerSort: false, mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          // console.warn("Mutator error for wavelength:", e);
          return value;
        }
      }},
    { title: "Weight", field: "weight", editor: "input", width: 150, headerSort: false , mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          // console.warn("Mutator error for weight:", e);
          return value;
        }
      }},
    { 
      title: "Primary Wavelength", 
      field: "primary", 
      width: 150, 
      headerSort: false,
      editor: "tickCross",
      editorParams: {
        trueValue: "Primary Wavelength",
        falseValue: "",
      },
      }
    ]
  });

  // Tabulatorエラーハンドリング
  tableSource.on("error", function(error) {
    // console.warn("Source Tabulator error:", error);
  });

  // 初期化完了後の処理
  tableSource.on("tableBuilt", function(){
    // console.log("Source Tabulator initialized successfully");
    
    // グローバルウィンドウオブジェクトに設定（glass.jsの関数から参照できるように）
    if (typeof window !== 'undefined') {
      window.tableSource = tableSource;
      // console.log('✅ tableSource set to window.tableSource');
    }
  });

  // Primary Wavelength編集時の処理
  tableSource.on("cellEdited", function(cell) {
    const field = cell.getField();
    const value = cell.getValue();
    const row = cell.getRow();
    const rowData = row.getData();
    
    // Primary Wavelengthが選択された場合
    if (field === "primary" && value === "Primary Wavelength") {
      console.log('🔧 Primary Wavelength selected, clearing other primary entries');
      
      // 他の全ての行のprimaryフィールドをクリア
      const allData = tableSource.getData();
      let changed = false;
      
      allData.forEach((rowItem, index) => {
        if (rowItem.id !== rowData.id && rowItem.primary === "Primary Wavelength") {
          rowItem.primary = "";
          changed = true;
        }
      });
      
      if (changed) {
        tableSource.replaceData(allData);
        console.log('✅ Cleared other primary wavelength entries');
      }
      
      saveTableData(allData);
      
      // 主波長変更通知
      notifyPrimaryWavelengthChanged();
      
      // Image面のSemi Dia自動計算をトリガー
      recalculateAutoSemiDiaIfAvailable();
    }
    
    // 主波長に設定されている行のwavelengthが変更された場合
    if (field === "wavelength" && rowData.primary === "Primary Wavelength") {
      console.log(`🔧 Primary wavelength value changed to: ${value} μm`);
      saveTableData(tableSource.getData());
      
      // 主波長変更通知
      notifyPrimaryWavelengthChanged();
      
      // Image面のSemi Dia自動計算をトリガー
      recalculateAutoSemiDiaIfAvailable();
    }
  });

} catch (error) {
  // If we're in a headless environment or Tabulator isn't present, do not treat this as fatal.
  // Keep logging concise to avoid noise.
  if (canInitTabulator) {
    console.error("❌ Failed to initialize Source Tabulator:", error);
    console.error("❌ Stack trace:", error.stack);
  }
  tableSource = null;
}

// クリックで1行だけ選択状態にする
if (tableSource) {
  tableSource.on("rowClick", function(e, row){
    tableSource.deselectRow(); // すべての選択を解除
    row.select();        // クリックした行のみ選択
  });
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