import { expandBlocksToOpticalSystemRows, type Block } from '../data/block-schema.ts';

/**
 * Expand one independently routed exact section without the synthetic Object
 * and Image boundary rows that the full-system block expander inserts. Real
 * ObjectSurface/ImageSurface blocks retain their block ids and remain intact.
 */
export function expandSequentialGroupRows(blocks: Block[]): any[] {
  const sourceBlocks = Array.isArray(blocks) ? blocks : [];
  const rows = expandBlocksToOpticalSystemRows(sourceBlocks).rows;
  if (!Array.isArray(rows)) return [];

  // The expander intentionally leaves some real Object/Image rows without a
  // block id, so `_blockId` alone cannot distinguish an authored boundary from
  // an automatically inserted one.  Presence of the corresponding source
  // block is the authoritative signal.
  const authoredTypes = new Set(
    sourceBlocks.map((block: any) => String(block?.blockType ?? '').trim().toLowerCase()),
  );
  const hasAuthoredObject = authoredTypes.has('objectsurface') || authoredTypes.has('objectplane');
  const hasAuthoredImage = authoredTypes.has('imagesurface') || authoredTypes.has('imageplane');

  return rows.filter((row: any, index: number) => {
    const type = String(row?._blockType ?? row?.['object type'] ?? '').trim().toLowerCase();
    if (index === 0 && type === 'object' && !hasAuthoredObject) return false;
    if (
      index === rows.length - 1
      && (type === 'image' || type === 'imagesurface')
      && !hasAuthoredImage
    ) return false;
    return true;
  });
}
