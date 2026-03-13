#!/usr/bin/env node
// Quick test script to verify Zemax import preserves Abbe/Vd for ___BLANK materials

import fs from 'fs';
import path from 'path';

// Extract text from ZMX file (simplified parser)
function decodeZmxArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 32 && b < 127) text += String.fromCharCode(b);
    else if (b === 10) text += '\n';
    else if (b === 13) text += '\r';
  }
  return text;
}

// Parse ZMX text
function parseZMXTextToOpticalSystemRows(text) {
  const lines = text.split('\n');
  const rows = [];
  let currentSurf = 0;
  let currentRow = { id: 0, 'object type': 'Object', material: '', thickness: 'INF', radius: 'INF' };

  const parseNumberOrNull = (s) => {
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tokens = trimmed.split(/\s+/);
    const key = tokens[0]?.toUpperCase();

    if (key === 'SURF') {
      if (currentRow.id !== undefined) rows.push(currentRow);
      currentSurf = parseInt(tokens[1], 10) || 0;
      currentRow = { 
        id: currentSurf, 
        'object type': 'Object',
        material: '',
        thickness: 'INF',
        radius: 'INF'
      };
    }

    if (key === 'GLAS') {
      const name = String(tokens[1] || '').trim();
      if (name.toUpperCase() === '___BLANK') {
        const nd = parseNumberOrNull(tokens[4]);
        const vd = parseNumberOrNull(tokens[5]);
        if (nd !== null && Number.isFinite(nd) && nd > 0) {
          currentRow.material = String(nd);
        }
        if (vd !== null && Number.isFinite(vd) && vd > 0) {
          currentRow.abbe = String(vd);
        }
      } else {
        currentRow.material = name;
      }
    }

    if (key === 'CURV') {
      const curv = parseNumberOrNull(tokens[1]);
      if (curv !== null) {
        currentRow.radius = 1 / curv; // Invert curvature to radius
      }
    }

    if (key === 'DISZ') {
      const disz = parseNumberOrNull(tokens[1]);
      if (disz === Infinity) {
        currentRow.thickness = 'INF';
      } else if (Number.isFinite(disz)) {
        currentRow.thickness = disz;
      }
    }
  }

  if (currentRow.id !== undefined) rows.push(currentRow);
  return rows;
}

// Main test
const zmxPath = '/Users/masanori/Downloads/20260220_f50_F#2.8_HFV23.4.zmx';

if (!fs.existsSync(zmxPath)) {
  console.error(`File not found: ${zmxPath}`);
  process.exit(1);
}

try {
  const buffer = fs.readFileSync(zmxPath);
  const text = decodeZmxArrayBuffer(buffer);
  const rows = parseZMXTextToOpticalSystemRows(text);

  console.log('\n📋 Parsed surfaces with Abbe/Vd:');
  console.log('─'.repeat(80));

  rows.forEach((row, idx) => {
    if (row.material && row.material !== 'AIR' && row.material !== '') {
      const hasAbbe = row.abbe !== undefined ? `✓ ${row.abbe}` : '✗ MISSING';
      console.log(`${idx}: material=${row.material}, abbe=${hasAbbe}`);
    }
  });

  console.log('─'.repeat(80));
  const withAbbe = rows.filter(r => r.abbe !== undefined).length;
  console.log(`\n✅ Total surfaces with Abbe: ${withAbbe}/${rows.length}`);
  
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
