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

// 表の構成
export let tableObject;

try {
  // Check if Tabulator is available
  if (typeof Tabulator === 'undefined') {
    throw new Error('Tabulator is not available');
  }
  
  // Check if DOM element exists
  const tableElement = hasDocument ? document.getElementById('table-object') : null;
  if (!tableElement) {
    throw new Error('DOM element #table-object not found');
  }
  
  tableObject = new Tabulator("#table-object", {
    data: initialData,
    layout: "fitColumns",
    selectable: 1, // 1行のみ選択可能
    validationMode: "manual", // バリデーションモードを手動に設定
    editTriggerEvent: "click", // 編集トリガーをクリックに限定
    tabEndNewRow: false, // タブでの新行作成を無効化
    columns: [
    { title: "Object", field: "id", width: 80, headerSort: false },
    { title: "X value", field: "xHeightAngle", editor: "input", width: 150, headerSort: false, mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for xHeightAngle:", e);
          return value;
        }
      }},
    { title: "Y value", field: "yHeightAngle", editor: "input", width: 150, headerSort: false, mutator: function(value) {
        try {
          return value === "" ? "" : Number(value);
        } catch (e) {
          console.warn("Mutator error for yHeightAngle:", e);
          return value;
        }
      }},
    { 
      title: "Position", 
      field: "position", 
      editor: "select", 
      editorParams: { values: ["Point", "Angle", "Rectangle"] },
      width: 120, 
      headerSort: false
    }
  ]
  });



  // Tabulatorエラーハンドリング
  tableObject.on("error", function(error) {
    console.warn("Object Tabulator error:", error);
  });

  // 初期化完了後の処理
  tableObject.on("tableBuilt", function(){
    console.log('✅ [TableObject] Table built successfully');
    
    // windowオブジェクトにtableObjectをセット
    window.tableObject = tableObject;
    window.objectTabulator = tableObject; // 互換性のため
    
    console.log('✅ [TableObject] tableObject set to window');
    console.log('📋 [TableObject] Table data count:', tableObject.getDataCount());
    
    // データの内容を確認
    const currentData = tableObject.getData();
    console.log('📋 [TableObject] Current data:', currentData);
  });

} catch (error) {
  console.error("❌ [TableObject] Failed to initialize Object Tabulator:", error);
  tableObject = null;
  
  // Fallback: setTimeout to retry initialization
  if (hasWindow && hasDocument) {
    setTimeout(() => {
      console.log('🔄 [TableObject] Retrying initialization...');
      try {
        if (typeof Tabulator !== 'undefined' && document.getElementById('table-object') && window?.location?.reload) {
          // Retry the initialization
          window.location.reload(); // Simple solution: reload the page
        }
      } catch (retryError) {
        console.error("❌ [TableObject] Retry failed:", retryError);
      }
    }, 3000);
  }
}

// クリックで1行だけ選択状態にする
if (tableObject) {
  tableObject.on("rowClick", function(e, row){
    tableObject.deselectRow();
    row.select();
  });
} else {
  console.warn('❌ [TableObject] Cannot add rowClick event - tableObject is null');
}

// 行追加
const addObjectBtn = hasDocument ? document.getElementById("add-object-btn") : null;
if (addObjectBtn) addObjectBtn.addEventListener("click", function(){
  if (!tableObject) {
    console.error('❌ [TableObject] Cannot add row - tableObject is null');
    alert('テーブルが初期化されていません。ページを再読み込みしてください。');
    return;
  }
  
  const selectedRows = tableObject.getSelectedRows();
  let insertIndex = tableObject.getDataCount();

  if(selectedRows.length > 0){
    const selectedRow = selectedRows[0];
    insertIndex = tableObject.getRows().indexOf(selectedRow) + 1;
  }
  
  tableObject.addRow({
      id: tableObject.getDataCount() + 1,
      xHeightAngle: "",
      yHeightAngle: "",
      position: "Point"
      }, false, insertIndex).then(() => {
    const data = tableObject.getData();
    renumberIds(data);
    tableObject.replaceData(data);
    saveTableData(data);
    console.log('✅ [TableObject] Row added successfully');
  }).catch(error => {
    console.error('❌ [TableObject] Error adding row:', error);
  });
});

// 行削除
const deleteObjectBtn = hasDocument ? document.getElementById("delete-object-btn") : null;
if (deleteObjectBtn) deleteObjectBtn.addEventListener("click", function(){
  if (!tableObject) {
    console.error('❌ [TableObject] Cannot delete row - tableObject is null');
    alert('テーブルが初期化されていません。ページを再読み込みしてください。');
    return;
  }
  
  const selectedRows = tableObject.getSelectedRows();
  if(selectedRows.length > 0){
    selectedRows[0].delete();
    setTimeout(() => {
      const data = tableObject.getData();
      renumberIds(data);
      tableObject.replaceData(data);
      saveTableData(data);
      console.log('✅ [TableObject] Row deleted successfully');
    }, 0);
  } else {
    alert("削除する行を選択してください。");
  }
});

// タイトル変更用関数
function setAngleTitles() {
  if (!tableObject) {
    console.error('❌ [TableObject] Cannot set angle titles - tableObject is null');
    return;
  }
  
  try {
    tableObject.getColumn("xHeightAngle").updateDefinition({ title: "X angle (deg)" });
    tableObject.getColumn("yHeightAngle").updateDefinition({ title: "Y angle (deg)" });

    // すべての行のpositionを"Angle"にする
    const data = tableObject.getData();
    data.forEach(row => {
      row.position = "Angle";
    });
    tableObject.replaceData(data);
    saveTableData(data);
    console.log('✅ [TableObject] Angle titles set successfully');
  } catch (error) {
    console.error('❌ [TableObject] Error setting angle titles:', error);
  }
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
  if (!tableObject) {
    console.error('❌ [TableObject] Cannot set rectangle titles - tableObject is null');
    return;
  }
  
  try {
    tableObject.getColumn("xHeightAngle").updateDefinition({ title: "X height rect (mm)" });
    tableObject.getColumn("yHeightAngle").updateDefinition({ title: "Y height rect (mm)" });
    // すべての行のpositionを"Rectangle"にする
    const data = tableObject.getData();
    data.forEach(row => {
      row.position = "Rectangle";
    });
    tableObject.replaceData(data);
    saveTableData(data);
    console.log('✅ [TableObject] Rectangle titles set successfully');
  } catch (error) {
    console.error('❌ [TableObject] Error setting rectangle titles:', error);
  }
}

// PSF選択肢更新機能
function updatePSFObjectSelectIfAvailable() {
  // main.jsでPSF機能が利用可能かチェック
  if (typeof window.updatePSFObjectSelect === 'function') {
    window.updatePSFObjectSelect();
  }
}

// テーブルデータ変更時のコールバック
if (tableObject) {
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
    
    // Image面のSemi Dia自動計算をトリガー
    recalculateAutoSemiDiaIfAvailable();
  });
} else {
  console.warn('❌ [TableObject] Cannot add change listeners - tableObject is null');
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
