import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const toolbarSource = await readFile(new URL('../ui/toolbar-handlers.ts', import.meta.url), 'utf8');
const domSource = await readFile(new URL('../ui/dom-event-handlers.ts', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	return start >= 0 && end > start ? source.slice(start, end) : '';
}

const handleSaveSource = sourceBetween(
	toolbarSource,
	'export function handleSave(): void {',
	'export async function handleLoadDefault()',
);
const setupSaveSource = sourceBetween(
	domSource,
	'function setupSaveButton(): void {',
	'function setupLoadDefaultButton()',
);

assert.notEqual(handleSaveSource, '');
assert.notEqual(setupSaveSource, '');
assert.match(handleSaveSource, /isTauriRuntime\(\)[\s\S]*?saveJsonFromNativeDialog\(serialized\)/);
assert.match(setupSaveSource, /isTauriRuntime\(\)[\s\S]*?saveJsonFromNativeDialog\(serialized\)/);
assert.match(handleSaveSource, /let filename = 'optical_system_data\.json'/);
assert.match(setupSaveSource, /let filename = 'optical_system_data\.json'/);
assert.doesNotMatch(handleSaveSource, /\bprompt\s*\(/);
assert.doesNotMatch(setupSaveSource, /\bprompt\s*\(/);

console.log('Save dialog smoke: PASS');