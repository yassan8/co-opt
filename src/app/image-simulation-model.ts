export type ImageSimulationImage = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

export type ImageSimulationTargetKind = 'field-chart' | 'usaf-array' | 'grid-points';

export type ImageSimulationScaleMode = 'field-fit' | 'sensor-width' | 'pixel-pitch';
export type ImageSimulationDistortionMap = {
  gridSize: number;
  idealX: number[];
  idealY: number[];
  realX: Array<number | null>;
  realY: Array<number | null>;
};

export type ImageSimulationPhysicalExtent = {
  minXmm: number;
  maxXmm: number;
  minYmm: number;
  maxYmm: number;
  widthMm: number;
  heightMm: number;
};

export type ImageSimulationKernel = {
  size: number;
  data: Float32Array;
  sparse: Array<{ dx: number; dy: number; weight: number }>;
};

export type ImageSimulationFieldKernel = {
  xNorm: number;
  yNorm: number;
  kernel: ImageSimulationKernel;
  redKernel?: ImageSimulationKernel;
  greenKernel?: ImageSimulationKernel;
  blueKernel?: ImageSimulationKernel;
  fieldLabel?: string;
};

export type ImageSimulationSpectralLayer = {
  image: ImageSimulationImage;
  wavelengthUm: number;
  weight: number;
  linearRgb: [number, number, number];
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const IMAGE_SIMULATION_SVG_VIEWBOX = 4096;
const IMAGE_SIMULATION_SVG_EDGE_GUARD = 16;

const svgNumber = (value: number) => Number(value.toFixed(3)).toString();
const escapeSvgText = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export type Usaf1951ElementGeometry = {
  group: number;
  element: number;
  spatialFrequencyLpPerMm: number;
  barWidthMm: number;
  spaceWidthMm: number;
  barLengthMm: number;
};

export function getUsaf1951ElementGeometry(group: number, element: number): Usaf1951ElementGeometry {
  if (!Number.isInteger(group) || group < -2 || group > 7) {
    throw new Error('USAF 1951 group must be an integer from -2 through 7.');
  }
  if (!Number.isInteger(element) || element < 1 || element > 6) {
    throw new Error('USAF 1951 element must be an integer from 1 through 6.');
  }
  const spatialFrequencyLpPerMm = Math.pow(2, group + (element - 1) / 6);
  const barWidthMm = 1 / (2 * spatialFrequencyLpPerMm);
  return {
    group,
    element,
    spatialFrequencyLpPerMm,
    barWidthMm,
    spaceWidthMm: barWidthMm,
    barLengthMm: barWidthMm * 5,
  };
}

export function getImageSimulationTargetNominalMaxFrequencyLpmm(
  kind: ImageSimulationTargetKind | 'upload',
  imageWidthMm: number,
): number | null {
  if (kind !== 'field-chart' && kind !== 'usaf-array') return null;
  const widthMm = Math.abs(Number(imageWidthMm));
  if (!(Number.isFinite(widthMm) && widthMm > 1e-12)) return null;
  const reference = getUsaf1951ElementGeometry(0, 1);
  const finest = getUsaf1951ElementGeometry(0, 3);
  const normalizedBarWidth = 14 * finest.barWidthMm / reference.barWidthMm;
  const minimumClusterScale = kind === 'usaf-array' ? 0.88 : 1;
  const barWidthMm = widthMm * normalizedBarWidth * minimumClusterScale / IMAGE_SIMULATION_SVG_VIEWBOX;
  return barWidthMm > 0 ? 1 / (2 * barWidthMm) : null;
}

function createSvgTriBars(barWidth: number): string {
  const length = barWidth * 5;
  return '<g data-usaf-bar-width="' + svgNumber(barWidth)
    + '" data-usaf-space-width="' + svgNumber(barWidth)
    + '" data-usaf-bar-length="' + svgNumber(length) + '">'
    + [-1, 0, 1].map((index) => (
      '<rect x="' + svgNumber(index * barWidth * 2 - barWidth / 2)
      + '" y="' + svgNumber(-length / 2)
      + '" width="' + svgNumber(barWidth)
      + '" height="' + svgNumber(length) + '"/>'
    )).join('') + '</g>';
}

function createSvgUsafCluster(
  x: number,
  y: number,
  label: string,
  rotationDeg = 0,
  scale = 1,
): string {
  const elementNumbers = [1, 2, 3];
  const referenceGeometry = getUsaf1951ElementGeometry(0, elementNumbers[0]);
  const rowGap = 18;
  const rows = elementNumbers.map((element) => {
    const geometry = getUsaf1951ElementGeometry(0, element);
    const barWidth = 14 * geometry.barWidthMm / referenceGeometry.barWidthMm;
    return {
      element,
      barWidth,
      length: barWidth * 5,
      widthRatio: geometry.barWidthMm / referenceGeometry.barWidthMm,
    };
  });
  const totalRowsHeight = rows.reduce((sum, row) => sum + row.length, 0) + rowGap * (rows.length - 1);
  let cursorY = -totalRowsHeight / 2;
  const rowSvg = rows.map((row) => {
    const centerY = cursorY + row.length / 2;
    cursorY += row.length + rowGap;
    return '<g data-usaf-element="' + row.element
      + '" data-usaf-width-ratio="' + svgNumber(row.widthRatio) + '">'
      + '<g transform="translate(-62 ' + svgNumber(centerY) + ')">' + createSvgTriBars(row.barWidth) + '</g>'
      + '<g transform="translate(62 ' + svgNumber(centerY) + ') rotate(90)">' + createSvgTriBars(row.barWidth) + '</g>'
      + '<text x="-132" y="' + svgNumber(centerY + 5)
      + '" font-family="ui-monospace,Consolas,monospace" font-size="14" fill="#64748b">E'
      + row.element + '</text></g>';
  }).join('');
  const plateTop = -totalRowsHeight / 2 - 26;
  const plateHeight = totalRowsHeight + 52;
  const labelY = plateTop + plateHeight + 38;
  return '<g transform="translate(' + svgNumber(x) + ' ' + svgNumber(y) + ') rotate(' + svgNumber(rotationDeg)
    + ') scale(' + svgNumber(scale) + ')" data-usaf-scale="normalized">'
    + '<rect x="-152" y="' + svgNumber(plateTop) + '" width="304" height="' + svgNumber(plateHeight)
    + '" rx="14" fill="#fff" stroke="#64748b" stroke-width="3"/>'
    + '<g fill="#111827">' + rowSvg + '</g>'
    + '<text x="0" y="' + svgNumber(labelY)
    + '" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="24" fill="#334155">'
    + escapeSvgText(label) + ' · E1–E3</text></g>';
}

function createSvgSiemensStar(x: number, y: number, radius: number): string {
  const spokes = 72;
  const wedges: string[] = [];
  for (let index = 0; index < spokes; index += 2) {
    const a0 = index / spokes * Math.PI * 2;
    const a1 = (index + 1) / spokes * Math.PI * 2;
    wedges.push('<path d="M ' + svgNumber(x) + ' ' + svgNumber(y)
      + ' L ' + svgNumber(x + Math.cos(a0) * radius) + ' ' + svgNumber(y + Math.sin(a0) * radius)
      + ' A ' + svgNumber(radius) + ' ' + svgNumber(radius) + ' 0 0 1 '
      + svgNumber(x + Math.cos(a1) * radius) + ' ' + svgNumber(y + Math.sin(a1) * radius)
      + ' Z" fill="#0f172a"/>');
  }
  return '<circle cx="' + svgNumber(x) + '" cy="' + svgNumber(y) + '" r="' + svgNumber(radius)
    + '" fill="#fff" stroke="#64748b" stroke-width="4"/>' + wedges.join('');
}

function createSvgPointConstellation(x: number, y: number, scale: number): string {
  const offsets = [[0, 0], [-3, -2], [3, -2], [-3, 2], [3, 2], [0, -4], [0, 4]];
  return '<g fill="#020617">' + offsets.map(([dx, dy], index) => (
    '<circle cx="' + svgNumber(x + dx * scale) + '" cy="' + svgNumber(y + dy * scale)
    + '" r="' + svgNumber(index === 0 ? scale * 0.58 : scale * 0.35) + '"/>'
  )).join('') + '</g>';
}

export function generateImageSimulationTargetSvg(
  kind: ImageSimulationTargetKind = 'field-chart',
): string {
  const size = IMAGE_SIMULATION_SVG_VIEWBOX;
  const margin = size * 0.055;
  const patternSpan = size - IMAGE_SIMULATION_SVG_EDGE_GUARD * 2;
  const elements: string[] = [];
  const title = kind === 'field-chart'
    ? 'CO-OPT VECTOR FIELD IMAGE TARGET'
    : kind === 'usaf-array'
      ? 'USAF VECTOR FIELD ARRAY'
      : 'VECTOR GRID / POINT FIELD';
  const targetDescription = kind === 'grid-points'
    ? 'Resolution-independent optical image simulation target. All patterns are native SVG vectors.'
    : 'Resolution-independent optical image simulation target. USAF patterns use MIL-STD-150A element proportions at a normalized scale.';
  const detailNote = kind === 'grid-points'
    ? 'SVG · 4096 viewBox · lossless scale'
    : 'USAF 1951 ratios · normalized scale · SVG';

  if (kind === 'usaf-array') {
    const positions = [-0.8, -0.4, 0, 0.4, 0.8];
    positions.forEach((ny, row) => positions.forEach((nx, column) => {
      const radial = Math.hypot(nx, ny);
      elements.push(createSvgUsafCluster(
        size * (0.5 + nx * 0.46),
        size * (0.5 - ny * 0.46),
        String.fromCharCode(65 + row) + String(column + 1),
        (row + column) % 2 ? 45 : 0,
        radial > 0.9 ? 0.88 : 1,
      ));
    }));
  } else if (kind === 'field-chart') {
    const positions = [
      [-0.78, 0.78], [0, 0.82], [0.78, 0.78],
      [-0.82, 0.38], [-0.4, 0.4], [0.4, 0.4], [0.82, 0.38],
      [-0.82, 0], [-0.42, 0], [0.42, 0], [0.82, 0],
      [-0.82, -0.38], [-0.4, -0.4], [0.4, -0.4], [0.82, -0.38],
      [-0.78, -0.78], [0, -0.82], [0.78, -0.78],
    ];
    positions.forEach(([nx, ny], index) => {
      elements.push(createSvgUsafCluster(
        size * (0.5 + nx * 0.47),
        size * (0.5 - ny * 0.47),
        'F' + String(index + 1).padStart(2, '0'),
        index % 3 === 2 ? 45 : 0,
      ));
    });
    elements.push(createSvgSiemensStar(size / 2, size / 2, size * 0.085));
    elements.push(createSvgPointConstellation(size * 0.5, size * 0.26, size / 510));
    elements.push(createSvgPointConstellation(size * 0.5, size * 0.74, size / 510));
    elements.push('<rect x="' + svgNumber(size * 0.09) + '" y="' + svgNumber(size * 0.38)
      + '" width="' + svgNumber(size * 0.1) + '" height="' + svgNumber(size * 0.24)
      + '" fill="#111827" transform="rotate(5 ' + svgNumber(size * 0.14) + ' ' + svgNumber(size * 0.5) + ')"/>');
    elements.push('<rect x="' + svgNumber(size * 0.81) + '" y="' + svgNumber(size * 0.38)
      + '" width="' + svgNumber(size * 0.1) + '" height="' + svgNumber(size * 0.24)
      + '" fill="#111827" transform="rotate(-5 ' + svgNumber(size * 0.86) + ' ' + svgNumber(size * 0.5) + ')"/>');
    const colors = ['#ef4444', '#22c55e', '#3b82f6', '#ffffff', '#94a3b8', '#111827'];
    const patchWidth = size * 0.055;
    colors.forEach((color, index) => {
      elements.push('<rect x="' + svgNumber(size * 0.5 + (index - 3) * patchWidth)
        + '" y="' + svgNumber(size * 0.934) + '" width="' + svgNumber(patchWidth)
        + '" height="' + svgNumber(size * 0.025) + '" fill="' + color + '" stroke="#334155" stroke-width="2"/>');
    });
  } else {
    const positions = [-0.75, -0.38, 0, 0.38, 0.75];
    positions.forEach((ny) => positions.forEach((nx) => {
      elements.push(createSvgPointConstellation(
        size * (0.5 + nx * 0.5),
        size * (0.5 - ny * 0.5),
        size / 590,
      ));
    }));
    elements.push(createSvgSiemensStar(size / 2, size / 2, size * 0.12));
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096" viewBox="0 0 4096 4096" role="img" aria-label="'
    + escapeSvgText(title) + '">'
    + '<title>' + escapeSvgText(title) + '</title>'
    + '<desc>' + escapeSvgText(targetDescription) + '</desc>'
    + '<defs>'
    + '<pattern id="minor-grid" width="128" height="128" patternUnits="userSpaceOnUse"><path d="M128 0H0V128" fill="none" stroke="#cbd5e1" stroke-width="2"/></pattern>'
    + '<pattern id="major-grid" width="512" height="512" patternUnits="userSpaceOnUse"><path d="M512 0H0V512" fill="none" stroke="#64748b" stroke-width="5"/></pattern>'
    + '</defs>'
    + '<rect width="4096" height="4096" fill="#f8fafc"/>'
    + '<rect x="' + svgNumber(IMAGE_SIMULATION_SVG_EDGE_GUARD) + '" y="' + svgNumber(IMAGE_SIMULATION_SVG_EDGE_GUARD)
    + '" width="' + svgNumber(patternSpan) + '" height="' + svgNumber(patternSpan) + '" fill="url(#minor-grid)"/>'
    + '<rect x="' + svgNumber(IMAGE_SIMULATION_SVG_EDGE_GUARD) + '" y="' + svgNumber(IMAGE_SIMULATION_SVG_EDGE_GUARD)
    + '" width="' + svgNumber(patternSpan) + '" height="' + svgNumber(patternSpan) + '" fill="url(#major-grid)"/>'
    + '<rect x="' + svgNumber(margin) + '" y="' + svgNumber(margin) + '" width="' + svgNumber(size - margin * 2)
    + '" height="' + svgNumber(size - margin * 2) + '" fill="none" stroke="#0f172a" stroke-width="8"/>'
    + '<path d="M2048 ' + svgNumber(margin) + 'V' + svgNumber(size - margin)
    + ' M' + svgNumber(margin) + ' 2048H' + svgNumber(size - margin) + '" stroke="#0f172a" stroke-width="6"/>'
    + elements.join('')
    + '<text x="' + svgNumber(margin) + '" y="132" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="72" font-weight="700" fill="#0f172a">'
    + escapeSvgText(title) + '</text>'
    + '<text x="' + svgNumber(size - margin) + '" y="132" text-anchor="end" font-family="ui-monospace,Consolas,monospace" font-size="34" fill="#475569">' + escapeSvgText(detailNote) + '</text>'
    + '</svg>';
}

export async function rasterizeImageSimulationTargetSvg(
  svg: string,
  requestedSize: number,
): Promise<ImageSimulationImage> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('SVG target rasterization requires a browser image renderer.');
  }
  const size = Math.max(256, Math.min(4096, Math.round(Number(requestedSize) || 1536)));
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG target could not be decoded.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size);
    return { width: size, height: size, rgba: new Uint8ClampedArray(data.data) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function generateImageSimulationTarget(
  requestedSize: number,
  kind: ImageSimulationTargetKind = 'field-chart',
): Promise<ImageSimulationImage> {
  return rasterizeImageSimulationTargetSvg(generateImageSimulationTargetSvg(kind), requestedSize);
}

function sampleImageBilinear(image: ImageSimulationImage, x: number, y: number, out: Uint8ClampedArray, offset: number) {
  const { width, height, rgba } = image;
  const boundedX = clamp(Number.isFinite(x) ? x : 0, 0, width - 1);
  const boundedY = clamp(Number.isFinite(y) ? y : 0, 0, height - 1);
  const x0 = Math.floor(boundedX);
  const y0 = Math.floor(boundedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = boundedX - x0;
  const ty = boundedY - y0;
  for (let channel = 0; channel < 4; channel += 1) {
    const v00 = rgba[(y0 * width + x0) * 4 + channel] || 0;
    const v10 = rgba[(y0 * width + x1) * 4 + channel] || 0;
    const v01 = rgba[(y1 * width + x0) * 4 + channel] || 0;
    const v11 = rgba[(y1 * width + x1) * 4 + channel] || 0;
    out[offset + channel] = Math.round((v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty);
  }
}

export function getImageSimulationPhysicalExtent(map: ImageSimulationDistortionMap): ImageSimulationPhysicalExtent {
  const xs = (Array.isArray(map?.idealX) ? map.idealX : []).map(Number).filter(Number.isFinite);
  const ys = (Array.isArray(map?.idealY) ? map.idealY : []).map(Number).filter(Number.isFinite);
  const minXmm = xs.length ? Math.min(...xs) : -1;
  const maxXmm = xs.length ? Math.max(...xs) : 1;
  const minYmm = ys.length ? Math.min(...ys) : -1;
  const maxYmm = ys.length ? Math.max(...ys) : 1;
  return {
    minXmm,
    maxXmm,
    minYmm,
    maxYmm,
    widthMm: Math.max(1e-9, maxXmm - minXmm),
    heightMm: Math.max(1e-9, maxYmm - minYmm),
  };
}

function prepareDisplacement(map: ImageSimulationDistortionMap) {
  const gridSize = Math.max(2, Math.floor(Number(map?.gridSize) || 2));
  const count = gridSize * gridSize;
  const extent = getImageSimulationPhysicalExtent(map);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const valid: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const idealX = Number(map?.idealX?.[index]);
    const idealY = Number(map?.idealY?.[index]);
    const realXValue = map?.realX?.[index];
    const realYValue = map?.realY?.[index];
    const realX = typeof realXValue === 'number' ? realXValue : Number.NaN;
    const realY = typeof realYValue === 'number' ? realYValue : Number.NaN;
    if (Number.isFinite(idealX) && Number.isFinite(idealY) && Number.isFinite(realX) && Number.isFinite(realY)) {
      dx[index] = realX - idealX;
      dy[index] = realY - idealY;
      valid.push(index);
    } else {
      dx[index] = Number.NaN;
      dy[index] = Number.NaN;
    }
  }
  for (let index = 0; index < count; index += 1) {
    if (Number.isFinite(dx[index]) && Number.isFinite(dy[index])) continue;
    const row = Math.floor(index / gridSize);
    const column = index % gridSize;
    let sumWeights = 0;
    let sumX = 0;
    let sumY = 0;
    valid.forEach((candidate) => {
      const candidateRow = Math.floor(candidate / gridSize);
      const candidateColumn = candidate % gridSize;
      const distance2 = (candidateRow - row) ** 2 + (candidateColumn - column) ** 2;
      const weight = 1 / Math.max(0.25, distance2);
      sumWeights += weight;
      sumX += dx[candidate] * weight;
      sumY += dy[candidate] * weight;
    });
    dx[index] = sumWeights > 0 ? sumX / sumWeights : 0;
    dy[index] = sumWeights > 0 ? sumY / sumWeights : 0;
  }
  return { gridSize, extent, dx, dy, validCount: valid.length };
}

function sampleDisplacement(
  prepared: ReturnType<typeof prepareDisplacement>,
  idealX: number,
  idealY: number,
): [number, number] {
  const { gridSize, extent, dx, dy } = prepared;
  const gx = clamp((idealX - extent.minXmm) / extent.widthMm * (gridSize - 1), 0, gridSize - 1);
  const gy = clamp((idealY - extent.minYmm) / extent.heightMm * (gridSize - 1), 0, gridSize - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(gridSize - 1, x0 + 1);
  const y1 = Math.min(gridSize - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const sample = (array: Float64Array) => {
    const a = array[y0 * gridSize + x0];
    const b = array[y0 * gridSize + x1];
    const c = array[y1 * gridSize + x0];
    const d = array[y1 * gridSize + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  return [sample(dx), sample(dy)];
}

export function warpImageWithDistortion(
  image: ImageSimulationImage,
  map: ImageSimulationDistortionMap,
  rasterExtent?: ImageSimulationPhysicalExtent,
): ImageSimulationImage {
  const prepared = prepareDisplacement(map);
  if (prepared.validCount <= 0) return { ...image, rgba: new Uint8ClampedArray(image.rgba) };
  const out = new Uint8ClampedArray(image.width * image.height * 4);
  const extent = rasterExtent || prepared.extent;
  for (let rasterY = 0; rasterY < image.height; rasterY += 1) {
    const realY = extent.maxYmm - (rasterY / Math.max(1, image.height - 1)) * extent.heightMm;
    for (let rasterX = 0; rasterX < image.width; rasterX += 1) {
      const realX = extent.minXmm + (rasterX / Math.max(1, image.width - 1)) * extent.widthMm;
      let idealX = realX;
      let idealY = realY;
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const [offsetX, offsetY] = sampleDisplacement(prepared, idealX, idealY);
        idealX = realX - offsetX;
        idealY = realY - offsetY;
      }
      const sourceX = (idealX - extent.minXmm) / extent.widthMm * (image.width - 1);
      const sourceY = (extent.maxYmm - idealY) / extent.heightMm * (image.height - 1);
      sampleImageBilinear(image, sourceX, sourceY, out, (rasterY * image.width + rasterX) * 4);
    }
  }
  return { width: image.width, height: image.height, rgba: out };
}

function buildSparseKernel(size: number, data: Float32Array): ImageSimulationKernel['sparse'] {
  let peak = 0;
  for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Number(data[index]) || 0);
  const threshold = peak * 1e-7;
  const center = (size - 1) / 2;
  const sparse: ImageSimulationKernel['sparse'] = [];
  let sum = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const weight = Number(data[y * size + x]) || 0;
      if (!(weight > threshold)) continue;
      sparse.push({ dx: x - center, dy: y - center, weight });
      sum += weight;
    }
  }
  if (sum > 0) sparse.forEach((entry) => { entry.weight /= sum; });
  return sparse;
}

export function createIdentityImageSimulationKernel(size = 21): ImageSimulationKernel {
  const normalizedSize = Math.max(3, Math.floor(size) | 1);
  const data = new Float32Array(normalizedSize * normalizedSize);
  data[((normalizedSize - 1) / 2) * normalizedSize + (normalizedSize - 1) / 2] = 1;
  return { size: normalizedSize, data, sparse: buildSparseKernel(normalizedSize, data) };
}

type ImageSimulationPoint = { x: number; y: number };

function clipImageSimulationPolygon(
  polygon: ImageSimulationPoint[],
  axis: 'x' | 'y',
  boundary: number,
  keepGreater: boolean,
): ImageSimulationPoint[] {
  if (!polygon.length) return [];
  const out: ImageSimulationPoint[] = [];
  const isInside = (point: ImageSimulationPoint) => (
    keepGreater ? point[axis] >= boundary - 1e-12 : point[axis] <= boundary + 1e-12
  );
  let previous = polygon[polygon.length - 1];
  let previousInside = isInside(previous);
  for (const current of polygon) {
    const currentInside = isInside(current);
    if (currentInside !== previousInside) {
      const denominator = current[axis] - previous[axis];
      if (Math.abs(denominator) > 1e-15) {
        const t = (boundary - previous[axis]) / denominator;
        out.push({
          x: previous.x + (current.x - previous.x) * t,
          y: previous.y + (current.y - previous.y) * t,
        });
      }
    }
    if (currentInside) out.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return out;
}

function imageSimulationPolygonArea(polygon: ImageSimulationPoint[]): number {
  if (polygon.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function imageSimulationPolygonRectangleOverlapArea(
  polygon: ImageSimulationPoint[],
  left: number,
  right: number,
  top: number,
  bottom: number,
): number {
  let clipped = clipImageSimulationPolygon(polygon, 'x', left, true);
  clipped = clipImageSimulationPolygon(clipped, 'x', right, false);
  clipped = clipImageSimulationPolygon(clipped, 'y', top, true);
  clipped = clipImageSimulationPolygon(clipped, 'y', bottom, false);
  return imageSimulationPolygonArea(clipped);
}

export function resamplePsfToImageKernel(
  psfData: number[][],
  psfPixelSizeUm: number,
  imagePixelPitchXUm: number,
  imagePixelPitchYUm: number,
  requestedSize = 21,
  rotationDeg = 0,
): ImageSimulationKernel {
  const size = Math.max(3, Math.min(41, Math.floor(requestedSize) | 1));
  const data = new Float32Array(size * size);
  const rows = Array.isArray(psfData) ? psfData.length : 0;
  const columns = rows > 0 && Array.isArray(psfData[0]) ? psfData[0].length : 0;
  const sourcePitch = Number(psfPixelSizeUm);
  const targetPitchX = Number(imagePixelPitchXUm);
  const targetPitchY = Number(imagePixelPitchYUm);
  if (!(rows > 0 && columns > 0 && sourcePitch > 0 && targetPitchX > 0 && targetPitchY > 0)) {
    return createIdentityImageSimulationKernel(size);
  }
  // fftshift places the zero-frequency PSF sample at floor(N / 2), including
  // even FFT grids. Treat every sample as an energy-carrying cell and rebin by
  // exact overlap area. Point splatting would add a tent filter and turn the
  // centered sample of an even grid into an artificial 2x2 blur.
  const sourceCenterX = Math.floor(columns / 2);
  const sourceCenterY = Math.floor(rows / 2);
  const targetCenter = (size - 1) / 2;
  const radians = (Number(rotationDeg) || 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sourceHalfPitch = sourcePitch / 2;
  const sourceCellArea = sourcePitch * sourcePitch;
  for (let sourceY = 0; sourceY < rows; sourceY += 1) {
    for (let sourceX = 0; sourceX < columns; sourceX += 1) {
      const value = Math.max(0, Number(psfData[sourceY]?.[sourceX]) || 0);
      if (!(value > 0)) continue;
      const centerX = (sourceX - sourceCenterX) * sourcePitch;
      const centerY = (sourceY - sourceCenterY) * sourcePitch;
      const sourceCorners = [
        { x: centerX - sourceHalfPitch, y: centerY - sourceHalfPitch },
        { x: centerX + sourceHalfPitch, y: centerY - sourceHalfPitch },
        { x: centerX + sourceHalfPitch, y: centerY + sourceHalfPitch },
        { x: centerX - sourceHalfPitch, y: centerY + sourceHalfPitch },
      ];
      // rotationDeg follows the existing Cartesian convention (+Y is raster
      // up), expressed here in raster coordinates where +Y points down.
      const polygon = sourceCorners.map((point) => ({
        x: cos * point.x + sin * point.y,
        y: -sin * point.x + cos * point.y,
      }));
      const minX = Math.min(...polygon.map((point) => point.x));
      const maxX = Math.max(...polygon.map((point) => point.x));
      const minY = Math.min(...polygon.map((point) => point.y));
      const maxY = Math.max(...polygon.map((point) => point.y));
      const firstTargetX = Math.max(0, Math.ceil(minX / targetPitchX + targetCenter - 0.5 - 1e-12));
      const lastTargetX = Math.min(size - 1, Math.floor(maxX / targetPitchX + targetCenter + 0.5 + 1e-12));
      const firstTargetY = Math.max(0, Math.ceil(minY / targetPitchY + targetCenter - 0.5 - 1e-12));
      const lastTargetY = Math.min(size - 1, Math.floor(maxY / targetPitchY + targetCenter + 0.5 + 1e-12));
      for (let targetY = firstTargetY; targetY <= lastTargetY; targetY += 1) {
        const top = (targetY - targetCenter - 0.5) * targetPitchY;
        const bottom = top + targetPitchY;
        for (let targetX = firstTargetX; targetX <= lastTargetX; targetX += 1) {
          const left = (targetX - targetCenter - 0.5) * targetPitchX;
          const right = left + targetPitchX;
          const overlapArea = imageSimulationPolygonRectangleOverlapArea(polygon, left, right, top, bottom);
          if (overlapArea > 1e-15) data[targetY * size + targetX] += value * overlapArea / sourceCellArea;
        }
      }
    }
  }
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) sum += data[index];
  if (!(sum > 0)) return createIdentityImageSimulationKernel(size);
  for (let index = 0; index < data.length; index += 1) data[index] /= sum;
  return { size, data, sparse: buildSparseKernel(size, data) };
}

function blendFieldKernel(
  nodes: ImageSimulationFieldKernel[],
  xNorm: number,
  yNorm: number,
  channel: 'redKernel' | 'greenKernel' | 'blueKernel' | 'kernel' = 'kernel',
): ImageSimulationKernel {
  if (!nodes.length) return createIdentityImageSimulationKernel();
  const ranked = nodes
    .map((node) => ({ node, distance2: (node.xNorm - xNorm) ** 2 + (node.yNorm - yNorm) ** 2 }))
    .sort((left, right) => left.distance2 - right.distance2)
    .slice(0, Math.min(4, nodes.length));
  const kernelFor = (node: ImageSimulationFieldKernel) => node[channel] || node.kernel;
  if (ranked[0].distance2 <= 1e-14) return kernelFor(ranked[0].node);
  const size = kernelFor(ranked[0].node).size;
  const data = new Float32Array(size * size);
  let weightSum = 0;
  ranked.forEach(({ node, distance2 }) => {
    const sourceKernel = kernelFor(node);
    if (sourceKernel.size !== size) return;
    const weight = 1 / Math.max(1e-6, distance2);
    weightSum += weight;
    for (let index = 0; index < data.length; index += 1) data[index] += sourceKernel.data[index] * weight;
  });
  if (weightSum > 0) for (let index = 0; index < data.length; index += 1) data[index] /= weightSum;
  return { size, data, sparse: buildSparseKernel(size, data) };
}

const srgbToLinear = (value: number) => {
  const normalized = clamp(value / 255, 0, 1);
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
};

const linearToSrgbByte = (value: number) => {
  const clamped = clamp(value, 0, 1);
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(clamp(encoded, 0, 1) * 255);
};

export async function convolveImageSpatiallyVarying(
  image: ImageSimulationImage,
  fieldKernels: ImageSimulationFieldKernel[],
  options: {
    tileSize?: number;
    onProgress?: (percent: number, message: string) => void;
  } = {},
): Promise<ImageSimulationImage> {
  if (!fieldKernels.length) return { ...image, rgba: new Uint8ClampedArray(image.rgba) };
  const { width, height, rgba } = image;
  const pixelCount = width * height;
  const red = new Float32Array(pixelCount);
  const green = new Float32Array(pixelCount);
  const blue = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    red[index] = srgbToLinear(rgba[index * 4]);
    green[index] = srgbToLinear(rgba[index * 4 + 1]);
    blue[index] = srgbToLinear(rgba[index * 4 + 2]);
  }
  const out = new Uint8ClampedArray(pixelCount * 4);
  const tileSize = Math.max(16, Math.min(96, Math.floor(Number(options.tileSize) || 32)));
  const tileColumns = Math.ceil(width / tileSize);
  const tileRows = Math.ceil(height / tileSize);
  let completedTiles = 0;
  for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tileColumns; tileColumn += 1) {
      const xStart = tileColumn * tileSize;
      const yStart = tileRow * tileSize;
      const xEnd = Math.min(width, xStart + tileSize);
      const yEnd = Math.min(height, yStart + tileSize);
      const centerX = (xStart + xEnd - 1) / 2;
      const centerY = (yStart + yEnd - 1) / 2;
      const xNorm = width > 1 ? centerX / (width - 1) * 2 - 1 : 0;
      const yNorm = height > 1 ? 1 - centerY / (height - 1) * 2 : 0;
      const channelSpecific = fieldKernels.some((node) => node.redKernel || node.greenKernel || node.blueKernel);
      const scalarKernel = channelSpecific ? null : blendFieldKernel(fieldKernels, xNorm, yNorm, 'kernel');
      const redKernel = channelSpecific ? blendFieldKernel(fieldKernels, xNorm, yNorm, 'redKernel') : scalarKernel;
      const greenKernel = channelSpecific ? blendFieldKernel(fieldKernels, xNorm, yNorm, 'greenKernel') : scalarKernel;
      const blueKernel = channelSpecific ? blendFieldKernel(fieldKernels, xNorm, yNorm, 'blueKernel') : scalarKernel;
      const convolveChannel = (plane: Float32Array, x: number, y: number, kernel: ImageSimulationKernel) => {
        let sum = 0;
        for (const entry of kernel.sparse) {
          const sourceX = clamp(x - entry.dx, 0, width - 1);
          const sourceY = clamp(y - entry.dy, 0, height - 1);
          sum += plane[sourceY * width + sourceX] * entry.weight;
        }
        return sum;
      };
      for (let y = yStart; y < yEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) {
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          if (scalarKernel) {
            for (const entry of scalarKernel.sparse) {
              const sourceX = clamp(x - entry.dx, 0, width - 1);
              const sourceY = clamp(y - entry.dy, 0, height - 1);
              const sourceIndex = sourceY * width + sourceX;
              sumR += red[sourceIndex] * entry.weight;
              sumG += green[sourceIndex] * entry.weight;
              sumB += blue[sourceIndex] * entry.weight;
            }
          } else {
            sumR = convolveChannel(red, x, y, redKernel!);
            sumG = convolveChannel(green, x, y, greenKernel!);
            sumB = convolveChannel(blue, x, y, blueKernel!);
          }
          const destination = (y * width + x) * 4;
          out[destination] = linearToSrgbByte(sumR);
          out[destination + 1] = linearToSrgbByte(sumG);
          out[destination + 2] = linearToSrgbByte(sumB);
          out[destination + 3] = 255;
        }
      }
      completedTiles += 1;
    }
    options.onProgress?.(
      (completedTiles / Math.max(1, tileColumns * tileRows)) * 100,
      'Spatially varying PSF convolution ' + completedTiles + '/' + (tileColumns * tileRows),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { width, height, rgba: out };
}

export function combineImageSimulationSpectralLayers(
  layers: ImageSimulationSpectralLayer[],
): ImageSimulationImage {
  if (!layers.length) throw new Error('No spectral image layers were provided.');
  if (layers.length === 1) {
    const image = layers[0].image;
    return { ...image, rgba: new Uint8ClampedArray(image.rgba) };
  }
  const width = Math.min(...layers.map((layer) => layer.image.width));
  const height = Math.min(...layers.map((layer) => layer.image.height));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const channelWeights = [0, 0, 0];
  const scalarWeight = layers.reduce((sum, layer) => sum + Math.max(0, Number(layer.weight) || 0), 0);
  layers.forEach((layer) => {
    for (let channel = 0; channel < 3; channel += 1) {
      channelWeights[channel] += Math.max(0, Number(layer.weight) || 0) * Math.max(0, Number(layer.linearRgb[channel]) || 0);
    }
  });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const destination = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let normalization = channelWeights[channel];
        for (const layer of layers) {
          const source = (y * layer.image.width + x) * 4 + channel;
          const spectralWeight = Math.max(0, Number(layer.weight) || 0)
            * Math.max(0, Number(layer.linearRgb[channel]) || 0);
          sum += srgbToLinear(layer.image.rgba[source]) * spectralWeight;
        }
        if (!(normalization > 1e-12)) {
          normalization = scalarWeight;
          sum = layers.reduce((fallback, layer) => {
            const source = (y * layer.image.width + x) * 4 + channel;
            return fallback + srgbToLinear(layer.image.rgba[source]) * Math.max(0, Number(layer.weight) || 0);
          }, 0);
        }
        rgba[destination + channel] = linearToSrgbByte(normalization > 0 ? sum / normalization : 0);
      }
      rgba[destination + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export function calculateMaxLateralChromaticDisplacementUm(
  maps: ImageSimulationDistortionMap[],
): number {
  if (maps.length < 2) return 0;
  let maxSeparationMm = 0;
  const pointCount = Math.min(...maps.map((map) => Math.min(map.realX.length, map.realY.length)));
  for (let point = 0; point < pointCount; point += 1) {
    for (let first = 0; first < maps.length - 1; first += 1) {
      const firstX = Number(maps[first].realX[point]);
      const firstY = Number(maps[first].realY[point]);
      if (!Number.isFinite(firstX) || !Number.isFinite(firstY)) continue;
      for (let second = first + 1; second < maps.length; second += 1) {
        const secondX = Number(maps[second].realX[point]);
        const secondY = Number(maps[second].realY[point]);
        if (!Number.isFinite(secondX) || !Number.isFinite(secondY)) continue;
        maxSeparationMm = Math.max(maxSeparationMm, Math.hypot(secondX - firstX, secondY - firstY));
      }
    }
  }
  return maxSeparationMm * 1000;
}

export function createImageSimulationDifference(
  original: ImageSimulationImage,
  simulated: ImageSimulationImage,
  gain = 3,
): ImageSimulationImage {
  const width = Math.min(original.width, simulated.width);
  const height = Math.min(original.height, simulated.height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const originalOffset = (Math.floor(index / width) * original.width + (index % width)) * 4;
    const simulatedOffset = (Math.floor(index / width) * simulated.width + (index % width)) * 4;
    const destination = index * 4;
    rgba[destination] = clamp(Math.abs(original.rgba[originalOffset] - simulated.rgba[simulatedOffset]) * gain, 0, 255);
    rgba[destination + 1] = clamp(Math.abs(original.rgba[originalOffset + 1] - simulated.rgba[simulatedOffset + 1]) * gain, 0, 255);
    rgba[destination + 2] = clamp(Math.abs(original.rgba[originalOffset + 2] - simulated.rgba[simulatedOffset + 2]) * gain, 0, 255);
    rgba[destination + 3] = 255;
  }
  return { width, height, rgba };
}

export function calculateImageSimulationDifferencePercent(
  original: ImageSimulationImage,
  simulated: ImageSimulationImage,
): number {
  const width = Math.min(original.width, simulated.width);
  const height = Math.min(original.height, simulated.height);
  if (!(width > 0 && height > 0)) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const originalOffset = (y * original.width + x) * 4;
      const simulatedOffset = (y * simulated.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        sum += Math.abs(original.rgba[originalOffset + channel] - simulated.rgba[simulatedOffset + channel]);
        count += 1;
      }
    }
  }
  return count > 0 ? sum / count / 255 * 100 : 0;
}

export function resolveImageSimulationRasterExtent(
  fieldExtent: ImageSimulationPhysicalExtent,
  mode: ImageSimulationScaleMode,
  imageWidth: number,
  imageHeight: number,
  sensorWidthMm: number,
  sensorHeightMm: number,
  pixelPitchUm: number,
): ImageSimulationPhysicalExtent {
  if (mode === 'field-fit') return { ...fieldExtent };
  const widthPixels = Math.max(1, Math.floor(Number(imageWidth) || 1));
  const heightPixels = Math.max(1, Math.floor(Number(imageHeight) || 1));
  let widthMm: number;
  let heightMm: number;
  if (mode === 'sensor-width') {
    widthMm = Math.abs(Number(sensorWidthMm));
    if (!(Number.isFinite(widthMm) && widthMm > 1e-9)) {
      throw new Error('Sensor width must be greater than zero.');
    }
    heightMm = Math.abs(Number(sensorHeightMm));
    if (!(Number.isFinite(heightMm) && heightMm > 1e-9)) {
      throw new Error('Sensor height must be greater than zero.');
    }
  } else {
    const pitchUm = Math.abs(Number(pixelPitchUm));
    if (!(Number.isFinite(pitchUm) && pitchUm > 1e-9)) {
      throw new Error('Pixel pitch must be greater than zero.');
    }
    widthMm = pitchUm * widthPixels / 1000;
    heightMm = pitchUm * heightPixels / 1000;
  }
  const centerXmm = (fieldExtent.minXmm + fieldExtent.maxXmm) / 2;
  const centerYmm = (fieldExtent.minYmm + fieldExtent.maxYmm) / 2;
  return {
    minXmm: centerXmm - widthMm / 2,
    maxXmm: centerXmm + widthMm / 2,
    minYmm: centerYmm - heightMm / 2,
    maxYmm: centerYmm + heightMm / 2,
    widthMm,
    heightMm,
  };
}
