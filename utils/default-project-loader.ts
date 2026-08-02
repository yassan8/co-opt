const EXAMPLE_PROJECT_MODULES = import.meta.glob('../Examples/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

type ExampleProjectEntry = {
  fileName: string;
  project: unknown;
};

function buildExampleProjectEntries(): ExampleProjectEntry[] {
  return Object.entries(EXAMPLE_PROJECT_MODULES)
    .map(([modulePath, project]) => ({
      fileName: modulePath.split('/').pop() || modulePath,
      project,
    }))
    .sort((left, right) => {
      if (left.fileName === 'default-load.json') return -1;
      if (right.fileName === 'default-load.json') return 1;
      return left.fileName.localeCompare(right.fileName);
    });
}

const EXAMPLE_PROJECT_ENTRIES = buildExampleProjectEntries();

function cloneExampleProject<T>(project: T): T {
  return JSON.parse(JSON.stringify(project)) as T;
}

function normalizeExampleFileName(fileName: string): string {
  const normalized = String(fileName || '').trim();
  if (!normalized) return 'default-load.json';
  return normalized.endsWith('.json') ? normalized : `${normalized}.json`;
}

export function listBundledExampleProjectFiles(): string[] {
  return EXAMPLE_PROJECT_ENTRIES.map((entry) => entry.fileName);
}

export async function loadBundledExampleProjectJson(fileName = 'default-load.json'): Promise<any> {
  const normalizedFileName = normalizeExampleFileName(fileName);
  const entry = EXAMPLE_PROJECT_ENTRIES.find((candidate) => candidate.fileName === normalizedFileName);
  if (!entry) {
    throw new Error(`Example project not found: ${normalizedFileName}`);
  }
  return cloneExampleProject(entry.project);
}