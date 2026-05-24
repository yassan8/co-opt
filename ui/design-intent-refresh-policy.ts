export function requiresExpandedRowsForDesignIntentChange(path: any): boolean {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath) return false;
  return /^parameters\./.test(normalizedPath) || /^aperture\./.test(normalizedPath);
}

export function requiresBlockInspectorRefreshForDesignIntentChange(path: any): boolean {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath) return false;
  return /parameters\.(?:material\d*|rindex\d*|abbe\d*|vd\d*|nd\d*|surfType|frontSurfType|backSurfType|surf1SurfType|surf2SurfType|surf3SurfType|thicknessMode|objectDistanceMode|semidiaMode|optimizeSemiDia|apertureShape|coordBreakOrder|transformOrder|position|zoomGroup|zoomLaw|linkedZoomGroups|zoomLaws)|^aperture\./.test(normalizedPath);
}

export function requiresZoomUiRefreshForDesignIntentChange(path: any): boolean {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath) return false;
  return /parameters\.(?:zoom(Position|Group|Law|GroupProfiles)|linkedZoomGroups|zoomLaws|compensationStroke|compensationSamples)/.test(normalizedPath);
}