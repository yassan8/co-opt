// An exited process is not evidence that the requested checks actually ran.
export function parseFinalJson(output) {
  const source = String(output).trim();
  const starts = [...source.matchAll(/(?:^|\n)(?=\{)/g)].map(match => match.index + (source[match.index] === '\n' ? 1 : 0));
  for (const start of starts.reverse()) {
    try { return JSON.parse(source.slice(start)); } catch { /* Try the preceding JSON block. */ }
  }
  return null;
}

export function classifyResult({ code, error, timedOut, output, contract = 'ok', marker }) {
  if (timedOut) return { status: 'fail', reason: 'Time limit exceeded; this is not a completed calculation.' };
  if (error) return { status: 'blocked', reason: String(error.message ?? error) };
  if (code !== 0) return { status: 'fail', reason: `Process exited ${code}. See the saved log.`,
    ...(contract === 'typecheck' ? { data: { errorCount: [...String(output).matchAll(/error TS\d+:/g)].length } } : {}),
  };
  const data = parseFinalJson(output);
  if (data?.skipped === true || /(?:^|\n)\s*SKIP(?:PED)?\b/i.test(output)) {
    return { status: 'blocked', reason: data?.reason ?? 'Diagnostic skipped its checks.' };
  }
  if (data?.ok === false || data?.status === 'FAIL') return { status: 'fail', reason: 'Diagnostic reported failure.', data };
  if (contract === 'ok') {
    return data?.ok === true
      ? { status: 'pass', data }
      : { status: 'fail', reason: 'Missing explicit ok=true result.' };
  }
  if (contract === 'status') return data?.status === 'PASS'
    ? { status: 'pass', data } : { status: 'fail', reason: 'Missing explicit PASS result.' };
  if (contract === 'marker') return String(output).split(/\r?\n/).includes(marker)
    ? { status: 'pass' } : { status: 'fail', reason: 'Expected completion marker was not emitted.' };
  if (contract === 'rust') {
    const passed = [...String(output).matchAll(/test result: ok\. (\d+) passed/g)].reduce((n, m) => n + Number(m[1]), 0);
    return passed > 0 ? { status: 'pass', data: { passedTests: passed } }
      : { status: 'fail', reason: 'No executed Rust tests were reported.' };
  }
  if (contract === 'assembly') return Array.isArray(data?.detector) && data.detector.length === 2
    ? { status: 'pass', data } : { status: 'fail', reason: 'Missing assembly assertion report.' };
  if (contract === 'build') return /built in /.test(output)
    ? { status: 'pass' } : { status: 'fail', reason: 'Production build did not finish.' };
  if (contract === 'typecheck') return { status: 'pass', data: { errorCount: 0 } };
  return { status: 'fail', reason: `Unknown result contract: ${contract}` };
}

export function summarize(results) {
  const counts = { pass: 0, fail: 0, blocked: 0, pending: 0 };
  for (const result of results) {
    if (!(result.status in counts)) throw new Error(`Unknown status: ${result.status}`);
    counts[result.status]++;
  }
  return counts;
}
