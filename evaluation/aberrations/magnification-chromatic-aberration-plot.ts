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

export function plotMagnificationChromaticAberration(data, targetDivId = 'magnification-chromatic-aberration-container', options: any = {}) {
    if (!data || !Array.isArray(data.fieldValues) || data.fieldValues.length === 0) {
        console.warn('No valid data for magnification chromatic aberration plot');
        return false;
    }

    const fieldValues = data.fieldValues.slice();
    const maxField = Math.max(...fieldValues.map(v => Math.abs(v)));
    const heightMode = !!data.heightMode;
    const referenceWavelength = Number.isFinite(Number(data.referenceWavelength))
        ? Number(data.referenceWavelength)
        : 0.5876;

    const xMin = Number.isFinite(Number(options.xMin)) ? Number(options.xMin) : -0.05;
    const xMax = Number.isFinite(Number(options.xMax)) ? Number(options.xMax) : 0.05;

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

    const referencePairs = finitePairs(fieldValues.map(() => 0), fieldValues);
    const referenceTrace = {
        x: referencePairs.x,
        y: referencePairs.y,
        name: `d-line ${(referenceWavelength * 1000).toFixed(1)}nm`,
        mode: 'lines',
        line: { color: '#666', width: 1, dash: 'dash' }
    };
    if (referencePairs.x.length >= 2) traces.push(referenceTrace);

    const dataByWavelength = Array.isArray(data.dataByWavelength) ? data.dataByWavelength : [];
    let globalMaxAbsDisp = 0;
    dataByWavelength.forEach((entry) => {
        const wavelength = Number(entry?.wavelength);
        if (!Number.isFinite(wavelength)) return;
        if (Math.abs(wavelength - referenceWavelength) < 1e-6) return;
        const displacements = Array.isArray(entry?.displacements) ? entry.displacements : [];
        if (displacements.length === 0) return;
        const pairs = finitePairs(displacements, fieldValues);
        if (pairs.x.length < 2) return;
        for (const x of pairs.x) {
            const a = Math.abs(Number(x));
            if (Number.isFinite(a) && a > globalMaxAbsDisp) globalMaxAbsDisp = a;
        }
        const wavelengthNm = (wavelength * 1000).toFixed(1);
        const color = getWavelengthColor(wavelength);
        const maxAbsUm = pairs.x.reduce((m, v) => {
            const a = Math.abs(Number(v));
            return Number.isFinite(a) && a > m ? a : m;
        }, 0) * 1000;

        traces.push({
            x: pairs.x,
            y: pairs.y,
            name: `λ=${wavelengthNm}nm (max ${maxAbsUm.toFixed(3)}µm)`,
            mode: 'lines',
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
        title: 'Lateral Chromatic Aberration (d-line reference)',
        xaxis: {
            title: 'Lateral Displacement (mm)',
            range: [xMinPlot, xMaxPlot]
        },
        yaxis: {
            title: heightMode ? 'Object Height (mm)' : 'Object Angle (deg)',
            range: [0, maxField]
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
                y1: maxField,
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
