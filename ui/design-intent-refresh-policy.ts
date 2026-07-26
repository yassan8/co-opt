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

export function syncDesignIntentParameterToVariable(block: any, path: any, value: any): boolean {
  const match = /^parameters\.([^.]+)$/.exec(String(path ?? '').trim());
  if (!match || !block?.variables || typeof block.variables !== 'object') return false;

  const requestedKey = match[1];
  const variableKey = Object.keys(block.variables).find((key) => key.toLowerCase() === requestedKey.toLowerCase());
  if (!variableKey) return false;
  const entry = block.variables[variableKey];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;

  entry.value = value;
  return true;
}

export function reconcileDesignIntentVariableValues(block: any): number {
  if (!block?.parameters || typeof block.parameters !== 'object') return 0;
  if (!block?.variables || typeof block.variables !== 'object') return 0;

  const parameterKeys = new Map(Object.keys(block.parameters).map((key) => [key.toLowerCase(), key]));
  let changed = 0;
  for (const [variableKey, entry] of Object.entries(block.variables)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const parameterKey = parameterKeys.get(variableKey.toLowerCase());
    if (!parameterKey) continue;
    const parameterValue = block.parameters[parameterKey];
    if (!Object.is((entry as any).value, parameterValue)) {
      (entry as any).value = parameterValue;
      changed += 1;
    }
  }
  return changed;
}