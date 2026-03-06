export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Record<string, unknown>).__TAURI_INTERNALS__);
}

export function basenameFromPath(path: string): string {
  const normalized = String(path || "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || normalized;
}
