/**
 * Integrated Aberration Diagram (統合収差図)
 * 球面収差、非点収差、歪曲収差を一つのウィンドウにまとめて表示
 * 
 * 機能:
 * - 3つの収差図を並べて表示（Plotly subplots使用）
 * - 左：球面収差（Longitudinal Aberration）
 * - 中央：非点収差（Astigmatic Field Curves）
 * - 右：歪曲収差（Distortion）
 * 
 * 作成日: 2025/12/18
 */

/**
 * 波長から色を取得（6段階スペクトル）
 */
function getColorForWavelength(wavelength) {
    if (wavelength < 0.45) return '#8B00FF';      // 青紫（g線）
    if (wavelength < 0.495) return '#0000FF';     // 青（F線）
    if (wavelength < 0.57) return '#00FF00';      // 緑
    if (wavelength < 0.59) return '#9ACD32';      // 濃い黄緑（d線）
    if (wavelength < 0.62) return '#FF8800';      // オレンジ
    return '#FF0000';                              // 赤（C線）
}

function inferObjectFieldMode(objects) {
    const rows = Array.isArray(objects) ? objects : [];
    const pickTag = (o) => {
        const raw = o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type;
        return (raw ?? '').toString().toLowerCase();
    };
    const tags = rows.map(pickTag).filter(Boolean);

    const hasRect = tags.some(t => t.includes('rect') || t.includes('rectangle'));
    const hasHeight = tags.some(t => t.includes('height'));
    if (hasRect || hasHeight) return { mode: 'height' };

    const hasAngle = tags.some(t => t.includes('angle'));
    if (hasAngle) return { mode: 'angle' };

    // Fallback (データ列から推定)
    const hasNumericHeight = rows.some(o => {
        const h = parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? NaN);
        return Number.isFinite(h) && Math.abs(h) > 0;
    });
    return { mode: hasNumericHeight ? 'height' : 'angle' };
}

/**
 * 統合収差図を表示
 * @param {Object} longitudinalData - 球面収差データ
 * @param {Object} astigmatismData - 非点収差データ
 * @param {Object} distortionData - 歪曲収差データ
 * @param {Object} options - 表示オプション
 */
export function plotIntegratedAberrationDiagram(longitudinalData, astigmatismData, distortionData, options = {}) {
    console.log('📊 統合収差図作成開始');

    const containerElement = options?.containerElement || null;
    const infoElement = options?.infoElement || null;

    // popup/container描画モード
    if (containerElement) {
        const doc = containerElement.ownerDocument;
        const targetWindow = doc?.defaultView || window;
        const plotly = targetWindow?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
        if (!plotly) {
            console.error('❌ Plotly library is not loaded');
            alert('Plotly.js がロードされていません。');
            return;
        }

        const defaultOptions = {
            width: 1440,
            height: 600,
            mainTitle: 'Integrated Aberration Diagram',
            configName: '',
            ...options
        };
        const plotOptions = { ...defaultOptions, ...options };

        createIntegratedPlot({
            targetWindow,
            plotly,
            containerElement,
            infoElement
        }, longitudinalData, astigmatismData, distortionData, plotOptions);
        return;
    }

    // legacy: 新しいウィンドウを作成して描画
    if (typeof Plotly === 'undefined') {
        console.error('❌ Plotly library is not loaded');
        alert('Plotly.js がロードされていません。HTMLファイルにPlotly.jsを含めてください。');
        return;
    }

    const newWindow = window.open('', '_blank', 'width=1600,height=1024');
    if (!newWindow) {
        alert('ポップアップブロックが有効になっている可能性があります。');
        return;
    }

    const defaultOptions = {
        width: 1440,
        height: 600,
        mainTitle: 'Integrated Aberration Diagram',
        configName: '',
        ...options
    };

    const plotOptions = { ...defaultOptions, ...options };

    newWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Integrated Aberration Diagram</title>
            <script src="https://cdn.plot.ly/plotly-2.26.0.min.js"></script>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                    background-color: #f5f5f5;
                }
                h1 {
                    text-align: center;
                    color: #333;
                    margin-bottom: 20px;
                }
                #plot-container {
                    background-color: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .info-panel {
                    margin-top: 20px;
                    padding: 15px;
                    background-color: #f9f9f9;
                    border-left: 4px solid #4CAF50;
                    border-radius: 4px;
                }
                .info-panel h3 {
                    margin-top: 0;
                    color: #4CAF50;
                }
            </style>
        </head>
        <body>
            <h1>${plotOptions.mainTitle}</h1>
            <div id="plot-container"></div>
            <div class="info-panel" id="info-panel"></div>
        </body>
        </html>
    `);
    newWindow.document.close();

    const checkPlotly = setInterval(() => {
        if (newWindow.Plotly) {
            clearInterval(checkPlotly);
            createIntegratedPlot({
                targetWindow: newWindow,
                plotly: newWindow.Plotly,
                containerElement: newWindow.document.getElementById('plot-container'),
                infoElement: newWindow.document.getElementById('info-panel')
            }, longitudinalData, astigmatismData, distortionData, plotOptions);
        }
    }, 100);
}

/**
 * 統合プロットを作成
 */
function createIntegratedPlot(target, longitudinalData, astigmatismData, distortionData, options) {
    const targetWindow = target?.targetWindow || window;
    const plotly = target?.plotly || targetWindow?.Plotly;
    const containerElement = target?.containerElement || targetWindow?.document?.getElementById?.('plot-container');
    const infoElement = target?.infoElement || null;

    if (!plotly) {
        console.error('❌ Plotly library is not loaded (createIntegratedPlot)');
        return;
    }
    if (!containerElement) {
        console.error('❌ Plot container is missing (createIntegratedPlot)');
        return;
    }

    const traces = [];
    // Object table (Angle / Rectangle) からモード判定
    let objectRows = [];
    try {
        const openerWindow = targetWindow.opener || window;
        objectRows = openerWindow?.tableObject?.getData?.() || [];
    } catch (_) {
        objectRows = [];
    }
    const fieldMode = inferObjectFieldMode(objectRows);
    const heightMode = fieldMode.mode === 'height';
    
    // ===========================================
    // 1. 球面収差（左側：subplot 1）
    // ===========================================
    if (longitudinalData && longitudinalData.meridionalData) {
        // メリディオナル光線（実線）
        longitudinalData.meridionalData.forEach((data, index) => {
            const wavelength = data.wavelength;
            const wavelengthNm = (wavelength * 1000).toFixed(1);
            const color = getColorForWavelength(wavelength);
            
            const sortedPoints = [...data.points].sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
            const xValues = sortedPoints.map(p => p.longitudinalAberration);
            const yValues = sortedPoints.map(p => p.pupilCoordinate);
            
            traces.push({
                x: xValues,
                y: yValues,
                mode: 'lines+markers',
                type: 'scatter',
                name: `SA ${wavelengthNm}nm`,
                line: { color: color, width: 2 },
                marker: { size: 4, color: color },
                xaxis: 'x',
                yaxis: 'y',
                legendgroup: `spherical-${wavelengthNm}`,
                showlegend: true
            });
        });
        
        // サジタル光線（破線）
        if (longitudinalData.sagittalData) {
            longitudinalData.sagittalData.forEach((data, index) => {
                const wavelength = data.wavelength;
                const wavelengthNm = (wavelength * 1000).toFixed(1);
                const color = getColorForWavelength(wavelength);
                
                const sortedPoints = [...data.points].sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
                const xValues = sortedPoints.map(p => p.longitudinalAberration);
                const yValues = sortedPoints.map(p => p.pupilCoordinate);
                
                traces.push({
                    x: xValues,
                    y: yValues,
                    mode: 'lines+markers',
                    type: 'scatter',
                    name: `${wavelengthNm}nm (S)`,
                    line: { color: color, width: 2, dash: 'dash' },
                    marker: { size: 4, color: color, symbol: 'square' },
                    xaxis: 'x',
                    yaxis: 'y',
                    legendgroup: `spherical-${wavelengthNm}`,
                    showlegend: false
                });
            });
        }
    }
    
    // ===========================================
    // 2. 非点収差（中央：subplot 2）
    // ===========================================
    if (astigmatismData && astigmatismData.data && astigmatismData.data.length > 0) {
        // 波長ごとにデータをグループ化
        const wavelengthGroups = {};
        astigmatismData.data.forEach(point => {
            const wl = point.wavelength;
            if (!wavelengthGroups[wl]) {
                wavelengthGroups[wl] = [];
            }
            wavelengthGroups[wl].push(point);
        });
        
        // 各波長のメリディオナル・サジタル曲線を描画
        Object.entries(wavelengthGroups).forEach(([wavelength, points]) => {
            const wl = parseFloat(wavelength);
            const wavelengthNm = (wl * 1000).toFixed(1);
            const color = getColorForWavelength(wl);
            
            // フィールド角度でソート
            const sortedPoints = points.sort((a, b) => a.fieldAngle - b.fieldAngle);
            
            // メリディオナル曲線（実線）
            const meridionalX = sortedPoints.map(p => p.meridionalDeviation || 0);
            const meridionalY = sortedPoints.map(p => p.fieldAngle);
            
            if (meridionalX.length > 0) {
                traces.push({
                    x: meridionalX,
                    y: meridionalY,
                    mode: 'lines+markers',
                    type: 'scatter',
                    name: `AS ${wavelengthNm}nm M:solid, S:dashed`,
                    line: { color: color, width: 2 },
                    marker: { size: 4, color: color },
                    xaxis: 'x2',
                    yaxis: 'y2',
                    legendgroup: `astigmatism-${wavelengthNm}`,
                    showlegend: true
                });
            }
            
            // サジタル曲線（破線）
            const sagittalX = sortedPoints.map(p => p.sagittalDeviation || 0);
            const sagittalY = sortedPoints.map(p => p.fieldAngle);
            
            if (sagittalX.length > 0) {
                traces.push({
                    x: sagittalX,
                    y: sagittalY,
                    mode: 'lines+markers',
                    type: 'scatter',
                    name: `${wavelengthNm}nm (S)`,
                    line: { color: color, width: 2, dash: 'dash' },
                    marker: { size: 4, color: color, symbol: 'square' },
                    xaxis: 'x2',
                    yaxis: 'y2',
                    legendgroup: `astigmatism-${wavelengthNm}`,
                    showlegend: false
                });
            }
        });
    }
    
    // ===========================================
    // 3. 歪曲収差（右側：subplot 3）
    // ===========================================
    if (distortionData && Array.isArray(distortionData)) {
        // 各波長の歪曲収差をプロット
        distortionData.forEach((wavelengthData, index) => {
            const { wavelength, data } = wavelengthData;
            
            if (data && data.fieldValues && data.distortionPercent) {
                const xValues = data.distortionPercent.filter(v => v !== null);
                const yValues = data.fieldValues.filter((_, i) => data.distortionPercent[i] !== null);
                
                if (xValues.length > 0) {
                    const wavelengthNm = (wavelength * 1000).toFixed(1);
                    const color = getColorForWavelength(wavelength);
                    
                    traces.push({
                        x: xValues,
                        y: yValues,
                        mode: 'lines+markers',
                        type: 'scatter',
                        name: `DIST ${wavelengthNm}nm`,
                        line: { color: color, width: 2 },
                        marker: { size: 6, color: color },
                        xaxis: 'x3',
                        yaxis: 'y3',
                        legendgroup: `distortion-${wavelengthNm}`,
                        showlegend: true
                    });
                }
            }
        });
    }
    
    // レイアウト設定
    const layout = {
        title: {
            text: '',
            font: { size: 18, family: 'Arial, sans-serif' }
        },
        width: options.width,
        height: options.height,
        
        // 球面収差軸（左側）
        xaxis: {
            title: { text: 'Longitudinal Aberration (mm)', font: { size: 12 } },
            domain: [0, 0.28],
            range: [-0.5, 0.5],
            dtick: 0.1,
            ticklabelstandoff: 10,
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2,
            gridcolor: '#E0E0E0'
        },
        yaxis: {
            title: { text: 'Normalized Pupil Coord.', font: { size: 12 } },
            anchor: 'x',
            domain: [0, 1],
            range: [0, 1],
            rangemode: 'tozero',
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2
        },
        
        // 非点収差軸（中央）
        xaxis2: {
            title: { text: 'Image Position (mm)', font: { size: 12 } },
            domain: [0.36, 0.64],
            anchor: 'y2',
            range: [-0.5, 0.5],
            dtick: 0.1,
            ticklabelstandoff: 10,
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1,
            gridcolor: '#E0E0E0'
        },
        yaxis2: {
            title: { text: heightMode ? 'Object Height (mm)' : 'Object Angle θ (deg)', font: { size: 12 } },
            anchor: 'x2',
            domain: [0, 1],
            rangemode: 'tozero',
            autorange: true,
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1
        },
        
        // 歪曲収差軸（右側）
        xaxis3: {
            title: { text: 'Distortion (%)', font: { size: 12 } },
            domain: [0.72, 1],
            anchor: 'y3',
            range: [-5, 5],
            dtick: 1,
            ticklabelstandoff: 10,
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 2,
            gridcolor: '#E0E0E0'
        },
        yaxis3: {
            title: { text: heightMode ? 'Object Height (mm)' : 'Object Angle θ (deg)', font: { size: 12 } },
            anchor: 'x3',
            domain: [0, 1],
            rangemode: 'tozero',
            autorange: true,
            gridcolor: '#E0E0E0',
            zeroline: true,
            zerolinecolor: '#000000',
            zerolinewidth: 1
        },
        
        // 凡例設定
        showlegend: true,
        legend: {
            x: 1.02,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',
            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#cccccc',
            borderwidth: 1
        },
        
        // サブプロットのタイトル
        annotations: [
            {
                text: 'Spherical Aberration',
                x: 0.14,
                y: 1.05,
                xref: 'paper',
                yref: 'paper',
                xanchor: 'center',
                yanchor: 'bottom',
                showarrow: false,
                font: { size: 14, color: '#333', weight: 'bold' }
            },
            {
                text: 'Astigmatic Field Curves',
                x: 0.5,
                y: 1.05,
                xref: 'paper',
                yref: 'paper',
                xanchor: 'center',
                yanchor: 'bottom',
                showarrow: false,
                font: { size: 14, color: '#333', weight: 'bold' }
            },
            {
                text: 'Distortion',
                x: 0.86,
                y: 1.05,
                xref: 'paper',
                yref: 'paper',
                xanchor: 'center',
                yanchor: 'bottom',
                showarrow: false,
                font: { size: 14, color: '#333', weight: 'bold' }
            }
        ],
        
        margin: { l: 60, r: 150, t: 100, b: 60 },
        hovermode: 'closest',
        autosize: false
    };
    
    // container描画時はウィンドウに追従（autosize + responsive）
    if (target?.containerElement) {
        layout.autosize = true;
        delete layout.width;
        delete layout.height;
    }

    // プロット作成
    plotly.newPlot(containerElement, traces, layout, {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d'],
        displaylogo: false
    });

    // 情報パネルの更新（任意）
    if (infoElement) {
        updateInfoPanel({ infoElement }, longitudinalData, astigmatismData, distortionData, heightMode);
    }
    
    console.log('✅ 統合収差図作成完了');
}

/**
 * 情報パネルを更新
 */
function updateInfoPanel(target, longitudinalData, astigmatismData, distortionData, heightMode = false) {
    const infoPanel = target?.infoElement || null;
    if (!infoPanel) return;
    
    let html = '<h3>Aberration Diagram Information</h3>';
    html += '<ul>';
    
    if (longitudinalData) {
        const wavelengths = longitudinalData.meridionalData?.map(d => 
            `${(d.wavelength * 1000).toFixed(1)}nm`
        ).join(', ') || 'N/A';
        html += `<li><strong>Spherical Aberration:</strong> Wavelengths ${wavelengths}</li>`;
    }
    
    if (astigmatismData && astigmatismData.data) {
        // ユニークなフィールド値をカウント
        const uniqueFieldValues = new Set(astigmatismData.data.map(p => p.fieldAngle));
        const fieldCount = uniqueFieldValues.size;
        const fieldLabel = heightMode ? 'object heights' : 'object angles';
        html += `<li><strong>Astigmatism:</strong> ${fieldCount} ${fieldLabel}</li>`;
    }
    
    if (distortionData && Array.isArray(distortionData)) {
        // 全波長の歪曲収差から最大値を計算
        let maxDistortion = 0;
        distortionData.forEach(wavelengthData => {
            if (wavelengthData.data && wavelengthData.data.distortionPercent) {
                wavelengthData.data.distortionPercent.forEach(val => {
                    if (val !== null) {
                        maxDistortion = Math.max(maxDistortion, Math.abs(val));
                    }
                });
            }
        });
        html += `<li><strong>Distortion:</strong> Maximum ${maxDistortion.toFixed(2)}%</li>`;
    }
    
    html += '</ul>';
    html += '<p><em>Legend: M=Meridional, S=Sagittal</em></p>';
    
    infoPanel.innerHTML = html;
}
