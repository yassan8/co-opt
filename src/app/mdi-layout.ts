export type MdiTileRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MdiTileLayoutOptions = {
  gap?: number;
  minWidth?: number;
  minHeight?: number;
  targetAspectRatio?: number;
};

export function calculateMdiTileLayout(
  windowCount: number,
  desktopWidth: number,
  desktopHeight: number,
  options: MdiTileLayoutOptions = {},
): MdiTileRect[] {
  const count = Math.max(0, Math.floor(Number(windowCount) || 0));
  if (count === 0) return [];

  const gap = Math.max(0, Math.floor(options.gap ?? 12));
  const minWidth = Math.max(1, Math.floor(options.minWidth ?? 420));
  const minHeight = Math.max(1, Math.floor(options.minHeight ?? 280));
  const targetAspectRatio = Math.max(0.1, options.targetAspectRatio ?? 1.5);
  const width = Math.max(1, Math.floor(Number(desktopWidth) || 1));
  const height = Math.max(1, Math.floor(Number(desktopHeight) || 1));
  const maxColumnsThatFit = Math.max(1, Math.floor((width - gap) / (minWidth + gap)));
  const maxColumns = Math.min(count, maxColumnsThatFit);

  let bestColumns = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(count / columns);
    const tileWidth = Math.max(1, Math.floor((width - gap * (columns + 1)) / columns));
    const tileHeight = Math.max(minHeight, Math.floor((height - gap * (rows + 1)) / rows));
    const aspectPenalty = Math.abs(Math.log((tileWidth / tileHeight) / targetAspectRatio));
    const emptySlotPenalty = ((columns * rows) - count) / count;
    const score = aspectPenalty + emptySlotPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestColumns = columns;
    }
  }

  const rows = Math.ceil(count / bestColumns);
  const tileWidth = Math.max(1, Math.floor((width - gap * (bestColumns + 1)) / bestColumns));
  const tileHeight = Math.max(minHeight, Math.floor((height - gap * (rows + 1)) / rows));

  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / bestColumns);
    const column = index % bestColumns;
    const itemsInRow = Math.min(bestColumns, count - row * bestColumns);
    const rowWidth = itemsInRow * tileWidth + Math.max(0, itemsInRow - 1) * gap;
    const rowStartX = Math.max(gap, Math.floor((width - rowWidth) / 2));
    return {
      x: rowStartX + column * (tileWidth + gap),
      y: gap + row * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight,
    };
  });
}
