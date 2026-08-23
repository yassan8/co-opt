import fs from 'node:fs/promises';
import path from 'node:path';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const prettyMetric = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (value === 0) return '0';
    if (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e5) return value.toExponential(4);
    return Number(value.toPrecision(8)).toString();
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(prettyMetric).join(', ');
  if (typeof value === 'object' && Object.hasOwn(value, 'actual')) {
    return `${prettyMetric(value.actual)} (delta ${prettyMetric(value.delta)}, tol ${prettyMetric(value.tolerance)})`;
  }
  return JSON.stringify(value);
};

function flattenMetrics(value, prefix = '', output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'actual')) {
    output.push([prefix || 'value', prettyMetric(value)]);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenMetrics(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

export async function writeVerificationReport(report, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, 'analysis-verification-latest.json');
  const htmlPath = path.join(outputDirectory, 'analysis-verification-latest.html');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const stageCards = report.stages.map((stage) => {
    const checkRows = (stage.results ?? []).map((check) => {
      const metricRows = flattenMetrics(check.metrics).slice(0, 12);
      const details = metricRows.length
        ? `<dl>${metricRows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
        : (check.error ? `<p class="error">${escapeHtml(check.error)}</p>` : '');
      return `<article class="check ${escapeHtml(check.status)}">
        <div class="check-heading"><span class="badge ${escapeHtml(check.status)}">${escapeHtml(check.status)}</span><h3>${escapeHtml(check.title)}</h3></div>
        <p>${escapeHtml(check.domain)} · ${escapeHtml(check.reference)} · ${Number(check.durationMs ?? 0).toFixed(1)} ms</p>
        ${details}
      </article>`;
    }).join('');

    const planned = stage.resultStatus === 'pending'
      ? `<ul>${stage.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join('')}</ul>`
      : '';
    return `<section>
      <div class="stage-heading"><div><span class="stage-order">${stage.order}</span><h2>${escapeHtml(stage.title)}</h2></div><span class="stage-status ${escapeHtml(stage.resultStatus)}">${escapeHtml(stage.resultStatus)}</span></div>
      <p>${escapeHtml(stage.description)}</p>
      ${checkRows || planned}
    </section>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>co-opt Analysis Verification</title>
<style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#17233b;background:#f3f6fb}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;padding:32px 24px 64px}header{display:flex;gap:24px;justify-content:space-between;align-items:flex-end;margin-bottom:24px}h1{font-size:28px;margin:0 0 8px}h2,h3,p{margin-top:0}.summary{display:grid;grid-template-columns:repeat(4,minmax(90px,1fr));gap:8px}.summary div,section{background:#fff;border:1px solid #dce4f0;border-radius:14px}.summary div{padding:10px 14px}.summary strong{display:block;font-size:22px}.summary span{color:#65728a;font-size:12px}section{padding:20px;margin-top:14px}.stage-heading,.stage-heading>div,.check-heading{display:flex;align-items:center;gap:10px}.stage-heading{justify-content:space-between}.stage-order{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#edf2f9;font-weight:700}.stage-heading h2,.check-heading h3{margin:0}.stage-status,.badge{font-size:11px;font-weight:700;text-transform:uppercase;border-radius:999px;padding:5px 9px;background:#e9edf4;color:#546078}.pass{--accent:#16875b}.fail{--accent:#cc3d4a}.pending{--accent:#78859b}.stage-status.pass,.badge.pass{background:#dff5e9;color:#116c49}.stage-status.fail,.badge.fail{background:#fee8ea;color:#a82533}.stage-status.pending{background:#eef1f5;color:#65728a}.check{border-left:4px solid var(--accent);padding:14px 16px;margin-top:12px;background:#fbfcfe;border-radius:8px}.check p{color:#65728a;font-size:12px;margin:7px 0 0}.check h3{font-size:15px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:6px 16px;margin:12px 0 0}dl div{min-width:0}dt{font-size:11px;color:#748198}dd{margin:2px 0 0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.error{color:#a82533!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.meta{color:#65728a;font-size:13px}@media(max-width:760px){header{display:block}.summary{margin-top:16px;grid-template-columns:repeat(2,1fr)}}
</style></head><body><main>
<header><div><h1>co-opt Analysis Verification</h1><p class="meta">${escapeHtml(report.generatedAt)} · profile ${escapeHtml(report.profile)}</p></div>
<div class="summary"><div><strong>${report.summary.total}</strong><span>checks</span></div><div><strong>${report.summary.passed}</strong><span>passed</span></div><div><strong>${report.summary.failed}</strong><span>failed</span></div><div><strong>${Number(report.summary.durationMs).toFixed(0)}</strong><span>ms</span></div></div></header>
${stageCards}
</main></body></html>`;

  await fs.writeFile(htmlPath, html, 'utf8');
  return { jsonPath, htmlPath };
}
