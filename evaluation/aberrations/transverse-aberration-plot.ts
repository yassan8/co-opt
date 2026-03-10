/**
 * Transverse Aberration Plot (Plotly Version)
 * 横収差グラフ表示用ファイル
 * 
 * 機能:
 * - Plotlyを使用した横収差グラフの表示
 * - メリジオナル・サジタル光線の左右分割表示
 * - 主光線を基準とした横収差の可視化
 * - 規格化された瞳座標での表示
 * - 従来関数との互換性維持
 * 
 * 作成日: 2025/07/24
 */

/**
 * 横収差図をPlotlyで表示
 * @param {s            // サジタル軸（右側）
            xaxis2: {
                title: '規格化瞳座標',
                range: [-1.1, 1.1], // ±1まで（10%マージン）
                showgrid: plotOptions.gridLines,
                zeroline: true,
                domain: [0.55, 1]
            },ontainerId - 表示コンテナのID
 * @param {Object} aberrationData - 横収差データ
 * @param {Object} options - 表示オプション
 */
export function plotTransverseAberration(containerId, aberrationData, options = {}) {
    console.log('📊 横収差図作成開始');
    console.log('📊 [DEBUG] meridionalData数:', aberrationData?.meridionalData?.length);
    console.log('📊 [DEBUG] sagittalData数:', aberrationData?.sagittalData?.length);
    console.log('📊 [DEBUG] aberrationData詳細:', aberrationData);
    
    if (!aberrationData || !aberrationData.meridionalData || !aberrationData.sagittalData) {
        console.error('❌ 無効な横収差データです');
        return;
    }
    
    const container = typeof containerId === 'string'
        ? document.getElementById(containerId)
        : containerId;
    if (!container) {
        console.error(`❌ コンテナ ${typeof containerId === 'string' ? containerId : '(element)'} が見つかりません`);
        return;
    }

    const targetDocument = container.ownerDocument || document;
    const plotlyRef = targetDocument?.defaultView?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
    
    // デフォルトオプション
    const defaultOptions = {
        width: 1000,
        height: 600,
        title: '横収差図',
        showLegend: true,
        gridLines: true,
        colors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
    };
    
    const plotOptions = { ...defaultOptions, ...options };

    const computeSquareDomains = () => {
        const margin = { l: 80, r: 150, t: 80, b: 80 };
        const gap = 0.1;
        const maxSpanBySpace = (1 - gap) / 2; // 0.45

        const containerWidth = Math.max(200, Number(container?.clientWidth) || Number(plotOptions.width) || 1000);
        const containerHeight = Math.max(200, Number(container?.clientHeight) || Number(plotOptions.height) || 600);
        const innerW = Math.max(100, containerWidth - margin.l - margin.r);
        const innerH = Math.max(100, containerHeight - margin.t - margin.b);
        const spanByAspect = innerH / innerW;

        // Case A: wide canvas -> shrink X span and keep full Y.
        // Case B: tall canvas -> keep max X span and shrink Y span.
        let xSpan = maxSpanBySpace;
        let ySpan = 1;
        if (spanByAspect <= maxSpanBySpace) {
            xSpan = Math.max(0.1, spanByAspect);
            ySpan = 1;
        } else {
            xSpan = maxSpanBySpace;
            ySpan = Math.max(0.1, Math.min(1, (xSpan * innerW) / innerH));
        }

        const totalX = 2 * xSpan + gap;
        const xStart = Math.max(0, (1 - totalX) / 2);
        const yStart = Math.max(0, (1 - ySpan) / 2);

        const x1: [number, number] = [xStart, xStart + xSpan];
        const x2: [number, number] = [xStart + xSpan + gap, xStart + 2 * xSpan + gap];
        const y: [number, number] = [yStart, yStart + ySpan];

        return {
            margin,
            x1,
            x2,
            y,
            meridionalCenterX: x1[0] + xSpan / 2,
            sagittalCenterX: x2[0] + xSpan / 2,
        };
    };

    const parseNumber = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const getFieldLabel = (fieldSetting, index) => {
        const fs = fieldSetting || {};
        const posRaw = String(fs.position ?? fs.fieldType ?? fs.type ?? '').toLowerCase();
        const isAngle = posRaw.includes('angle') && !posRaw.includes('rect');

        const fx = isAngle
            ? parseNumber(fs.fieldAngle?.x ?? fs.xFieldAngle ?? fs.xHeightAngle ?? fs.x)
            : parseNumber(fs.xHeight ?? fs.x ?? fs.xHeightAngle);
        const fy = isAngle
            ? parseNumber(fs.fieldAngle?.y ?? fs.yFieldAngle ?? fs.yHeightAngle ?? fs.y)
            : parseNumber(fs.yHeight ?? fs.y ?? fs.yHeightAngle);

        const unit = isAngle ? 'deg' : 'mm';
        const modeLabel = isAngle ? 'Angle' : 'Height';
        const xText = Number.isFinite(fx) ? fx.toFixed(3) : '0.000';
        const yText = Number.isFinite(fy) ? fy.toFixed(3) : '0.000';
        return `Object ${index + 1} (${modeLabel}: X=${xText} ${unit}, Y=${yText} ${unit})`;
    };
    
    try {
        // Plotlyの可用性チェック
        if (!plotlyRef) {
            throw new Error('Plotly library is not loaded. Please include Plotly.js in your HTML file.');
        }
        
        // サブプロット構成（左：メリジオナル、右：サジタル）
        const traces = [];
        
        // 全データから最大収差値を取得してY軸範囲を統一（部分的なデータも含む）
        let maxAberration = 0;
        
        // メリジオナルデータから最大値を取得
        aberrationData.meridionalData.forEach(data => {
            if (data.points && data.points.length > 0) {
                data.points.forEach(point => {
                    if (isFinite(point.transverseAberration)) {
                        maxAberration = Math.max(maxAberration, Math.abs(point.transverseAberration));
                    }
                });
            }
        });
        
        // サジタルデータから最大値を取得
        aberrationData.sagittalData.forEach(data => {
            if (data.points && data.points.length > 0) {
                data.points.forEach(point => {
                    if (isFinite(point.transverseAberration)) {
                        maxAberration = Math.max(maxAberration, Math.abs(point.transverseAberration));
                    }
                });
            }
        });
        
        // μm単位に変換（mm→μm: ×1000）、10%のマージンを追加
        const maxAberrationMicrons = maxAberration * 1000 * 1.1;
        const yAxisRange = [-maxAberrationMicrons, maxAberrationMicrons];
        
        // 有限系の場合、全フィールドのデータから最適化されたオフセットを計算
        let globalCenterOffset = { meridional: 0, sagittal: 0 };
        
        if (aberrationData.isFiniteSystem) {
            // メリジオナル全データの最適化されたオフセットを計算
            let allMeridionalCoords = [];
            aberrationData.meridionalData.forEach(data => {
                if (data.points && data.points.length > 0) {
                    const coords = data.points.map(p => p.pupilCoordinate);
                    allMeridionalCoords.push(...coords);
                }
            });
            if (allMeridionalCoords.length > 0) {
                // 重複を除去してユニークな座標のみを使用
                const uniqueCoords = [...new Set(allMeridionalCoords)].sort((a, b) => a - b);
                const minCoord = uniqueCoords[0];
                const maxCoord = uniqueCoords[uniqueCoords.length - 1];
                globalCenterOffset.meridional = (minCoord + maxCoord) / 2;
            }
            
            // サジタル全データの最適化されたオフセットを計算
            let allSagittalCoords = [];
            aberrationData.sagittalData.forEach(data => {
                if (data.points && data.points.length > 0) {
                    const coords = data.points.map(p => p.pupilCoordinate);
                    allSagittalCoords.push(...coords);
                }
            });
            if (allSagittalCoords.length > 0) {
                // 重複を除去してユニークな座標のみを使用
                const uniqueCoords = [...new Set(allSagittalCoords)].sort((a, b) => a - b);
                const minCoord = uniqueCoords[0];
                const maxCoord = uniqueCoords[uniqueCoords.length - 1];
                globalCenterOffset.sagittal = (minCoord + maxCoord) / 2;
            }
        }
        
        // メリジオナルデータの処理
        aberrationData.meridionalData.forEach((data, fieldIndex) => {
            if (data.points && data.points.length > 0) {
                // オフセット情報をログ出力
                if (data.hasOffset) {
                    console.log(`📊 Field ${fieldIndex} M: データ既にオフセット済み (${data.offsetMethod}, 元位置=${data.zeroAberrationPosition?.toFixed(6)})`);
                } else {
                    console.log(`📊 Field ${fieldIndex} M: オフセット処理なし`);
                }
                
                // 完全に成功した光線と部分的な光線を分離
                const fullSuccessPoints = data.points.filter(p => p.isFullSuccess !== false);
                const partialPoints = data.points.filter(p => p.isPartial === true);
                
                // 完全成功光線のプロット
                if (fullSuccessPoints.length > 0) {
                    // データが既にオフセット済みなので、そのまま使用
                    if (data.hasOffset && data.zeroAberrationPosition !== null && data.zeroAberrationPosition !== undefined) {
                        console.log(`📊 Field ${fieldIndex} M: データ既にオフセット済み (${data.offsetMethod}, 元位置=${data.zeroAberrationPosition?.toFixed(6)})`);
                    } else {
                        console.log(`📊 Field ${fieldIndex} M: オフセット処理なし`);
                    }
                    
                    // 瞳座標をそのまま使用（データは既にオフセット済み）
                    const x = fullSuccessPoints.map(p => p.pupilCoordinate);
                    const y = fullSuccessPoints.map(p => p.transverseAberration * 1000); // mm→μmに変換
                    
                    traces.push({
                        x: x,
                        y: y,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${getFieldLabel(data.fieldSetting, fieldIndex)} (M)`,
                        line: {
                            color: plotOptions.colors[fieldIndex % plotOptions.colors.length],
                            width: 2
                        },
                        xaxis: 'x',
                        yaxis: 'y',
                        hovertemplate: '<b>%{fullData.name}</b><br>' +
                                       'Pupil Coord: %{x:.3f}<br>' +
                                       'Transverse Aberration: %{y:.3f} μm<br>' +
                                       '<extra></extra>'
                    });
                }
                
                // 部分的な光線のプロット（異なるスタイル）
                if (partialPoints.length > 0) {
                    // データが既にオフセット済みなので、そのまま使用
                    const x = partialPoints.map(p => p.pupilCoordinate);
                    const y = partialPoints.map(p => p.transverseAberration * 1000); // mm→μmに変換
                    
                    traces.push({
                        x: x,
                        y: y,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${getFieldLabel(data.fieldSetting, fieldIndex)} (M-partial)`,
                        line: {
                            color: plotOptions.colors[fieldIndex % plotOptions.colors.length],
                            width: 1.5,
                            dash: 'dot'
                        },
                        xaxis: 'x',
                        yaxis: 'y',
                        hovertemplate: '<b>%{fullData.name}</b><br>' +
                                       'Pupil Coord: %{x:.3f}<br>' +
                                       'Transverse Aberration: %{y:.3f} μm (estimated)<br>' +
                                       '<extra></extra>'
                    });
                }
            }
        });
        
        // サジタルデータの処理
        aberrationData.sagittalData.forEach((data, fieldIndex) => {
            if (data.points && data.points.length > 0) {
                // オフセット情報をログ出力
                if (data.hasOffset) {
                    console.log(`📊 Field ${fieldIndex} S: データ既にオフセット済み (${data.offsetMethod}, 元位置=${data.zeroAberrationPosition?.toFixed(6)})`);
                } else {
                    console.log(`📊 Field ${fieldIndex} S: オフセットなし`);
                }
                
                // 完全に成功した光線と部分的な光線を分離
                const fullSuccessPoints = data.points.filter(p => p.isFullSuccess !== false);
                const partialPoints = data.points.filter(p => p.isPartial === true);
                
                // 完全成功光線のプロット
                if (fullSuccessPoints.length > 0) {
                    // データが既にオフセット済みかチェック
                    if (data.hasOffset && data.zeroAberrationPosition !== null && data.zeroAberrationPosition !== undefined) {
                        console.log(`📊 Field ${fieldIndex} S: データ既にオフセット済み (${data.offsetMethod}, 元位置=${data.zeroAberrationPosition?.toFixed(6)})`);
                    } else {
                        console.log(`📊 Field ${fieldIndex} S: オフセット処理なし`);
                    }
                    
                    // 瞳座標をそのまま使用（フィッティングによるオフセットのみ適用済み）
                    const x = fullSuccessPoints.map(p => p.pupilCoordinate);
                    const y = fullSuccessPoints.map(p => p.transverseAberration * 1000); // mm→μmに変換
                    
                    traces.push({
                        x: x,
                        y: y,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${getFieldLabel(data.fieldSetting, fieldIndex)} (S)`,
                        line: {
                            color: plotOptions.colors[fieldIndex % plotOptions.colors.length],
                            width: 2,
                            dash: 'dash' // サジタルは破線で区別
                        },
                        xaxis: 'x2',
                        yaxis: 'y2',
                        hovertemplate: '<b>%{fullData.name}</b><br>' +
                                       'Pupil Coord: %{x:.3f}<br>' +
                                       'Transverse Aberration: %{y:.3f} μm<br>' +
                                       '<extra></extra>'
                    });
                }
                
                // 部分的な光線のプロット（異なるスタイル）
                if (partialPoints.length > 0) {
                    // データが既にオフセット済みの場合はそのまま使用
                    const partialX = partialPoints.map(p => p.pupilCoordinate);
                    const partialY = partialPoints.map(p => p.transverseAberration * 1000); // mm→μmに変換
                    
                    traces.push({
                        x: partialX,
                        y: partialY,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${getFieldLabel(data.fieldSetting, fieldIndex)} (S-partial)`,
                        line: {
                            color: plotOptions.colors[fieldIndex % plotOptions.colors.length],
                            width: 1.5,
                            dash: 'dot'
                        },
                        xaxis: 'x2',
                        yaxis: 'y2',
                        hovertemplate: '<b>%{fullData.name}</b><br>' +
                                       'Pupil Coord: %{x:.3f}<br>' +
                                       'Transverse Aberration: %{y:.3f} μm (estimated)<br>' +
                                       '<extra></extra>'
                    });
                }
            }
        });
        
        // レイアウト設定
        const squareDomains = computeSquareDomains();
        const layout = {
            title: {
                text: plotOptions.title,
                font: { size: 16 }
            },
            width: plotOptions.width,
            height: plotOptions.height,
            
            // サブプロット設定
            grid: {
                rows: 1,
                columns: 2,
                pattern: 'independent',
                xgap: 0.1
            },
            
            // メリジオナル軸（左側）
            xaxis: {
                title: 'Normalized Pupil Coordinate',
                range: [-1.1, 1.1], // ±1まで（10%マージン）
                showgrid: plotOptions.gridLines,
                zeroline: true,
                domain: squareDomains.x1
            },
            yaxis: {
                title: 'Transverse Aberration (μm)',
                range: yAxisRange,
                showgrid: plotOptions.gridLines,
                zeroline: true,
                domain: squareDomains.y
            },
            
            // サジタル軸（右側）
            xaxis2: {
                title: 'Normalized Pupil Coordinate',
                range: [-1.1, 1.1], // ±1まで（10%マージン）
                showgrid: plotOptions.gridLines,
                zeroline: true,
                domain: squareDomains.x2
            },
            yaxis2: {
                title: 'Transverse Aberration (μm)',
                range: yAxisRange,
                showgrid: plotOptions.gridLines,
                zeroline: true,
                domain: squareDomains.y
            },
            
            // 凡例設定
            showlegend: plotOptions.showLegend,
            legend: {
                x: 1.05,
                y: 1,
                bgcolor: 'rgba(255,255,255,0.8)',
                bordercolor: 'rgba(0,0,0,0.2)',
                borderwidth: 1
            },
            
            // アノテーション（軸ラベル）
            annotations: [
                {
                    text: 'Meridional',
                    x: squareDomains.meridionalCenterX,
                    y: 1.02,
                    xref: 'paper',
                    yref: 'paper',
                    xanchor: 'center',
                    yanchor: 'bottom',
                    showarrow: false,
                    font: { size: 14, color: '#333' }
                },
                {
                    text: 'Sagittal',
                    x: squareDomains.sagittalCenterX,
                    y: 1.02,
                    xref: 'paper',
                    yref: 'paper',
                    xanchor: 'center',
                    yanchor: 'bottom',
                    showarrow: false,
                    font: { size: 14, color: '#333' }
                }
            ],
            
            // マージン設定
            margin: {
                l: squareDomains.margin.l,
                r: squareDomains.margin.r,
                t: squareDomains.margin.t,
                b: squareDomains.margin.b
            }
        };
        
        // プロット作成（popup含む: container要素を直接渡す）
        layout.autosize = true;
        delete layout.width;
        delete layout.height;

        plotlyRef.newPlot(container, traces, layout, {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d'],
            displaylogo: false
        });

        // リサイズ追従
        const win = targetDocument?.defaultView;
        if (win && plotlyRef?.Plots?.resize) {
            if (container.__transversePlotResizeHandler) {
                try { win.removeEventListener('resize', container.__transversePlotResizeHandler); } catch (_) {}
            }
            container.__transversePlotResizeHandler = () => {
                try {
                    plotlyRef.Plots.resize(container);
                    const d = computeSquareDomains();
                    plotlyRef.relayout(container, {
                        'xaxis.domain': d.x1,
                        'xaxis2.domain': d.x2,
                        'yaxis.domain': d.y,
                        'yaxis2.domain': d.y,
                        'annotations[0].x': d.meridionalCenterX,
                        'annotations[1].x': d.sagittalCenterX,
                    });
                } catch (_) {}
            };
            win.addEventListener('resize', container.__transversePlotResizeHandler);
            try { container.__transversePlotResizeHandler(); } catch (_) {}
        }
        
        // 情報パネルの更新
        if (typeof containerId === 'string') {
            updateAberrationInfoPanel(aberrationData, containerId);
        }
        
        console.log('✅ 横収差図作成完了');
        
    } catch (error) {
        console.error('❌ 横収差図作成エラー:', error);
        container.innerHTML = `
            <div style="text-align: center; padding: 50px; color: #666;">
                <h3>グラフ作成エラー</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
}

/**
 * 従来の横収差図表示関数（互換性維持用）
 * @param {Object} aberrationData - 横収差データ
 * @param {string} containerId - 表示コンテナのID  
 * @param {Document} targetDocument - 描画対象のドキュメント
 */
export function plotTransverseAberrationDiagram(aberrationData, containerId = 'transverse-aberration-container', targetDocument = document) {
    console.log('🔄 従来形式の横収差図表示（Plotly版へ変換）');
    
    // 新形式のデータ構造に変換
    const convertedData = convertLegacyDataFormat(aberrationData);
    
    // Plotly版で表示
    plotTransverseAberration(containerId, convertedData, {
        title: 'Transverse Aberration Diagram',
        width: 1000,
        height: 600
    });
}

/**
 * 従来形式のデータを新形式に変換
 * @param {Object} legacyData - 従来形式のデータ
 * @returns {Object} 新形式のデータ
 */
function convertLegacyDataFormat(legacyData) {
    console.log('🔄 データ変換開始:', legacyData);
    
    const convertedData = {
        fieldSettings: legacyData.fieldSettings || [],
        wavelength: legacyData.wavelength || 0.5876,
        targetSurface: legacyData.targetSurface || 0,
        stopSurface: legacyData.stopSurface || 0,
        stopRadius: legacyData.stopRadius || 5,
        isFiniteSystem: legacyData.isFiniteSystem || false,
        meridionalData: [],
        sagittalData: [],
        metadata: legacyData.metadata || {}
    };
    
    // メリジオナルデータの変換
    if (legacyData.meridionalData) {
        console.log('🔄 メリジオナルデータ変換:', legacyData.meridionalData);
        console.log(`🔄 メリジオナルデータ配列長: ${legacyData.meridionalData.length}`);
        console.log(`🔄 fieldSettings配列長: ${legacyData.fieldSettings.length}`);
        
        legacyData.meridionalData.forEach((data, index) => {
            const fieldSetting = legacyData.fieldSettings[index] || { displayName: `Field ${index + 1}` };
            
            console.log(`🔍 Field ${index}: fieldSetting =`, fieldSetting);
            console.log(`🔍 Field ${index}: data.points length = ${data.points ? data.points.length : 'undefined'}`);
            
            // サンプルポイントをログ出力
            if (data.points && data.points.length > 0) {
                console.log(`🔍 Field ${index} メリジオナル sample points:`, data.points.slice(0, 3));
                // 全てのポイントの収差値をチェック
                const aberrationValues = data.points.map(p => p.transverseAberration);
                console.log(`🔍 Field ${index} メリジオナル収差値範囲: [${Math.min(...aberrationValues).toFixed(6)}, ${Math.max(...aberrationValues).toFixed(6)}]`);
                
                // データが同一かチェック
                if (index > 0) {
                    const prevData = legacyData.meridionalData[index - 1];
                    if (prevData && prevData.points && prevData.points.length > 0) {
                        const currentFirst = data.points[0];
                        const prevFirst = prevData.points[0];
                        const isSame = (
                            currentFirst.pupilCoordinate === prevFirst.pupilCoordinate &&
                            currentFirst.transverseAberration === prevFirst.transverseAberration
                        );
                        console.log(`🔍 Field ${index} vs Field ${index-1} データ同一: ${isSame}`);
                        
                        // 詳細比較
                        if (isSame) {
                            console.log(`❌ Field ${index}: 収差データが前のフィールドと同一です！`);
                            console.log(`   Current field angle: ${fieldSetting.fieldAngle}°`);
                            console.log(`   Previous field angle: ${legacyData.fieldSettings[index-1]?.fieldAngle}°`);
                            console.log(`   Current aberration: ${currentFirst.transverseAberration}`);
                            console.log(`   Previous aberration: ${prevFirst.transverseAberration}`);
                        }
                    }
                }
            }
            
            convertedData.meridionalData.push({
                fieldSetting: fieldSetting,
                rayType: 'meridional',
                points: data.points ? data.points.map(p => ({
                    pupilCoordinate: p.pupilCoordinate || p.normalizedPupilCoord || p.pupilCoord || 0,
                    transverseAberration: p.transverseAberration || 0,
                    actualCoordinate: {
                        x: p.imageX || 0,
                        y: p.imageY || 0
                    },
                    chiefReference: {
                        x: 0,
                        y: 0
                    }
                })) : [],
                // オフセット情報を保持
                hasOffset: data.hasOffset || false,
                zeroAberrationPosition: data.zeroAberrationPosition || null,
                offsetMethod: data.offsetMethod || 'none'
            });
        });
    }
    
    // サジタルデータの変換
    if (legacyData.sagittalData) {
        console.log('🔄 サジタルデータ変換:', legacyData.sagittalData);
        console.log(`🔄 サジタルデータ配列長: ${legacyData.sagittalData.length}`);
        
        legacyData.sagittalData.forEach((data, index) => {
            const fieldSetting = legacyData.fieldSettings[index] || { displayName: `Field ${index + 1}` };
            
            console.log(`🔍 Field ${index}: サジタル fieldSetting =`, fieldSetting);
            console.log(`🔍 Field ${index}: サジタル data.points length = ${data.points ? data.points.length : 'undefined'}`);
            
            // サンプルポイントをログ出力
            if (data.points && data.points.length > 0) {
                console.log(`🔍 Field ${index} サジタル sample points:`, data.points.slice(0, 3));
                // 全てのポイントの収差値をチェック
                const aberrationValues = data.points.map(p => p.transverseAberration);
                console.log(`🔍 Field ${index} サジタル収差値範囲: [${Math.min(...aberrationValues).toFixed(6)}, ${Math.max(...aberrationValues).toFixed(6)}]`);
                
                // データが同一かチェック
                if (index > 0) {
                    const prevData = legacyData.sagittalData[index - 1];
                    if (prevData && prevData.points && prevData.points.length > 0) {
                        const currentFirst = data.points[0];
                        const prevFirst = prevData.points[0];
                        const isSame = (
                            currentFirst.pupilCoordinate === prevFirst.pupilCoordinate &&
                            currentFirst.transverseAberration === prevFirst.transverseAberration
                        );
                        console.log(`🔍 Field ${index} vs Field ${index-1} サジタルデータ同一: ${isSame}`);
                        
                        // 詳細比較
                        if (isSame) {
                            console.log(`❌ Field ${index}: サジタル収差データが前のフィールドと同一です！`);
                            console.log(`   Current field angle: ${fieldSetting.fieldAngle}°`);
                            console.log(`   Previous field angle: ${legacyData.fieldSettings[index-1]?.fieldAngle}°`);
                            console.log(`   Current aberration: ${currentFirst.transverseAberration}`);
                            console.log(`   Previous aberration: ${prevFirst.transverseAberration}`);
                        }
                    }
                }
            }
            
            convertedData.sagittalData.push({
                fieldSetting: fieldSetting,
                rayType: 'sagittal',
                points: data.points ? data.points.map(p => ({
                    pupilCoordinate: p.pupilCoordinate || p.normalizedPupilCoord || p.pupilCoord || 0,
                    transverseAberration: p.transverseAberration || 0,
                    actualCoordinate: {
                        x: p.imageX || 0,
                        y: p.imageY || 0
                    },
                    chiefReference: {
                        x: 0,
                        y: 0
                    }
                })) : [],
                // オフセット情報を保持
                hasOffset: data.hasOffset || false,
                zeroAberrationPosition: data.zeroAberrationPosition || null,
                offsetMethod: data.offsetMethod || 'none'
            });
        });
    }
    
    console.log('✅ データ変換完了:', convertedData);
    return convertedData;
}

/**
 * 新しいウィンドウで横収差図を表示する
 * @param {Object} aberrationData - 横収差データ
 */
export function showTransverseAberrationInNewWindow(aberrationData) {
    console.log('🚀 新しいウィンドウで横収差図を表示します');

    // 1. 新しいウィンドウを開く
    const newWindow = window.open('', '_blank', 'width=1200,height=800,resizable=yes,scrollbars=yes');
    if (!newWindow) {
        console.error('❌ ポップアップウィンドウを開けませんでした。ポップアップブロッカーを確認してください。');
        alert('ポップアップウィンドウを開けませんでした。ブラウザのポップアップブロッカーを無効にしてください。');
        return;
    }

    newWindow.document.title = 'Transverse Aberration Plot';
    newWindow.document.body.style.backgroundColor = '#f0f0f0';
    newWindow.document.body.style.margin = '0';
    newWindow.document.body.style.padding = '0';

    // 2. Plotly.jsを新しいウィンドウに読み込み
    const plotlyScript = newWindow.document.createElement('script');
    plotlyScript.src = 'https://cdn.plot.ly/plotly-latest.min.js';
    newWindow.document.head.appendChild(plotlyScript);

    // 3. スタイルをコピー
    Array.from(document.styleSheets).forEach(styleSheet => {
        try {
            const cssRules = Array.from(styleSheet.cssRules).map(rule => rule.cssText).join('\n');
            const style = newWindow.document.createElement('style');
            style.textContent = cssRules;
            newWindow.document.head.appendChild(style);
        } catch (e) {
            console.warn(`Cannot read rules from stylesheet: ${styleSheet.href}`, e);
            if (styleSheet.href) {
                const link = newWindow.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = styleSheet.href;
                newWindow.document.head.appendChild(link);
            }
        }
    });

    // 4. プロット用のコンテナを作成
    const containerId = 'transverse-aberration-container-new-window';
    const container = newWindow.document.createElement('div');
    container.id = containerId;
    container.style.padding = '20px';
    newWindow.document.body.appendChild(container);

    // 5. Plotlyが読み込まれた後に横収差図を描画
    plotlyScript.onload = () => {
        setTimeout(() => {
            try {
                // 新しいウィンドウ用のPlotly関数を移植
                newWindow.plotTransverseAberration = (containerId, aberrationData, options = {}) => {
                    const convertedData = convertLegacyDataFormat(aberrationData);
                    
                    const defaultOptions = {
                        width: 1000,
                        height: 600,
                        title: '横収差図',
                        showLegend: true,
                        gridLines: true,
                        colors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
                    };
                    
                    const plotOptions = { ...defaultOptions, ...options };
                    const traces = [];
                    
                    // 全データから最大収差値を取得してY軸範囲を統一
                    let maxAberration = 0;
                    
                    // メリジオナルデータから最大値を取得
                    convertedData.meridionalData.forEach(data => {
                        if (data.points && data.points.length > 0) {
                            data.points.forEach(point => {
                                maxAberration = Math.max(maxAberration, Math.abs(point.transverseAberration));
                            });
                        }
                    });
                    
                    // サジタルデータから最大値を取得
                    convertedData.sagittalData.forEach(data => {
                        if (data.points && data.points.length > 0) {
                            data.points.forEach(point => {
                                maxAberration = Math.max(maxAberration, Math.abs(point.transverseAberration));
                            });
                        }
                    });
                    
                    // μm単位に変換（mm→μm: ×1000）、10%のマージンを追加
                    const maxAberrationMicrons = maxAberration * 1000 * 1.1;
                    const yAxisRange = [-maxAberrationMicrons, maxAberrationMicrons];
                    
                    // 有限系の場合、全フィールドのデータから最適化されたオフセットを計算
                    let globalCenterOffset = { meridional: 0, sagittal: 0 };
                    
                    if (convertedData.isFiniteSystem) {
                        // メリジオナル全データの最適化されたオフセットを計算
                        let allMeridionalCoords = [];
                        convertedData.meridionalData.forEach(data => {
                            if (data.points && data.points.length > 0) {
                                const coords = data.points.map(p => p.pupilCoordinate);
                                allMeridionalCoords.push(...coords);
                            }
                        });
                        if (allMeridionalCoords.length > 0) {
                            // 重複を除去してユニークな座標のみを使用
                            const uniqueCoords = [...new Set(allMeridionalCoords)].sort((a, b) => a - b);
                            const minCoord = uniqueCoords[0];
                            const maxCoord = uniqueCoords[uniqueCoords.length - 1];
                            globalCenterOffset.meridional = (minCoord + maxCoord) / 2;
                        }
                        
                        // サジタル全データの最適化されたオフセットを計算
                        let allSagittalCoords = [];
                        convertedData.sagittalData.forEach(data => {
                            if (data.points && data.points.length > 0) {
                                const coords = data.points.map(p => p.pupilCoordinate);
                                allSagittalCoords.push(...coords);
                            }
                        });
                        if (allSagittalCoords.length > 0) {
                            // 重複を除去してユニークな座標のみを使用
                            const uniqueCoords = [...new Set(allSagittalCoords)].sort((a, b) => a - b);
                            const minCoord = uniqueCoords[0];
                            const maxCoord = uniqueCoords[uniqueCoords.length - 1];
                            globalCenterOffset.sagittal = (minCoord + maxCoord) / 2;
                        }
                    }
                    
                    // メリジオナルデータの処理
                    convertedData.meridionalData.forEach((data, fieldIndex) => {
                        if (data.points && data.points.length > 0) {
                            let x, y;
                            
                            if (convertedData.isFiniteSystem) {
                                // 有限系の場合は元の瞳座標をそのまま使用（オフセットなし）
                                x = data.points.map(p => p.pupilCoordinate);
                                y = data.points.map(p => p.transverseAberration * 1000); // mm→μmに変換
                            } else {
                                // 無限系の場合は各フィールドごとの中点を計算してオフセットを適用
                                const pupilCoords = data.points.map(p => p.pupilCoordinate);
                                const minCoord = Math.min(...pupilCoords);
                                const maxCoord = Math.max(...pupilCoords);
                                const centerOffset = (minCoord + maxCoord) / 2;
                                
                                x = data.points.map(p => p.pupilCoordinate - centerOffset);
                                y = data.points.map(p => p.transverseAberration * 1000); // mm→μmに変換
                            }
                            
                            traces.push({
                                x: x,
                                y: y,
                                type: 'scatter',
                                mode: 'lines',
                                name: `${data.fieldSetting.displayName} (M)`,
                                line: {
                                    color: plotOptions.colors[fieldIndex % plotOptions.colors.length],
                                    width: 2
                                },
                                xaxis: 'x',
                                yaxis: 'y'
                            });
                        }
                    });
                    
                    // サジタルデータの処理
                    convertedData.sagittalData.forEach((data, fieldIndex) => {
                        if (data.points && data.points.length > 0) {
                            let x, y;
                            
                            if (convertedData.isFiniteSystem) {
                                // 有限系の場合は元の瞳座標をそのまま使用（オフセットなし）
                                x = data.points.map(p => p.pupilCoordinate);
                                y = data.points.map(p => p.transverseAberration * 1000); // mm→μmに変換
                            } else {
                                // 無限系の場合は各フィールドごとの中点を計算してオフセットを適用
                                const pupilCoords = data.points.map(p => p.pupilCoordinate);
                                const minCoord = Math.min(...pupilCoords);
                                const maxCoord = Math.max(...pupilCoords);
                                const centerOffset = (minCoord + maxCoord) / 2;
                                
                                x = data.points.map(p => p.pupilCoordinate - centerOffset);
                                y = data.points.map(p => p.transverseAberration * 1000); // mm→μmに変換
                            }
                            
                            traces.push({
                                x: x,
                                y: y,
                                type: 'scatter',
                                mode: 'lines',
                                name: `${data.fieldSetting.displayName} (S)`,
                                line: {
                                    color: plotOptions.colors[fieldIndex % plotOptions.colors.length],
                                    width: 2,
                                    dash: 'dash'
                                },
                                xaxis: 'x2',
                                yaxis: 'y2'
                            });
                        }
                    });
                    
                    const layout = {
                        title: {
                            text: plotOptions.title,
                            font: { size: 16 }
                        },
                        width: plotOptions.width,
                        height: plotOptions.height,
                        grid: {
                            rows: 1,
                            columns: 2,
                            pattern: 'independent',
                            xgap: 0.1
                        },
                        xaxis: {
                            title: 'Normalized Pupil Coordinate',
                            range: [-1.1, 1.1], // ±1まで（10%マージン）
                            showgrid: true,
                            zeroline: true,
                            domain: [0, 0.45]
                        },
                        yaxis: {
                            title: 'Transverse Aberration (μm)',
                            range: yAxisRange,
                            showgrid: true,
                            zeroline: true
                        },
                        xaxis2: {
                            title: 'Normalized Pupil Coordinate',
                            range: [-1.1, 1.1], // ±1まで（10%マージン）
                            showgrid: true,
                            zeroline: true,
                            domain: [0.55, 1]
                        },
                        yaxis2: {
                            title: 'Transverse Aberration (μm)',
                            range: yAxisRange,
                            showgrid: true,
                            zeroline: true
                        },
                        annotations: [
                            {
                                text: 'メリジオナル',
                                x: 0.225,
                                y: 1.02,
                                xref: 'paper',
                                yref: 'paper',
                                xanchor: 'center',
                                yanchor: 'bottom',
                                showarrow: false,
                                font: { size: 14, color: '#333' }
                            },
                            {
                                text: 'サジタル',
                                x: 0.775,
                                y: 1.02,
                                xref: 'paper',
                                yref: 'paper',
                                xanchor: 'center',
                                yanchor: 'bottom',
                                showarrow: false,
                                font: { size: 14, color: '#333' }
                            }
                        ]
                    };
                    
                    newWindow.Plotly.newPlot(containerId, traces, layout, {
                        responsive: true,
                        displayModeBar: true,
                        displaylogo: false
                    });
                };
                
                // プロット実行
                newWindow.plotTransverseAberration(containerId, aberrationData);
                console.log('✅ 新しいウィンドウでの描画が完了しました');
                
            } catch (error) {
                console.error('❌ 新しいウィンドウでの横収差図の描画中にエラーが発生しました:', error);
                newWindow.document.body.innerHTML = `<pre>Error during plot rendering: ${error.message}</pre>`;
            }
        }, 500);
    };
}

/**
 * 情報パネルを更新
 * @param {Object} aberrationData - 横収差データ
 * @param {string} containerId - コンテナID
 */
function updateAberrationInfoPanel(aberrationData, containerId) {
    // 情報パネルの要素を探す
    let infoPanel = document.getElementById(containerId + '-info');
    
    if (!infoPanel) {
        // 情報パネルが存在しない場合は作成
        const container = document.getElementById(containerId);
        if (container && container.parentNode) {
            infoPanel = document.createElement('div');
            infoPanel.id = containerId + '-info';
            infoPanel.style.cssText = `
                margin-top: 15px;
                padding: 15px;
                background-color: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 5px;
                font-family: Arial, sans-serif;
                font-size: 14px;
            `;
            container.parentNode.insertBefore(infoPanel, container.nextSibling);
        } else {
            return; // パネル作成に失敗
        }
    }
    
    // 統計情報を計算
    const stats = calculateAberrationStatistics(aberrationData);
    
    // HTML内容を作成
    const infoHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px;">
            <div>
                <h4 style="margin: 0 0 10px 0; color: #495057;">Calculation Settings</h4>
                <div style="font-size: 13px; line-height: 1.5;">
                    <div><strong>System Type:</strong> ${aberrationData.isFiniteSystem ? 'Finite' : 'Infinite'}</div>
                    <div><strong>Wavelength:</strong> ${aberrationData.wavelength} μm</div>
                    <div><strong>Evaluation Surface:</strong> ${aberrationData.targetSurface + 1}</div>
                    <div><strong>Stop Surface:</strong> ${aberrationData.stopSurface + 1}</div>
                    <div><strong>Object Count:</strong> ${aberrationData.fieldSettings.length}</div>
                </div>
            </div>
            
            <div>
                <h4 style="margin: 0 0 10px 0; color: #495057;">Meridional Statistics</h4>
                <div style="font-size: 13px; line-height: 1.5;">
                    <div><strong>Max Aberration:</strong> ${(stats.meridional.maxAberration * 1000).toFixed(3)} μm</div>
                    <div><strong>RMS Aberration:</strong> ${(stats.meridional.rmsAberration * 1000).toFixed(3)} μm</div>
                    <div><strong>Data Points:</strong> ${stats.meridional.totalPoints}</div>
                </div>
            </div>
            
            <div>
                <h4 style="margin: 0 0 10px 0; color: #495057;">Sagittal Statistics</h4>
                <div style="font-size: 13px; line-height: 1.5;">
                    <div><strong>Max Aberration:</strong> ${(stats.sagittal.maxAberration * 1000).toFixed(3)} μm</div>
                    <div><strong>RMS Aberration:</strong> ${(stats.sagittal.rmsAberration * 1000).toFixed(3)} μm</div>
                    <div><strong>Data Points:</strong> ${stats.sagittal.totalPoints}</div>
                </div>
            </div>
        </div>
        
        <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #dee2e6;">
            <h4 style="margin: 0 0 10px 0; color: #495057;">Field Details</h4>
            <div style="font-size: 12px; max-height: 120px; overflow-y: auto;">
                ${aberrationData.fieldSettings.map((field, index) => {
                    const mData = aberrationData.meridionalData[index];
                    const sData = aberrationData.sagittalData[index];
                    const mMax = mData && mData.points.length > 0 ? 
                        (Math.max(...mData.points.map(p => Math.abs(p.transverseAberration))) * 1000).toFixed(3) : 'N/A';
                    const sMax = sData && sData.points.length > 0 ? 
                        (Math.max(...sData.points.map(p => Math.abs(p.transverseAberration))) * 1000).toFixed(3) : 'N/A';
                    
                    return `
                        <div style="margin-bottom: 5px;">
                            <strong>${field.displayName}:</strong> 
                            M=${mMax}μm (${mData ? mData.points.length : 0} pts), 
                            S=${sMax}μm (${sData ? sData.points.length : 0} pts)
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    
    infoPanel.innerHTML = infoHTML;
}

/**
 * 横収差統計を計算
 * @param {Object} aberrationData - 横収差データ
 * @returns {Object} 統計情報
 */
function calculateAberrationStatistics(aberrationData) {
    const stats = {
        meridional: {
            maxAberration: 0,
            rmsAberration: 0,
            totalPoints: 0
        },
        sagittal: {
            maxAberration: 0,
            rmsAberration: 0,
            totalPoints: 0
        }
    };
    
    // メリジオナル統計
    let mValues = [];
    aberrationData.meridionalData.forEach(data => {
        if (data.points) {
            data.points.forEach(point => {
                if (!isNaN(point.transverseAberration)) {
                    mValues.push(point.transverseAberration);
                }
            });
        }
    });
    
    if (mValues.length > 0) {
        stats.meridional.maxAberration = Math.max(...mValues.map(Math.abs));
        stats.meridional.rmsAberration = Math.sqrt(mValues.reduce((sum, val) => sum + val * val, 0) / mValues.length);
        stats.meridional.totalPoints = mValues.length;
    }
    
    // サジタル統計
    let sValues = [];
    aberrationData.sagittalData.forEach(data => {
        if (data.points) {
            data.points.forEach(point => {
                if (!isNaN(point.transverseAberration)) {
                    sValues.push(point.transverseAberration);
                }
            });
        }
    });
    
    if (sValues.length > 0) {
        stats.sagittal.maxAberration = Math.max(...sValues.map(Math.abs));
        stats.sagittal.rmsAberration = Math.sqrt(sValues.reduce((sum, val) => sum + val * val, 0) / sValues.length);
        stats.sagittal.totalPoints = sValues.length;
    }
    
    return stats;
}

/**
 * 横収差図の表示オプションを作成
 * @param {Object} customOptions - カスタムオプション
 * @returns {Object} 表示オプション
 */
export function createTransverseAberrationPlotOptions(customOptions = {}) {
    const defaultOptions = {
        width: 1000,
        height: 600,
        title: '横収差図',
        showLegend: true,
        gridLines: true,
        colors: [
            '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
            '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
        ]
    };
    
    return { ...defaultOptions, ...customOptions };
}

/**
 * 横収差データをCSV形式でエクスポート
 * @param {Object} aberrationData - 横収差データ
 * @param {string} filename - ファイル名（デフォルト: 'transverse_aberration.csv'）
 */
export function exportTransverseAberrationToCSV(aberrationData, filename = 'transverse_aberration.csv') {
    try {
        let csvContent = 'Field,RayType,PupilCoordinate,TransverseAberration_microns,ActualX,ActualY,ChiefX,ChiefY\n';
        
        // メリジオナルデータ
        aberrationData.meridionalData.forEach(data => {
            data.points.forEach(point => {
                csvContent += `"${data.fieldSetting.displayName}",Meridional,${point.pupilCoordinate},${(point.transverseAberration * 1000).toFixed(3)},${point.actualCoordinate.x},${point.actualCoordinate.y},${point.chiefReference.x},${point.chiefReference.y}\n`;
            });
        });
        
        // サジタルデータ
        aberrationData.sagittalData.forEach(data => {
            data.points.forEach(point => {
                csvContent += `"${data.fieldSetting.displayName}",Sagittal,${point.pupilCoordinate},${(point.transverseAberration * 1000).toFixed(3)},${point.actualCoordinate.x},${point.actualCoordinate.y},${point.chiefReference.x},${point.chiefReference.y}\n`;
            });
        });
        
        // ダウンロード
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        console.log(`✅ 横収差データをCSVエクスポート: ${filename}`);
        
    } catch (error) {
        console.error('❌ CSVエクスポートエラー:', error);
    }
}
