export const OPTICAL_SHOWCASE_TARGET_SPEC = Object.freeze({
  widthMm: 240,
  heightMm: 240,
  sceneName: 'USAF 1951 Radial Grid 01',
  sceneVersion: 6,
  centralGroups: [-2, -1] as const,
  fieldGroups: [0, 1] as const,
  radialRadiusMm: 60,
  radialTargetCount: 8,
  gridPitchMm: 46,
  gridTargetCount: 16,
  pairInnerWidthUnits: 30,
  pairInnerHeightUnits: 30,
  cornerRadialChartCount: 4,
  cornerRadialChartRadiusMm: 6,
  cornerRadialChartCycles: 36,
  colorBarPatchCount: 8,
  grayscaleBarPatchCount: 11,
  groupNumberToPairReferenceBarRatio: 3.75,
  primaryElementNumberToPairReferenceBarRatio: 2.7,
  secondaryElementNumberToPairReferenceBarRatio: 1.65,
});

type UsafElementGeometry = {
  frequencyLpMm: number;
  barWidthMm: number;
  barLengthMm: number;
};

const svgNumber = (value: number) => Number(value.toFixed(9)).toString();

function getUsafElementGeometry(group: number, element: number): UsafElementGeometry {
  if (!Number.isInteger(group) || group < -2 || group > 7) {
    throw new Error('USAF 1951 group must be an integer from -2 through 7.');
  }
  if (!Number.isInteger(element) || element < 1 || element > 6) {
    throw new Error('USAF 1951 element must be an integer from 1 through 6.');
  }
  const frequencyLpMm = Math.pow(2, group + (element - 1) / 6);
  const barWidthMm = 1 / (2 * frequencyLpMm);
  return {
    frequencyLpMm,
    barWidthMm,
    barLengthMm: 5 * barWidthMm,
  };
}

function createTriBars(
  centerX: number,
  centerY: number,
  barWidthMm: number,
  orientation: 'horizontal' | 'vertical',
): string {
  const barLengthMm = 5 * barWidthMm;
  return [-1, 0, 1].map((offset) => {
    if (orientation === 'vertical') {
      return '<rect data-usaf-bar="true" x="' + svgNumber(centerX + offset * 2 * barWidthMm - barWidthMm / 2)
        + '" y="' + svgNumber(centerY - barLengthMm / 2) + '" width="' + svgNumber(barWidthMm)
        + '" height="' + svgNumber(barLengthMm) + '"/>';
    }
    return '<rect data-usaf-bar="true" x="' + svgNumber(centerX - barLengthMm / 2)
      + '" y="' + svgNumber(centerY + offset * 2 * barWidthMm - barWidthMm / 2)
      + '" width="' + svgNumber(barLengthMm) + '" height="' + svgNumber(barWidthMm) + '"/>';
  }).join('');
}

function createUsafElement(
  group: number,
  element: number,
  instanceId: string,
  firstCenterX: number,
  secondCenterX: number,
  centerY: number,
  firstOrientation: 'horizontal' | 'vertical',
  numberX: number,
  numberFontSizeMm: number,
  numberAnchor: 'start' | 'middle' | 'end',
): string {
  const geometry = getUsafElementGeometry(group, element);
  const secondOrientation = firstOrientation === 'horizontal' ? 'vertical' : 'horizontal';
  return '<g data-target="usaf-1951-element" data-instance="' + instanceId + '" data-usaf-group="' + group
    + '" data-usaf-element="' + element + '" data-frequency-lp-mm="' + svgNumber(geometry.frequencyLpMm)
    + '" data-bar-width-mm="' + svgNumber(geometry.barWidthMm) + '" data-space-width-mm="'
    + svgNumber(geometry.barWidthMm) + '" data-bar-length-mm="' + svgNumber(geometry.barLengthMm)
    + '" data-first-center-x-mm="' + svgNumber(firstCenterX) + '" data-second-center-x-mm="'
    + svgNumber(secondCenterX) + '" data-center-y-mm="' + svgNumber(centerY)
    + '" data-first-orientation="' + firstOrientation + '" data-second-orientation="' + secondOrientation + '">'
    + '<g fill="#090b0c">'
    + createTriBars(firstCenterX, centerY, geometry.barWidthMm, firstOrientation)
    + createTriBars(secondCenterX, centerY, geometry.barWidthMm, secondOrientation)
    + '</g>'
    + '<text data-number-role="element" data-number-size-mm="' + svgNumber(numberFontSizeMm)
    + '" x="' + svgNumber(numberX) + '" y="' + svgNumber(centerY + numberFontSizeMm * 0.34)
    + '" font-size="' + svgNumber(numberFontSizeMm) + '" text-anchor="' + numberAnchor + '">' + element + '</text>'
    + '</g>';
}

function createUsafPairPlate(
  centerX: number,
  centerY: number,
  firstGroup: number,
  secondGroup: number,
  rotationDeg: number,
  placement: 'center' | 'radial' | 'grid',
  index: number,
): string {
  const spec = OPTICAL_SHOWCASE_TARGET_SPEC;
  const firstInstance = placement + '-' + index + '-a';
  const secondInstance = placement + '-' + index + '-b';
  const firstReference = getUsafElementGeometry(firstGroup, 1).barWidthMm;
  const secondReference = getUsafElementGeometry(secondGroup, 1).barWidthMm;
  const unit = Math.max(firstReference, secondReference);
  const groupNumberSizeMm = spec.groupNumberToPairReferenceBarRatio * unit;
  const primaryNumberSizeMm = spec.primaryElementNumberToPairReferenceBarRatio * unit;
  const secondaryNumberSizeMm = spec.secondaryElementNumberToPairReferenceBarRatio * unit;
  const innerWidthMm = spec.pairInnerWidthUnits * unit;
  const innerHeightMm = spec.pairInnerHeightUnits * unit;
  const paddingMm = 1.15 * unit;
  const plateWidthMm = innerWidthMm + 2 * paddingMm;
  const plateHeightMm = innerHeightMm + 2 * paddingMm;
  const originX = -innerWidthMm / 2;
  const originY = -innerHeightMm / 2;
  const contentLeftX = 3 * unit;
  const contentRightX = 27 * unit;

  const primaryElements: string[] = [];
  let primaryCursorY = 4.7 * unit;
  let primaryElementSixBottomY = primaryCursorY;
  for (let element = 2; element <= 6; element += 1) {
    const geometry = getUsafElementGeometry(firstGroup, element);
    const centerElementY = primaryCursorY + geometry.barLengthMm / 2;
    // The outer ends of the horizontal tri-bars follow the left edge of the
    // classic imaginary square instead of being centre-aligned into a taper.
    const horizontalCenterX = contentLeftX + geometry.barLengthMm / 2;
    const verticalCenterX = horizontalCenterX + 7 * geometry.barWidthMm;
    primaryElements.push(createUsafElement(
      firstGroup,
      element,
      firstInstance,
      horizontalCenterX,
      verticalCenterX,
      centerElementY,
      'horizontal',
      1.3 * unit,
      primaryNumberSizeMm,
      'middle',
    ));
    if (element === 6) primaryElementSixBottomY = centerElementY + geometry.barLengthMm / 2;
    primaryCursorY += geometry.barLengthMm + 0.62 * unit;
  }
  const primaryElementOne = getUsafElementGeometry(firstGroup, 1);
  const primaryElementOneCenterY = primaryElementSixBottomY - primaryElementOne.barLengthMm / 2;
  const primaryElementOneHorizontalCenterX = contentRightX - primaryElementOne.barLengthMm / 2;
  const primaryElementOneVerticalCenterX = primaryElementOneHorizontalCenterX - 7 * primaryElementOne.barWidthMm;
  primaryElements.push(createUsafElement(
    firstGroup,
    1,
    firstInstance,
    primaryElementOneVerticalCenterX,
    primaryElementOneHorizontalCenterX,
    primaryElementOneCenterY,
    'vertical',
    28.65 * unit,
    primaryNumberSizeMm,
    'middle',
  ));

  const secondaryElements: string[] = [];
  let secondaryCursorY = 4.7 * unit;
  for (let element = 1; element <= 6; element += 1) {
    const geometry = getUsafElementGeometry(secondGroup, element);
    const centerElementY = secondaryCursorY + geometry.barLengthMm / 2;
    // The right ends of every horizontal tri-bar share the opposite edge of
    // the same imaginary square.
    const horizontalCenterX = contentRightX - geometry.barLengthMm / 2;
    const verticalCenterX = horizontalCenterX - 7 * geometry.barWidthMm;
    secondaryElements.push(createUsafElement(
      secondGroup,
      element,
      secondInstance,
      verticalCenterX,
      horizontalCenterX,
      centerElementY,
      'vertical',
      28.65 * unit,
      secondaryNumberSizeMm,
      'middle',
    ));
    secondaryCursorY += geometry.barLengthMm + 0.38 * unit;
  }

  const primaryTopGeometry = getUsafElementGeometry(firstGroup, 2);
  const secondaryTopGeometry = getUsafElementGeometry(secondGroup, 1);
  const referenceSquareSideMm = primaryTopGeometry.barLengthMm;
  const primaryTopRightX = contentLeftX + 12 * primaryTopGeometry.barWidthMm;
  const secondaryTopLeftX = contentRightX - 12 * secondaryTopGeometry.barWidthMm;
  const referenceSquareCenterX = (primaryTopRightX + secondaryTopLeftX) / 2;
  const referenceSquareCenterY = 4.7 * unit + referenceSquareSideMm / 2;

  return '<g data-diagnostic="usaf-pair" data-layout="classic-spiral-pair" data-placement="' + placement
    + '" data-placement-index="' + index + '" data-first-group="' + firstGroup + '" data-second-group="'
    + secondGroup + '" data-rotation-deg="' + svgNumber(rotationDeg) + '" data-inner-width-mm="'
    + svgNumber(innerWidthMm) + '" data-inner-height-mm="' + svgNumber(innerHeightMm)
    + '" data-imaginary-square-left-mm="' + svgNumber(contentLeftX) + '" data-imaginary-square-right-mm="'
    + svgNumber(contentRightX)
    + '" data-primary-element-one-bottom-mm="' + svgNumber(primaryElementOneCenterY + primaryElementOne.barLengthMm / 2)
    + '" data-primary-element-six-bottom-mm="' + svgNumber(primaryElementSixBottomY) + '" transform="translate('
    + svgNumber(centerX) + ' ' + svgNumber(centerY) + ') rotate(' + svgNumber(rotationDeg) + ')">'
    + '<rect x="' + svgNumber(-plateWidthMm / 2) + '" y="' + svgNumber(-plateHeightMm / 2)
    + '" width="' + svgNumber(plateWidthMm) + '" height="' + svgNumber(plateHeightMm)
    + '" rx="' + svgNumber(0.5 * unit) + '" fill="#fff" stroke="#15191d" stroke-width="'
    + svgNumber(Math.max(0.08, 0.18 * unit)) + '"/>'
    + '<g transform="translate(' + svgNumber(originX) + ' ' + svgNumber(originY) + ')" font-family="Arial,Helvetica,sans-serif" fill="#090b0c">'
    + '<rect data-diagnostic="opaque-reference-square" x="' + svgNumber(referenceSquareCenterX - referenceSquareSideMm / 2)
    + '" y="' + svgNumber(referenceSquareCenterY - referenceSquareSideMm / 2) + '" width="'
    + svgNumber(referenceSquareSideMm) + '" height="' + svgNumber(referenceSquareSideMm) + '"/>'
    + '<g data-target="usaf-1951-group" data-instance="' + firstInstance + '" data-usaf-group="' + firstGroup
    + '" data-reference-bar-width-mm="' + svgNumber(firstReference) + '" data-pair-reference-bar-width-mm="'
    + svgNumber(unit) + '" data-number-scale-role="primary">'
    + '<text data-number-role="group" data-number-size-mm="' + svgNumber(groupNumberSizeMm)
    + '" x="' + svgNumber((contentLeftX + primaryTopRightX) / 2) + '" y="' + svgNumber(3.25 * unit) + '" font-size="' + svgNumber(groupNumberSizeMm)
    + '" font-weight="600" text-anchor="middle">' + firstGroup + '</text>'
    + primaryElements.join('') + '</g>'
    + '<g data-target="usaf-1951-group" data-instance="' + secondInstance + '" data-usaf-group="' + secondGroup
    + '" data-reference-bar-width-mm="' + svgNumber(secondReference) + '" data-pair-reference-bar-width-mm="'
    + svgNumber(unit) + '" data-number-scale-role="secondary">'
    + '<text data-number-role="group" data-number-size-mm="' + svgNumber(groupNumberSizeMm)
    + '" x="' + svgNumber((secondaryTopLeftX + contentRightX) / 2) + '" y="' + svgNumber(3.25 * unit) + '" font-size="'
    + svgNumber(groupNumberSizeMm) + '" font-weight="600" text-anchor="middle">' + secondGroup + '</text>'
    + secondaryElements.join('') + '</g>'
    + '</g></g>';
}

function createGridGuides(): string {
  const lines: string[] = [];
  for (let coordinate = 28; coordinate <= 212; coordinate += OPTICAL_SHOWCASE_TARGET_SPEC.gridPitchMm) {
    lines.push('<path d="M ' + coordinate + ' 8 V 232 M 8 ' + coordinate + ' H 232"/>');
  }
  return '<g data-diagnostic="field-grid" fill="none" stroke="#64707a" stroke-opacity="0.2" stroke-width="0.22">'
    + lines.join('') + '</g>';
}

function createRadialGuides(): string {
  const spec = OPTICAL_SHOWCASE_TARGET_SPEC;
  const spokes: string[] = [];
  for (let index = 0; index < spec.radialTargetCount; index += 1) {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / spec.radialTargetCount;
    const x = 120 + Math.cos(angle) * spec.radialRadiusMm;
    const y = 120 + Math.sin(angle) * spec.radialRadiusMm;
    spokes.push('<path d="M 120 120 L ' + svgNumber(x) + ' ' + svgNumber(y) + '"/>');
  }
  return '<g data-diagnostic="radial-grid" fill="none" stroke="#6a737a" stroke-opacity="0.28" stroke-width="0.28">'
    + '<circle cx="120" cy="120" r="' + spec.radialRadiusMm + '"/>' + spokes.join('') + '</g>';
}

function createRegistrationMarks(): string {
  const positions: Array<[number, number]> = [[7, 120], [233, 120]];
  return '<g data-diagnostic="registration" fill="#fff" stroke="#090b0c" stroke-width="0.35">'
    + positions.map(([x, y]) => '<g><circle cx="' + x + '" cy="' + y + '" r="2.7"/><circle cx="' + x + '" cy="' + y
      + '" r="0.65" fill="#090b0c"/><path d="M ' + (x - 3.7) + ' ' + y + ' H ' + (x + 3.7)
      + ' M ' + x + ' ' + (y - 3.7) + ' V ' + (y + 3.7) + '" fill="none"/></g>').join('') + '</g>';
}

function createBinaryRadialChart(centerX: number, centerY: number, index: number): string {
  const spec = OPTICAL_SHOWCASE_TARGET_SPEC;
  const radius = spec.cornerRadialChartRadiusMm;
  const sectorCount = spec.cornerRadialChartCycles * 2;
  const sectorAngle = Math.PI * 2 / sectorCount;
  const sectors: string[] = [];
  for (let sector = 0; sector < sectorCount; sector += 2) {
    const start = -Math.PI / 2 + sector * sectorAngle;
    const end = start + sectorAngle;
    sectors.push('<path d="M ' + svgNumber(centerX) + ' ' + svgNumber(centerY)
      + ' L ' + svgNumber(centerX + Math.cos(start) * radius) + ' ' + svgNumber(centerY + Math.sin(start) * radius)
      + ' A ' + svgNumber(radius) + ' ' + svgNumber(radius) + ' 0 0 1 '
      + svgNumber(centerX + Math.cos(end) * radius) + ' ' + svgNumber(centerY + Math.sin(end) * radius)
      + ' Z"/>');
  }
  return '<g data-target="binary-radial-chart" data-placement="corner" data-placement-index="' + index
    + '" data-cycles-per-revolution="' + spec.cornerRadialChartCycles + '">'
    + '<circle cx="' + svgNumber(centerX) + '" cy="' + svgNumber(centerY) + '" r="' + svgNumber(radius)
    + '" fill="#fff" stroke="#090b0c" stroke-width="0.28"/>'
    + '<g fill="#090b0c">' + sectors.join('') + '</g>'
    + '<circle cx="' + svgNumber(centerX) + '" cy="' + svgNumber(centerY) + '" r="0.32" fill="#808080"/>'
    + '</g>';
}

function createCornerRadialCharts(): string {
  const centers: Array<[number, number]> = [[12.5, 12.5], [227.5, 12.5], [12.5, 227.5], [227.5, 227.5]];
  return '<g data-diagnostic="corner-radial-charts">'
    + centers.map(([x, y], index) => createBinaryRadialChart(x, y, index)).join('') + '</g>';
}

function createColorAndGrayscaleBars(): string {
  const spec = OPTICAL_SHOWCASE_TARGET_SPEC;
  const colorPatches = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
  const grayscalePatches = ['#000000', '#1a1a1a', '#333333', '#4d4d4d', '#666666', '#808080', '#999999', '#b3b3b3', '#cccccc', '#e6e6e6', '#ffffff'];
  const barWidth = 64;
  const colorPatchWidth = barWidth / spec.colorBarPatchCount;
  const grayscalePatchWidth = barWidth / spec.grayscaleBarPatchCount;
  const startX = 120 - barWidth / 2;
  const renderPatches = (patches: readonly string[], y: number, patchWidth: number, role: string) => patches.map((fill, index) => (
    '<rect data-bar-role="' + role + '" data-patch-index="' + index + '" x="' + svgNumber(startX + index * patchWidth)
    + '" y="' + svgNumber(y) + '" width="' + svgNumber(patchWidth) + '" height="3.2" fill="' + fill + '"/>'
  )).join('');
  return '<g data-diagnostic="color-grayscale-bars">'
    + '<g data-target="srgb-color-bar" data-patch-count="' + spec.colorBarPatchCount + '">'
    + renderPatches(colorPatches, 7, colorPatchWidth, 'color')
    + '<rect x="' + svgNumber(startX) + '" y="7" width="' + barWidth + '" height="3.2" fill="none" stroke="#090b0c" stroke-width="0.24"/></g>'
    + '<g data-target="srgb-grayscale-bar" data-patch-count="' + spec.grayscaleBarPatchCount + '">'
    + renderPatches(grayscalePatches, 229.8, grayscalePatchWidth, 'grayscale')
    + '<rect x="' + svgNumber(startX) + '" y="229.8" width="' + barWidth + '" height="3.2" fill="none" stroke="#090b0c" stroke-width="0.24"/></g>'
    + '</g>';
}

export function generateOpticalShowcaseTargetSvg(): string {
  const spec = OPTICAL_SHOWCASE_TARGET_SPEC;
  const targets: string[] = [];

  targets.push(createUsafPairPlate(
    120,
    120,
    spec.centralGroups[0],
    spec.centralGroups[1],
    0,
    'center',
    0,
  ));

  for (let index = 0; index < spec.radialTargetCount; index += 1) {
    const angleRad = -Math.PI / 2 + index * Math.PI * 2 / spec.radialTargetCount;
    const angleDeg = index * 360 / spec.radialTargetCount;
    targets.push(createUsafPairPlate(
      120 + Math.cos(angleRad) * spec.radialRadiusMm,
      120 + Math.sin(angleRad) * spec.radialRadiusMm,
      spec.fieldGroups[0],
      spec.fieldGroups[1],
      angleDeg,
      'radial',
      index,
    ));
  }

  const gridCoordinates = [-92, -46, 0, 46, 92];
  let gridIndex = 0;
  gridCoordinates.forEach((dy, row) => gridCoordinates.forEach((dx, column) => {
    if (Math.abs(dx) !== 92 && Math.abs(dy) !== 92) return;
    targets.push(createUsafPairPlate(
      120 + dx,
      120 + dy,
      spec.fieldGroups[0],
      spec.fieldGroups[1],
      (row + column) % 2 === 0 ? 0 : 90,
      'grid',
      gridIndex,
    ));
    gridIndex += 1;
  }));

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" width="' + spec.widthMm + 'mm" height="' + spec.heightMm
    + 'mm" viewBox="0 0 ' + spec.widthMm + ' ' + spec.heightMm + '" role="img"'
    + ' aria-label="Co-opt USAF 1951 Radial Grid 01" data-scene="optical-showcase" data-scene-name="'
    + spec.sceneName + '" data-scene-version="' + spec.sceneVersion + '" data-coordinate-unit="mm"'
    + ' data-usaf-frequency-formula="2^(group+(element-1)/6)" data-usaf-bar-aspect-ratio="5:1"'
    + ' data-usaf-line-to-space-ratio="1:1">'
    + '<title>CO-OPT · USAF 1951 RADIAL GRID · 01</title>'
    + '<desc>Native-vector field chart composed of mathematically sized USAF 1951 six-element group pairs in the classic near-square spiral arrangement. Every bar width, gap, bar length and frequency is expressed in millimetres without geometric scaling.</desc>'
    + '<rect width="240" height="240" fill="#f5f5f2"/>'
    + createGridGuides()
    + createRadialGuides()
    + '<path d="M120 8V232M8 120H232" fill="none" stroke="#39434a" stroke-opacity="0.24" stroke-width="0.3"/>'
    + targets.join('')
    + createCornerRadialCharts()
    + createColorAndGrayscaleBars()
    + '<g data-diagnostic="chart-title" font-family="Arial,Helvetica,sans-serif" fill="#090b0c" text-anchor="middle">'
    + '<text x="120" y="14.2" font-size="2.7" font-weight="700" letter-spacing="0.55">USAF 1951 · RADIAL / GRID</text>'
    + '<text x="120" y="17.6" font-size="1.35" letter-spacing="0.28">EXACT MIL-STD-150A ELEMENT GEOMETRY · NATIVE SVG</text>'
    + '<text x="120" y="236.8" font-size="1.35" letter-spacing="0.28">240 × 240 mm · CO-OPT IMAGE SIMULATION SOURCE</text>'
    + '</g>'
    + createRegistrationMarks()
    + '<rect x="4.5" y="4.5" width="231" height="231" fill="none" stroke="#090b0c" stroke-width="0.75"/>'
    + '</svg>';
}
