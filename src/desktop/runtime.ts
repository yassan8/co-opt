export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export function basenameFromPath(path: string): string {
  const normalized = String(path || "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || normalized;
}
