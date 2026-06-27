export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Record<string, unknown>;
  const internals = w.__TAURI_INTERNALS__ as { invoke?: unknown } | undefined;
  if (typeof internals?.invoke === "function") return true;
  const tauri = w.__TAURI__ as { invoke?: unknown } | undefined;
  return typeof tauri?.invoke === "function";
}

export function basenameFromPath(path: string): string {
  const normalized = String(path || "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || normalized;
}
