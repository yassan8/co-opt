export function cloneOptimizeConfigWithLiveObjectRows(systemConfig: any, liveObjectRows: any[]): any {
  if (!systemConfig || typeof systemConfig !== 'object') return null;

  let cloned: any;
  try {
    cloned = JSON.parse(JSON.stringify(systemConfig));
  } catch (_) {
    return null;
  }

  if (!Array.isArray(cloned?.configurations) || cloned.configurations.length === 0) {
    return cloned;
  }
  if (!Array.isArray(liveObjectRows) || liveObjectRows.length === 0) {
    return cloned;
  }

  const activeId = cloned.activeConfigId;
  const active = cloned.configurations.find((config: any) => String(config?.id) === String(activeId))
    || cloned.configurations[0];
  if (!active || typeof active !== 'object') return cloned;

  try {
    active.object = JSON.parse(JSON.stringify(liveObjectRows));
  } catch (_) {
    active.object = liveObjectRows.map(row => (row && typeof row === 'object') ? { ...row } : row);
  }
  return cloned;
}
