declare const Plotly: any;

function resolvePlotTarget(target) {
    if (typeof target === 'string') {
        const el = document.getElementById(target);
        const plotly = el?.ownerDocument?.defaultView?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
        return { element: el, plotly, isElement: false, id: target };
    }
    if (target && typeof target === 'object') {
        const el = target;
        const plotly = el?.ownerDocument?.defaultView?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
        return { element: el, plotly, isElement: true, id: null };
    }
    return { element: null, plotly: null, isElement: false, id: null };
}

function getWavelengthColor(wavelength) {
    if (wavelength < 0.45) return '#8B00FF';
    if (wavelength < 0.495) return '#0000FF';
    if (wavelength < 0.57) return '#00AA00';
    if (wavelength < 0.59) return '#9ACD32';
    if (wavelength < 0.62) return '#FF8800';
    return '#FF0000';
}

function sanitizeLcaSeries(displacements: any[], fieldValues: any[]) {
    const n = Math.min(Array.isArray(displacements) ? displacements.length : 0, Array.isArray(fieldValues) ? fieldValues.length : 0);
    const outX: Array<number | null> = [];
    const outY: Array<number | null> = [];
    for (let i = 0; i < n; i++) {
        const y = Number(fieldValues[i]);
        if (!Number.isFinite(y)) continue;
        const xRaw = displacements[i];
        const x = (typeof xRaw === 'number' && Number.isFinite(xRaw)) ? xRaw : null;
        outX.push(x);
        outY.push(y);
    }
    if (outX.length < 2) return { x: [] as Array<number | null>, y: [] as Array<number | null> };
    return { x: outX, y: outY };
}

function smoothByAdjacentWindow(x: Array<number | null>, adjacentCount: number): Array<number | null> {
    const n = Array.isArray(x) ? x.length : 0;
    if (n < 3) return Array.isArray(x) ? x.slice() : [];
    const k = Math.max(0, Math.floor(Number(adjacentCount) || 0));
    if (k <= 0) return x.slice();

    const out = x.slice();
    for (let i = 1; i < n - 1; i++) {
        const center = x[i];
        let sum = (typeof center === 'number' && Number.isFinite(center)) ? center : 0;
        let count = (typeof center === 'number' && Number.isFinite(center)) ? 1 : 0;
        let leftCount = 0;
        let rightCount = 0;

        for (let d = 1; d <= k; d++) {
            const li = i - d;
            if (li >= 0) {
                const v = x[li];
                if (typeof v === 'number' && Number.isFinite(v)) {
                    sum += v;
                    count += 1;
                    leftCount += 1;
                }
            }

            const ri = i + d;
            if (ri < n) {
                const v = x[ri];
                if (typeof v === 'number' && Number.isFinite(v)) {
                    sum += v;
                    count += 1;
                    rightCount += 1;
                }
            }
        }

        if (leftCount > 0 && rightCount > 0 && count > 1) {
            out[i] = sum / count;
        }
    }

    return out;
}

function formatLcaBackendLabel(data: any): string {
    const backend = String(data?.backend || data?.meta?.backend || '').trim();
    const executionMode = String(data?.meta?.executionMode || '').trim();
    if (backend && executionMode) return `${backend} / ${executionMode}`;
    if (backend) return backend;
    if (executionMode) return executionMode;
    return 'unknown-backend';
}

export function plotMagnificationChromaticAberration(data, targetDivId = 'magnification-chromatic-aberration-container', options: any = {}) {
    if (!data || !Array.isArray(data.fieldValues) || data.fieldValues.length === 0) {
        console.warn('No valid data for magnification chromatic aberration plot');
        return false;
    }

    const fieldValues = data.fieldValues.slice();
    const maxField = Math.max(...fieldValues.map(v => Math.abs(v)));
    const heightMode = !!data.heightMode;
    const imageHeightMode = !!data.imageHeightMode;
    const referenceWavelength = Number.isFinite(Number(data.referenceWavelength))
        ? Number(data.referenceWavelength)
        : 0.5876;
    const backendLabel = formatLcaBackendLabel(data);

    const legacyXMin = Number.isFinite(Number(options.xMin)) ? Number(options.xMin) : NaN;
    const legacyXMax = Number.isFinite(Number(options.xMax)) ? Number(options.xMax) : NaN;
    let xRange = Number.isFinite(Number(options.xRange))
        ? Math.abs(Number(options.xRange))
        : (Number.isFinite(legacyXMin) && Number.isFinite(legacyXMax)
            ? Math.max(Math.abs(legacyXMin), Math.abs(legacyXMax))
            : 0.04);
    if (!Number.isFinite(xRange) || xRange <= 0) xRange = 0.04;
    const xMin = -xRange;
    const xMax = xRange;
    const smoothingAdjacentPoints = Math.max(0, Math.floor(Number(options.smoothingAdjacentPoints) || 0));

    const traces: any[] = [];

    const finitePairs = (xArr: any[], yArr: any[]) => {
        const x: number[] = [];
        const y: number[] = [];
        const len = Math.min(Array.isArray(xArr) ? xArr.length : 0, Array.isArray(yArr) ? yArr.length : 0);
        for (let i = 0; i < len; i++) {
            const xv = (typeof xArr[i] === 'number') ? xArr[i] : Number.NaN;
            const yv = (typeof yArr[i] === 'number') ? yArr[i] : Number.NaN;
            if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
            x.push(xv);
            y.push(yv);
        }
        return { x, y };
    };

    const dataByWavelength = Array.isArray(data.dataByWavelength) ? data.dataByWavelength : [];

    const yAxisValues: number[] = fieldValues
        .map((value) => {
            const v = Number(value);
            return Number.isFinite(v) ? v : NaN;
        });
    const maxY = Math.max(...yAxisValues.filter(v => Number.isFinite(v)).map(v => Math.abs(v)));
    const effectiveMaxY = Number.isFinite(maxY) && maxY > 0 ? maxY : maxField;

    const referencePairs = finitePairs(yAxisValues.map(() => 0), yAxisValues);
    const referenceColor = getWavelengthColor(referenceWavelength);
    const referenceTrace = {
        x: referencePairs.x,
        y: referencePairs.y,
        name: `Primary ${(referenceWavelength * 1000).toFixed(1)}nm`,
        mode: 'lines',
        line: { color: referenceColor, width: 2 }
    };
    if (referencePairs.x.length >= 2) traces.push(referenceTrace);

    let globalMaxAbsDisp = 0;
    dataByWavelength.forEach((entry) => {
        const wavelength = Number(entry?.wavelength);
        if (!Number.isFinite(wavelength)) return;
        if (Math.abs(wavelength - referenceWavelength) < 1e-6) return;
        const displacements = Array.isArray(entry?.displacements) ? entry.displacements : [];
        if (displacements.length === 0) return;
        const pairs = sanitizeLcaSeries(displacements, yAxisValues);
        if (pairs.x.length < 2) return;
        const smoothedX = smoothByAdjacentWindow(pairs.x, smoothingAdjacentPoints);
        for (const x of smoothedX) {
            const a = Math.abs(Number(x));
            if (Number.isFinite(a) && a > globalMaxAbsDisp) globalMaxAbsDisp = a;
        }
        const wavelengthNm = (wavelength * 1000).toFixed(1);
        const color = getWavelengthColor(wavelength);
        const maxAbsUm = smoothedX.reduce((m, v) => {
            const a = Math.abs(Number(v));
            return Number.isFinite(a) && a > m ? a : m;
        }, 0) * 1000;

        traces.push({
            x: smoothedX,
            y: pairs.y,
            name: `λ=${wavelengthNm}nm (max ${maxAbsUm.toFixed(3)}µm)`,
            mode: 'lines',
            connectgaps: false,
            line: { color, width: 2 }
        });
    });

    // If values are tiny relative to default range, zoom in automatically so curves become visible.
    let xMinPlot = xMin;
    let xMaxPlot = xMax;
    const currentHalf = Math.max(Math.abs(xMin), Math.abs(xMax));
    if (globalMaxAbsDisp > 0 && currentHalf > 0 && globalMaxAbsDisp < (currentHalf / 200)) {
        const half = Math.max(globalMaxAbsDisp * 1.3, 1e-6);
        xMinPlot = -half;
        xMaxPlot = half;
    }

    const layout: any = {
        title: `Lateral Chromatic Aberration (primary reference) [${backendLabel}]`,
        xaxis: {
            title: 'Lateral Displacement (mm)',
            range: [xMinPlot, xMaxPlot]
        },
        yaxis: {
            title: imageHeightMode ? 'Image Height (mm)' : (heightMode ? 'Object Height (mm)' : 'Object Angle (deg)'),
            range: [0, effectiveMaxY]
        },
        width: 800,
        height: 600,
        showlegend: true,
        legend: { orientation: 'v', x: 1.02, y: 1 },
        shapes: [
            {
                type: 'line',
                x0: 0,
                x1: 0,
                y0: 0,
                y1: effectiveMaxY,
                line: { color: '#888', width: 1, dash: 'dot' }
            }
        ]
    };

    const { element, plotly, isElement, id } = resolvePlotTarget(targetDivId);
    if (!plotly) {
        console.warn('Plotly not available; cannot plot magnification chromatic aberration');
        return false;
    }

    if (traces.length === 0) {
        const target = element || (typeof id === 'string' ? document.getElementById(id) : null);
        if (target) {
            target.innerHTML = '<div style="padding:20px;color:#444;font-family:Arial;">No finite lateral chromatic aberration points to plot.</div>';
        }
        console.warn('No finite LCA points after filtering');
        return false;
    }

    const config = { responsive: true, displayModeBar: true, displaylogo: false };
    if (isElement && element) {
        layout.autosize = true;
        delete layout.width;
        delete layout.height;
        plotly.newPlot(element, traces, layout, config);
    } else if (id) {
        plotly.newPlot(id, traces, layout, config);
    }

    return true;
}
