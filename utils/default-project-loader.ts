function normalizeBaseUrl(): string {
  const fromLocation = (() => {
    try {
      const path = String((globalThis as any)?.location?.pathname || '/');
      if (path.startsWith('/co-opt/')) return '/co-opt/';
      return '/';
    } catch {
      return '/';
    }
  })();

  try {
    const raw = (import.meta as any)?.env?.BASE_URL;
    const base = typeof raw === 'string' && raw.length > 0 ? raw : fromLocation;
    const withLeadingSlash = base.startsWith('/') ? base : `/${base}`;
    const normalized = withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
    if (normalized === '/' && fromLocation !== '/') return fromLocation;
    return normalized;
  } catch {
    return fromLocation;
  }
}

function buildDefaultProjectCandidates(): string[] {
  const baseUrl = normalizeBaseUrl();
  return Array.from(new Set([
    `${baseUrl}defaults/default-load.json`,
    '/co-opt/defaults/default-load.json',
    '/defaults/default-load.json',
  ]));
}

export async function loadBrowserDefaultProjectJson(): Promise<any> {
  let lastStatusText = 'unknown error';

  for (const url of buildDefaultProjectCandidates()) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        lastStatusText = `${response.status} ${response.statusText}`.trim();
        continue;
      }
      return await response.json();
    } catch (error) {
      lastStatusText = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Failed to load default system: ${lastStatusText}`);
}