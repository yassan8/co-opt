import assert from 'node:assert/strict';
import { selectEngineeringRunRequirements } from '../../analysis/engineering-requirement-selection.ts';

const stale = { systemRequirements: [{ id: 1, enabled: true, operand: 'PP1', target: 0 }] };
const latest = structuredClone(stale);
latest.systemRequirements[0].enabled = false;
const monitor = () => ({ id: '__monitor', operand: 'MTFA', analysisMonitor: true, configId: '2' });
assert.equal(selectEngineeringRunRequirements(stale, [], monitor).automatic, false);
const disabled = selectEngineeringRunRequirements(latest, [], monitor);
assert.equal(disabled.automatic, true, 'Disabling all Requirements after opening the window must use a monitor');
assert.equal(disabled.rows[0].operand, 'MTFA');
assert.equal(disabled.rows[0].configId, '2');
latest.systemRequirements.push({ id: 2, enabled: true, operand: 'EFFL', target: 50 });
assert.deepEqual(selectEngineeringRunRequirements(latest, ['2'], monitor).rows, [latest.systemRequirements[1]]);
assert.deepEqual(selectEngineeringRunRequirements(latest, ['deleted-requirement'], monitor).rows, [latest.systemRequirements[1]]);
assert.equal(selectEngineeringRunRequirements(latest, ['1'], monitor).rows[0].id, 2, 'A disabled selected row must not be evaluated');
assert.equal(stale.systemRequirements[0].enabled, true, 'Selection must not mutate input snapshots');
assert.equal(selectEngineeringRunRequirements({ systemRequirements: [] }, [], monitor).automatic, true);
console.log(JSON.stringify({ ok: true, cases: ['fresh enabled flags', 'fresh selected target', 'deleted IDs', 'empty rows', 'no input mutation'] }, null, 2));
