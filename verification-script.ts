import { expandBlocksToOpticalSystemRows } from './data/block-schema.ts';
import { calculateParaxialData } from './raytracing/core/ray-paraxial.ts';

function normalizeGapThicknessMode(mode: any): string | null {
  const s = String(mode ?? '').trim().toUpperCase();
  return (s === 'IMD' || s === 'BFL') ? s : null;
}

function resolveParaxialScalar(val: any): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return NaN;
}

function getPrimaryWavelengthForOptimization(): number {
  return 0.58756;
}

function applyGapThicknessModesToBlocks(blocks: any[]) {
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  const primaryWavelength = getPrimaryWavelengthForOptimization();
  if (!(Number.isFinite(primaryWavelength) && primaryWavelength > 0)) return;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== 'object') continue;

    const blockType = String(block.blockType ?? '').trim();
    if (blockType !== 'Gap' && blockType !== 'AirGap') continue;

    const params = (block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
    if (!params) continue;

    const mode = normalizeGapThicknessMode(params.thicknessMode);
    if (!mode) continue;

    let target = NaN;
    try {
      const expanded = expandBlocksToOpticalSystemRows(blocks);
      const rows = (expanded && Array.isArray(expanded.rows)) ? expanded.rows : null;
      if (!rows || rows.length === 0) continue;
      const paraxial = calculateParaxialData(rows, primaryWavelength);
        
      target = resolveParaxialScalar(mode === 'IMD' ? paraxial?.imageDistance : paraxial?.backFocalLength);
    } catch (_) {
      target = NaN;
    }

    if (!Number.isFinite(target)) continue;
    params.thickness = target;
    try {
      if (block.variables && typeof block.variables === 'object' && block.variables.thickness && typeof block.variables.thickness === 'object') {
        block.variables.thickness.value = target;
      }
    } catch (_) {}
  }
}

function expandBlocksForOptimization(blocks: any[]) {
  if (!Array.isArray(blocks)) return null;
  let workingBlocks = blocks;
  try {
    workingBlocks = JSON.parse(JSON.stringify(blocks));
  } catch (_) {
    workingBlocks = Array.isArray(blocks) ? blocks.slice() : blocks;
  }

  applyGapThicknessModesToBlocks(workingBlocks);
  return expandBlocksToOpticalSystemRows(workingBlocks);
}

const originalBlocks = [
  { blockType: 'ObjectSurface', parameters: { thickness: Infinity } },
  { blockType: 'Lens', parameters: { thickness: 5, radius: 20, material: 'N-BK7' } },
  { 
    blockType: 'Gap', 
    parameters: { thickness: 0, thicknessMode: 'IMD' },
    variables: { thickness: { value: 0 } }
  }
];

const originalThicknessBefore = originalBlocks[2].parameters.thickness;

const expanded = expandBlocksForOptimization(originalBlocks);

const originalThicknessAfter = originalBlocks[2].parameters.thickness;
const expandedGapRow = expanded?.rows?.find(r => r.__cooptGapApplied);

console.log('--- Verification Output ---');
console.log('Original Gap Thickness Before:', originalThicknessBefore);
console.log('Original Gap Thickness After:', originalThicknessAfter);
console.log('Expanded Rows Length:', expanded?.rows?.length);
console.log('Expanded Gap Row Thickness:', expandedGapRow?.thickness);
console.log('Is Original Mutated:', (originalThicknessBefore !== originalThicknessAfter));
console.log('--- End ---');
