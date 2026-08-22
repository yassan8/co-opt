export type CalibratedCameraTargetSpec = {
  widthMm: number;
  heightMm: number;
  marginMm: number;
  gridPitchMm: number;
  fieldPositionsMm: readonly number[];
  edgePatchSizeMm: number;
  edgeSquareSizeMm: number;
  edgeAnglesDeg: readonly number[];
  usafPlateWidthMm: number;
  usafPlateHeightMm: number;
  calibrationLengthMm: number;
  edgeLightSrgbByte: number;
  edgeDarkSrgbByte: number;
  edgeLinearContrast: number;
  usafGroups: readonly number[];
  siemensCyclesPerRevolution: number;
  siemensRadiusMm: number;
  siemensInnerRadiusMm: number;
};

const srgbByteToLinear = (byte: number) => {
  const encoded = byte / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : Math.pow((encoded + 0.055) / 1.055, 2.4);
};

const EDGE_DARK_SRGB_BYTE = 119;
const EDGE_LIGHT_SRGB_BYTE = 223;

export const CALIBRATED_CAMERA_TARGET_SPEC: Readonly<CalibratedCameraTargetSpec> = Object.freeze({
  widthMm: 240,
  heightMm: 240,
  marginMm: 5,
  gridPitchMm: 10,
  fieldPositionsMm: Object.freeze([28, 74, 120, 166, 212]),
  edgePatchSizeMm: 24,
  edgeSquareSizeMm: 14,
  edgeAnglesDeg: Object.freeze([-7, -5, 5, 7]),
  usafPlateWidthMm: 24,
  usafPlateHeightMm: 23,
  calibrationLengthMm: 100,
  edgeLightSrgbByte: EDGE_LIGHT_SRGB_BYTE,
  edgeDarkSrgbByte: EDGE_DARK_SRGB_BYTE,
  edgeLinearContrast: srgbByteToLinear(EDGE_LIGHT_SRGB_BYTE) / srgbByteToLinear(EDGE_DARK_SRGB_BYTE),
  usafGroups: Object.freeze([-1, 0, 1, 2]),
  siemensCyclesPerRevolution: 72,
  siemensRadiusMm: 27,
  siemensInnerRadiusMm: 1.5,
});

const svgNumber = (value: number) => Number(value.toFixed(9)).toString();

const usafFrequencyLpmm = (group: number, element: number) => (
  Math.pow(2, group + (element - 1) / 6)
);

function createTriBarsMm(barWidthMm: number, rotationDeg: number): string {
  const lengthMm = barWidthMm * 5;
  return '<g transform="rotate(' + svgNumber(rotationDeg) + ')"'
    + ' data-bar-width-mm="' + svgNumber(barWidthMm) + '"'
    + ' data-space-width-mm="' + svgNumber(barWidthMm) + '"'
    + ' data-bar-length-mm="' + svgNumber(lengthMm) + '">'
    + [-1, 0, 1].map((index) => (
      '<rect x="' + svgNumber(index * barWidthMm * 2 - barWidthMm / 2)
      + '" y="' + svgNumber(-lengthMm / 2)
      + '" width="' + svgNumber(barWidthMm)
      + '" height="' + svgNumber(lengthMm) + '"/>'
    )).join('')
    + '</g>';
}

function createCalibratedUsafGroup(cx: number, cy: number, group: number): string {
  const spec = CALIBRATED_CAMERA_TARGET_SPEC;
  const cellWidthMm = 10;
  const cellHeightMm = 6.2;
  const positions = [
    [-cellWidthMm / 2, -cellHeightMm], [cellWidthMm / 2, -cellHeightMm],
    [-cellWidthMm / 2, 0], [cellWidthMm / 2, 0],
    [-cellWidthMm / 2, cellHeightMm], [cellWidthMm / 2, cellHeightMm],
  ];
  const elements = positions.map(([x, y], index) => {
    const element = index + 1;
    const frequency = usafFrequencyLpmm(group, element);
    const barWidthMm = 1 / (2 * frequency);
    return '<g transform="translate(' + svgNumber(x) + ' ' + svgNumber(y) + ')"'
      + ' data-usaf-group="' + group + '" data-usaf-element="' + element + '"'
      + ' data-frequency-lp-mm="' + svgNumber(frequency) + '">'
      + createTriBarsMm(barWidthMm, index % 2 === 0 ? 0 : 90)
      + '<text x="0" y="2.7" text-anchor="middle" font-size="1.6" fill="#475569">E' + element + '</text>'
      + '</g>';
  }).join('');
  return '<g transform="translate(' + svgNumber(cx) + ' ' + svgNumber(cy) + ')"'
    + ' data-target="usaf-1951" data-usaf-group="' + group + '">'
    + '<rect x="' + svgNumber(-spec.usafPlateWidthMm / 2) + '" y="' + svgNumber(-spec.usafPlateHeightMm / 2)
    + '" width="' + svgNumber(spec.usafPlateWidthMm) + '" height="' + svgNumber(spec.usafPlateHeightMm)
    + '" rx="1.2" fill="#ffffff" stroke="#64748b" stroke-width="0.35"/>'
    + '<g fill="#0f172a">' + elements + '</g>'
    + '<text x="0" y="10.4" text-anchor="middle" font-size="2.1" font-weight="700" fill="#334155">USAF G' + group + '</text>'
    + '</g>';
}

function createSlantedEdgePatch(cx: number, cy: number, angleDeg: number, index: number): string {
  const spec = CALIBRATED_CAMERA_TARGET_SPEC;
  const patchHalf = spec.edgePatchSizeMm / 2;
  const squareHalf = spec.edgeSquareSizeMm / 2;
  const light = 'rgb(' + spec.edgeLightSrgbByte + ' ' + spec.edgeLightSrgbByte + ' ' + spec.edgeLightSrgbByte + ')';
  const dark = 'rgb(' + spec.edgeDarkSrgbByte + ' ' + spec.edgeDarkSrgbByte + ' ' + spec.edgeDarkSrgbByte + ')';
  return '<g data-target="esfr-slanted-square" data-target-index="' + index + '"'
    + ' data-edge-angle-deg="' + svgNumber(angleDeg) + '"'
    + ' data-light-srgb-byte="' + spec.edgeLightSrgbByte + '"'
    + ' data-dark-srgb-byte="' + spec.edgeDarkSrgbByte + '"'
    + ' data-linear-contrast="' + svgNumber(spec.edgeLinearContrast) + '">'
    + '<rect x="' + svgNumber(cx - patchHalf) + '" y="' + svgNumber(cy - patchHalf)
    + '" width="' + svgNumber(spec.edgePatchSizeMm) + '" height="' + svgNumber(spec.edgePatchSizeMm)
    + '" rx="1" fill="' + light + '" stroke="#64748b" stroke-width="0.35"/>'
    + '<rect x="' + svgNumber(cx - squareHalf) + '" y="' + svgNumber(cy - squareHalf)
    + '" width="' + svgNumber(spec.edgeSquareSizeMm) + '" height="' + svgNumber(spec.edgeSquareSizeMm)
    + '" fill="' + dark + '" transform="rotate(' + svgNumber(angleDeg) + ' ' + svgNumber(cx) + ' ' + svgNumber(cy) + ')"/>'
    + '<text x="' + svgNumber(cx) + '" y="' + svgNumber(cy + patchHalf - 1.4)
    + '" text-anchor="middle" font-size="1.55" fill="#475569">' + svgNumber(angleDeg) + '° · 4:1</text>'
    + '</g>';
}

function createSiemensStar(cx: number, cy: number): string {
  const spec = CALIBRATED_CAMERA_TARGET_SPEC;
  const sectors = spec.siemensCyclesPerRevolution * 2;
  const wedges: string[] = [];
  for (let sector = 0; sector < sectors; sector += 2) {
    const a0 = sector / sectors * Math.PI * 2 - Math.PI / 2;
    const a1 = (sector + 1) / sectors * Math.PI * 2 - Math.PI / 2;
    wedges.push('<path d="M ' + svgNumber(cx) + ' ' + svgNumber(cy)
      + ' L ' + svgNumber(cx + Math.cos(a0) * spec.siemensRadiusMm)
      + ' ' + svgNumber(cy + Math.sin(a0) * spec.siemensRadiusMm)
      + ' A ' + svgNumber(spec.siemensRadiusMm) + ' ' + svgNumber(spec.siemensRadiusMm) + ' 0 0 1 '
      + svgNumber(cx + Math.cos(a1) * spec.siemensRadiusMm)
      + ' ' + svgNumber(cy + Math.sin(a1) * spec.siemensRadiusMm) + ' Z"/>');
  }
  const maxFrequency = spec.siemensCyclesPerRevolution / (2 * Math.PI * spec.siemensInnerRadiusMm);
  return '<g data-target="binary-siemens-star"'
    + ' data-cycles-per-revolution="' + spec.siemensCyclesPerRevolution + '"'
    + ' data-radius-mm="' + svgNumber(spec.siemensRadiusMm) + '"'
    + ' data-inner-radius-mm="' + svgNumber(spec.siemensInnerRadiusMm) + '"'
    + ' data-max-frequency-lp-mm="' + svgNumber(maxFrequency) + '">'
    + '<circle cx="' + svgNumber(cx) + '" cy="' + svgNumber(cy) + '" r="' + svgNumber(spec.siemensRadiusMm)
    + '" fill="#ffffff" stroke="#64748b" stroke-width="0.45"/>'
    + '<g fill="#0f172a">' + wedges.join('') + '</g>'
    + '<circle cx="' + svgNumber(cx) + '" cy="' + svgNumber(cy) + '" r="' + svgNumber(spec.siemensInnerRadiusMm)
    + '" fill="#94a3b8"/>'
    + '</g>';
}

export function getCalibratedCameraTargetNominalMaxFrequencyLpmm(): number {
  const spec = CALIBRATED_CAMERA_TARGET_SPEC;
  const highestGroup = Math.max(...spec.usafGroups);
  const usafMaximum = usafFrequencyLpmm(highestGroup, 6);
  const starMaximum = spec.siemensCyclesPerRevolution / (2 * Math.PI * spec.siemensInnerRadiusMm);
  return Math.max(usafMaximum, starMaximum);
}

export function generateCalibratedCameraResolutionTargetSvg(): string {
  const spec = CALIBRATED_CAMERA_TARGET_SPEC;
  const fieldPositions = spec.fieldPositionsMm;
  const usafByCell = new Map([
    ['0,2', spec.usafGroups[0]],
    ['2,0', spec.usafGroups[1]],
    ['2,4', spec.usafGroups[2]],
    ['4,2', spec.usafGroups[3]],
  ]);
  const features: string[] = [];
  let edgeIndex = 0;
  fieldPositions.forEach((y, row) => fieldPositions.forEach((x, column) => {
    if (row === 2 && column === 2) return;
    const usafGroup = usafByCell.get(row + ',' + column);
    if (usafGroup !== undefined) {
      features.push(createCalibratedUsafGroup(x, y, usafGroup));
      return;
    }
    const angle = spec.edgeAnglesDeg[edgeIndex % spec.edgeAnglesDeg.length];
    features.push(createSlantedEdgePatch(x, y, angle, edgeIndex + 1));
    edgeIndex += 1;
  }));
  features.push(createSiemensStar(120, 120));

  const maxFrequency = getCalibratedCameraTargetNominalMaxFrequencyLpmm();
  const calibrationStartX = (spec.widthMm - spec.calibrationLengthMm) / 2;
  const calibrationEndX = calibrationStartX + spec.calibrationLengthMm;
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" width="' + spec.widthMm + 'mm" height="' + spec.heightMm
    + 'mm" viewBox="0 0 ' + spec.widthMm + ' ' + spec.heightMm + '" role="img"'
    + ' aria-label="Co-opt calibrated camera resolution target"'
    + ' data-coordinate-unit="mm" data-nominal-width-mm="' + spec.widthMm
    + '" data-nominal-height-mm="' + spec.heightMm
    + '" data-nominal-max-frequency-lp-mm="' + svgNumber(maxFrequency) + '">'
    + '<title>CO-OPT CALIBRATED CAMERA RESOLUTION TARGET</title>'
    + '<desc>Mathematically generated image-simulation source. Coordinates are millimetres. Slanted squares use calibrated 8-bit sRGB values with a 4.000056543:1 decoded linear-light ratio. USAF dimensions use f=2^(group+(element-1)/6), bar width=1/(2f), and bar length=5 times the bar width.</desc>'
    + '<defs><pattern id="calibrated-10mm-grid" width="' + spec.gridPitchMm + '" height="' + spec.gridPitchMm
    + '" patternUnits="userSpaceOnUse"><path d="M ' + spec.gridPitchMm + ' 0 H 0 V ' + spec.gridPitchMm
    + '" fill="none" stroke="#dbe4ef" stroke-width="0.18"/></pattern></defs>'
    + '<rect width="' + spec.widthMm + '" height="' + spec.heightMm + '" fill="#f8fafc"/>'
    + '<rect x="' + spec.marginMm + '" y="' + spec.marginMm + '" width="' + (spec.widthMm - spec.marginMm * 2)
    + '" height="' + (spec.heightMm - spec.marginMm * 2) + '" fill="url(#calibrated-10mm-grid)"/>'
    + '<rect x="' + spec.marginMm + '" y="' + spec.marginMm + '" width="' + (spec.widthMm - spec.marginMm * 2)
    + '" height="' + (spec.heightMm - spec.marginMm * 2) + '" fill="none" stroke="#0f172a" stroke-width="0.8"/>'
    + '<path d="M 120 5 V 235 M 5 120 H 235" stroke="#94a3b8" stroke-width="0.25"/>'
    + features.join('')
    + '<g data-calibration-length-mm="' + svgNumber(spec.calibrationLengthMm) + '" stroke="#0f172a" fill="#334155">'
    + '<path d="M ' + svgNumber(calibrationStartX) + ' 231 V 235 M ' + svgNumber(calibrationStartX)
    + ' 233 H ' + svgNumber(calibrationEndX) + ' M ' + svgNumber(calibrationEndX) + ' 231 V 235" stroke-width="0.45"/>'
    + '<text x="120" y="230.5" text-anchor="middle" font-size="2.2" stroke="none">100 mm nominal coordinate span</text>'
    + '</g>'
    + '<text x="8" y="11" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="4.2" font-weight="700" fill="#0f172a">CO-OPT CALIBRATED CAMERA RESOLUTION TARGET</text>'
    + '<text x="232" y="11" text-anchor="end" font-family="ui-monospace,Consolas,monospace" font-size="2.2" fill="#475569">240 × 240 mm coordinate model · native SVG</text>'
    + '</svg>';
}
