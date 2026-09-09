/** Resolve a run from its fresh design snapshot, not the window-open snapshot. */
export function selectEngineeringRunRequirements(
  snapshot: { systemRequirements?: any[] },
  requirementIds: Array<string | number> | undefined,
  createAutomaticMonitor: () => any,
): { rows: any[]; automatic: boolean } {
  const enabled = (Array.isArray(snapshot.systemRequirements) ? snapshot.systemRequirements : [])
    .filter(row => row && row.rowType !== 'memo' && row.enabled !== false && row.operand);
  const selected = new Set((requirementIds ?? []).map(String));
  const matched = enabled.filter(row => selected.size === 0 || selected.has(String(row.id)));
  // Keep the established migration behavior for a Study with obsolete IDs.
  const rows = matched.length > 0 || enabled.length === 0 ? matched : enabled;
  return rows.length ? { rows, automatic: false } : { rows: [createAutomaticMonitor()], automatic: true };
}
