import { readFile } from 'node:fs/promises';

const port = Number(process.env.COOPT_CDP_PORT || 9223);
const targetUrlFragment = String(process.env.COOPT_CDP_URL || '').trim();
const [modeOrExpression, jsonPath] = process.argv.slice(2);

if (!modeOrExpression) {
  throw new Error('Usage: node diagnostics/tauri-cdp-eval.mjs <expression> | --load-json <project.json>');
}
if ((modeOrExpression === '--load-json' || modeOrExpression === '--seed-project') && !jsonPath) {
  throw new Error('Usage: node diagnostics/tauri-cdp-eval.mjs --load-json|--seed-project <project.json>');
}

const projectJson = (modeOrExpression === '--load-json' || modeOrExpression === '--seed-project')
  ? await readFile(jsonPath, 'utf8')
  : null;
const expression = modeOrExpression === '--load-json'
  ? `Promise.resolve(window.__loadAllDataObjectIntoApp(${projectJson})).then(() => ({ ok: true }))`
  : modeOrExpression === '--seed-project'
  ? `(async () => {
      const project = ${projectJson};
      const config = structuredClone(project?.configurations);
      if (!config || !Array.isArray(config.configurations)) {
        throw new Error('Project has no configurations payload');
      }
      const active = config.configurations.find((entry) => String(entry?.id) === String(config.activeConfigId))
        || config.configurations[0];
      // A file export mirrors the currently displayed tables at the document
      // root and keeps Blocks in configurations. Reconstruct the same active
      // configuration that the normal file loader creates.
      if (active) {
        if (Array.isArray(project?.source)) active.source = structuredClone(project.source);
        if (Array.isArray(project?.object)) active.object = structuredClone(project.object);
        if (Array.isArray(project?.opticalSystem)) active.opticalSystem = structuredClone(project.opticalSystem);
      }
      // Exported projects keep requirement and merit rows at the document
      // root, while the runtime configuration stores them beside its
      // configurations. Preserve that distinction when seeding a CDP test.
      if (Array.isArray(project?.systemRequirements)) config.systemRequirements = project.systemRequirements;
      if (Array.isArray(project?.meritFunction)) config.meritFunction = project.meritFunction;
      const module = await import('/co-opt/data/table-configuration.ts');
      window.__cooptSystemConfig = structuredClone(config);
      window.__cooptPreferRuntimeSystemConfig = true;
      module.saveSystemConfigurations(structuredClone(config));
      return {
        ok: true,
        configurations: config.configurations.length,
        activeConfigId: config.activeConfigId,
        fields: Array.isArray(active?.object) ? active.object.length : 0,
        surfaces: Array.isArray(active?.opticalSystem) ? active.opticalSystem.length : 0,
      };
    })()`
  : modeOrExpression;

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = (targetUrlFragment
  ? targets.find((entry) => entry.type === 'page' && String(entry.url || '').includes(targetUrlFragment))
  : null)
  || targets.find((entry) => entry.type === 'page');
if (!target?.webSocketDebuggerUrl) {
  throw new Error(`No page target found on CDP port ${port}${targetUrlFragment ? ` for ${targetUrlFragment}` : ''}`);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
socket.close();

if (result.exceptionDetails) {
  throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
}

console.log(JSON.stringify(result.result?.value, null, 2));
