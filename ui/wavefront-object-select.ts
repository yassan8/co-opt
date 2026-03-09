// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

import { clearObjectTableDataProjection } from '../data/table-configuration.ts';

/**
 * 波面収差図Object選択UI管理
 * Objectの数に応じて動的にドロップダウンオプションを更新
 */

/**
 * Object選択ドロップダウンを更新
 */
export function updateWavefrontObjectSelect(): void {
    try {
        const objectSelect = document.getElementById('wavefront-object-select') as HTMLSelectElement | null;
        if (!objectSelect) {
            return;
        }
        
        // table-object.jsからObjectデータを取得
        let objectRows = [];
        if (typeof window !== 'undefined' && w.tableObject && w.tableObject.getData) {
            const allObjectRows = w.tableObject.getData();
            
            // 有効なObjectデータのみをフィルタリング
            objectRows = allObjectRows.filter((obj) => {
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
        
    } catch (error) {
        console.error('❌ Object選択ドロップダウン更新エラー:', error);
    }
}

/**
 * PSF Object選択ドロップダウンを更新
 */
export function updatePSFObjectOptions(): void {
    try {
        const objectSelect = document.getElementById('psf-object-select') as HTMLSelectElement | null;
        if (!objectSelect) {
            return;
        }

        let objectRows: any[] = [];
        if (typeof window !== 'undefined' && w.tableObject && w.tableObject.getData) {
            const allObjectRows = w.tableObject.getData();
            objectRows = Array.isArray(allObjectRows)
                ? allObjectRows.filter((obj) => obj && obj !== null && obj !== undefined)
                : [];
        }

        const currentSelection = objectSelect.value;
        objectSelect.innerHTML = '';

        if (objectRows.length === 0) {
            const defaultOption = document.createElement('option');
            defaultOption.value = '0';
            defaultOption.textContent = 'Object 1 (Empty)';
            defaultOption.disabled = true;
            objectSelect.appendChild(defaultOption);
            return;
        }

        objectRows.forEach((obj, index) => {
            const option = document.createElement('option');
            option.value = index.toString();

            const xRaw = obj?.xHeightAngle ?? obj?.xFieldAngle ?? obj?.xAngle ?? obj?.x ?? 0;
            const yRaw = obj?.yHeightAngle ?? obj?.yFieldAngle ?? obj?.yAngle ?? obj?.y ?? obj?.fieldAngle ?? 0;
            const x = Number.isFinite(Number(xRaw)) ? Number(xRaw) : 0;
            const y = Number.isFinite(Number(yRaw)) ? Number(yRaw) : 0;
            const position = String(obj?.position ?? obj?.object ?? obj?.objectType ?? 'Object');

            option.textContent = `${index + 1}: ${position} (${x}, ${y})`;
            objectSelect.appendChild(option);
        });

        if (currentSelection && objectSelect.querySelector(`option[value="${currentSelection}"]`)) {
            objectSelect.value = currentSelection;
        } else {
            objectSelect.value = '0';
        }
    } catch (error) {
        console.error('❌ PSF Object選択ドロップダウン更新エラー:', error);
    }
}

/**
 * PSF Object選択UIの初期化
 */
export function initializePSFObjectUI(): void {
    updatePSFObjectOptions();

    // Compatibility aliases for existing callers.
    w.updatePSFObjectOptions = updatePSFObjectOptions;
    w.updatePSFObjectSelect = updatePSFObjectOptions;
    w.setupPSFObjectSelect = updatePSFObjectOptions;
}

/**
 * Object選択ドロップダウンの変更イベントリスナーを設定
 */
export function setupWavefrontObjectSelectListener(): void {
    const objectSelect = document.getElementById('wavefront-object-select') as HTMLSelectElement | null;
    if (objectSelect) {
        objectSelect.addEventListener('change', function(this: HTMLSelectElement) {
            const selectedIndex = parseInt(this.value) || 0;
            clearObjectTableDataProjection(selectedIndex);
        });
    }
}

/**
 * 波面収差図Object選択UIの初期化
 */
export function initializeWavefrontObjectUI(): void {
    setupWavefrontObjectSelectListener();
    updateWavefrontObjectSelect();
    
    // グローバルアクセス用にwindowオブジェクトに登録
    w.updateWavefrontObjectSelect = updateWavefrontObjectSelect;
    w.debugResetObjectTable = debugResetObjectTable;
}

/**
 * デバッグ用：Objectテーブルデータを強制リセット
 */
export function debugResetObjectTable(): void {
    try {
        clearObjectTableDataProjection();
        location.reload();
    } catch (error) {
        console.error('❌ Objectテーブルリセットエラー:', error);
    }
}

/**
 * Objectテーブルが更新された時に呼び出される関数
 * main.jsや他のファイルから呼び出し可能
 */
export function onObjectTableUpdated(): void {
    updateWavefrontObjectSelect();
    updatePSFObjectOptions();
}
