import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyResult, summarize } from './result-policy.mjs';

const classify = (output, extra = {}) => classifyResult({ code: 0, output, ...extra });
test('only explicit successful results pass', () => {
  assert.equal(classify('log\n{"ok":true}').status, 'pass');
  assert.equal(classify('').status, 'fail');
  assert.equal(classify('{"ok":false}').status, 'fail');
  assert.equal(classify('{"ok":true}', { code: 1 }).status, 'fail');
});
test('a missing fixture or a skipped diagnostic never passes', () => {
  assert.equal(classify('{"skipped":true,"reason":"missing fixture"}').status, 'blocked');
  assert.equal(classify('SKIP fixture\n{"ok":true}').status, 'blocked');
});
test('timeout, launch failure, and zero Rust tests stay distinct', () => {
  assert.equal(classify('{"ok":true}', { timedOut: true }).status, 'fail');
  assert.equal(classify('', { error: new Error('spawn denied') }).status, 'blocked');
  assert.equal(classify('test result: ok. 0 passed', { contract: 'rust' }).status, 'fail');
  assert.equal(classify('test result: ok. 25 passed', { contract: 'rust' }).data.passedTests, 25);
});
test('summary cannot count unexecuted checks as passed', () => {
  assert.deepEqual(summarize(['pass', 'fail', 'blocked', 'pending'].map(status => ({ status }))),
    { pass: 1, fail: 1, blocked: 1, pending: 1 });
});
test('typecheck failures remain failures even if the production build passed', () => {
  assert.equal(classify('', { contract: 'typecheck' }).status, 'pass');
  const failed = classify('a.ts(1,1): error TS1234: Example\nb.ts(2,1): error TS5678: Example', { contract: 'typecheck', code: 2 });
  assert.equal(failed.status, 'fail');
  assert.equal(failed.data.errorCount, 2);
});
