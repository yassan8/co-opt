function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function getActiveConfig(systemConfig: any): any {
  const activeId = String(systemConfig?.activeConfigId ?? '').trim();
  const configurations = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
  return configurations.find((config: any) => String(config?.id ?? '').trim() === activeId)
    || configurations[0]
    || null;
}

export function selectCanonicalOptimizedRows(
  systemConfigSnapshot: any,
  directRowsSnapshot: any,
  expandBlocks: ((blocks: any[]) => any) | null | undefined,
): any[] {
  const activeConfig = getActiveConfig(systemConfigSnapshot);
  const blocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
  if (blocks.length > 0 && typeof expandBlocks === 'function') {
    try {
      const expanded = expandBlocks(blocks);
      if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
        return cloneJson(expanded.rows);
      }
    } catch (_) {}
  }

  const configuredRows = Array.isArray(activeConfig?.opticalSystem)
    ? activeConfig.opticalSystem
    : (Array.isArray(activeConfig?.opticalSystemRows) ? activeConfig.opticalSystemRows : []);
  if (configuredRows.length > 0) return cloneJson(configuredRows);
  return Array.isArray(directRowsSnapshot) ? cloneJson(directRowsSnapshot) : [];
}

export function injectActiveOpticalRows(systemConfigSnapshot: any, rows: any[]): any {
  const cloned = systemConfigSnapshot && typeof systemConfigSnapshot === 'object'
    ? cloneJson(systemConfigSnapshot)
    : null;
  if (!cloned || !Array.isArray(rows) || rows.length === 0) return cloned;
  const activeConfig = getActiveConfig(cloned);
  if (activeConfig) activeConfig.opticalSystem = cloneJson(rows);
  return cloned;
}

export function getOptimizedResultApplySnapshots(payload: any): {
  afterConfig?: any;
  afterRows: any[];
} {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const afterRows = Array.isArray(payload?.afterRowsSnapshot) && payload.afterRowsSnapshot.length > 0
    ? cloneJson(payload.afterRowsSnapshot)
    : cloneJson(rows);
  const rawAfterConfig = payload?.afterConfigSnapshot && typeof payload.afterConfigSnapshot === 'object'
    ? payload.afterConfigSnapshot
    : null;
  const afterConfig = rawAfterConfig
    ? injectActiveOpticalRows(rawAfterConfig, rows)
    : undefined;
  return { afterConfig, afterRows };
}