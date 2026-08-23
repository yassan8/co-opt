/**
 * Longitudinal Aberration Plot Module (Spherical Aberration Diagram)
 * 球面収差図プロットモジュール
 * 
 * 球面収差図を Plotly を使用してプロットする
 * X軸: 縦収差（Longitudinal Aberration）[mm]
 * Y軸: 正規化瞳座標（Normalized Pupil Coordinate）
 */

declare const Plotly: any;

/**
 * 球面収差図をプロット
 * @param {string} containerId - 表示先コンテナID
 * @param {Object} aberrationData - 縦収差データ
 * @param {Object} options - プロットオプション
 */
export function plotLongitudinalAberration(containerId: string, aberrationData: any, options: any = {}) {
    const {
        title = 'Spherical Aberration Diagram',
        width = 800,
        height = 600,
        showSC = true,
        fitToContainer = true
    } = options;
    
    console.log('📈 球面収差図プロット開始');
    
    if (!aberrationData || !aberrationData.meridionalData) {
        console.error('❌ 縦収差データが不正です');
        return;
    }
    
    const container = typeof containerId === 'string'
        ? document.getElementById(containerId)
        : containerId;
    if (!container) {
        console.error(`❌ コンテナが見つかりません: ${containerId}`);
        return;
    }

    const doc = container.ownerDocument || document;
    const plotly = doc.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    if (!plotly || typeof plotly.newPlot !== 'function') {
        console.error('❌ Plotly is not available. Please ensure the library is loaded.');
        return;
    }
    
    // Plotlyトレースを作成
    const traces = [];
    const axisNotes: string[] = [];
    
    // 波長に応じた色を取得する関数
    // 可視光スペクトルに基づいた色分け
    // g線: 0.4308 μm (430.8 nm) → 青紫
    // F線: 0.4861 μm (486.1 nm) → 青
    // d線: 0.5876 μm (587.6 nm) → 明るい黄色（やや黄緑寄り）
    // C線: 0.6563 μm (656.3 nm) → 赤
    const getColorForWavelength = (wavelength) => {
        if (wavelength < 0.45) {
            return '#8B00FF'; // 青紫（380-450nm）- g線
        } else if (wavelength < 0.495) {
            return '#0000FF'; // 青（450-495nm）- F線
        } else if (wavelength < 0.57) {
            return '#00FF00'; // 緑（495-570nm）
        } else if (wavelength < 0.59) {
            return '#9ACD32'; // 濃い黄緑（570-590nm）- d線
        } else if (wavelength < 0.62) {
            return '#FF8800'; // オレンジ（590-620nm）
        } else {
            return '#FF0000'; // 赤（620-750nm）- C線
        }
    };
    
    // メリジオナル光線のトレース（実線）
    aberrationData.meridionalData.forEach((data, index) => {
        const wavelength = data.wavelength;
        const wavelengthNm = (wavelength * 1000).toFixed(1);  // μmをnmに変換
        const color = getColorForWavelength(wavelength);
        const legendGroup = `wl-${wavelengthNm}`;
        
        // 瞳座標でソート（Y軸の値が単調増加するように）
        const sortedPoints = [...data.points].sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        if (sortedPoints.length === 0) {
            const note = 'Meridional (Y): afocal — no finite longitudinal focus';
            if (!axisNotes.includes(note)) axisNotes.push(note);
            return;
        }
        
        // X軸とY軸を入れ替え：X軸=縦収差、Y軸=瞳座標
        const xValues = sortedPoints.map(p => p.longitudinalAberration);
        const yValues = sortedPoints.map(p => p.pupilCoordinate);
        
        traces.push({
            x: xValues,
            y: yValues,
            mode: 'lines',
            type: 'scatter',
            name: `${wavelengthNm}nm`,
            legendgroup: legendGroup,
            showlegend: true,
            hovertemplate: 'Longitudinal Aberration: %{x:.6f} mm<br>Normalized Pupil: %{y:.6f}<extra></extra>',
            line: {
                color: color,
                width: 2
            }
        });
    });
    
    // サジタル光線のトレース（破線）
    aberrationData.sagittalData.forEach((data, index) => {
        const wavelength = data.wavelength;
        const wavelengthNm = (wavelength * 1000).toFixed(1);  // μmをnmに変換
        const color = getColorForWavelength(wavelength);
        const legendGroup = `wl-${wavelengthNm}`;
        
        // 瞳座標でソート（Y軸の値が単調増加するように）
        const sortedPoints = [...data.points].sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        if (sortedPoints.length === 0) {
            const note = 'Sagittal (X): afocal — no finite longitudinal focus';
            if (!axisNotes.includes(note)) axisNotes.push(note);
            return;
        }
        
        // X軸とY軸を入れ替え：X軸=縦収差、Y軸=瞳座標
        const xValues = sortedPoints.map(p => p.longitudinalAberration);
        const yValues = sortedPoints.map(p => p.pupilCoordinate);
        
        traces.push({
            x: xValues,
            y: yValues,
            mode: 'lines',
            type: 'scatter',
            name: `${wavelengthNm}nm`,
            legendgroup: legendGroup,
            showlegend: false,
            hovertemplate: 'Longitudinal Aberration: %{x:.6f} mm<br>Normalized Pupil: %{y:.6f}<extra></extra>',
            line: {
                color: color,
                width: 2,
                dash: 'dash'
            }
        });
    });
    
    // 近軸縦収差位置のプロットをコメントアウト（非表示）
    /*
    // 各波長の近軸縦収差位置をマーカーでプロット（瞳座標0の位置）
    aberrationData.meridionalData.forEach((data, index) => {
        const wavelength = data.wavelength;
        const wavelengthNm = (wavelength * 1000).toFixed(1);  // μmをnmに変換
        const color = getColorForWavelength(wavelength);
        
        if (data.paraxialAberration !== undefined) {
            traces.push({
                x: [data.paraxialAberration],  // 近軸の縦収差（主波長との差）
                y: [0],  // 瞳座標0
                mode: 'markers',
                type: 'scatter',
                name: `P (${wavelengthNm}nm)`,
                marker: {
                    size: 10,
                    color: color,
                    symbol: 'diamond',
                    line: {
                        color: 'white',
                        width: 1
                    }
                },
                showlegend: true,
                hovertemplate: `近軸縦収差<br>λ=${wavelength.toFixed(4)} μm<br>縦収差: %{x:.6f} mm<br>瞳座標: %{y:.3f}<extra></extra>`
            });
        }
    });
    */
    
    // 正弦条件違反量（SC）のトレースを追加
    if (showSC) {
        aberrationData.meridionalData.forEach((data, index) => {
            const wavelength = data.wavelength;
            const displayName = `λ=${wavelength.toFixed(4)} μm`;
            const color = getColorForWavelength(wavelength);
            
            // SC値があるデータポイントのみ抽出（null と undefined を除外）
            const pointsWithSC = data.points.filter(p => p.sineConditionViolation != null);
            
            if (pointsWithSC.length > 0) {
                // 瞳座標でソート
                const sortedPoints = [...pointsWithSC].sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
                
                // X軸=SC値（パーセント表示）、Y軸=瞳座標
                const xValues = sortedPoints.map(p => p.sineConditionViolation * 100);  // パーセント表示
                const yValues = sortedPoints.map(p => p.pupilCoordinate);
                
                traces.push({
                    x: xValues,
                    y: yValues,
                    mode: 'lines',
                    type: 'scatter',
                    name: `${displayName} (SC)`,
                    line: {
                        color: color,
                        width: 1.5,
                        dash: 'dot'  // 点線
                    },
                    xaxis: 'x2',  // 第2のX軸を使用
                    yaxis: 'y',
                    hovertemplate: `SC: %{x:.4f}%<br>瞳座標: %{y:.3f}<extra></extra>`
                });
            }
        });
    }
    
    // X軸の範囲を計算（0に対して対称）
    let allXValues = [];
    let allSCValues = [];
    
    traces.forEach(trace => {
        if (trace.xaxis === 'x2') {
            // SC値
            allSCValues = allSCValues.concat(trace.x);
        } else {
            // 縦収差値
            allXValues = allXValues.concat(trace.x);
        }
    });
    
    // 横軸範囲: 通常は±0.5mm（非点収差図と揃える）。
    // ただし値が大きい場合は自動で拡張し、プロットが空に見えるのを避ける。
    const maxAbsLong = allXValues.length > 0 ? Math.max(...allXValues.map(x => Math.abs(x))) : 0.5;
    const symmetricRange = Math.max(0.5, (Number.isFinite(maxAbsLong) && maxAbsLong > 0) ? maxAbsLong * 1.1 : 0.5);
    
    const maxAbsSC = allSCValues.length > 0 ? Math.max(...allSCValues.map(x => Math.abs(x))) : 1;
    const symmetricRangeSC = maxAbsSC * 1.1; // 10%のマージンを追加
    
    // レイアウト設定
    const layout = {
        title: {
            text: title,
            font: { size: 18 }
        },
        annotations: axisNotes.length > 0 ? [{
            xref: 'paper',
            yref: 'paper',
            x: 0.01,
            y: 0.99,
            xanchor: 'left',
            yanchor: 'top',
            text: axisNotes.join('<br>'),
            showarrow: false,
            align: 'left',
            font: { size: 12, color: '#526176' },
            bgcolor: 'rgba(255,255,255,0.86)',
            bordercolor: '#d6dee9',
            borderwidth: 1,
            borderpad: 5,
        }] : [],
        xaxis: {
            title: {
                text: 'Longitudinal Aberration (mm)',
                font: { size: 14 },
                standoff: 10
            },
            domain: [0, 0.82],  // プロット領域を固定（凡例の影響を防ぐ）
            automargin: false,  // 自動マージン調整を無効化
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2,
            range: [-symmetricRange, symmetricRange],  // 0に対して対称
            dtick: 0.1,  // 0.1mm刻みの目盛り
            side: 'bottom'
        },
        xaxis2: {
            domain: [0, 0.82],  // プロット領域を固定
            automargin: false,  // 自動マージン調整を無効化
            zeroline: true,
            zerolinecolor: '#888888',
            zerolinewidth: 1,
            range: [-symmetricRangeSC, symmetricRangeSC],
            overlaying: 'x',
            side: 'top',
            showgrid: false
        },
        yaxis: {
            title: {
                text: 'Normalized Pupil Coordinate',
                font: { size: 14 }
            },
            domain: [0, 1],  // プロット領域を固定
            automargin: false,  // 自動マージン調整を無効化
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2,
            range: [0, 1.1]  // 瞳座標の範囲を0から1に設定（球面収差は対称性収差）
        },
        width: width,
        height: height,
        autosize: false,
        hovermode: 'closest',
        legend: {
            x: 1.02,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',
            xref: 'paper',
            yref: 'paper',
            groupclick: 'togglegroup',
            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#cccccc',
            borderwidth: 1
        },
        margin: {
            l: 80,
            r: 150,  // 非点収差図と同じ値に統一
            t: 80,  // 非点収差図と統一（SC表示の有無に関わらず固定）
            b: 80
        }
    };

    if (fitToContainer) {
        // Let Plotly size to the container.
        delete layout.width;
        delete layout.height;
        layout.autosize = true;
    }
    
    // プロット実行
    plotly.newPlot(container, traces, layout, {
        responsive: !!fitToContainer,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false
    });

    if (fitToContainer && plotly.Plots && typeof plotly.Plots.resize === 'function') {
        const win = doc.defaultView || window;
        if (win && !(container as any).__plotlyResizeHandlerAttached) {
            (container as any).__plotlyResizeHandlerAttached = true;
            win.addEventListener('resize', () => {
                try { plotly.Plots.resize(container); } catch (_) {}
            });
        }
    }
    
    console.log('✅ 球面収差図プロット完了');
}

/**
 * 従来形式の球面収差図表示（互換性用）
 * @param {Object} aberrationData - 縦収差データ
 * @param {string} containerId - 表示先コンテナID
 */
export function plotLongitudinalAberrationDiagram(aberrationData, containerId = 'longitudinal-aberration-container') {
    console.log('🔄 球面収差図表示（Plotly版）');
    
    plotLongitudinalAberration(containerId, aberrationData, {
        title: 'Spherical Aberration Diagram',
        showSC: false,  // 軸上光線ではSCは物理的に意味がないため非表示
        fitToContainer: true
    });
}

/**
 * 正弦条件違反量（SC）をプロット
 * @param {string} containerId - 表示先コンテナID
 * @param {Object} aberrationData - 縦収差データ（sineConditionViolationを含む）
 * @param {Object} options - プロットオプション
 */
export function plotSineConditionViolation(containerId: string, aberrationData: any, options: any = {}) {
    const {
        title = '正弦条件違反量 (Sine Condition Violation)',
        width = 800,
        height = 600,
        asPercentage = true  // パーセント表示するかどうか
    } = options;
    
    console.log('📈 正弦条件違反量プロット開始');
    
    if (!aberrationData || !aberrationData.meridionalData) {
        console.error('❌ 縦収差データが不正です');
        return;
    }
    
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`❌ コンテナが見つかりません: ${containerId}`);
        return;
    }
    
    // Plotlyトレースを作成
    const traces = [];
    let allXValues = [];  // X軸範囲計算用
    
    // 波長に応じた色を取得する関数（可視光スペクトルに基づく）
    const getColorForWavelength = (wavelength) => {
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
    };
    
    // メリジオナル光線のSCをプロット
    aberrationData.meridionalData.forEach((data, index) => {
        const wavelength = data.wavelength;
        const displayName = `λ=${wavelength.toFixed(4)} μm`;
        const color = getColorForWavelength(wavelength);
        
        // SC値があるデータポイントのみ抽出
        const pointsWithSC = data.points.filter(p => p.sineConditionViolation !== undefined);
        
        if (pointsWithSC.length === 0) {
            console.warn(`⚠️ 波長 ${wavelength.toFixed(4)} μm: SC値がありません`);
            return;
        }
        
        // 瞳座標でソート
        const sortedPoints = [...pointsWithSC].sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // X軸=SC値、Y軸=瞳座標
        const scMultiplier = asPercentage ? 100 : 1;  // パーセント表示の場合は100倍
        const xValues = sortedPoints.map(p => p.sineConditionViolation * scMultiplier);
        const yValues = sortedPoints.map(p => p.pupilCoordinate);
        
        allXValues = allXValues.concat(xValues);  // X軸範囲計算用に収集
        
        traces.push({
            x: xValues,
            y: yValues,
            mode: 'lines',
            type: 'scatter',
            name: displayName,
            line: {
                color: color,
                width: 2
            }
        });
    });
    
    // 横軸範囲: 通常は±0.5mm（非点収差図と揃える）。
    // ただし値が大きい場合は自動で拡張し、プロットが空に見えるのを避ける。
    const maxAbsLong = allXValues.length > 0 ? Math.max(...allXValues.map(x => Math.abs(x))) : 0.5;
    const symmetricRange = Math.max(0.5, (Number.isFinite(maxAbsLong) && maxAbsLong > 0) ? maxAbsLong * 1.1 : 0.5);
    
    // レイアウト設定
    const xAxisTitle = asPercentage ? 'Sine Condition Violation (%)' : 'Sine Condition Violation';
    
    const layout = {
        title: {
            text: title,
            font: { size: 18 }
        },
        xaxis: {
            title: {
                text: xAxisTitle,
                font: { size: 14 },
                standoff: 10
            },
            domain: [0, 0.82],  // プロット領域を固定
            automargin: false,  // 自動マージン調整を無効化
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2,
            range: [-symmetricRange, symmetricRange],
            dtick: 0.1  // 0.1mm刻みの目盛り
        },
        yaxis: {
            title: {
                text: 'Normalized Pupil Coordinate',
                font: { size: 14 }
            },
            domain: [0, 1],  // プロット領域を固定
            automargin: false,  // 自動マージン調整を無効化
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2,
            range: [0, 1.1]
        },
        width: width,
        height: height,
        autosize: false,  // 自動サイズ調整を無効化
        hovermode: 'closest',
        legend: {
            x: 1.02,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',
            xref: 'paper',
            yref: 'paper',
            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#cccccc',
            borderwidth: 1
        },
        margin: {
            l: 80,
            r: 150,  // 非点収差図と同じ値に統一
            t: 80,
            b: 80
        }
    };
    
    // プロット実行
    Plotly.newPlot(container, traces, layout, {
        responsive: false,  // autosize: falseと統一するためfalseに
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false
    });
    
    console.log('✅ 正弦条件違反量プロット完了');
}
