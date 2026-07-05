// Zemax OpticStudio ZMX import (minimal subset)
// - Accepts UTF-16LE/BE (BOM) and UTF-8
// - Supports: STANDARD-like, EVENASPH (TYPE EVENASPH + CONI + PARM), COORDBRK
// - Detects unsupported: Aspheric odd

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function parseNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^inf(inity)?$/i.test(s)) return Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function invertCurvatureToRadius(curv) {
  if (!Number.isFinite(curv) || curv === 0) return 'INF';
  const raw = 1 / curv;
  if (!Number.isFinite(raw) || Math.abs(raw) < 1e-12) return 'INF';

  // Avoid storing binary floating-point tails (e.g. 144.296000000000006).
  // We try to find a rounded decimal radius that round-trips back to the given
  // curvature within a tight tolerance.
  const relTol = 1e-12;
  const absTol = 1e-12;
  const maxDecimals = 12;

  for (let decimals = 0; decimals <= maxDecimals; decimals++) {
    const snapped = Number(raw.toFixed(decimals));
    if (!Number.isFinite(snapped) || Math.abs(snapped) < 1e-12) continue;
    const back = 1 / snapped;
    if (!Number.isFinite(back)) continue;
    const tol = Math.max(absTol, relTol * Math.max(1, Math.abs(curv)));
    if (Math.abs(back - curv) <= tol) return snapped;
  }

  return raw;
}

function normalizeImportedMaterialName(material) {
  const s = String(material ?? '').trim();
  if (s === '') return '';
  const up = s.toUpperCase();
  if (up === 'AIR' || up === 'VACUUM') return '';

  // co-opt glass catalog includes some Ohara names with a space before a trailing single digit
  // (e.g. "S-TIH 6", "S-TIM 8", "L-BSL 7"). co-opt exports whitespace-free names to match Zemax,
  // so on import, restore that space for common cases.
  if (!/\s/.test(s) && /^(S|L)-[A-Z]{3,}\d$/i.test(s)) {
    return s.replace(/^([A-Z]-[A-Z]{3,})(\d)$/i, '$1 $2');
  }

  return s;
}

function normalizeCoordReturnMode(rawValue) {
  const s = String(rawValue ?? '').trim().toLowerCase();
  if (s === '' || s === '0' || s === 'none' || s === 'off') return 'none';
  if (s === '1' || s === 'orientation' || s === 'orientationonly' || s === 'orient') return 'orientation';
  if (s === '2' || s === 'orientationxy' || s === 'xy') return 'xy';
  if (s === '3' || s === 'orientationxyz' || s === 'xyz' || s === 'on') return 'xyz';
  return 'none';
}

function decodeZmxArrayBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);

  const decodeUtf16Fallback = (isLittleEndian) => {
    try {
      const start = (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) ? 2 : 0;
      let out = '';
      for (let i = start; i + 1 < bytes.length; i += 2) {
        const code = isLittleEndian
          ? (bytes[i] | (bytes[i + 1] << 8))
          : ((bytes[i] << 8) | bytes[i + 1]);
        out += String.fromCharCode(code);
      }
      return out;
    } catch (_) {
      return '';
    }
  };

  if (bytes.length >= 2) {
    // UTF-16LE BOM
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      try {
        return new TextDecoder('utf-16le').decode(bytes);
      } catch (_) {
        const fallback = decodeUtf16Fallback(true);
        if (fallback) return fallback;
      }
    }
    // UTF-16BE BOM
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      try {
        return new TextDecoder('utf-16be').decode(bytes);
      } catch (_) {
        const fallback = decodeUtf16Fallback(false);
        if (fallback) return fallback;
      }
    }
  }

  // Heuristic (no BOM): detect UTF-16 by NUL bytes pattern.
  const sampleLen = Math.min(bytes.length, 4096);
  let zerosEven = 0;
  let zerosOdd = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) zerosEven++;
      else zerosOdd++;
    }
  }
  const zeroRatio = (zerosEven + zerosOdd) / Math.max(1, sampleLen);
  if (zeroRatio > 0.2 && sampleLen >= 8) {
    // Many NULs: likely UTF-16.
    if (zerosOdd > zerosEven) {
      try {
        return new TextDecoder('utf-16le').decode(bytes);
      } catch (_) {
        const fallback = decodeUtf16Fallback(true);
        if (fallback) return fallback;
      }
    } else {
      try {
        return new TextDecoder('utf-16be').decode(bytes);
      } catch (_) {
        const fallback = decodeUtf16Fallback(false);
        if (fallback) return fallback;
      }
    }
  }

  // Default: UTF-8
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (_) {
    // Very old environments: fallback via latin1-ish mapping
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

function tokenizeZmxLine(line) {
  // Split by whitespace, but keep "..." as one token.
  const out = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '"') {
      i++;
      let start = i;
      while (i < s.length && s[i] !== '"') i++;
      out.push(s.slice(start, i));
      if (i < s.length && s[i] === '"') i++;
      continue;
    }

    let start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    out.push(s.slice(start, i));
  }
  return out;
}

function makeEmptyRow(id) {
  const row = {
    id,
    'object type': '',
    comment: '',
    surfType: 'Spherical',
    radius: '',
    thickness: '',
    semidia: '',
    material: '',
    conic: 0
  };
  for (let j = 1; j <= 10; j++) row[`coef${j}`] = 0;
  return row;
}

function ensureRow(rows, idx) {
  while (rows.length <= idx) rows.push(makeEmptyRow(rows.length));
  if (!rows[idx]) rows[idx] = makeEmptyRow(idx);
  rows[idx].id = idx;
  return rows[idx];
}

function markDefaultsForObjectAndImage(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (!rows[0]) rows[0] = makeEmptyRow(0);
  rows[0].id = 0;
  if (!rows[0]['object type']) rows[0]['object type'] = 'Object';

  const last = rows.length - 1;
  if (!rows[last]) rows[last] = makeEmptyRow(last);
  rows[last].id = last;
  if (!rows[last]['object type']) rows[last]['object type'] = 'Image';
}

export function parseZMXTextToOpticalSystemRows(zmxText, options = {}) {
  const text = String(zmxText ?? '');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const rows = [];
  const issues = [];

  // System-level data (optional)
  /** @type {Map<number, {wavelength:number, weight:number}>} */
  const wavelengthsByIndex = new Map();
  /** @type {number[]} */
  const wavelengthsList = [];
  /** @type {number[]} */
  const wavelengthWeightsList = [];
  let primaryWavelengthIndex = null;
  /** @type {number[]} */
  let fieldXs = [];
  /** @type {number[]} */
  let fieldYs = [];
  /** @type {number[]} */
  let fieldWs = [];
  /** @type {'Angle'|'Rectangle'} */
  let fieldPosition = 'Rectangle';
  /** @type {null|'Angle'|'Rectangle'} */
  let fieldPositionFromFTYP = null;
  let entrancePupilDiameterMm = null;
  /** @type {null|number} */
  let otxPrimaryWavelengthIndex = null;
  /** @type {null|'XFLN'|'YFLN'|'WWGT'|'FWGT'} */
  let lastSystemListKey = null;

  let currentSurf = null;

  const addIssue = (severity, message) => {
    issues.push({ severity, message });
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    const line = String(raw ?? '').trim();
    if (line === '') continue;

    const tokens = tokenizeZmxLine(line);
    if (tokens.length === 0) continue;

    if (currentSurf === null && lastSystemListKey) {
      const firstAsNumber = parseNumberOrNull(tokens[0]);
      if (firstAsNumber !== null && Number.isFinite(firstAsNumber)) {
        const continuationValues = tokens
          .map((token) => parseNumberOrNull(token))
          .filter((value) => value !== null && Number.isFinite(value));
        if (continuationValues.length > 0) {
          if (lastSystemListKey === 'XFLN') fieldXs = [...fieldXs, ...continuationValues];
          if (lastSystemListKey === 'YFLN') fieldYs = [...fieldYs, ...continuationValues];
          if (lastSystemListKey === 'WWGT' || lastSystemListKey === 'FWGT') fieldWs = [...fieldWs, ...continuationValues];
          continue;
        }
      }
    }

    const key = String(tokens[0] ?? '').toUpperCase();

    if (!['XFLN', 'YFLN', 'WWGT', 'FWGT'].includes(key)) {
      lastSystemListKey = null;
    }

    // --- Global / system-level records ---
    if (key === 'WAVM') {
      // WAVM <index> <wavelength_um> <weight>
      const idx = parseNumberOrNull(tokens[1]);
      const wl = parseNumberOrNull(tokens[2]);
      const wt = parseNumberOrNull(tokens[3]);
      const ii = (idx !== null && Number.isFinite(idx)) ? Math.trunc(idx) : null;
      if (!ii || ii <= 0 || wl === null || !Number.isFinite(wl) || wl <= 0) {
        addIssue('warning', `Invalid WAVM at line ${lineNo + 1}: ${line}`);
        continue;
      }
      wavelengthsByIndex.set(ii, {
        wavelength: wl,
        weight: (wt !== null && Number.isFinite(wt)) ? wt : 1
      });
      continue;
    }

    if (key === 'WAVL' || key === 'WL') {
      // WAVL <wl1> <wl2> ... (Zemax list form)
      for (let k = 1; k < tokens.length; k++) {
        const wl = parseNumberOrNull(tokens[k]);
        if (wl === null || !Number.isFinite(wl) || wl <= 0) continue;
        wavelengthsList.push(wl);
      }
      continue;
    }

    if (key === 'WWGT' || key === 'WTW') {
      // WWGT <w1> <w2> ... (weights list form)
      for (let k = 1; k < tokens.length; k++) {
        const w = parseNumberOrNull(tokens[k]);
        if (w === null || !Number.isFinite(w)) continue;
        wavelengthWeightsList.push(w);
      }
      continue;
    }

    if (key === 'PWAV') {
      const idx = parseNumberOrNull(tokens[1]);
      const ii = (idx !== null && Number.isFinite(idx)) ? Math.trunc(idx) : null;
      if (!ii || ii <= 0) {
        addIssue('warning', `Invalid PWAV at line ${lineNo + 1}: ${line}`);
        continue;
      }
      primaryWavelengthIndex = ii;
      continue;
    }

    if (key === 'REF') {
      const idx = parseNumberOrNull(tokens[1]);
      const ii = (idx !== null && Number.isFinite(idx)) ? Math.trunc(idx) : null;
      if (ii && ii > 0) otxPrimaryWavelengthIndex = ii;
      continue;
    }

    if (key === 'ENPD') {
      const v = parseNumberOrNull(tokens[1]);
      if (v !== null && Number.isFinite(v) && v > 0) entrancePupilDiameterMm = v;
      continue;
    }

    if (key === 'FTYP') {
      // Minimal handling: co-opt export uses Angle field type.
      // We treat token[3] == 2 as Angle (matches our exporter: `FTYP 0 0 2 3 0 0 0 2`).
      const t3 = parseNumberOrNull(tokens[3]);
      if (t3 !== null && Number.isFinite(t3) && Math.trunc(t3) === 2) {
        fieldPosition = 'Angle';
        fieldPositionFromFTYP = 'Angle';
      } else {
        // OpTaliX uses FTYP 4 for angle fields in many exported files.
        const t1 = parseNumberOrNull(tokens[1]);
        if ((t1 !== null && Math.trunc(t1) === 4) || (t3 !== null && Math.trunc(t3) === 4)) {
          fieldPosition = 'Angle';
          fieldPositionFromFTYP = 'Angle';
        }
      }
      continue;
    }

    // Zemax may store fields as list lines ("XFLN x1 x2 ...") or index lines ("XFLN <i> <x>")
    const parseFieldList = (toks) => {
      const out = [];
      for (let k = 1; k < toks.length; k++) {
        const n = parseNumberOrNull(toks[k]);
        if (n === null || !Number.isFinite(n)) continue;
        out.push(n);
      }
      return out;
    };
    const parseFieldIndexed = (toks) => {
      const idx = parseNumberOrNull(toks[1]);
      const val = parseNumberOrNull(toks[2]);
      if (idx === null || val === null || !Number.isFinite(idx) || !Number.isFinite(val)) return null;
      const ii = Math.trunc(idx);
      if (ii <= 0) return null;
      return { index: ii, value: val };
    };

    if (key === 'XFLN') {
      lastSystemListKey = 'XFLN';
      if (tokens.length === 3) {
        const p = parseFieldIndexed(tokens);
        if (p) {
          const need = Math.max(fieldXs.length, p.index);
          while (fieldXs.length < need) fieldXs.push(0);
          fieldXs[p.index - 1] = p.value;
          continue;
        }
      }
      const list = parseFieldList(tokens);
      if (list.length > 0) fieldXs = list;
      continue;
    }

    if (key === 'YFLN') {
      lastSystemListKey = 'YFLN';
      if (tokens.length === 3) {
        const p = parseFieldIndexed(tokens);
        if (p) {
          const need = Math.max(fieldYs.length, p.index);
          while (fieldYs.length < need) fieldYs.push(0);
          fieldYs[p.index - 1] = p.value;
          continue;
        }
      }
      const list = parseFieldList(tokens);
      if (list.length > 0) fieldYs = list;
      continue;
    }

    if (key === 'FLD') {
      const id1 = parseNumberOrNull(tokens[1]);
      const x = parseNumberOrNull(tokens[2]);
      const y = parseNumberOrNull(tokens[3]);
      if (id1 === null || x === null || y === null) continue;
      const oneBased = Math.max(1, Math.trunc(id1));
      while (fieldXs.length < oneBased) fieldXs.push(0);
      while (fieldYs.length < oneBased) fieldYs.push(0);
      fieldXs[oneBased - 1] = x;
      fieldYs[oneBased - 1] = y;
      continue;
    }

    if (key === 'FWGN') {
      if (tokens.length === 3) {
        const p = parseFieldIndexed(tokens);
        if (p) {
          const need = Math.max(fieldWs.length, p.index);
          while (fieldWs.length < need) fieldWs.push(0);
          fieldWs[p.index - 1] = p.value;
          continue;
        }
      }
      const list = parseFieldList(tokens);
      if (list.length > 0) fieldWs = list;
      continue;
    }

    if (key === 'WWGT' || key === 'FWGT') {
      lastSystemListKey = key;
      const list = parseFieldList(tokens);
      if (list.length > 0) fieldWs = [...fieldWs, ...list];
      continue;
    }

    if (key === 'SURF' || key === 'SUR') {
      const idx = parseNumberOrNull(tokens[1]);
      if (idx === null || !Number.isFinite(idx) || idx < 0) {
        addIssue('warning', `Invalid SURF/SUR index at line ${lineNo + 1}: ${line}`);
        currentSurf = null;
        continue;
      }
      currentSurf = Math.trunc(idx);
      ensureRow(rows, currentSurf);
      continue;
    }

    // Most records apply to a surface, but some are global (UNIT/NAME/NOTE/etc).
    // If we see a surface record without a SURF header, we treat it as a warning.
    const needsSurf = new Set(['STOP', 'STO', 'CURV', 'CUY', 'DISZ', 'THI', 'GLAS', 'GLA', 'DIAM', 'APE', 'CLAP', 'TYPE', 'SUT', 'CONI', 'PARM', 'XDAT', 'SPS', 'COMM']);
    if (needsSurf.has(key) && (currentSurf === null || currentSurf === undefined)) {
      addIssue('warning', `Record without SURF context at line ${lineNo + 1}: ${line}`);
      continue;
    }

    if (key === 'STOP') {
      const row = ensureRow(rows, currentSurf);
      row['object type'] = 'Stop';
      continue;
    }

    if (key === 'STO') {
      const row = ensureRow(rows, currentSurf);
      row['object type'] = 'Stop';
      continue;
    }

    if (key === 'CURV') {
      const row = ensureRow(rows, currentSurf);
      const curv = parseNumberOrNull(tokens[1]);
      if (curv === null) continue;
      row.radius = invertCurvatureToRadius(curv);
      continue;
    }

    if (key === 'CUY') {
      const row = ensureRow(rows, currentSurf);
      const curv = parseNumberOrNull(tokens[1]);
      if (curv === null) continue;
      row.radius = invertCurvatureToRadius(curv);
      continue;
    }

    if (key === 'DISZ') {
      const row = ensureRow(rows, currentSurf);
      const disz = parseNumberOrNull(tokens[1]);
      if (disz === null) continue;
      // Treat Zemax INFINITY as INF in co-opt.
      if (disz === Infinity) {
        row.thickness = 'INF';
        // If the object is at infinity and FTYP is missing, fields are almost certainly angles.
        if (currentSurf === 0 && fieldPositionFromFTYP === null) {
          fieldPosition = 'Angle';
        }
      } else if (Number.isFinite(disz) && Math.abs(disz) >= 1e9) {
        // If a very large placeholder is used, treat it as INF for co-opt.
        row.thickness = 'INF';
        addIssue('warning', `DISZ treated as INF at surface ${currentSurf} (value=${tokens[1]}).`);
        if (currentSurf === 0 && fieldPositionFromFTYP === null) {
          fieldPosition = 'Angle';
        }
      } else {
        row.thickness = disz;
      }

      if (String(row.surfType ?? '').trim().toLowerCase() === 'coord trans') {
        const dz = (row.thickness === 'INF') ? 0 : parseNumberOrNull(row.thickness);
        row.decenterZ = (dz !== null && Number.isFinite(dz)) ? dz : 0;
      }
      continue;
    }

    if (key === 'THI') {
      const row = ensureRow(rows, currentSurf);
      const disz = parseNumberOrNull(tokens[1]);
      if (disz === null) continue;
      if (disz === Infinity) {
        row.thickness = 'INF';
        if (currentSurf === 0 && fieldPositionFromFTYP === null) fieldPosition = 'Angle';
      } else if (Number.isFinite(disz) && Math.abs(disz) >= 1e9) {
        row.thickness = 'INF';
        if (currentSurf === 0 && fieldPositionFromFTYP === null) fieldPosition = 'Angle';
      } else {
        row.thickness = disz;
      }
      continue;
    }

    if (key === 'GLAS') {
      const row = ensureRow(rows, currentSurf);
      const name = String(tokens[1] ?? '').trim();

      // Zemax can represent a "model glass" as:
      // GLAS ___BLANK <...> <nd> <vd>
      // Import the nd (tokens[4]) as a numeric material name so co-opt can still ray-trace.
      if (String(name).toUpperCase() === '___BLANK') {
        const nd = parseNumberOrNull(tokens[4]);
        const vd = parseNumberOrNull(tokens[5]);
        if (nd !== null && Number.isFinite(nd) && nd > 0) {
          row.material = String(nd);
        } else {
          row.material = '';
        }

        // Preserve Abbe number so Design Intent conversion can map numeric nd to a real glass.
        if (vd !== null && Number.isFinite(vd) && vd > 0) {
          row.abbe = String(vd);
        }
      } else {
        row.material = normalizeImportedMaterialName(name);
      }
      continue;
    }

    if (key === 'GLA') {
      const row = ensureRow(rows, currentSurf);
      const name = String(tokens[1] ?? '').trim();
      row.material = normalizeImportedMaterialName(name);
      continue;
    }

    if (key === 'DIAM') {
      const row = ensureRow(rows, currentSurf);
      const semidia = parseNumberOrNull(tokens[1]);
      if (semidia === null) continue;
      row.semidia = semidia;
      continue;
    }

    if (key === 'APE') {
      const row = ensureRow(rows, currentSurf);
      const sx = parseNumberOrNull(tokens[2]);
      const sy = parseNumberOrNull(tokens[3]);
      const semidia = Math.max(
        Number.isFinite(sx) ? Math.abs(Number(sx)) : 0,
        Number.isFinite(sy) ? Math.abs(Number(sy)) : 0,
      );
      if (semidia > 0) row.semidia = semidia;
      if (Number.isFinite(sx) && Number.isFinite(sy) && Math.abs(Number(sx) - Number(sy)) > 1e-9) {
        row._apertureShape = 'Rectangular';
        row._apertureWidth = Math.abs(Number(sx)) * 2;
        row._apertureHeight = Math.abs(Number(sy)) * 2;
      }
      continue;
    }

    if (key === 'CLAP') {
      const row = ensureRow(rows, currentSurf);
      if (!isBlank(row.semidia)) continue;
      const clearAperture = parseNumberOrNull(tokens[2]);
      if (clearAperture === null || !Number.isFinite(clearAperture) || clearAperture <= 0) continue;
      row.semidia = clearAperture;
      continue;
    }

    if (key === 'TYPE') {
      const row = ensureRow(rows, currentSurf);
      const typeName = String(tokens[1] ?? '').trim().toUpperCase();
      if (typeName === 'EVENASPH') {
        row.surfType = 'Aspheric even';
      } else if (typeName === 'QED_TYPE' || typeName === 'QCON' || typeName === 'QCON_TYPE') {
        row.surfType = 'Qcon';
      } else if (typeName === 'TORICS') {
        row.surfType = 'Toric';
        // Zemax TORICS uses PARM 1=radiusX curvature, PARM 2=radiusY curvature, PARM 3=axis
        // Will be handled in PARM section below
      } else if (typeName === 'COORDBRK' || typeName === 'COORD' || typeName === 'COORDINATEBREAK') {
        row.surfType = 'Coord Trans';
        row['object type'] = 'CT';
        row.radius = 'INF';
        row.decenterX = 0;
        row.decenterY = 0;
        row.decenterZ = 0;
        row.tiltX = 0;
        row.tiltY = 0;
        row.tiltZ = 0;
        row.order = 0;
        row.coordReturn = 'none';
        row.toSurf = 0;
      } else if (typeName.includes('ODD')) {
        const err: any = new Error(`Zemax import: Aspheric odd surfaces are not supported yet (surface ${currentSurf}).`);
        err.code = 'ZMX_UNSUPPORTED_ODD';
        throw err;
      } else {
        // Default: treat as spherical/standard.
        row.surfType = 'Spherical';
      }
      continue;
    }

    if (key === 'SUT') {
      const row = ensureRow(rows, currentSurf);
      const typeName = String(tokens[1] ?? '').trim().toUpperCase();
      if (typeName === 'A' || typeName === 'ASPHERIC') {
        if (String(row.surfType ?? '').trim() !== 'Qcon') row.surfType = 'Aspheric even';
      } else {
        row.surfType = 'Spherical';
      }
      continue;
    }

    if (key === 'CONI') {
      const row = ensureRow(rows, currentSurf);
      const coni = parseNumberOrNull(tokens[1]);
      if (coni === null) continue;
      row.conic = coni;
      continue;
    }

    if (key === 'PARM') {
      const row = ensureRow(rows, currentSurf);
      const idx = parseNumberOrNull(tokens[1]);
      const val = parseNumberOrNull(tokens[2]);
      if (idx === null || val === null) continue;
      const j = Math.trunc(idx);
      
      // Handle Toric surface parameters
      if (row.surfType === 'Toric') {
        if (j === 1) {
          // PARM 1 = radiusX curvature (1/radiusX)
          row.radiusX = invertCurvatureToRadius(val);
        } else if (j === 2) {
          // PARM 2 = radiusY curvature (1/radiusY)
          row.radiusY = invertCurvatureToRadius(val);
        } else if (j === 3) {
          // PARM 3 = axis rotation (degrees)
          row.axis = val;
        }
        // Other PARM values for TORICS may exist but are not used in spherical toric
      } else if (String(row.surfType ?? '').trim().toLowerCase() === 'coord trans') {
        if (j === 1) {
          row.decenterX = val;
          row.semidia = val;
        } else if (j === 2) {
          row.decenterY = val;
          row.material = String(val);
        } else if (j === 3) {
          row.tiltX = val;
          row.rindex = val;
        } else if (j === 4) {
          row.tiltY = val;
          row.abbe = val;
        } else if (j === 5) {
          row.tiltZ = val;
          row.conic = val;
        } else if (j === 6) {
          const order = (val === 0 || val === 1) ? val : (val > 0 ? 1 : 0);
          row.order = order;
          row.coef1 = order;
        } else if (j === 7) {
          row.coordReturn = normalizeCoordReturnMode(val);
        } else if (j === 8) {
          row.toSurf = Math.max(0, Math.trunc(val));
        } else {
          addIssue('warning', `Coord Break PARM index out of range (1..8) at surface ${currentSurf}: ${j}`);
        }
      } else {
        // Zemax PARM mapping for aspheric: PARM 1=unused, PARM 2=A4, PARM 3=A6, ...
        // co-opt mapping: coef1=A4, coef2=A6, coef3=A8, ...
        // So PARM n maps to coef(n-1), skipping PARM 1
        if (j >= 2 && j <= 11) {
          row[`coef${j - 1}`] = val;
        } else if (j === 1) {
          // PARM 1 is typically 0 and unused in Zemax; ignore it
        } else {
          addIssue('warning', `PARM index out of range (1..11) at surface ${currentSurf}: ${j}`);
        }
      }
      continue;
    }

    if (key === 'XDAT') {
      const row = ensureRow(rows, currentSurf);
      const idx = parseNumberOrNull(tokens[1]);
      const val = parseNumberOrNull(tokens[2]);
      if (idx === null || val === null) continue;
      const j = Math.trunc(idx);

      if (j === 1) {
        row.conic = val;
      } else if (j === 2) {
        // XDAT 2 is exported as diameter; store internal qconNrad/C2 as radius.
        row.qconNrad = Math.abs(val) / 2;
      } else if (j === 3) {
        row.qconOffset = val;
      } else if (j >= 4 && j <= 13) {
        row[`coef${j - 3}`] = val;
      }
      continue;
    }

    if (key === 'SPS') {
      const row = ensureRow(rows, currentSurf);
      const mode = String(tokens[1] ?? '').trim().toUpperCase();
      if (mode === 'QCN' || mode === 'QCON') {
        row.surfType = 'Qcon';
        continue;
      }

      const idx = parseNumberOrNull(tokens[1]);
      const val = parseNumberOrNull(tokens[2]);
      if (idx === null || val === null) continue;
      const c = Math.trunc(idx);
      if (c <= 0) continue;

      if (String(row.surfType ?? '').trim() === 'Qcon') {
        if (c === 1) {
          row.conic = val;
        } else if (c === 2) {
          row.qconNrad = val;
        } else if (c >= 3 && c <= 12) {
          row[`coef${c - 2}`] = val;
        } else if (c === 32) {
          row.qconTermCount = val;
        }
        continue;
      }

      if (c === 1) {
        row.conic = val;
      } else if (c === 2) {
        row.qconNrad = val;
      } else if (c >= 3 && c <= 12) {
        row[`coef${c - 2}`] = val;
      } else if (c === 32) {
        row.qconTermCount = val;
      }
      continue;
    }

    if (key === 'COMM') {
      const row = ensureRow(rows, currentSurf);
      // COMM "..." or COMM token...
      const comment = tokens.length >= 2 ? String(tokens.slice(1).join(' ')).trim() : '';
      if (comment) row.comment = comment.replace(/^"|"$/g, '');
      continue;
    }

    // Soft-detect Coord Break records even without TYPE and initialize CoordTrans row.
    if (key === 'COORDBRK' || key === 'COORD' || key === 'COORDINATEBREAK') {
      const row = ensureRow(rows, currentSurf);
      row.surfType = 'Coord Trans';
      row['object type'] = 'CT';
      row.radius = 'INF';
      if (row.decenterX === undefined) row.decenterX = 0;
      if (row.decenterY === undefined) row.decenterY = 0;
      if (row.decenterZ === undefined) row.decenterZ = 0;
      if (row.tiltX === undefined) row.tiltX = 0;
      if (row.tiltY === undefined) row.tiltY = 0;
      if (row.tiltZ === undefined) row.tiltZ = 0;
      if (row.order === undefined) row.order = 0;
      if (row.coordReturn === undefined) row.coordReturn = 'none';
      if (row.toSurf === undefined) row.toSurf = 0;
      continue;
    }
  }

  if (Array.isArray(rows)) {
    markDefaultsForObjectAndImage(rows);
  }

  // If no stop surface is defined in the import, place a Stop right after Object (Surf 1).
  if (Array.isArray(rows) && rows.length > 0) {
    const hasStopSurface = rows.some((row) => {
      if (!row || typeof row !== 'object') return false;
      const objTypeRaw = row['object type'] ?? row.object ?? row.objectType;
      const objType = String(objTypeRaw ?? '').trim().toLowerCase();
      const comment = String(row.comment ?? '').trim().toLowerCase();
      return objType === 'stop' || objType === 'sto' || comment === 'stop' || comment === 'aperture stop' || comment.includes('stop');
    });

    if (!hasStopSurface) {
      const stopRow = ensureRow(rows, 1);
      stopRow['object type'] = 'Stop';
    }
  }

  // Ensure ids are contiguous and consistent
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || typeof rows[i] !== 'object') rows[i] = makeEmptyRow(i);
    rows[i].id = i;
  }

  // Basic guard: avoid empty import
  if (rows.length === 0) {
    const err: any = new Error('Zemax import: no SURF records found.');
    err.code = 'ZMX_EMPTY';
    throw err;
  }

  // Convert system-level records into co-opt table rows (if present)
  /** @type {{id:number, wavelength:number, weight:number, primary:string, angle:number}[]} */
  const sourceRows = [];
  if (wavelengthsByIndex.size === 0 && wavelengthsList.length > 0) {
    for (let i = 0; i < wavelengthsList.length; i++) {
      const wl = wavelengthsList[i];
      const wt = (i < wavelengthWeightsList.length) ? wavelengthWeightsList[i] : 1;
      wavelengthsByIndex.set(i + 1, {
        wavelength: wl,
        weight: (Number.isFinite(wt) ? wt : 1)
      });
    }
  }

  if (wavelengthsByIndex.size > 0) {
    const indices = Array.from(wavelengthsByIndex.keys()).sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const ent = wavelengthsByIndex.get(idx);
      if (!ent) continue;
      sourceRows.push({
        id: i + 1,
        wavelength: ent.wavelength,
        weight: ent.weight,
        primary: '',
        angle: 0
      });
    }

    // Ensure a primary wavelength exists
    const pwFallback = (otxPrimaryWavelengthIndex !== null && Number.isFinite(otxPrimaryWavelengthIndex))
      ? Math.trunc(otxPrimaryWavelengthIndex)
      : 1;
    const pw = (primaryWavelengthIndex !== null && Number.isFinite(primaryWavelengthIndex)) ? Math.trunc(primaryWavelengthIndex) : pwFallback;
    const primaryOneBased = Math.max(1, Math.min(sourceRows.length, pw));
    for (let i = 0; i < sourceRows.length; i++) sourceRows[i].primary = '';
    if (sourceRows[primaryOneBased - 1]) sourceRows[primaryOneBased - 1].primary = 'Primary Wavelength';
  }

  /** @type {{id:number, xHeightAngle:number, yHeightAngle:number, position:string, angle:number}[]} */
  const objectRows = [];
  const fieldCount = Math.max(fieldXs.length, fieldYs.length, fieldWs.length);
  if (fieldCount > 0) {
    // Final fallback: if FTYP is absent, but the Object thickness is INF, treat fields as angles.
    try {
      const objT = rows?.[0]?.thickness;
      const isInf = objT === 'INF' || objT === 'Infinity' || objT === Infinity;
      if (fieldPositionFromFTYP === null && isInf) fieldPosition = 'Angle';
    } catch (_) {}
    for (let i = 0; i < fieldCount; i++) {
      const x = Number.isFinite(fieldXs[i]) ? fieldXs[i] : 0;
      const y = Number.isFinite(fieldYs[i]) ? fieldYs[i] : 0;
      // co-opt currently doesn't store per-field weight, but keep a stable row even if FWGN is present.
      objectRows.push({
        id: i + 1,
        xHeightAngle: x,
        yHeightAngle: y,
        position: fieldPosition,
        angle: 0
      });
    }
  }

  // Post-process: Update surfType for surfaces with non-zero conic or aspheric coefficients
  // This handles STANDARD surfaces in ZMX that have CONI values but no explicit TYPE EVENASPH
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    
    // Skip if already marked as aspheric or non-standard type
    const currentSurfType = String(row.surfType ?? '').trim();
    if (currentSurfType === 'Aspheric even' || currentSurfType === 'Qcon' || currentSurfType === 'Toric' || currentSurfType === 'Coord Trans') {
      continue;
    }
    
    // Check if conic or any aspheric coefficient is non-zero
    const conic = Number(row.conic) || 0;
    const hasNonZeroConic = conic !== 0;
    const hasAsphericCoef = [
      Number(row.coef1) || 0,
      Number(row.coef2) || 0,
      Number(row.coef3) || 0,
      Number(row.coef4) || 0,
      Number(row.coef5) || 0,
      Number(row.coef6) || 0,
      Number(row.coef7) || 0,
      Number(row.coef8) || 0,
      Number(row.coef9) || 0,
      Number(row.coef10) || 0
    ].some(c => c !== 0);
    
    if (hasNonZeroConic || hasAsphericCoef) {
      row.surfType = 'Aspheric even';
      if (hasNonZeroConic && !hasAsphericCoef) {
        addIssue('info', `Surface ${i}: Auto-detected conic surface (conic=${conic.toFixed(4)}), set surfType='Aspheric even'`);
      }
    }
  }

  return {
    rows,
    issues,
    sourceRows,
    objectRows,
    entrancePupilDiameterMm
  };
}

export function parseZMXArrayBufferToOpticalSystemRows(arrayBuffer, options = {}) {
  const text = decodeZmxArrayBuffer(arrayBuffer);
  return parseZMXTextToOpticalSystemRows(text, options);
}
