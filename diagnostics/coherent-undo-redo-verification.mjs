class MemoryLocalStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

const events = new EventTarget();
globalThis.window = globalThis;
globalThis.localStorage = new MemoryLocalStorage();
globalThis.CustomEvent = TestCustomEvent;
globalThis.document = {
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
  getElementById() { return null; },
};
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.dispatchEvent = events.dispatchEvent.bind(events);

localStorage.setItem('systemConfigurations', JSON.stringify({
  activeConfigId: 'cfg-undo',
  configurations: [{
    id: 'cfg-undo',
    name: 'Undo verification',
    assemblyRoutingMode: 'automatic-scene',
    blocks: [{
      blockId: 'Target-1',
      blockType: 'Target',
      parameters: {
        profile: 'sine',
        widthMm: 50,
        offsetUm: 0,
        amplitudeUm: 10,
        periodMm: 2,
        interaction: 'specular',
        reflectance: 1,
      },
      variables: {},
      metadata: { label: 'Target' },
    }],
    sequentialGroups: [],
    designConnections: [],
    portRoutes: [],
    routeSets: [],
    metadata: {},
  }],
  meritFunction: [],
  systemRequirements: [],
  toleranceStudies: [],
  optimizationRules: {},
}));

await import('../core/undo-history.ts');
const {
  readActiveCoherentDesign,
  subscribeActiveCoherentDesign,
  updateActiveCoherentDesign,
} = await import('../data/coherent-config-store.ts');

const delivered = [];
const unsubscribe = subscribeActiveCoherentDesign((snapshot, reason) => {
  delivered.push({ amplitudeUm: snapshot.design.target.amplitudeUm, reason });
});

const before = readActiveCoherentDesign();
const edited = structuredClone(before.design);
edited.target.amplitudeUm = 12;
updateActiveCoherentDesign(edited, 'target-amplitude');

const afterEdit = readActiveCoherentDesign();
const undoAccepted = window.undoHistory.undo();
const afterUndo = readActiveCoherentDesign();
const redoAccepted = window.undoHistory.redo();
const afterRedo = readActiveCoherentDesign();
unsubscribe();

const checks = {
  editPersisted: afterEdit.design.target.amplitudeUm === 12,
  globalHistoryRecorded: undoAccepted === true,
  undoRestored: afterUndo.design.target.amplitudeUm === 10,
  redoAccepted: redoAccepted === true,
  redoRestored: afterRedo.design.target.amplitudeUm === 12,
  sameWindowUpdatesDelivered: delivered.some((entry) => entry.amplitudeUm === 10 && entry.reason.startsWith('undo:'))
    && delivered.some((entry) => entry.amplitudeUm === 12 && entry.reason.startsWith('redo:')),
};

console.log('COHERENT_UNDO_REDO_REPORT', JSON.stringify({ checks, delivered }, null, 2));
if (Object.values(checks).some((value) => value !== true)) {
  console.error('COHERENT_UNDO_REDO_FAIL');
  process.exit(1);
}
console.log('COHERENT_UNDO_REDO_PASS');
