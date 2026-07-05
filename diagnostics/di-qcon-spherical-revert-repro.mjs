// Repro: DI Qcon -> Spherical revert after repeated Blocks expand/collapse.
// Run: node --experimental-strip-types diagnostics/di-qcon-spherical-revert-repro.mjs
import {
  expandBlocksToOpticalSystemRows,
  deriveBlocksFromLegacyOpticalSystemRows,
} from '../data/block-schema.ts';

function makeLensBlock(frontSurfType, extra = {}) {
  return {
    blockId: 'Lens-1',
    blockType: 'Lens',
    parameters: {
      frontRadius: 50,
      backRadius: -50,
      centerThickness: 5,
      material: 'N-BK7',
      frontSurfType,
      backSurfType: 'Spherical',
      frontConic: 0,
      backConic: 0,
      ...extra,
    },
    variables: {},
    aperture: { front: 10, back: 10 },
  };
}

function frontSurfTypeOf(blocks) {
  const b = blocks.find((x) => x.blockId === 'Lens-1');
  return b?.parameters?.frontSurfType;
}
function frontRowSurfType(rows) {
  const r = rows.find((x) => x?._surfaceRole === 'front' && String(x?._blockId) === 'Lens-1');
  return r?.surfType;
}

function runScenario(name, block) {
  console.log(`\n=== Scenario: ${name} ===`);
  let blocks = [block];
  console.log(`start block.frontSurfType = ${JSON.stringify(frontSurfTypeOf(blocks))}`);
  for (let cycle = 1; cycle <= 5; cycle++) {
    const exp = expandBlocksToOpticalSystemRows(blocks);
    const rows = exp.rows;
    const rowST = frontRowSurfType(rows);
    const der = deriveBlocksFromLegacyOpticalSystemRows(rows);
    blocks = der.blocks;
    const blkST = frontSurfTypeOf(blocks);
    console.log(`cycle ${cycle}: row.surfType=${JSON.stringify(rowST)} -> block.frontSurfType=${JSON.stringify(blkST)}`);
  }
}

// A: clean Spherical (qcon fully cleared) - expect stable Spherical
runScenario('Clean Spherical', makeLensBlock('Spherical'));

// B: Spherical but stale qcon coefs + qconNrad left in block (DI editor only changed surfType)
runScenario('Spherical w/ stale qcon coefs', makeLensBlock('Spherical', {
  frontQconNrad: 12.5,
  frontConic: -1.2,
  frontCoef1: 1e-4,
  frontCoef2: -2e-6,
}));

// C: original Qcon (sanity - should stay Qcon)
runScenario('Qcon', makeLensBlock('Qcon', {
  frontQconNrad: 12.5,
  frontCoef1: 1e-4,
}));
