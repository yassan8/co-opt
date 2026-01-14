/**
 * 波面収差図Object選択UI管理
 * Objectの数に応じて動的にドロップダウンオプションを更新
 */

/**
 * Object選択ドロップダウンを更新
 */
export function updateWavefrontObjectSelect() {
    try {
        const objectSelect = document.getElementById('wavefront-object-select');
        if (!objectSelect) {
            console.warn('⚠️ wavefront-object-select要素が見つかりません');
            return;
        }
        
        // table-object.jsからObjectデータを取得
        let objectRows = [];
        if (typeof window !== 'undefined' && window.tableObject && window.tableObject.getData) {
            const allObjectRows = window.tableObject.getData();
            
            // 有効なObjectデータのみをフィルタリング
            objectRows = allObjectRows.filter((obj, index) => {
                const isValid = obj && obj !== null && obj !== undefined;
                return isValid;
            });
            
            // データ数の警告
            if (allObjectRows.length > objectRows.length) {
                console.warn(`無効なObjectデータが${allObjectRows.length - objectRows.length}個あります。Clear Cacheでリセットを推奨。`);
            }
        } else {
            console.warn('⚠️ tableObjectが利用できません');
            return;
        }
        
        // 現在の選択値を保存
        const currentSelection = objectSelect.value;
        
        // ドロップダウンをクリア
        objectSelect.innerHTML = '';
        
        // 利用可能なObjectに基づいてオプションを追加
        if (objectRows.length === 0) {
            // Objectがない場合のデフォルトオプション
            const defaultOption = document.createElement('option');
            defaultOption.value = '0';
            defaultOption.textContent = 'Object 1 (Empty)';
            defaultOption.disabled = true;
            objectSelect.appendChild(defaultOption);
            

        } else {
            objectRows.forEach((obj, index) => {
                const option = document.createElement('option');
                option.value = index.toString();
                
                // Object名を構築
                let objectName = `Object ${index + 1}`;
                
                // 座標情報があれば追加
                const xHeight = obj.xHeightAngle || 0;
                const yHeight = obj.yHeightAngle || 0;
                
                if (xHeight !== 0 || yHeight !== 0) {
                    objectName += ` (${xHeight.toFixed(2)}, ${yHeight.toFixed(2)})`;
                } else {
                    objectName += ' (0.00, 0.00)'; // 軸上Object
                }
                
                option.textContent = objectName;
                objectSelect.appendChild(option);
            });
        }
        
        // 以前の選択を復元（可能であれば）
        if (currentSelection && objectSelect.querySelector(`option[value="${currentSelection}"]`)) {
            objectSelect.value = currentSelection;
        } else if (objectRows.length > 0) {
            objectSelect.value = '0'; // デフォルトは最初のObject
        }
        
        // 選択されているObject
        const selectedIndex = parseInt(objectSelect.value) || 0;
        const selectedObject = objectRows[selectedIndex];
        
    } catch (error) {
        console.error('❌ Object選択ドロップダウン更新エラー:', error);
    }
}

/**
 * Object選択ドロップダウンの変更イベントリスナーを設定
 */
export function setupWavefrontObjectSelectListener() {
    const objectSelect = document.getElementById('wavefront-object-select');
    if (objectSelect) {
        objectSelect.addEventListener('change', function() {
            const selectedIndex = parseInt(this.value) || 0;
            console.log(`🔄 Object選択変更: Object${selectedIndex + 1}`);
            
            // 選択されたObjectの詳細をログ出力
            try {
                if (typeof window !== 'undefined' && window.tableObject && window.tableObject.getData) {
                    const objectRows = window.tableObject.getData();
                    const selectedObject = objectRows[selectedIndex];
                    if (selectedObject) {
                        console.log(`   詳細: (${selectedObject.xHeightAngle || 0}, ${selectedObject.yHeightAngle || 0})`);
                    }
                }
            } catch (error) {
                console.warn('Object詳細取得エラー:', error);
            }
        });
    }
}

/**
 * 波面収差図Object選択UIの初期化
 */
export function initializeWavefrontObjectUI() {
    setupWavefrontObjectSelectListener();
    updateWavefrontObjectSelect();
    
    // グローバルアクセス用にwindowオブジェクトに登録
    window.updateWavefrontObjectSelect = updateWavefrontObjectSelect;
    window.debugResetObjectTable = debugResetObjectTable;
}

/**
 * デバッグ用：Objectテーブルデータを強制リセット
 */
export function debugResetObjectTable() {
    try {
        localStorage.removeItem('objectTableData');
        location.reload();
        console.log('🔄 Objectテーブルデータをリセットしました');
    } catch (error) {
        console.error('❌ Objectテーブルリセットエラー:', error);
    }
}

/**
 * Objectテーブルが更新された時に呼び出される関数
 * main.jsや他のファイルから呼び出し可能
 */
export function onObjectTableUpdated() {
    console.log('🔄 Objectテーブル更新検出 - Object選択ドロップダウンを更新');
    updateWavefrontObjectSelect();
}
