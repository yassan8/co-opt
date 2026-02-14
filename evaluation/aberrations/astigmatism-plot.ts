/**
 * Astigmatism Diagram Plotter
 * 非点収差図プロット機能
 * 
 * 定義:
 * - 縦軸: 像高または画角
 * - 横軸: メリディオナル（M）とサジタル（S）の結像点の近軸像点からの差分量
 * - メリディオナル像面（M）: 子午断面（YZ面）の扇形光線ファンによるRMS最良焦点
 * - サジタル像面（S）: 球欠断面（XZ面）の扇形光線ファンによるRMS最良焦点
 * 
 * 計算方法（実光線追跡による数値計算）:
 * 1. 各画角で主光線と扇形光線ファン（タンジェンシャル/サジタル）を追跡
 * 2. 各z位置で横収差RMSを評価
 * 3. RMSが最小となるz位置を最良焦点位置として採用
 * 4. パラキシャル像面からの差分をプロット
 * 
 * 機能:
 * - 画角に対する近軸像点からの差分量のプロット
 * - 波長別の色分け
 * - 実線（サジタル）と破線（メリディオナル）の区別
 * 
 * 作成日: 2025/01/XX
 * 更新日: 2025/11/14 - RMSベースの実光線追跡アルゴリズムに対応
 */

// Plotly global reference (loaded via script tag in HTML)
declare const Plotly: any;

// Plotlyが読み込まれているか確認
if (typeof Plotly === 'undefined') {
    console.error('❌ Plotly.js が読み込まれていません');
}

/**
 * 波長に対応する色を取得（可視光スペクトルに基づく）
 * @param {number} wavelength - 波長 (μm)
 * @returns {string} 色コード
 */
function getWavelengthColor(wavelength) {
    // 波長(μm)から色を決定
    // g線: 0.4358μm (435.8nm) → 青紫
    // F線: 0.4861μm (486.1nm) → 青
    // d線: 0.5876μm (587.6nm) → 明るい黄色（やや黄緑寄り）
    // C線: 0.6563μm (656.3nm) → 赤
    if (wavelength < 0.45) {
        return '#8B00FF'; // 青紫（g線領域 < 450nm）
    } else if (wavelength < 0.495) {
        return '#0000FF'; // 青（F線領域 450-495nm）
    } else if (wavelength < 0.57) {
        return '#00FF00'; // 緑（495-570nm）
    } else if (wavelength < 0.59) {
        return '#9ACD32'; // 濃い黄緑（d線領域 570-590nm）
    } else if (wavelength < 0.62) {
        return '#FF8800'; // オレンジ（590-620nm）
    } else {
        return '#FF0000'; // 赤（C線領域 >= 620nm）
    }
}

/**
 * 波長の表示名を取得
 * @param {number} wavelength - 波長 (μm)
 * @returns {string} 表示名
 */
function getWavelengthName(wavelength) {
    if (Math.abs(wavelength - 0.43583) < 0.001 || Math.abs(wavelength - 0.4358) < 0.001) {
        return 'g線 (435.8nm)';
    } else if (Math.abs(wavelength - 0.48613) < 0.001 || Math.abs(wavelength - 0.4861) < 0.001) {
        return 'F線 (486.1nm)';
    } else if (Math.abs(wavelength - 0.5876) < 0.001 || Math.abs(wavelength - 0.58756) < 0.001) {
        return 'd線 (587.6nm)';
    } else if (Math.abs(wavelength - 0.65627) < 0.001 || Math.abs(wavelength - 0.6563) < 0.001) {
        return 'C線 (656.3nm)';
    }
    return `${(wavelength * 1000).toFixed(1)}nm`;
}

/**
 * 非点収差図をプロット
 * @param {string} containerId - プロット先のコンテナID
 * @param {Object} astigmatismData - 非点収差データ
 * @param {Object} options - プロットオプション
 * @returns {void}
 */
export function plotAstigmatismDiagram(containerId, astigmatismData, options = {}) {
    console.log('📈 スポットダイアグラム（全画角）プロット開始');
    
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`❌ コンテナ "${containerId}" が見つかりません`);
        return;
    }
    
    if (!astigmatismData || !astigmatismData.data || astigmatismData.data.length === 0) {
        console.error('❌ 有効なデータがありません');
        container.innerHTML = '<p style="color: red;">データがありません</p>';
        return;
    }
    
    // デフォルトオプション
    const defaultOptions = {
        title: 'Spot Diagram (All Fields)',
        xAxisTitle: '像面 X方向 (mm)',
        yAxisTitle: '像面 Y方向 (mm)',
        showLegend: true,
        width: 800,
        height: 600,
        rayFilter: 'all'  // 'all', 'meridional', 'sagittal', 'chief'
    };
    
    const plotOptions = { ...defaultOptions, ...options };
    
    console.log(`📊 光線フィルタ: ${plotOptions.rayFilter}`);
    
    // 主波長（d線: 587.6nm）のみを優先表示。取得できない場合は全データを表示。
    const mainWavelength = 0.5876;
    const normalizedData = (astigmatismData.data || []).map(d => ({
        ...d,
        wavelength: Number(d.wavelength)
    }));
    let plotTarget = normalizedData.filter(d => Number.isFinite(d.wavelength) && Math.abs(d.wavelength - mainWavelength) < 0.001);
    if (plotTarget.length === 0) {
        console.warn('⚠️ 主波長データが見つからないため全波長データを表示します');
        plotTarget = normalizedData.filter(d => Number.isFinite(d.wavelength));
    }
    
    console.log(`   主波長データ: ${plotTarget.length}画角`);
    
    const traces = [];
    
    // 各画角のスポットを描画
    for (let i = 0; i < plotTarget.length; i++) {
        const data = plotTarget[i];
        const fieldName = data.fieldName || `Object ${i + 1}`;  // Use fieldName instead of fieldAngle
        const fieldAngle = data.fieldAngle;
        const crossIntersections = data.crossBeamIntersections;
        
        if (crossIntersections && crossIntersections.spots && crossIntersections.spots.length > 0) {
            let spots = crossIntersections.spots;
            
            // 光線タイプでフィルタリング
            if (plotOptions.rayFilter !== 'all') {
                spots = spots.filter(spot => {
                    const rayType = spot.rayType || '';
                    
                    switch (plotOptions.rayFilter) {
                        case 'meridional':
                            // メリディオナル方向: 主光線 + 上下マージナル光線
                            return rayType === 'chief' || 
                                   rayType === 'upper_marginal' || 
                                   rayType === 'lower_marginal' ||
                                   rayType.includes('meridional');
                        
                        case 'sagittal':
                            // サジタル方向: 主光線 + 左右マージナル光線
                            return rayType === 'chief' || 
                                   rayType === 'left_marginal' || 
                                   rayType === 'right_marginal' ||
                                   rayType.includes('sagittal');
                        
                        case 'chief':
                            // 主光線のみ
                            return rayType === 'chief';
                        
                        default:
                            return true;
                    }
                });
            }
            
            if (spots.length === 0) continue;
            
            const xCoords = spots.map(s => s.x);
            const yCoords = spots.map(s => s.y);
            
            // 画角ごとに色を変える
            const hue = plotTarget.length > 0 ? (i / plotTarget.length) * 360 : 0;
            const color = `hsl(${hue}, 70%, 50%)`;
            
            traces.push({
                x: xCoords,
                y: yCoords,
                mode: 'markers',
                name: fieldName,  // Use fieldName for legend (already in "XX.X°" format)
                marker: {
                    color: color,
                    size: 6,
                    symbol: 'circle',
                    opacity: 0.7
                },
                hovertemplate: `<b>${fieldName}</b><br>` +
                              'X: %{x:.4f}mm<br>' +
                              'Y: %{y:.4f}mm<br>' +
                              '<extra></extra>'
            });
        }
    }
    
    // レイアウト設定
    const layout = {
        title: {
            text: plotOptions.title,
            font: { size: 16, family: 'Arial, sans-serif' }
        },
        xaxis: {
            title: {
                text: plotOptions.xAxisTitle,
                font: { size: 14 }
            },
            domain: [0, 0.82],  // プロット領域を固定（凡例の影響を防ぐ）
            gridcolor: '#e0e0e0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1,
            scaleanchor: 'y',  // Y軸と同じスケールに
            scaleratio: 1       // 1:1のアスペクト比
        },
        yaxis: {
            title: {
                text: plotOptions.yAxisTitle,
                font: { size: 14 }
            },
            gridcolor: '#e0e0e0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1
        },
        showlegend: plotOptions.showLegend,
        legend: {
            x: 1.02,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',            xref: 'paper',
            yref: 'paper',            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#cccccc',
            borderwidth: 1
        },
        width: plotOptions.width,
        height: plotOptions.height,
        autosize: false,  // 自動サイズ調整を無効化
        margin: { l: 80, r: 150, t: 80, b: 80 },
        hovermode: 'closest',
        plot_bgcolor: '#ffffff',
        paper_bgcolor: '#ffffff'
    };
    
    // プロット設定
    const config = {
        responsive: false,  // autosize: falseと統一するためfalseに
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false
    };
    
    // プロット実行
    Plotly.newPlot(container, traces, layout, config)
        .then(() => {
            console.log('✅ 非点収差図プロット完了');
        })
        .catch(error => {
            console.error('❌ プロットエラー:', error);
            container.innerHTML = '<p style="color: red;">プロットに失敗しました</p>';
        });
}

/**
 * 非点収差図を更新
 * @param {string} containerId - プロット先のコンテナID
 * @param {Object} astigmatismData - 非点収差データ
 * @param {Object} options - プロットオプション
 * @returns {void}
 */
export function updateAstigmatismDiagram(containerId, astigmatismData, options = {}) {
    // 既存のプロットを削除して再描画
    const container = document.getElementById(containerId);
    if (container) {
        Plotly.purge(container);
    }
    plotAstigmatismDiagram(containerId, astigmatismData, options);
}

/**
 * 非点収差曲線図をプロット（Astigmatic Field Curves）
 * X軸: 像面位置（Z座標, mm）
 * Y軸: 画角（度）
 * @param {string} containerId - プロット先のコンテナID
 * @param {Object} astigmatismData - 非点収差データ
 * @param {Object} options - プロットオプション
 * @returns {void}
 */
export function plotAstigmaticFieldCurves(containerId, astigmatismData, options = {}) {
    console.log('📈 非点収差曲線図プロット開始');
    
    const container = typeof containerId === 'string'
        ? document.getElementById(containerId)
        : containerId;
    if (!container) {
        console.error(`❌ コンテナ "${typeof containerId === 'string' ? containerId : '(element)'}" が見つかりません`);
        return;
    }

    const targetDocument = container.ownerDocument || document;
    const plotlyRef = targetDocument?.defaultView?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
    
    if (!astigmatismData || !astigmatismData.data || astigmatismData.data.length === 0) {
        console.error('❌ 有効なデータがありません');
        container.innerHTML = '<p style="color: red;">データがありません</p>';
        return;
    }
    
    // デフォルトオプション
    // Object Position Angleは無限系（角度）、Rectangle/Heightは有限系（物体高）
    const fsList = astigmatismData.fieldSettings || [];
    const hasRectangleOrHeight = fsList.some(fs => {
        const posType = (fs.position || fs.fieldType || '').toLowerCase();
        return posType.includes('rectangle') || posType.includes('height');
    });
    const hasAngleOnly = fsList.some(fs => {
        const posType = (fs.position || fs.fieldType || '').toLowerCase();
        return posType.includes('angle') && !posType.includes('rectangle');
    });
    
    const fieldMode = astigmatismData.fieldMode
        ?? (astigmatismData.isAngleField ? 'angle' : null)
        ?? (hasRectangleOrHeight ? 'height' : (hasAngleOnly ? 'angle' : 'height'));
    const isAngleField = fieldMode === 'angle';
    
    console.log(`📊 フィールドタイプ判定: hasRectangleOrHeight=${hasRectangleOrHeight}, hasAngleOnly=${hasAngleOnly}, fieldMode=${fieldMode}, isAngleField=${isAngleField}`);
    console.log(`🔍 astigmatismData.isAngleField = ${astigmatismData.isAngleField}, fieldMode=${astigmatismData.fieldMode}`);
    console.log(`🔍 fieldSettings詳細:`, fsList.map(fs => ({
        name: fs.name || fs.displayName,
        position: fs.position,
        fieldType: fs.fieldType,
        y: fs.y,
        yHeight: fs.yHeight,
        yFieldAngle: fs.yFieldAngle
    })));
    console.log(`🔍 data[0]サンプル:`, astigmatismData.data[0]);
    const yAxisTitle = isAngleField ? 'Object Angle θ (deg)' : 'Object Height (mm)';
    const yUnit = isAngleField ? 'deg' : 'mm';
    const yValueLabel = isAngleField ? 'Object Angle θ' : 'Object Height';
    const defaultOptions = {
        title: 'Astigmatic Field Curves',
        xAxisTitle: 'Image Position (mm)',
        yAxisTitle,
        showLegend: true,
        width: 800,
        height: 600,
        // 横軸はデータから自動拡張（最低でも±0.5mmは確保）
        xRange: null
    };
    
    const plotOptions = { ...defaultOptions, ...options };
    
    const traces = [];

    const maxAbsAngle = isAngleField
        ? Math.max(...fsList.map(fs => Math.abs(parseFloat(fs?.y ?? fs?.yFieldAngle ?? fs?.fieldAngle ?? 0) || 0)))
        : 0;
    const normalizeAngleDeg = (angle) => {
        if (!Number.isFinite(angle)) return angle;
        if (!isAngleField || !Number.isFinite(maxAbsAngle) || maxAbsAngle <= 0) return angle;
        // Wrap to [-180, 180] so 360+θ does not blow up the axis.
        return ((((angle + 180) % 360) + 360) % 360) - 180;
    };
    
    // 波長ごとにグループ化
    const wavelengthGroups = {};
    astigmatismData.data.forEach(data => {
        const wl = data.wavelength;
        if (!wavelengthGroups[wl]) {
            wavelengthGroups[wl] = [];
        }
        wavelengthGroups[wl].push(data);
    });
    
    console.log(`   波長グループ数: ${Object.keys(wavelengthGroups).length}`);
    
    // 各波長について曲線を描画
    Object.keys(wavelengthGroups).forEach(wavelength => {
        const wlData = wavelengthGroups[wavelength];
        const wlNum = parseFloat(wavelength);
        const color = getWavelengthColor(wlNum);
        
        // 画角でソート
        wlData.sort((a, b) => a.fieldAngle - b.fieldAngle);
        
        // メリディオナル曲線（meridionalDeviationは既に主波長軸上基準の相対値）
        const meridionalAngles = [];
        const meridionalZ = [];
        wlData.forEach(d => {
            if (d.meridionalDeviation !== null) {
                meridionalAngles.push(normalizeAngleDeg(d.fieldAngle));
                meridionalZ.push(d.meridionalDeviation);  // 既に相対値
            }
        });
        
        if (meridionalAngles.length > 0) {
            traces.push({
                x: meridionalZ,
                y: meridionalAngles,
                mode: 'lines',
                name: `M (${(wlNum * 1000).toFixed(1)}nm)`,
                line: {
                    color: color,
                    width: 2,
                    dash: 'dash'  // メリディオナルは破線
                },
                hovertemplate: `<b>Meridional ${(wlNum * 1000).toFixed(1)}nm</b><br>` +
                              `${yValueLabel}: %{y:.4f}${yUnit}<br>` +
                              'Z位置: %{x:.4f}mm<br>' +
                              '<extra></extra>'
            });
        }
        
        // サジタル曲線（sagittalDeviationは既に主波長軸上基準の相対値）
        const sagittalAngles = [];
        const sagittalZ = [];
        wlData.forEach(d => {
            if (d.sagittalDeviation !== null) {
                sagittalAngles.push(normalizeAngleDeg(d.fieldAngle));
                sagittalZ.push(d.sagittalDeviation);  // 既に相対値
            }
        });
        
        if (sagittalAngles.length > 0) {
            traces.push({
                x: sagittalZ,
                y: sagittalAngles,
                mode: 'lines',
                name: `S (${(wlNum * 1000).toFixed(1)}nm)`,
                line: {
                    color: color,
                    width: 2,
                    dash: 'solid'  // サジタルは実線
                },
                hovertemplate: `<b>Sagittal ${(wlNum * 1000).toFixed(1)}nm</b><br>` +
                              `${yValueLabel}: %{y:.4f}${yUnit}<br>` +
                              'Z位置: %{x:.4f}mm<br>' +
                              '<extra></extra>'
            });
        }
    });
    
    console.log(`   トレース数: ${traces.length}`);

    // 横軸（像面位置）はデータから自動算出（SAと同じ思想：最低±0.5mm、必要なら拡張）
    const xValues = [];
    traces.forEach(t => {
        if (Array.isArray(t.x)) xValues.push(...t.x.filter(v => Number.isFinite(v)));
    });
    const maxAbsX = xValues.length ? Math.max(...xValues.map(v => Math.abs(v))) : 0;
    const symmetricMin = 0.5;
    const symmetricRange = (Number.isFinite(maxAbsX) && maxAbsX > symmetricMin)
        ? Math.max(symmetricMin, maxAbsX * 1.1)
        : symmetricMin;
    const computedXRange = [-symmetricRange, symmetricRange];
    const xTickStep = (Number.isFinite(maxAbsX) && maxAbsX > 0.5) ? 0.5 : 0.1;

    // 縦軸（画角/物体高）はデータから自動算出
    const yValues = [];
    traces.forEach(t => {
        if (Array.isArray(t.y)) yValues.push(...t.y.filter(v => Number.isFinite(v)));
    });
    const makeRange = (arr, paddingRatio = 0.1) => {
        if (!arr.length) return null;
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        let span = max - min;
        if (span < 1e-6) span = Math.max(Math.abs(max), 1) * 0.1 || 1;
        const pad = span * paddingRatio;
        return [min - pad, max + pad];
    };
    const yRange = makeRange(yValues);
    
    if (traces.length === 0) {
        console.error('❌ プロット可能なデータがありません');
        container.innerHTML = '<p style="color: orange;">非点収差データが不足しています</p>';
        return;
    }
    
    // レイアウト設定
    const layout = {
        title: {
            text: plotOptions.title,
            font: { size: 16, family: 'Arial, sans-serif' }
        },
        xaxis: {
            title: {
                text: plotOptions.xAxisTitle,
                font: { size: 14 },
                standoff: 10
            },
            domain: [0, 0.82],
            automargin: true,
            gridcolor: '#e0e0e0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1,
            range: Array.isArray(plotOptions.xRange) ? plotOptions.xRange : computedXRange,
            dtick: xTickStep
        },
        yaxis: {
            title: {
                text: plotOptions.yAxisTitle,
                font: { size: 14 },
                standoff: 10
            },
            domain: [0, 1],
            automargin: true,
            gridcolor: '#e0e0e0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1,
            range: yRange || undefined
        },
        showlegend: plotOptions.showLegend,
        legend: {
            x: 1.05,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',
            xref: 'paper',  // 紙面座標系で指定
            yref: 'paper',
            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#cccccc',
            borderwidth: 1
        },
        autosize: true,
        margin: { l: 80, r: 150, t: 80, b: 80 },
        hovermode: 'closest',
        plot_bgcolor: '#ffffff',
        paper_bgcolor: '#ffffff'
    };
    
    // プロット設定
    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false
    };
    
    // プロット実行
    if (!plotlyRef) {
        console.error('❌ Plotly library is not loaded');
        container.innerHTML = '<p style="color: red;">Plotlyが読み込まれていません</p>';
        return;
    }

    plotlyRef.newPlot(container, traces, layout, config)
        .then(() => {
            console.log('✅ 非点収差曲線図プロット完了');

            const win = targetDocument?.defaultView;
            if (win && plotlyRef?.Plots?.resize) {
                if (container.__astigmatismPlotResizeHandler) {
                    try { win.removeEventListener('resize', container.__astigmatismPlotResizeHandler); } catch (_) {}
                }
                container.__astigmatismPlotResizeHandler = () => {
                    try { plotlyRef.Plots.resize(container); } catch (_) {}
                };
                win.addEventListener('resize', container.__astigmatismPlotResizeHandler);
                try { container.__astigmatismPlotResizeHandler(); } catch (_) {}
            }
        })
        .catch(error => {
            console.error('❌ プロットエラー:', error);
            container.innerHTML = '<p style="color: red;">プロットに失敗しました</p>';
        });
}
