class MemoryLocalStorage {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(String(k)); }
  clear() { this._m.clear(); }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

globalThis.window = globalThis;
globalThis.localStorage = new MemoryLocalStorage();
globalThis.document = { addEventListener() {}, removeEventListener() {} };

const counters = {
  helperCalls: [],
  loadActiveConfigurationToTables: 0,
  refreshAllUI: 0,
  refreshBlockInspector: 0,
  saveSystemConfigurations: 0,
};

let systemConfig = {
  activeConfigId: 'cfg1',
  configurations: [
    {
      id: 'cfg1',
      name: 'cfg1',
      blocks: [
        {
          blockId: 'Lens-1',
          blockType: 'Lens',
          parameters: { radius: 10 },
          variables: { frontRadius: { value: 10, optimize: { mode: 'V' } } },
          metadata: {},
        },
      ],
      metadata: {},
    },
  ],
};

globalThis.__cooptScheduleDesignIntentUiRefresh = (options) => {
  counters.helperCalls.push(clone(options));
};
globalThis.loadSystemConfigurations = () => clone(systemConfig);
globalThis.saveSystemConfigurations = (next) => {
  counters.saveSystemConfigurations += 1;
  systemConfig = clone(next);
};
globalThis.expandBlocksToOpticalSystemRows = (blocks) => ({ rows: [{ id: 0, count: Array.isArray(blocks) ? blocks.length : 0 }] });
globalThis.refreshBlockInspector = () => { counters.refreshBlockInspector += 1; };
globalThis.loadActiveConfigurationToTables = () => { counters.loadActiveConfigurationToTables += 1; };
globalThis.refreshAllUI = () => { counters.refreshAllUI += 1; };
globalThis.requestRefreshBlockInspector = () => { counters.refreshBlockInspector += 1; };
globalThis.undoHistory = { isExecuting: false };

const {
  SetBlockParameterCommand,
  AddBlockCommand,
  DeleteBlockCommand,
  SetDesignIntentOptimizeBulkCommand,
} = await import('../core/undo-history.ts');

new SetBlockParameterCommand('cfg1', 'Lens-1', 'variables.frontRadius.value', 10, 20).execute();
new AddBlockCommand('cfg1', { blockId: 'Gap-1', blockType: 'Gap', parameters: {}, variables: {}, metadata: {} }, 1).execute();
new DeleteBlockCommand('cfg1', { blockId: 'Gap-1', blockType: 'Gap', parameters: {}, variables: {}, metadata: {} }, 1).undo();
new SetDesignIntentOptimizeBulkCommand('cfg1', systemConfig.configurations[0].blocks, systemConfig.configurations[0].blocks, true).execute();

const checks = {
  helperCallCount: counters.helperCalls.length,
  noLegacyFullReload: counters.loadActiveConfigurationToTables === 0 && counters.refreshAllUI === 0,
  variablePathStayedSelective: counters.helperCalls[0]?.changedPath === 'variables.frontRadius.value'
    && counters.helperCalls[0]?.forceExpandedRows !== true,
  structuralOpsForceExpandedRows: counters.helperCalls.slice(1).every((entry) => entry?.forceExpandedRows === true),
};

console.log('DI_COMMAND_REFRESH_REPORT', JSON.stringify({ counters, checks }, null, 2));

if (!(checks.helperCallCount === 4 && checks.noLegacyFullReload && checks.variablePathStayedSelective && checks.structuralOpsForceExpandedRows)) {
  console.error('DI_COMMAND_REFRESH_FAIL', JSON.stringify({ counters, checks }, null, 2));
  process.exit(1);
}

console.log('DI_COMMAND_REFRESH_PASS');