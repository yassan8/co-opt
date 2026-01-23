/**
 * Suggest Design Intent (B案: 複数候補 + 比較)
 *
 * - 既存UIの Suggest ボタンから呼ばれることを想定
 * - 破壊的変更を避けるため、評価は window.__cooptBlocksOverride を使って非永続に行う
 * - 結果は System Data (#system-data) にテキスト出力
 */

import { expandBlocksToOpticalSystemRows } from '../data/block-schema.js';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function nowString() {
  try {
    return new Date().toLocaleString();
  } catch {
    return String(Date.now());
  }
}

function getActiveConfig() {
  try {
    const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations'));
    const activeId = systemConfig?.activeConfigId;
    const cfg = systemConfig?.configurations?.find(c => c && c.id === activeId) || systemConfig?.configurations?.[0];
    return { systemConfig, cfg };
  } catch {
    return { systemConfig: null, cfg: null };
  }
}

function getSystemDataTextarea() {
  if (typeof document === 'undefined') return null;
  return document.getElementById('system-data');
}

function tryGetLocalStorageArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickPreservedObjectThickness(cfg, systemConfig, configId) {
  try {
    const hasObjectPlane = Array.isArray(cfg?.blocks) && cfg.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectPlane');
    if (hasObjectPlane) return undefined;
  } catch (_) {}

  // Prefer persisted config.opticalSystem[0].thickness.
  try {
    const v = cfg?.opticalSystem?.[0]?.thickness;
    const s = String(v ?? '').trim();
    if (s !== '') return v;
  } catch (_) {}

  // If this is the active config, fall back to current UI table snapshot.
  try {
    if (systemConfig && String(systemConfig.activeConfigId) === String(configId)) {
      const rows = tryGetLocalStorageArray('OpticalSystemTableData');
      const v = rows?.[0]?.thickness;
      const s = String(v ?? '').trim();
      if (s !== '') return v;
    }
  } catch (_) {}

  return undefined;
}

async function applyBlocksToActiveConfig(recommendedBlocks) {
  const { systemConfig, cfg } = getActiveConfig();
  if (!systemConfig || !cfg) {
    return { ok: false, reason: 'systemConfigurations / active configuration が見つかりません。' };
  }
  if (!Array.isArray(recommendedBlocks) || recommendedBlocks.length === 0) {
    return { ok: false, reason: 'Recommendation blocks が空です。' };
  }

  const configId = cfg.id;
  const preservedThickness = pickPreservedObjectThickness(cfg, systemConfig, configId);

  // Apply
  cfg.blocks = deepClone(recommendedBlocks);

  // Update expanded optical system (derived)
  try {
    const exp = expandBlocksToOpticalSystemRows(cfg.blocks);
    if (exp && Array.isArray(exp.rows)) {
      if (preservedThickness !== undefined && exp.rows[0] && typeof exp.rows[0] === 'object') {
        exp.rows[0].thickness = preservedThickness;
      }
      cfg.opticalSystem = exp.rows;
    }
  } catch (_) {
    // keep cfg.opticalSystem as-is if expand fails
  }

  try {
    localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
  } catch {
    return { ok: false, reason: 'localStorage への保存に失敗しました。' };
  }

  // Refresh UI
  try {
    if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
      await window.ConfigurationManager.loadActiveConfigurationToTables({
        applyToUI: true,
        suppressOpticalSystemDataChanged: true,
      });
    }
  } catch (_) {}
  try {
    if (typeof window.refreshBlockInspector === 'function') window.refreshBlockInspector();
  } catch (_) {}
  try {
    if (window.meritFunctionEditor && typeof window.meritFunctionEditor.calculateMerit === 'function') {
      window.meritFunctionEditor.calculateMerit();
    }
  } catch (_) {}

  return { ok: true };
}

function toNumberOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    if (/^inf(inity)?$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mutateLensParams(blocks, { radiusScale = 1.0, thicknessScale = 1.0, gapScale = 1.0 } = {}) {
  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const type = String(b.blockType ?? '').trim();
    const p = isPlainObject(b.parameters) ? b.parameters : null;
    if (!p) continue;

    if (type === 'Lens' || type === 'PositiveLens') {
      const fr = toNumberOrNull(p.frontRadius);
      const br = toNumberOrNull(p.backRadius);
      const ct = toNumberOrNull(p.centerThickness);
      if (fr !== null) p.frontRadius = fr * radiusScale;
      if (br !== null) p.backRadius = br * radiusScale;
      if (ct !== null) p.centerThickness = Math.max(1e-6, ct * thicknessScale);
    } else if (type === 'AirGap') {
      const t = toNumberOrNull(p.thickness);
      if (t !== null) p.thickness = Math.max(0, t * gapScale);
    } else if (type === 'Stop') {
      // keep
    }
  }
}

function mutateLensBendingByCurvature(blocks, { deltaCurvature = 0 } = {}) {
  const eps = 1e-12;
  const maxAbsCurv = 1e6;

  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const type = String(b.blockType ?? '').trim();
    if (!(type === 'Lens' || type === 'PositiveLens')) continue;
    const p = isPlainObject(b.parameters) ? b.parameters : null;
    if (!p) continue;

    const fr = toNumberOrNull(p.frontRadius);
    const br = toNumberOrNull(p.backRadius);
    if (fr === null || br === null) continue;
    if (!Number.isFinite(fr) || !Number.isFinite(br)) continue;
    if (Math.abs(fr) < eps || Math.abs(br) < eps) continue;

    const c1 = 1 / fr;
    const c2 = 1 / br;
    const c1n = c1 + deltaCurvature;
    const c2n = c2 + deltaCurvature;
    if (!Number.isFinite(c1n) || !Number.isFinite(c2n)) continue;
    if (Math.abs(c1n) < eps || Math.abs(c2n) < eps) continue;
    if (Math.abs(c1n) > maxAbsCurv || Math.abs(c2n) > maxAbsCurv) continue;

    p.frontRadius = 1 / c1n;
    p.backRadius = 1 / c2n;
  }
}

function mutateLensAsymmetricBend(blocks, { deltaCurvature = 0 } = {}) {
  const eps = 1e-12;
  const maxAbsCurv = 1e6;

  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const type = String(b.blockType ?? '').trim();
    if (!(type === 'Lens' || type === 'PositiveLens')) continue;
    const p = isPlainObject(b.parameters) ? b.parameters : null;
    if (!p) continue;

    const fr = toNumberOrNull(p.frontRadius);
    const br = toNumberOrNull(p.backRadius);
    if (fr === null || br === null) continue;
    if (!Number.isFinite(fr) || !Number.isFinite(br)) continue;
    if (Math.abs(fr) < eps || Math.abs(br) < eps) continue;

    const c1 = 1 / fr;
    const c2 = 1 / br;
    const c1n = c1 + deltaCurvature;
    const c2n = c2 - deltaCurvature;
    if (!Number.isFinite(c1n) || !Number.isFinite(c2n)) continue;
    if (Math.abs(c1n) < eps || Math.abs(c2n) < eps) continue;
    if (Math.abs(c1n) > maxAbsCurv || Math.abs(c2n) > maxAbsCurv) continue;

    p.frontRadius = 1 / c1n;
    p.backRadius = 1 / c2n;
  }
}

function mutateAlternateGaps(blocks, { oddScale = 1.0, evenScale = 1.0 } = {}) {
  let gapIndex = 0;
  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const type = String(b.blockType ?? '').trim();
    if (type !== 'AirGap') continue;
    const p = isPlainObject(b.parameters) ? b.parameters : null;
    if (!p) continue;
    const t = toNumberOrNull(p.thickness);
    if (t === null) continue;
    const scale = (gapIndex % 2 === 0) ? oddScale : evenScale;
    p.thickness = Math.max(0, t * scale);
    gapIndex++;
  }
}

function mutateStopSemiDiameter(blocks, { scale = 1.0 } = {}) {
  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const type = String(b.blockType ?? '').trim();
    if (type !== 'Stop') continue;
    const p = isPlainObject(b.parameters) ? b.parameters : null;
    if (!p) continue;
    const sd = toNumberOrNull(p.semiDiameter);
    if (sd === null) continue;
    p.semiDiameter = Math.max(1e-9, sd * scale);
  }
}

function diffBlocksBrief(baseBlocks, candBlocks, maxLines = 12) {
  const out = [];
  const byIdBase = new Map();
  for (const b of baseBlocks) {
    if (!isPlainObject(b)) continue;
    const id = String(b.blockId ?? '');
    if (!id) continue;
    byIdBase.set(id, b);
  }

  for (const cb of candBlocks) {
    if (!isPlainObject(cb)) continue;
    const id = String(cb.blockId ?? '');
    if (!id) continue;
    const bb = byIdBase.get(id);
    if (!bb) {
      out.push(`+ ${id} (${cb.blockType})`);
      if (out.length >= maxLines) break;
      continue;
    }

    const bp = isPlainObject(bb.parameters) ? bb.parameters : null;
    const cp = isPlainObject(cb.parameters) ? cb.parameters : null;
    if (!bp || !cp) continue;

    const keys = ['frontRadius', 'backRadius', 'centerThickness', 'thickness', 'semiDiameter', 'material'];
    for (const k of keys) {
      if (!(k in cp) && !(k in bp)) continue;
      const a = bp[k];
      const b = cp[k];
      const aStr = String(a ?? '');
      const bStr = String(b ?? '');
      if (aStr !== bStr) {
        out.push(`~ ${id}.${k}: ${aStr} → ${bStr}`);
        if (out.length >= maxLines) break;
      }
    }
    if (out.length >= maxLines) break;
  }

  return out;
}

function evaluateCandidateByOverride({ configId, blocks }) {
  const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
  if (!editor) return { ok: false, reason: 'meritFunctionEditor is not available.' };

  const prev = (typeof window !== 'undefined') ? window.__cooptBlocksOverride : null;
  const map = (prev && typeof prev === 'object') ? { ...prev } : {};
  map[String(configId)] = blocks;
  window.__cooptBlocksOverride = map;

  try {
    if (typeof editor.calculateMeritBreakdownOnly === 'function') {
      const br = editor.calculateMeritBreakdownOnly();
      const total = Number(br?.total);
      const terms = Array.isArray(br?.terms) ? br.terms : [];
      return { ok: true, total: Number.isFinite(total) ? total : Infinity, terms };
    }
    if (typeof editor.calculateMeritValueOnly === 'function') {
      const m = Number(editor.calculateMeritValueOnly());
      return { ok: true, total: Number.isFinite(m) ? m : Infinity, terms: [] };
    }
    return { ok: false, reason: 'No merit evaluator available.' };
  } finally {
    if (typeof window !== 'undefined') {
      if (prev && typeof prev === 'object') {
        window.__cooptBlocksOverride = prev;
      } else {
        try { delete window.__cooptBlocksOverride; } catch (_) {}
      }
    }
  }
}

function pickKeyMetrics(terms) {
  const out = {};
  for (const t of terms) {
    const op = String(t?.operand ?? '');
    if (!op) continue;
    if (op === 'EFFL' && out.EFFL === undefined) out.EFFL = t?.value;
    if (op === 'TOT3_SPH' && out.TOT3_SPH === undefined) out.TOT3_SPH = t?.value;
    if (op === 'TOT3_COMA' && out.TOT3_COMA === undefined) out.TOT3_COMA = t?.value;
    if (op === 'TOT3_ASTI' && out.TOT3_ASTI === undefined) out.TOT3_ASTI = t?.value;
    if (op === 'TOT3_FCUR' && out.TOT3_FCUR === undefined) out.TOT3_FCUR = t?.value;
    if (op === 'TOT3_DIST' && out.TOT3_DIST === undefined) out.TOT3_DIST = t?.value;
    if (op === 'TOT_LCA' && out.TOT_LCA === undefined) out.TOT_LCA = t?.value;
    if (op === 'TOT_TCA' && out.TOT_TCA === undefined) out.TOT_TCA = t?.value;
  }
  return out;
}

function formatNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(6) : String(v ?? '-');
}

function clampNumber(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function median(values) {
  const a = (Array.isArray(values) ? values : []).filter(v => Number.isFinite(Number(v))).map(Number).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const mid = Math.floor(a.length / 2);
  if (a.length % 2 === 1) return a[mid];
  return 0.5 * (a[mid - 1] + a[mid]);
}

function estimateCurvatureStepFromBlocks(blocks) {
  // Heuristic: scale delta curvature by typical lens curvature magnitude.
  // Falls back to legacy constant (0.002) if no lenses.
  const curvs = [];
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (!isPlainObject(b)) continue;
    const type = String(b.blockType ?? '').trim();
    if (!(type === 'Lens' || type === 'PositiveLens')) continue;
    const p = isPlainObject(b.parameters) ? b.parameters : null;
    if (!p) continue;
    const fr = toNumberOrNull(p.frontRadius);
    const br = toNumberOrNull(p.backRadius);
    if (fr !== null && Number.isFinite(fr) && fr !== 0) curvs.push(Math.abs(1 / fr));
    if (br !== null && Number.isFinite(br) && br !== 0) curvs.push(Math.abs(1 / br));
  }
  const med = median(curvs);
  if (!Number.isFinite(med) || med <= 0) return { small: 0.002, large: 0.004 };
  const small = clampNumber(0.02 * med, 1e-5, 0.005);
  const large = clampNumber(2 * small, 2e-5, 0.01);
  return { small, large };
}

function normalizeDesignType(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'balanced';
  if (s === 'tele' || s === 'telephoto' || s === 'tele-photo') return 'telephoto';
  if (s === 'wide' || s === 'wideangle' || s === 'wide-angle') return 'wide';
  if (s === 'balanced' || s === 'default') return 'balanced';
  return 'balanced';
}

function sortCandidatesByDesignType(candidates, designType) {
  const type = normalizeDesignType(designType);

  // Priority is a simple, deterministic ordering over tags.
  // This is intentionally conservative: it only changes which directions are tried first.
  const priorities = {
    balanced: ['global', 'bending_small', 'asym', 'gap', 'stop', 'bending_large', 'material'],
    telephoto: ['gap', 'asym', 'bending_small', 'global', 'stop', 'bending_large', 'material'],
    wide: ['stop', 'bending_small', 'asym', 'global', 'gap', 'bending_large', 'material'],
  };

  const order = priorities[type] || priorities.balanced;
  const rank = new Map(order.map((t, i) => [t, i]));

  const withIdx = (Array.isArray(candidates) ? candidates : []).map((c, idx) => ({ c, idx }));
  withIdx.sort((a, b) => {
    const ta = String(a.c?.tag ?? '');
    const tb = String(b.c?.tag ?? '');
    const ra = rank.has(ta) ? rank.get(ta) : 999;
    const rb = rank.has(tb) ? rank.get(tb) : 999;
    if (ra !== rb) return ra - rb;
    return a.idx - b.idx;
  });

  return withIdx.map(x => x.c);
}

function termLabel(t) {
  const id = (t && t.id !== undefined) ? String(t.id) : '?';
  const op = String(t?.operand ?? '');
  return `#${id} ${op || '(unknown)'}`;
}

function topContributorsLines(terms, k = 5) {
  const list = Array.isArray(terms) ? terms.slice() : [];
  list.sort((a, b) => Number(b?.term ?? 0) - Number(a?.term ?? 0));
  const out = [];
  for (const t of list.slice(0, k)) {
    const term = Number(t?.term);
    const impact = Number(t?.impactPct);
    out.push(`    - ${termLabel(t)}: term=${formatNum(term)}, impact=${formatNum(impact)}% (value=${formatNum(t?.value)}, target=${formatNum(t?.target)})`);
  }
  return out;
}

function topContributorsSummary(terms, k = 2) {
  const list = Array.isArray(terms) ? terms.slice() : [];
  list.sort((a, b) => Number(b?.term ?? 0) - Number(a?.term ?? 0));
  const picked = list.slice(0, Math.max(0, k));
  if (picked.length === 0) return '-';
  return picked.map(t => {
    const impact = Number(t?.impactPct);
    const pct = Number.isFinite(impact) ? `${impact.toFixed(1)}%` : '-';
    return `${termLabel(t)} ${pct}`;
  }).join(', ');
}

function deltaTermsSummary(baseTerms, candTerms, { improveK = 2, regressK = 1 } = {}) {
  const baseMap = termMapById(baseTerms);
  const candMap = termMapById(candTerms);
  const deltas = [];

  for (const [id, ct] of candMap.entries()) {
    const bt = baseMap.get(id);
    if (!bt) continue;
    const baseTerm = Number(bt?.term);
    const candTerm = Number(ct?.term);
    const d = candTerm - baseTerm;
    if (!Number.isFinite(d)) continue;
    deltas.push({ d, ct });
  }

  deltas.sort((a, b) => a.d - b.d);
  const improve = deltas.filter(x => x.d < 0).slice(0, Math.max(0, improveK));
  const regress = deltas.filter(x => x.d > 0).slice(-Math.max(0, regressK)).reverse();

  const improveStr = improve.length
    ? improve.map(x => `${termLabel(x.ct)} ${formatNum(x.d)}`).join(', ')
    : '-';
  const regressStr = regress.length
    ? regress.map(x => `${termLabel(x.ct)} +${formatNum(x.d)}`).join(', ')
    : '-';

  return { improveStr, regressStr };
}

function termMapById(terms) {
  const m = new Map();
  for (const t of (Array.isArray(terms) ? terms : [])) {
    const key = String(t?.id ?? '');
    if (!key) continue;
    m.set(key, t);
  }
  return m;
}

function compareTermsLines(baseTerms, candTerms, { kImprove = 3, kRegress = 2 } = {}) {
  const baseMap = termMapById(baseTerms);
  const candMap = termMapById(candTerms);
  const deltas = [];

  for (const [id, ct] of candMap.entries()) {
    const bt = baseMap.get(id);
    if (!bt) continue;
    const baseTerm = Number(bt?.term);
    const candTerm = Number(ct?.term);
    const d = candTerm - baseTerm;
    if (!Number.isFinite(d)) continue;
    deltas.push({ d, bt, ct });
  }

  deltas.sort((a, b) => a.d - b.d);
  const improve = deltas.filter(x => x.d < 0).slice(0, kImprove);
  const regress = deltas.filter(x => x.d > 0).slice(-kRegress).reverse();

  const out = [];
  if (improve.length > 0) {
    out.push('  Biggest improvements vs current (Δterm < 0):');
    for (const x of improve) {
      out.push(`    - ${termLabel(x.ct)}: Δterm=${formatNum(x.d)} (cur=${formatNum(x.bt?.term)} → cand=${formatNum(x.ct?.term)})`);
    }
  }
  if (regress.length > 0) {
    out.push('  Biggest regressions vs current (Δterm > 0):');
    for (const x of regress) {
      out.push(`    - ${termLabel(x.ct)}: Δterm=${formatNum(x.d)} (cur=${formatNum(x.bt?.term)} → cand=${formatNum(x.ct?.term)})`);
    }
  }
  return out;
}

function formatCandidateReport({ idx, title, intent, merit, metrics, diffs, baseTerms, candTerms }, explain = {}) {
  const lines = [];
  lines.push(`Candidate ${idx}: ${title}`);
  lines.push(`  Intent: ${intent}`);
  lines.push(`  Merit:  ${formatNum(merit)}`);

  const mKeys = Object.keys(metrics || {});
  if (mKeys.length > 0) {
    lines.push('  Key Metrics:');
    for (const k of mKeys) {
      lines.push(`    ${k}: ${formatNum(metrics[k])}`);
    }
  }

  if (diffs && diffs.length > 0) {
    lines.push('  Diffs (vs current):');
    for (const d of diffs) lines.push(`    ${d}`);
  }

  const topK = Number.isFinite(Number(explain.topK)) ? Number(explain.topK) : 5;
  const improveK = Number.isFinite(Number(explain.improveK)) ? Number(explain.improveK) : 3;
  const regressK = Number.isFinite(Number(explain.regressK)) ? Number(explain.regressK) : 2;

  if (Array.isArray(candTerms) && candTerms.length > 0) {
    lines.push('  Top contributors (candidate):');
    lines.push(...topContributorsLines(candTerms, topK));
  }
  if (Array.isArray(baseTerms) && baseTerms.length > 0 && Array.isArray(candTerms) && candTerms.length > 0) {
    lines.push(...compareTermsLines(baseTerms, candTerms, { kImprove: improveK, kRegress: regressK }));
  }

  return lines.join('\n');
}

function formatCandidateCompact({ idx, title, tag, merit, deltaMerit, baseTerms, candTerms }, explain = {}) {
  const topK = Number.isFinite(Number(explain.topK)) ? Number(explain.topK) : 2;
  const improveK = Number.isFinite(Number(explain.improveK)) ? Number(explain.improveK) : 2;
  const regressK = Number.isFinite(Number(explain.regressK)) ? Number(explain.regressK) : 1;

  const tagStr = String(tag ?? '').trim();
  const tagPart = tagStr ? ` [${tagStr}]` : '';
  const d = Number(deltaMerit);
  const dStr = Number.isFinite(d) ? (d >= 0 ? `+${formatNum(d)}` : `${formatNum(d)}`) : '-';

  const top = topContributorsSummary(candTerms, topK);
  const dt = deltaTermsSummary(baseTerms, candTerms, { improveK, regressK });

  const lines = [];
  lines.push(`C${idx}${tagPart}: ${title} | Merit ${formatNum(merit)} (Δ ${dStr})`);
  lines.push(`  Top: ${top}`);
  lines.push(`  Δterm: - ${dt.improveStr} | + ${dt.regressStr}`);
  return lines.join('\n');
}

function summarizeBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const t = String(b.blockType ?? '').trim();
    if (!t) continue;
    if (t === 'ImagePlane') continue;
    parts.push(`${t}${b.blockId ? `(${b.blockId})` : ''}`);
  }
  parts.push('ImagePlane');
  return parts.join(' → ');
}

export function runSuggestDesignIntent(options = {}) {
  const defaults = {
    candidateCount: 5,
    topK: 2,
    improveK: 2,
    regressK: 1,
    designType: 'balanced',
    outputMode: 'compact',
  };
  const userOpt = (typeof window !== 'undefined' && window.__cooptSuggestOptions && typeof window.__cooptSuggestOptions === 'object')
    ? window.__cooptSuggestOptions
    : {};
  const opt = { ...defaults, ...userOpt, ...(options && typeof options === 'object' ? options : {}) };

  const { systemConfig, cfg } = getActiveConfig();
  if (!systemConfig || !cfg) {
    alert('systemConfigurations / active configuration が見つかりません。');
    return;
  }
  if (!Array.isArray(cfg.blocks) || cfg.blocks.length === 0) {
    alert('Blocks がありません。Suggest は Blocks ベースで動作します。');
    return;
  }

  const configId = cfg.id;
  const baseBlocks = deepClone(cfg.blocks);

  const dC = estimateCurvatureStepFromBlocks(baseBlocks);

  // Evaluate current (baseline)
  const baseEval = evaluateCandidateByOverride({ configId, blocks: baseBlocks });
  const baseMerit = baseEval.ok ? baseEval.total : Infinity;
  const baseTerms = baseEval.ok ? (Array.isArray(baseEval.terms) ? baseEval.terms : []) : [];

  // Candidate generation: 方向の異なる入口を複数用意（AIなしでも探索の幅を持たせる）
  const candidates = [];

  {
    const blocks = deepClone(baseBlocks);
    mutateLensParams(blocks, { radiusScale: 0.95, thicknessScale: 1.0, gapScale: 1.02 });
    candidates.push({ title: 'Global bias A (R×0.95, gaps×1.02)', intent: 'やや強めパワー方向へ（近傍探索）', blocks, tag: 'global' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensParams(blocks, { radiusScale: 1.05, thicknessScale: 1.0, gapScale: 0.98 });
    candidates.push({ title: 'Global bias B (R×1.05, gaps×0.98)', intent: 'やや弱めパワー方向へ（別の局所解）', blocks, tag: 'global' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensBendingByCurvature(blocks, { deltaCurvature: +dC.small });
    candidates.push({ title: `Bending + (Δc=${formatNum(dC.small)})`, intent: '形状因子方向（小ステップ）', blocks, tag: 'bending_small' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensBendingByCurvature(blocks, { deltaCurvature: -dC.small });
    candidates.push({ title: `Bending - (Δc=-${formatNum(dC.small)})`, intent: '形状因子方向（小ステップ）', blocks, tag: 'bending_small' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensBendingByCurvature(blocks, { deltaCurvature: +dC.large });
    candidates.push({ title: `Bending ++ (Δc=${formatNum(dC.large)})`, intent: '形状因子方向（大ステップ）', blocks, tag: 'bending_large' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensBendingByCurvature(blocks, { deltaCurvature: -dC.large });
    candidates.push({ title: `Bending -- (Δc=-${formatNum(dC.large)})`, intent: '形状因子方向（大ステップ）', blocks, tag: 'bending_large' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensAsymmetricBend(blocks, { deltaCurvature: +dC.small });
    candidates.push({ title: `Asymmetric bend + (Δc=${formatNum(dC.small)})`, intent: '前後面の配分を変える（小ステップ）', blocks, tag: 'asym' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateLensAsymmetricBend(blocks, { deltaCurvature: -dC.small });
    candidates.push({ title: `Asymmetric bend - (Δc=${formatNum(dC.small)})`, intent: '前後面の配分を変える（小ステップ）', blocks, tag: 'asym' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateAlternateGaps(blocks, { oddScale: 1.05, evenScale: 0.95 });
    candidates.push({ title: 'Gap redistribute (odd×1.05, even×0.95)', intent: 'ギャップの再配分で探索（全体スケール以外）', blocks, tag: 'gap' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateStopSemiDiameter(blocks, { scale: 1.02 });
    candidates.push({ title: 'Stop +2% (semiDiameter×1.02)', intent: 'ストップ径の微調整で反応を見る', blocks, tag: 'stop' });
  }
  {
    const blocks = deepClone(baseBlocks);
    mutateStopSemiDiameter(blocks, { scale: 0.98 });
    candidates.push({ title: 'Stop -2% (semiDiameter×0.98)', intent: '逆方向のストップ径微調整で反応を見る', blocks, tag: 'stop' });
  }
  {
    const blocks = deepClone(baseBlocks);
    // 形状固定で材料探索の入口（material自体は変えない：OptimizeでV+候補を使う想定）
    candidates.push({ title: 'Material exploration preset', intent: '形状固定でガラス変更の余地を評価（入口）', blocks, tag: 'material' });
  }

  const orderedCandidates = sortCandidatesByDesignType(candidates, opt.designType);
  const requestedCount = Number(opt.candidateCount);
  const candidateCount = Number.isFinite(requestedCount) ? Math.max(1, Math.floor(requestedCount)) : orderedCandidates.length;
  const selectedCandidates = orderedCandidates.slice(0, candidateCount);

  const results = [];
  for (let i = 0; i < selectedCandidates.length; i++) {
    const c = selectedCandidates[i];
    const ev = evaluateCandidateByOverride({ configId, blocks: c.blocks });
    const total = ev.ok ? ev.total : Infinity;
    const metrics = ev.ok ? pickKeyMetrics(ev.terms) : {};
    const diffs = diffBlocksBrief(baseBlocks, c.blocks, 12);
    const candTerms = ev.ok ? (Array.isArray(ev.terms) ? ev.terms : []) : [];
    results.push({ idx: i + 1, ...c, ok: ev.ok, merit: total, deltaMerit: total - baseMerit, metrics, diffs, baseTerms, candTerms });
  }

  // Pick recommendation
  let best = results[0];
  for (const r of results) {
    if (r.merit < best.merit) best = r;
  }

  // Store last suggestion for one-click apply (non-persistent until user applies).
  try {
    window.__cooptLastSuggest = {
      version: 1,
      createdAt: Date.now(),
      configId: String(configId),
      recommendation: {
        idx: best.idx,
        title: best.title,
        blocks: deepClone(best.blocks)
      },
      candidates: results.map(r => ({ idx: r.idx, title: r.title, merit: r.merit }))
    };
  } catch (_) {}

  // Output
  const lines = [];
  lines.push('=== Suggest (B案: Candidates + Compare) ===');
  lines.push(`Time: ${nowString()}`);
  lines.push(`Config: ${cfg.name || '(unnamed)'} (ID: ${String(cfg.id)})`);
  lines.push(`Blocks: ${summarizeBlocks(baseBlocks)}`);
  lines.push('');
  lines.push(`Current Merit: ${formatNum(baseMerit)}`);
  if (baseTerms.length > 0) {
    lines.push(`Current Top: ${topContributorsSummary(baseTerms, Number(opt.topK) || 2)}`);
  }
  lines.push(`Suggest Options: designType=${normalizeDesignType(opt.designType)}, candidates=${selectedCandidates.length}, outputMode=${String(opt.outputMode || 'compact')}, topK=${opt.topK}, improveK=${opt.improveK}, regressK=${opt.regressK}`);
  lines.push(`Heuristic: Δc small=${formatNum(dC.small)}, large=${formatNum(dC.large)} (from current lens curvatures)`);
  lines.push('');

  for (const r of results) {
    if (String(opt.outputMode || '').toLowerCase() === 'detailed') {
      lines.push(formatCandidateReport(r, { topK: opt.topK, improveK: opt.improveK, regressK: opt.regressK }));
    } else {
      lines.push(formatCandidateCompact(r, { topK: opt.topK, improveK: opt.improveK, regressK: opt.regressK }));
    }
    lines.push('');
  }

  lines.push(`Recommendation: Candidate ${best.idx} (${best.title})`);
  lines.push('Next: このCandidateを初期値として Optimize を実行（数値V→収束後 material V）。');

  // Also sanity-check expand (so user can see if blocks are expandable)
  try {
    const exp = expandBlocksToOpticalSystemRows(best.blocks);
    if (exp?.issues?.length) {
      lines.push('');
      lines.push('Expand Issues (best candidate):');
      for (const iss of exp.issues.slice(0, 8)) {
        lines.push(`- [${iss.severity}] ${iss.phase}: ${iss.message}`);
      }
      if (exp.issues.length > 8) lines.push(`- ... (${exp.issues.length - 8} more)`);
    }
  } catch (_) {}

  const text = lines.join('\n');
  const ta = getSystemDataTextarea();
  if (ta) {
    ta.value = text;
  } else {
    console.log(text);
    alert('Suggest 出力先(#system-data)が見つからないため、consoleに出力しました。');
  }
}

// Register global hook for the existing Suggest button
if (typeof window !== 'undefined') {
  window.SuggestDesignIntent = {
    run: runSuggestDesignIntent,
    applyLastRecommendation: async () => {
      const last = window.__cooptLastSuggest;
      const blocks = last?.recommendation?.blocks;
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return { ok: false, reason: 'Suggestion の Recommendation がありません。先に Suggest を実行してください。' };
      }
      return applyBlocksToActiveConfig(blocks);
    }
  };
}
