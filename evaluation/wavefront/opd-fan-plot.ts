export interface OpdFanSeries {
    fieldIndex: number;
    fieldLabel: string;
    wavelengthUm: number;
    wavelengthLabel: string;
    chiefRayOpdWaves?: number;
    tangentialPoints: Array<{ pupilCoordinate: number; opdWaves: number | null }>;
    sagittalPoints: Array<{ pupilCoordinate: number; opdWaves: number | null }>;
}

export interface OpdFanData {
    backend: string;
    referenceMode?: string;
    opdDisplayMode?: string;
    series: OpdFanSeries[];
}

export function extractOpdFanSections(
    displayOpdGrid: Array<Array<number | null>>,
    entrancePupilCoordinateXGrid?: Array<Array<number | null>>,
    entrancePupilCoordinateYGrid?: Array<Array<number | null>>,
    usedObjectX = 0,
    usedObjectY = 0,
): Pick<OpdFanSeries, 'tangentialPoints' | 'sagittalPoints'> {
    const gridSize = displayOpdGrid.length;
    if (gridSize < 3 || gridSize % 2 === 0 || displayOpdGrid.some((row) => !Array.isArray(row) || row.length !== gridSize)) {
        throw new Error('OPD Fan requires a square odd-sized OPD grid.');
    }

    const center = Math.floor(gridSize / 2);
    const normalizedCoordinate = (index: number) => 1 - (2 * index) / (gridSize - 1);
    const hasPhysicalCoordinates = [entrancePupilCoordinateXGrid, entrancePupilCoordinateYGrid].every((grid) =>
        Array.isArray(grid)
        && grid.length === gridSize
        && grid.every((row) => Array.isArray(row) && row.length === gridSize),
    );
    const tangentialPoints: OpdFanSeries['tangentialPoints'] = [];
    const sagittalPoints: OpdFanSeries['sagittalPoints'] = [];
    let finiteTangentialCount = 0;
    let finiteSagittalCount = 0;

    if (hasPhysicalCoordinates) {
        const samples: Array<{ x: number; y: number; opd: number }> = [];
        for (let row = 0; row < gridSize; row++) {
            for (let column = 0; column < gridSize; column++) {
                const rawX = entrancePupilCoordinateXGrid?.[row]?.[column];
                const rawY = entrancePupilCoordinateYGrid?.[row]?.[column];
                const rawOpd = displayOpdGrid?.[row]?.[column];
                if (rawX === null || rawX === undefined || rawY === null || rawY === undefined || rawOpd === null || rawOpd === undefined) {
                    continue;
                }
                const x = -Number(rawX);
                const y = Number(rawY);
                const opd = Number(rawOpd);
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(opd)) {
                    samples.push({ x, y, opd });
                }
            }
        }
        if (samples.length > 0) {
            const fieldX = -Number(usedObjectX);
            const fieldY = Number(usedObjectY);
            const fieldMagnitude = Math.hypot(fieldX, fieldY);
            const tangentialUnit = fieldMagnitude > 1.0e-12
                ? { x: fieldX / fieldMagnitude, y: fieldY / fieldMagnitude }
                : { x: 0, y: 1 };
            const sagittalUnit = { x: -tangentialUnit.y, y: tangentialUnit.x };
            const nominalStep = 2 / Math.max(1, gridSize - 1);
            const bandHalfWidth = Math.max(nominalStep * 0.55, 0.01);
            const maxAxisGap = Math.max(nominalStep * 1.75, 0.04);
            const axisSamples = samples.map((sample) => {
                const tangentialCoordinate = sample.x * tangentialUnit.x + sample.y * tangentialUnit.y;
                const sagittalCoordinate = sample.x * sagittalUnit.x + sample.y * sagittalUnit.y;
                return {
                    tangentialCoordinate,
                    sagittalCoordinate,
                    tangentialOffAxis: sagittalCoordinate,
                    sagittalOffAxis: tangentialCoordinate,
                    opd: sample.opd,
                };
            });
            const buildSectionPoints = (
                axis: 'tangential' | 'sagittal',
            ): Array<{ pupilCoordinate: number; opdWaves: number | null }> => {
                const coordinateKeyScale = 1 / Math.max(nominalStep * 0.5, 1.0e-4);
                const buckets = new Map<number, { axisCoordinate: number; opd: number; offAxisDistance: number }>();
                for (const sample of axisSamples) {
                    const axisCoordinate = axis === 'tangential' ? sample.tangentialCoordinate : sample.sagittalCoordinate;
                    const offAxisDistance = Math.abs(axis === 'tangential' ? sample.tangentialOffAxis : sample.sagittalOffAxis);
                    if (!Number.isFinite(axisCoordinate) || offAxisDistance > bandHalfWidth) continue;
                    const bucketKey = Math.round(axisCoordinate * coordinateKeyScale);
                    const previous = buckets.get(bucketKey);
                    if (!previous || offAxisDistance < previous.offAxisDistance) {
                        buckets.set(bucketKey, { axisCoordinate, opd: sample.opd, offAxisDistance });
                    }
                }
                const sortedPoints = [...buckets.values()]
                    .map((bucket) => ({ pupilCoordinate: bucket.axisCoordinate, opdWaves: bucket.opd }))
                    .filter((point) => Number.isFinite(point.pupilCoordinate) && Number.isFinite(point.opdWaves))
                    .sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
                const separatedPoints: Array<{ pupilCoordinate: number; opdWaves: number | null }> = [];
                for (const point of sortedPoints) {
                    const previous = separatedPoints.length > 0 ? separatedPoints[separatedPoints.length - 1] : null;
                    if (
                        previous
                        && previous.opdWaves !== null
                        && Math.abs(point.pupilCoordinate - previous.pupilCoordinate) > maxAxisGap
                    ) {
                        separatedPoints.push({
                            pupilCoordinate: (previous.pupilCoordinate + point.pupilCoordinate) / 2,
                            opdWaves: null,
                        });
                    }
                    separatedPoints.push(point);
                }
                return separatedPoints;
            };
            tangentialPoints.push(...buildSectionPoints('tangential'));
            sagittalPoints.push(...buildSectionPoints('sagittal'));
            finiteTangentialCount = tangentialPoints.filter((point) => point.opdWaves !== null).length;
            finiteSagittalCount = sagittalPoints.filter((point) => point.opdWaves !== null).length;
            if (finiteTangentialCount > 0 && finiteSagittalCount > 0) {
                return { tangentialPoints, sagittalPoints };
            }
            tangentialPoints.length = 0;
            sagittalPoints.length = 0;
            finiteTangentialCount = 0;
            finiteSagittalCount = 0;
        }
    }

    for (let index = 0; index < gridSize; index++) {
        const physicalTangentialCoordinate = Number(entrancePupilCoordinateYGrid?.[index]?.[center]);
        const physicalSagittalCoordinate = -Number(entrancePupilCoordinateXGrid?.[center]?.[index]);
        const tangentialPupilCoordinate = hasPhysicalCoordinates && Number.isFinite(physicalTangentialCoordinate)
            ? physicalTangentialCoordinate
            : -normalizedCoordinate(index);
        const sagittalPupilCoordinate = hasPhysicalCoordinates && Number.isFinite(physicalSagittalCoordinate)
            ? physicalSagittalCoordinate
            : normalizedCoordinate(index);
        const tangentialValue = displayOpdGrid[index]?.[center];
        const sagittalValue = displayOpdGrid[center]?.[index];
        const tangentialOpd = Number(tangentialValue);
        const sagittalOpd = Number(sagittalValue);
        const finiteTangentialOpd = tangentialValue !== null && tangentialValue !== undefined && Number.isFinite(tangentialOpd) ? tangentialOpd : null;
        const finiteSagittalOpd = sagittalValue !== null && sagittalValue !== undefined && Number.isFinite(sagittalOpd) ? sagittalOpd : null;
        if (finiteTangentialOpd !== null) finiteTangentialCount += 1;
        if (finiteSagittalOpd !== null) finiteSagittalCount += 1;
        tangentialPoints.push({ pupilCoordinate: tangentialPupilCoordinate, opdWaves: finiteTangentialOpd });
        sagittalPoints.push({ pupilCoordinate: sagittalPupilCoordinate, opdWaves: finiteSagittalOpd });
    }

    if (finiteTangentialCount === 0 || finiteSagittalCount === 0) {
        throw new Error('The OPD grid contains no finite central pupil sections.');
    }
    return { tangentialPoints, sagittalPoints };
}

export function plotOpdFan(containerTarget: string | HTMLElement, data: OpdFanData, options: any = {}): void {
    const container = typeof containerTarget === 'string' ? document.getElementById(containerTarget) : containerTarget;
    if (!container) throw new Error('OPD Fan plot container was not found.');
    if (!Array.isArray(data?.series) || data.series.length === 0) throw new Error('No OPD Fan series were available to plot.');

    const targetDocument = container.ownerDocument || document;
    const plotly = (targetDocument.defaultView as any)?.Plotly || (globalThis as any).Plotly;
    if (!plotly) throw new Error('Plotly library is not loaded.');

    const scaleWaves = Math.abs(Number(options.aberrationScaleWaves));
    if (!Number.isFinite(scaleWaves) || scaleWaves <= 0) throw new Error('Aberration scale must be greater than zero.');
    const compactLayout = container.clientWidth > 0 && container.clientWidth < 760;

    const fieldIndices = [...new Set(data.series.map((series) => series.fieldIndex))].sort((a, b) => b - a);
    const availableHeight = Math.max(0, container.parentElement?.clientHeight || container.clientHeight || 0);
    const rowHeightPx = compactLayout ? 210 : 230;
    const rowGapPx = 14;
    const plotChromeHeightPx = compactLayout ? 245 : 200;
    const plotHeight = Math.max(
        availableHeight,
        plotChromeHeightPx + fieldIndices.length * rowHeightPx + Math.max(0, fieldIndices.length - 1) * rowGapPx,
    );
    container.style.height = `${plotHeight}px`;
    container.style.minHeight = `${plotHeight}px`;
    const wavelengths = [...new Set(data.series.map((series) => series.wavelengthUm))].sort((a, b) => a - b);
    const styles = ['#0057b8', '#16803a', '#d12626', '#7b3fb2', '#007b83'];
    const styleByWavelength = new Map(wavelengths.map((wavelength, index) => [wavelength, styles[index % styles.length]]));
    const pupilAxisLimit = 1;
    const pupilTickValues = [-1, -0.5, 0, 0.5, 1];
    const axisName = (base: string, index: number) => index === 1 ? base : `${base}${index}`;
    const axisRef = (base: string, index: number) => index === 1 ? base : `${base}${index}`;
    const leftDomain = [0.08, 0.47];
    const rightDomain = [0.53, 0.92];
    const plotAreaHeightPx = Math.max(1, plotHeight - plotChromeHeightPx);
    const rowGap = fieldIndices.length > 1 ? rowGapPx / plotAreaHeightPx : 0;
    const rowSpan = (1 - rowGap * Math.max(0, fieldIndices.length - 1)) / fieldIndices.length;
    const traces: any[] = [];
    const annotations: any[] = [
        { text: 'tangential', x: (leftDomain[0] + leftDomain[1]) / 2, y: 1.01, xref: 'paper', yref: 'paper', xanchor: 'center', yanchor: 'bottom', showarrow: false, font: { size: 14, color: '#333' } },
        { text: 'sagittal', x: (rightDomain[0] + rightDomain[1]) / 2, y: 1.01, xref: 'paper', yref: 'paper', xanchor: 'center', yanchor: 'bottom', showarrow: false, font: { size: 14, color: '#333' } },
        { text: 'Normalized Entrance Pupil', x: 0.5, y: -0.14, xref: 'paper', yref: 'paper', showarrow: false, font: { size: 13, color: '#333' } },
    ];
    const legendShown = new Set<string>();
    const layout: any = {
        title: {
            text: 'OPTICAL PATH DIFFERENCE FAN',
            font: { size: compactLayout ? 14 : 18 },
            x: leftDomain[0],
            xanchor: 'left',
            y: 0.985,
            yanchor: 'top',
        },
        autosize: true,
        height: plotHeight,
        showlegend: true,
        legend: compactLayout
            ? { x: 0.5, y: -0.22, xanchor: 'center', yanchor: 'top', orientation: 'h', bgcolor: 'rgba(255,255,255,0.9)', bordercolor: 'rgba(0,0,0,0.2)', borderwidth: 1 }
            : { x: 0.94, y: 1, xanchor: 'left', yanchor: 'top', bgcolor: 'rgba(255,255,255,0.85)', bordercolor: 'rgba(0,0,0,0.2)', borderwidth: 1 },
        margin: compactLayout ? { l: 60, r: 25, t: 90, b: 155 } : { l: 90, r: 220, t: 90, b: 110 },
        annotations,
    };

    fieldIndices.forEach((fieldIndex, rowIndex) => {
        const rowTop = 1 - rowIndex * (rowSpan + rowGap);
        const rowBottom = rowTop - rowSpan;
        const leftAxisIndex = rowIndex * 2 + 1;
        const rightAxisIndex = rowIndex * 2 + 2;
        const fieldSeries = data.series.filter((series) => series.fieldIndex === fieldIndex);
        const fieldLabel = fieldSeries[0]?.fieldLabel || `Object ${fieldIndex + 1}`;

        for (const [axisIndex, domain] of [[leftAxisIndex, leftDomain], [rightAxisIndex, rightDomain]] as Array<[number, number[]]>) {
            layout[axisName('xaxis', axisIndex)] = { domain, range: [-pupilAxisLimit, pupilAxisLimit], constrain: 'domain', showgrid: true, zeroline: true, tickmode: 'array', tickvals: pupilTickValues, tickformat: '.2f' };
            layout[axisName('yaxis', axisIndex)] = { domain: [rowBottom, rowTop], range: [-scaleWaves, scaleWaves], showgrid: true, zeroline: true, tickformat: '.3f', title: axisIndex === leftAxisIndex && rowIndex === Math.floor(fieldIndices.length / 2) ? 'OPD (waves)' : undefined };
        }

        annotations.push({
            text: fieldLabel,
            x: 0.5,
            y: compactLayout ? rowTop - rowSpan * 0.04 : rowBottom + rowSpan / 2,
            xref: 'paper',
            yref: 'paper',
            showarrow: false,
            font: { size: compactLayout ? 10 : 12, color: '#333' },
            bgcolor: 'rgba(255,255,255,0.82)',
            align: 'center',
        });

        const addTrace = (series: OpdFanSeries, points: OpdFanSeries['tangentialPoints'], axisIndex: number, sectionLabel: string) => {
            const legendKey = series.wavelengthLabel;
            traces.push({
                x: points.map((point) => point.pupilCoordinate),
                y: points.map((point) => point.opdWaves),
                type: 'scatter',
                mode: 'lines',
                connectgaps: false,
                name: series.wavelengthLabel,
                legendgroup: legendKey,
                showlegend: !legendShown.has(legendKey),
                line: { color: styleByWavelength.get(series.wavelengthUm), width: 2 },
                xaxis: axisRef('x', axisIndex),
                yaxis: axisRef('y', axisIndex),
                hovertemplate: `<b>${sectionLabel}</b><br>Entrance pupil: %{x:.3f}<br>OPD: %{y:.5f} waves<extra>${series.wavelengthLabel}</extra>`,
            });
            legendShown.add(legendKey);
        };

        fieldSeries.forEach((series) => {
            addTrace(series, series.tangentialPoints, leftAxisIndex, 'Tangential');
            addTrace(series, series.sagittalPoints, rightAxisIndex, 'Sagittal');
        });
    });

    plotly.newPlot(container, traces, layout, { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['pan2d', 'lasso2d'], displaylogo: false });
}