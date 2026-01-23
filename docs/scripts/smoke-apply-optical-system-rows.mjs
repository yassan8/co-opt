// Smoke test for apply_optical_system_rows
// Runs in Node without external dependencies by stubbing minimal browser globals.

class MemoryLocalStorage {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(String(k)); }
  clear() { this._m.clear(); }
}

function installBrowserStubs() {
  globalThis.window = globalThis;
  globalThis.localStorage = new MemoryLocalStorage();

  // Minimal document stub (most code paths won’t touch this in the smoke test).
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    createElement() {
      return {
        style: {},
        setAttribute() {},
        appendChild() {},
        addEventListener() {},
        removeEventListener() {},
      };
    },
    body: {
      insertAdjacentHTML() {},
      appendChild() {},
    }
  };

  globalThis.addEventListener = () => {};

}

function installUIRefreshSpies() {
  // Imports may overwrite globals; install spies right before tool call.
  globalThis.__smoke = {
    loadActiveConfigurationToTablesCalls: [],
    refreshBlockInspectorCalls: 0,
    calculateMeritCalls: 0,
    scheduleEvaluateAndUpdateCalls: 0,
  };

  globalThis.ConfigurationManager = {
    async loadActiveConfigurationToTables(opts) {
      globalThis.__smoke.loadActiveConfigurationToTablesCalls.push(opts || null);
    }
  };

  globalThis.refreshBlockInspector = () => { globalThis.__smoke.refreshBlockInspectorCalls++; };
  globalThis.meritFunctionEditor = { calculateMerit: () => { globalThis.__smoke.calculateMeritCalls++; } };
  globalThis.systemRequirementsEditor = { scheduleEvaluateAndUpdate: () => { globalThis.__smoke.scheduleEvaluateAndUpdateCalls++; } };
}

function seedSystemConfigurations() {
  const systemConfigurations = {
    activeConfigId: 'cfg_smoke',
    configurations: [
      {
        id: 'cfg_smoke',
        name: 'Smoke',
        schemaVersion: '1',
        blocks: [],
        opticalSystem: [],
        metadata: {}
      }
    ]
  };
  localStorage.setItem('systemConfigurations', JSON.stringify(systemConfigurations));
}

function sampleLegacyRows() {
  // Minimal sequential system that should convert into at least one Lens block.
  // Convention: object row at index 0, optional image row at end.
  return [
    { id: 0, 'object type': 'Object', radius: 'INF', thickness: 100, semidia: 10, material: 'AIR' },
    { id: 1, 'object type': 'Standard', radius: 50, thickness: 5, semidia: 10, material: 'N-BK7', surfType: 'Spherical', conic: 0 },
    { id: 2, 'object type': 'Standard', radius: -50, thickness: 30, semidia: 10, material: 'N-BK7', surfType: 'Spherical', conic: 0 },
    { id: 3, 'object type': 'Image', radius: 'INF', thickness: 0, semidia: 10, material: 'AIR' }
  ];
}

async function runOnce(label, moduleUrl) {
  console.log(`SMOKE_STEP ${label}: begin`);
  // Reset persistent state per run.
  localStorage.clear();
  seedSystemConfigurations();

  console.log(`SMOKE_STEP ${label}: importing ${moduleUrl}`);
  const mod = await import(moduleUrl);
  console.log(`SMOKE_STEP ${label}: imported`);
  if (typeof mod.__debug_apply_optical_system_rows !== 'function') {
    throw new Error(`${label}: __debug_apply_optical_system_rows export not found`);
  }

  console.log(`SMOKE_STEP ${label}: calling tool`);
  installUIRefreshSpies();
  const result = await mod.__debug_apply_optical_system_rows({ rows: sampleLegacyRows() });
  console.log(`SMOKE_STEP ${label}: tool returned`);

  const saved = JSON.parse(localStorage.getItem('systemConfigurations'));
  const cfg = saved?.configurations?.[0];

  const blocksOk = Array.isArray(cfg?.blocks) && cfg.blocks.length > 0;
  const derivedOk = cfg?.metadata?.importAnalyzeMode === false;
  const uiRefreshOk = Array.isArray(globalThis.__smoke.loadActiveConfigurationToTablesCalls)
    && globalThis.__smoke.loadActiveConfigurationToTablesCalls.length > 0;

  return {
    label,
    toolOk: !!result?.ok,
    blocksDerived: blocksOk,
    importAnalyzeModeFalse: derivedOk,
    uiRefreshCalled: uiRefreshOk,
    blocksCount: Array.isArray(cfg?.blocks) ? cfg.blocks.length : 0,
    appliedToConfigs: result?.appliedToConfigs || null,
  };
}

installBrowserStubs();

// Use URLs relative to this script (stable even when cwd changes).
const srcUrl = new URL('../ai/ai-assistant.js', import.meta.url).href;
const docsUrl = new URL('../docs/ai/ai-assistant.js', import.meta.url).href;

const reports = [];
try {
  reports.push(await runOnce('src', srcUrl));
  reports.push(await runOnce('docs', docsUrl));
} catch (e) {
  console.error('SMOKE_FAIL', e?.message || String(e));
  try {
    const props = {};
    for (const k of Object.getOwnPropertyNames(e || {})) {
      try { props[k] = e[k]; } catch { props[k] = '[unreadable]'; }
    }
    console.error('SMOKE_ERROR_PROPS', JSON.stringify(props, null, 2));
  } catch (_) {}
  if (e?.stack) console.error(String(e.stack));
  process.exit(1);
}

const failed = reports.filter(r => !(r.toolOk && r.blocksDerived && r.importAnalyzeModeFalse && r.uiRefreshCalled));

console.log('SMOKE_REPORT', JSON.stringify(reports, null, 2));
if (failed.length) {
  console.error('SMOKE_FAIL', JSON.stringify(failed, null, 2));
  process.exit(2);
}

console.log('SMOKE_PASS');
