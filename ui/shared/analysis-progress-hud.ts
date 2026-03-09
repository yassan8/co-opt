type ProgressUpdate = {
  label?: string;
  percent?: number | null;
};

type ProgressElements = {
  wrap: HTMLDivElement;
  label: HTMLDivElement;
  prog: HTMLProgressElement;
};

const HUD_WRAP_ID = 'analysis-progress-wrap';
const HUD_LABEL_ID = 'analysis-progress-label';
const HUD_BAR_ID = 'analysis-progress-bar';

let elsCache: ProgressElements | null = null;
let throttleState: { label: string; value: number; max: number; at: number } | null = null;
let visibleTimer: number | null = null;

function ensureHud(): ProgressElements | null {
  if (elsCache) return elsCache;

  const existingWrap = document.getElementById(HUD_WRAP_ID) as HTMLDivElement | null;
  const existingLabel = document.getElementById(HUD_LABEL_ID) as HTMLDivElement | null;
  const existingBar = document.getElementById(HUD_BAR_ID);
  if (existingWrap && existingLabel && existingBar instanceof HTMLProgressElement) {
    elsCache = { wrap: existingWrap, label: existingLabel, prog: existingBar };
    return elsCache;
  }

  const wrap = document.createElement('div');
  wrap.id = HUD_WRAP_ID;
  wrap.className = 'analysis-progress-wrap';
  wrap.style.display = 'none';

  const label = document.createElement('div');
  label.id = HUD_LABEL_ID;
  label.className = 'analysis-progress-label';
  label.textContent = '';

  const prog = document.createElement('progress');
  prog.id = HUD_BAR_ID;
  prog.className = 'analysis-progress-bar';
  prog.max = 100;
  prog.value = 0;

  wrap.appendChild(label);
  wrap.appendChild(prog);
  document.body.appendChild(wrap);

  elsCache = { wrap, label, prog };
  return elsCache;
}

export function showAnalysisProgressHud(label = 'Computing analysis...', delayMs = 180): void {
  const els = ensureHud();
  if (!els) return;

  if (visibleTimer !== null) {
    clearTimeout(visibleTimer);
    visibleTimer = null;
  }

  if (delayMs <= 0) {
    els.wrap.style.display = 'block';
  } else {
    visibleTimer = window.setTimeout(() => {
      visibleTimer = null;
      try {
        els.wrap.style.display = 'block';
      } catch (_) {}
    }, delayMs);
  }

  updateAnalysisProgressHud({ label, percent: null });
}

export function updateAnalysisProgressHud(update: ProgressUpdate): void {
  const els = ensureHud();
  if (!els) return;

  const label = String(update?.label ?? 'Computing analysis...');
  const numeric = Number(update?.percent);
  const hasPercent = Number.isFinite(numeric);
  const value = hasPercent ? Math.max(0, Math.min(100, numeric)) : 0;
  const now = Date.now();

  const prev = throttleState;
  if (prev) {
    const sameLabel = prev.label === label;
    const sameValue = prev.value === value;
    const progressRateLimited = sameLabel && !sameValue && (now - prev.at) < 120;
    if ((sameLabel && sameValue) || progressRateLimited) {
      return;
    }
  }

  els.label.textContent = label;
  if (hasPercent) {
    els.prog.max = 100;
    els.prog.value = value;
    els.prog.removeAttribute('data-indeterminate');
  } else {
    els.prog.value = 0;
    els.prog.setAttribute('data-indeterminate', '1');
  }

  throttleState = { label, value, max: 100, at: now };
}

export function hideAnalysisProgressHud(): void {
  if (visibleTimer !== null) {
    clearTimeout(visibleTimer);
    visibleTimer = null;
  }

  const els = ensureHud();
  if (!els) return;
  els.wrap.style.display = 'none';
  throttleState = null;
}
