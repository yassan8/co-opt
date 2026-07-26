import { storageGetItem, storageSetItem } from './ui-storage-gateway.ts';

export const OPTIMIZE_RAY_GRID_SIZE_KEY = 'coopt.optimize.rayGridSize';
export const OPTIMIZE_RAY_GRID_SIZES = [4, 8, 16, 32, 64, 128, 256, 512, 1024] as const;
export type OptimizeRayGridSize = (typeof OPTIMIZE_RAY_GRID_SIZES)[number];

export const DEFAULT_OPTIMIZE_RAY_GRID_SIZE: OptimizeRayGridSize = 8;

export function sanitizeOptimizeRayGridSize(value: unknown): OptimizeRayGridSize {
  const parsed = Math.floor(Number(value));
  return (OPTIMIZE_RAY_GRID_SIZES as readonly number[]).includes(parsed)
    ? parsed as OptimizeRayGridSize
    : DEFAULT_OPTIMIZE_RAY_GRID_SIZE;
}

export function loadOptimizeRayGridSize(): OptimizeRayGridSize {
  try {
    return sanitizeOptimizeRayGridSize(storageGetItem(OPTIMIZE_RAY_GRID_SIZE_KEY));
  } catch (_) {
    return DEFAULT_OPTIMIZE_RAY_GRID_SIZE;
  }
}

export function saveOptimizeRayGridSize(value: unknown): OptimizeRayGridSize {
  const gridSize = sanitizeOptimizeRayGridSize(value);
  try {
    storageSetItem(OPTIMIZE_RAY_GRID_SIZE_KEY, String(gridSize));
  } catch (_) {}
  return gridSize;
}

export function optimizeRayCountFromGridSize(value: unknown): number {
  const gridSize = sanitizeOptimizeRayGridSize(value);
  return gridSize * gridSize;
}
