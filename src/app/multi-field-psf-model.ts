import { PSFPlotter } from '../../evaluation/psf/psf-plot.ts';

export const MULTI_FIELD_PSF_GRID_PRESETS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 19, 21, 25, 31] as const;

export type MultiFieldPsfPositionMode = 'angle' | 'height' | 'imageheight';
export type MultiFieldPsfShape = 'ellipse' | 'rectangle';

export type MultiFieldPsfGridPoint = {
  key: string;
  row: number;
  column: number;
  x: number;
  y: number;
  inside: boolean;
};

export type MultiFieldPsfFieldDefinition = {
  mode: MultiFieldPsfPositionMode;
  unit: 'deg' | 'mm';
  maxX: number;
  maxY: number;
};

export type MultiFieldPsfImage = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  intensityCenter?: {
    x: number;
    y: number;
  };
};

export function getMultiFieldPsfCenteringOffset(
  image: MultiFieldPsfImage,
  renderedWidth: number,
  renderedHeight = renderedWidth,
): { x: number; y: number } {
  const width = Math.max(0, Math.floor(Number(image?.width) || 0));
  const height = Math.max(0, Math.floor(Number(image?.height) || 0));
  if (!(width > 0 && height > 0)) return { x: 0, y: 0 };
  const geometricCenterX = (width - 1) / 2;
  const geometricCenterY = (height - 1) / 2;
  const intensityCenterX = Number(image?.intensityCenter?.x);
  const intensityCenterY = Number(image?.intensityCenter?.y);
  return {
    x: Number.isFinite(intensityCenterX)
      ? (geometricCenterX - intensityCenterX) * (Math.max(0, Number(renderedWidth) || 0) / width)
      : 0,
    y: Number.isFinite(intensityCenterY)
      ? (geometricCenterY - intensityCenterY) * (Math.max(0, Number(renderedHeight) || 0) / height)
      : 0,
  };
}

export function getMultiFieldPsfFieldAzimuthDeg(
  point: Pick<MultiFieldPsfGridPoint, 'x' | 'y'>,
  mode: MultiFieldPsfPositionMode,
): number {
  const x = Number(point?.x) || 0;
  const y = Number(point?.y) || 0;
  if (Math.hypot(x, y) <= 1e-12) return 0;
  if (mode === 'angle') {
    const angleX = x * Math.PI / 180;
    const angleY = y * Math.PI / 180;
    const directionX = Math.sin(angleX) * Math.cos(angleY);
    const directionY = Math.sin(angleY) * Math.cos(angleX);
    return Math.atan2(directionY, directionX) * 180 / Math.PI;
  }
  return Math.atan2(y, x) * 180 / Math.PI;
}

/**
 * Native infinite-field OPD uses a local transverse basis where local X is
 * sagittal and local -Y is radial. Rotate that local PSF into global image X/Y.
 */
export function getMultiFieldPsfLocalToGlobalRotationDeg(
  point: Pick<MultiFieldPsfGridPoint, 'x' | 'y'>,
  mode: MultiFieldPsfPositionMode,
): number {
  if (mode === 'height' || Math.hypot(Number(point?.x) || 0, Number(point?.y) || 0) <= 1e-12) return 0;
  const rotation = getMultiFieldPsfFieldAzimuthDeg(point, mode) + 90;
  return ((rotation + 180) % 360 + 360) % 360 - 180;
}

export function rotateMultiFieldPsfImageCartesian(
  image: MultiFieldPsfImage,
  rotationDeg: number,
): MultiFieldPsfImage {
  const width = Math.max(0, Math.floor(Number(image?.width) || 0));
  const height = Math.max(0, Math.floor(Number(image?.height) || 0));
  if (!(width > 0 && height > 0) || image.rgba.length < width * height * 4) return image;
  const normalizedRotation = ((Number(rotationDeg) % 360) + 360) % 360;
  if (normalizedRotation <= 1e-10 || Math.abs(normalizedRotation - 360) <= 1e-10) return image;

  const radians = normalizedRotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let rasterY = 0; rasterY < height; rasterY += 1) {
    for (let rasterX = 0; rasterX < width; rasterX += 1) {
      const globalX = rasterX - centerX;
      const globalY = centerY - rasterY;
      const localX = cos * globalX + sin * globalY;
      const localY = -sin * globalX + cos * globalY;
      const sourceX = centerX + localX;
      const sourceY = centerY - localY;
      const destinationOffset = (rasterY * width + rasterX) * 4;
      out[destinationOffset + 3] = 255;
      if (sourceX < 0 || sourceY < 0 || sourceX > width - 1 || sourceY > height - 1) continue;

      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const tx = sourceX - x0;
      const ty = sourceY - y0;
      for (let channel = 0; channel < 3; channel += 1) {
        const v00 = image.rgba[(y0 * width + x0) * 4 + channel] || 0;
        const v10 = image.rgba[(y0 * width + x1) * 4 + channel] || 0;
        const v01 = image.rgba[(y1 * width + x0) * 4 + channel] || 0;
        const v11 = image.rgba[(y1 * width + x1) * 4 + channel] || 0;
        const top = v00 * (1 - tx) + v10 * tx;
        const bottom = v01 * (1 - tx) + v11 * tx;
        out[destinationOffset + channel] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  const sourceIntensityCenterX = Number(image?.intensityCenter?.x);
  const sourceIntensityCenterY = Number(image?.intensityCenter?.y);
  let intensityCenter: MultiFieldPsfImage['intensityCenter'];
  if (Number.isFinite(sourceIntensityCenterX) && Number.isFinite(sourceIntensityCenterY)) {
    const localX = sourceIntensityCenterX - centerX;
    const localY = centerY - sourceIntensityCenterY;
    const globalX = cos * localX - sin * localY;
    const globalY = sin * localX + cos * localY;
    intensityCenter = {
      x: centerX + globalX,
      y: centerY - globalY,
    };
  }
  return { width, height, rgba: out, intensityCenter };
}

function firstFinite(values: unknown[], fallback = 0): number {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

export function detectMultiFieldPsfPositionMode(objectRows: any[]): MultiFieldPsfPositionMode {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.some((row) => String(row?.__cooptOriginalPosition ?? row?.position ?? row?.type ?? '').toLowerCase().includes('imageheight'))) {
    return 'imageheight';
  }
  if (rows.some((row) => {
    const position = String(row?.position ?? row?.object ?? row?.type ?? '').toLowerCase();
    return position.includes('angle') || position === 'point';
  })) return 'angle';
  return 'height';
}

export function readMultiFieldPsfCoordinates(row: any, mode: MultiFieldPsfPositionMode): { x: number; y: number } {
  if (mode === 'height') {
    return {
      x: firstFinite([row?.xHeight, row?.x, row?.xHeightAngle, row?.xFieldAngle], 0),
      y: firstFinite([row?.yHeight, row?.y, row?.height, row?.yHeightAngle, row?.yFieldAngle], 0),
    };
  }
  return {
    x: firstFinite([row?.xHeightAngle, row?.xFieldAngle, row?.xAngle, row?.xHeight, row?.x], 0),
    y: firstFinite([row?.yHeightAngle, row?.yFieldAngle, row?.fieldAngle, row?.yAngle, row?.yHeight, row?.y], 0),
  };
}

export function deriveMultiFieldPsfFieldDefinition(objectRows: any[]): MultiFieldPsfFieldDefinition {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  const mode = detectMultiFieldPsfPositionMode(rows);
  let maxX = 0;
  let maxY = 0;
  rows.forEach((row) => {
    const point = readMultiFieldPsfCoordinates(row, mode);
    maxX = Math.max(maxX, Math.abs(point.x));
    maxY = Math.max(maxY, Math.abs(point.y));
  });
  if (!(maxX > 0) && maxY > 0) maxX = maxY;
  if (!(maxY > 0) && maxX > 0) maxY = maxX;
  if (!(maxX > 0)) maxX = 1;
  if (!(maxY > 0)) maxY = 1;
  return { mode, unit: mode === 'angle' ? 'deg' : 'mm', maxX, maxY };
}

export function buildMultiFieldPsfGrid(options: {
  rows: number;
  columns: number;
  maxX: number;
  maxY: number;
  shape: MultiFieldPsfShape;
}): MultiFieldPsfGridPoint[] {
  const rows = Math.max(1, Math.min(31, Math.floor(Number(options.rows) || 1)));
  const columns = Math.max(1, Math.min(31, Math.floor(Number(options.columns) || 1)));
  const maxX = Math.max(0, Math.abs(Number(options.maxX) || 0));
  const maxY = Math.max(0, Math.abs(Number(options.maxY) || 0));
  const points: MultiFieldPsfGridPoint[] = [];
  for (let row = 0; row < rows; row += 1) {
    const normalizedY = rows <= 1 ? 0 : 1 - (2 * row) / (rows - 1);
    for (let column = 0; column < columns; column += 1) {
      const normalizedX = columns <= 1 ? 0 : -1 + (2 * column) / (columns - 1);
      const inside = options.shape === 'rectangle' || normalizedX * normalizedX + normalizedY * normalizedY <= 1 + 1e-10;
      points.push({
        key: `${row}:${column}`,
        row,
        column,
        x: normalizedX * maxX,
        y: normalizedY * maxY,
        inside,
      });
    }
  }
  return points;
}

export function buildMultiFieldPsfObjectRow(
  objectRows: any[],
  point: Pick<MultiFieldPsfGridPoint, 'x' | 'y'>,
  mode: MultiFieldPsfPositionMode,
): any {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  let template = rows[0] || {};
  let nearestDistance = Number.POSITIVE_INFINITY;
  rows.forEach((row) => {
    const existing = readMultiFieldPsfCoordinates(row, mode);
    const distance = Math.hypot(existing.x - point.x, existing.y - point.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      template = row;
    }
  });

  const next = { ...(template && typeof template === 'object' ? template : {}) };
  next.x = point.x;
  next.y = point.y;
  next.xHeight = point.x;
  next.yHeight = point.y;
  next.xHeightAngle = point.x;
  next.yHeightAngle = point.y;
  next.xFieldAngle = point.x;
  next.yFieldAngle = point.y;
  if (mode === 'angle') {
    next.position = 'Angle';
  } else if (mode === 'imageheight') {
    next.position = 'ImageHeight';
    next.__cooptOriginalPosition = 'ImageHeight';
  } else {
    next.position = String(next.position || '').toLowerCase().includes('rectangle') ? next.position : 'Rectangle';
  }
  next.comment = `Field (${point.x.toFixed(6)}, ${point.y.toFixed(6)})`;
  return next;
}

export function calculateMultiFieldPsfOpdRmsUm(gridOpd: any[][], pupilMask: any[][]): number {
  const values: number[] = [];
  for (let y = 0; y < (Array.isArray(gridOpd) ? gridOpd.length : 0); y += 1) {
    const row = gridOpd[y] || [];
    for (let x = 0; x < row.length; x += 1) {
      if (!pupilMask?.[y]?.[x]) continue;
      const value = Number(row[x]);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (!values.length) return Number.NaN;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function pseudoColor(value: number): [number, number, number] {
  const normalized = Math.max(0, Math.min(1, value));
  if (normalized <= 0.5) {
    const t = normalized * 2;
    return [0, Math.round(255 * t), Math.round(255 * (1 - t))];
  }
  const t = (normalized - 0.5) * 2;
  return [Math.round(255 * t), Math.round(255 * (1 - t)), 0];
}

export function prepareMultiFieldPsfImage(
  psfData: any[][],
  trueColorData: any,
  colorMode: 'pseudo' | 'true' | 'false',
  logScale: boolean,
): MultiFieldPsfImage | null {
  const scalar = Array.isArray(psfData) ? psfData : [];
  const height = scalar.length;
  const width = height > 0 && Array.isArray(scalar[0]) ? scalar[0].length : 0;
  if (!(height > 0 && width > 0)) return null;

  let peak = 0;
  scalar.forEach((row) => row.forEach((value) => { peak = Math.max(peak, Math.max(0, Number(value) || 0)); }));
  const centroidThreshold = peak * 0.3;
  let centroidWeight = 0;
  let centroidX = 0;
  let centroidY = 0;
  if (peak > 0) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = Math.max(0, Number(scalar[y]?.[x]) || 0);
        if (value < centroidThreshold) continue;
        centroidWeight += value;
        centroidX += x * value;
        centroidY += (height - 1 - y) * value;
      }
    }
  }
  const intensityCenter = centroidWeight > 0
    ? { x: centroidX / centroidWeight, y: centroidY / centroidWeight }
    : { x: (width - 1) / 2, y: (height - 1) / 2 };

  const rgba = new Uint8ClampedArray(width * height * 4);
  if (colorMode !== 'pseudo') {
    const rgbRows = PSFPlotter.prepareTrueColorImageData(trueColorData, logScale);
    if (!Array.isArray(rgbRows) || !rgbRows.length) return null;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = rgbRows[y]?.[x] || [0, 0, 0];
        // PSF rows increase with Cartesian +Y, while raster rows increase
        // down the screen. Flip only Y for display; never transpose X/Y.
        const rasterY = height - 1 - y;
        const offset = (rasterY * width + x) * 4;
        rgba[offset] = Number(pixel[0]) || 0;
        rgba[offset + 1] = Number(pixel[1]) || 0;
        rgba[offset + 2] = Number(pixel[2]) || 0;
        rgba[offset + 3] = 255;
      }
    }
    return { width, height, rgba, intensityCenter };
  }

  if (!(peak > 0)) peak = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = Math.max(0, Number(scalar[y]?.[x]) || 0) / peak;
      if (logScale) value = Math.log1p(1000 * value) / Math.log1p(1000);
      const rgb = pseudoColor(value);
      const rasterY = height - 1 - y;
      const offset = (rasterY * width + x) * 4;
      rgba[offset] = rgb[0];
      rgba[offset + 1] = rgb[1];
      rgba[offset + 2] = rgb[2];
      rgba[offset + 3] = 255;
    }
  }
  return { width, height, rgba, intensityCenter };
}
