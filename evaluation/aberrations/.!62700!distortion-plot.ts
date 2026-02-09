// eva-distortion-plot.js
// Plotting utilities for distortion using Plotly.
// Automatically derives field sweep from Object table (angles or object heights).
// Supports multi-wavelength plotting from Source table.

import { calculateDistortionData, calculateGridDistortion } from './distortion.ts';
import { getObjectRows, getOpticalSystemRows, getSourceRows } from '../../utils/data-utils.ts';
import { getPrimaryWavelength } from '../../data/glass.ts';

function inferObjectFieldMode(objects) {
  const rows = Array.isArray(objects) ? objects : [];
  const pickTag = (o) => {
    const raw = o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type;
    return (raw ?? '').toString().toLowerCase();
  };
  const tags = rows.map(pickTag).filter(Boolean);

  // Explicit Rectangle/Height wins
  const hasRect = tags.some(t => t.includes('rect') || t.includes('rectangle'));
  const hasHeight = tags.some(t => t.includes('height'));
  if (hasRect || hasHeight) return { mode: 'height' };

  // Explicit Angle
  const hasAngle = tags.some(t => t.includes('angle'));
  if (hasAngle) return { mode: 'angle' };

  // Fallback: infer from data columns (but do NOT treat yHeightAngle as height)
  const hasNumericHeight = rows.some(o => {
    const h = parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? NaN);
    return Number.isFinite(h) && Math.abs(h) > 0;
  });
  return { mode: hasNumericHeight ? 'height' : 'angle' };
}

export function deriveMaxFieldAngleFromObjects() {
  let objects = [];
  try { objects = getObjectRows(); } catch (_) { objects = []; }
  if (!objects || objects.length === 0) return 20; // fallback

