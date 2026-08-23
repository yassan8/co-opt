function compactIdealLensToken(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function parseIdealThinLensFocalLength(value: unknown): number {
  const token = String(value ?? '').trim();
  if (!token || /^inf(inity)?$/i.test(token)) return Number.POSITIVE_INFINITY;
  const numeric = Number(token);
  return Number.isFinite(numeric) && Math.abs(numeric) >= 1e-12
    ? numeric
    : Number.POSITIVE_INFINITY;
}

export function isIdealThinLensRow(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  const blockType = compactIdealLensToken(row?._blockType ?? row?.blockType ?? row?.block_type ?? row?.blockTypeName);
  const surfaceType = compactIdealLensToken(row?.surfType ?? row?.['surf type'] ?? row?.surfaceType);
  return row?._idealThinLens === true
    || blockType === 'paraxial'
    || blockType === 'thinlens'
    || surfaceType === 'thinlens'
    || Object.prototype.hasOwnProperty.call(row, '_thinLensFocalLengthX')
    || Object.prototype.hasOwnProperty.call(row, '_thinLensFocalLengthY');
}

export function isIdealThinLensBackRow(row: any): boolean {
  if (!isIdealThinLensRow(row)) return false;
  return compactIdealLensToken(row?._surfaceRole ?? row?.surfaceRole) === 'back';
}

export function getIdealThinLensFocalPair(row: any): { fx: number; fy: number } {
  return {
    fx: parseIdealThinLensFocalLength(
      row?._thinLensFocalLengthX ?? row?.focalLengthX ?? row?.focalLength
      ?? row?._thinLensFocalLengthY ?? row?.focalLengthY,
    ),
    fy: parseIdealThinLensFocalLength(
      row?._thinLensFocalLengthY ?? row?.focalLengthY ?? row?.focalLength
      ?? row?._thinLensFocalLengthX ?? row?.focalLengthX,
    ),
  };
}

export function isAnamorphicIdealThinLensRow(row: any): boolean {
  if (!isIdealThinLensRow(row) || isIdealThinLensBackRow(row)) return false;
  const { fx, fy } = getIdealThinLensFocalPair(row);
  if (Number.isFinite(fx) !== Number.isFinite(fy)) return true;
  if (!Number.isFinite(fx) && !Number.isFinite(fy)) return false;
  const scale = Math.max(1, Math.abs(fx), Math.abs(fy));
  return Math.abs(fx - fy) > 1e-9 * scale;
}

export function hasAnamorphicIdealThinLens(opticalSystemRows: any[] = []): boolean {
  return Array.isArray(opticalSystemRows) && opticalSystemRows.some(isAnamorphicIdealThinLensRow);
}

export function hasUnpoweredIdealThinLensAxis(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows)) return false;
  return opticalSystemRows.some((row) => {
    if (!isIdealThinLensRow(row) || isIdealThinLensBackRow(row)) return false;
    const { fx, fy } = getIdealThinLensFocalPair(row);
    return Number.isFinite(fx) !== Number.isFinite(fy);
  });
}

export function hasIdealThinLens(opticalSystemRows: any[] = []): boolean {
  return Array.isArray(opticalSystemRows) && opticalSystemRows.some(isIdealThinLensRow);
}

export function isIdealThinLensOnlySystem(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;

  let hasIdealLens = false;
  for (const row of opticalSystemRows) {
    if (!row || typeof row !== 'object') continue;
    if (isIdealThinLensRow(row)) {
      hasIdealLens = true;
      continue;
    }

    const objectType = compactIdealLensToken(row?.['object type'] ?? row?.objectType ?? row?.object ?? row?.Object);
    const surfaceType = compactIdealLensToken(row?.surfType ?? row?.['surf type'] ?? row?.surfaceType ?? row?.type);
    const blockType = compactIdealLensToken(row?._blockType ?? row?.blockType);
    const kind = compactIdealLensToken(row?.kind);
    const isPassive = objectType === 'object'
      || objectType === 'image'
      || objectType === 'stop'
      || surfaceType === 'stop'
      || surfaceType === 'gap'
      || surfaceType === 'airgap'
      || blockType === 'gap'
      || blockType === 'airgap'
      || surfaceType === 'coordinatebreak'
      || surfaceType === 'coordbrk'
      || surfaceType === 'coordtrans'
      || blockType === 'coordinatebreak'
      || blockType === 'coordbrk'
      || blockType === 'coordtrans'
      || kind === 'gap'
      || kind === 'airgap';
    if (isPassive) continue;

    // A normal refractive/mirror surface commonly has an empty object-type.
    // It must not be mistaken for a passive row, otherwise a mixed real-lens
    // system is incorrectly replaced by a diffraction-limited ideal system.
    return false;
  }

  return hasIdealLens;
}

export function isRotationallySymmetricIdealThinLensOnlySystem(opticalSystemRows: any[] = []): boolean {
  return isIdealThinLensOnlySystem(opticalSystemRows)
    && !opticalSystemRows.some(isAnamorphicIdealThinLensRow);
}
