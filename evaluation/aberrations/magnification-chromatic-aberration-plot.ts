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
        return;
    }

    const fieldValues = data.fieldValues.slice();
    const maxField = Math.max(...fieldValues.map(v => Math.abs(v)));
    const heightMode = !!data.heightMode;
    const referenceWavelength = Number.isFinite(Number(data.referenceWavelength))
        ? Number(data.referenceWavelength)
        : 0.5876;

    const xMin = Number.isFinite(Number(options.xMin)) ? Number(options.xMin) : -0.05;
    const xMax = Number.isFinite(Number(options.xMax)) ? Number(options.xMax) : 0.05;

    const traces = [];

    const referenceTrace = {
        x: fieldValues.map(() => 0),
        y: fieldValues,
        name: `d-line ${(referenceWavelength * 1000).toFixed(1)}nm`,
        mode: 'lines',
        line: { color: '#666', width: 1, dash: 'dash' }
    };
    traces.push(referenceTrace);

    const dataByWavelength = Array.isArray(data.dataByWavelength) ? data.dataByWavelength : [];
    dataByWavelength.forEach((entry) => {
        const wavelength = Number(entry?.wavelength);
        if (!Number.isFinite(wavelength)) return;
        if (Math.abs(wavelength - referenceWavelength) < 1e-6) return;
        const displacements = Array.isArray(entry?.displacements) ? entry.displacements : [];
        if (displacements.length === 0) return;
        const wavelengthNm = (wavelength * 1000).toFixed(1);
        const color = getWavelengthColor(wavelength);

        traces.push({
            x: displacements,
            y: fieldValues,
            name: `λ=${wavelengthNm}nm`,
            mode: 'lines',
            line: { color, width: 2 }
        });
    });

    const layout: any = {
        title: 'Lateral Chromatic Aberration (d-line reference)',
        xaxis: {
            title: 'Lateral Displacement (mm)',
            range: [xMin, xMax]
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
        return;
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
}
