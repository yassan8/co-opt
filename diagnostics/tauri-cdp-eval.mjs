const port = Number(process.env.COOPT_CDP_PORT || 9223);
const targetUrlFragment = String(process.env.COOPT_CDP_URL || '').trim();
const expression = process.argv[2];

if (!expression) {
  throw new Error('Usage: node diagnostics/tauri-cdp-eval.mjs <expression>');
}

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
