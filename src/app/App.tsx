import { useEffect, useRef, useState } from "react";
import { DistortionAnalysisPage } from './DistortionAnalysisPage';
import { MtfAnalysisPage } from './MtfAnalysisPage';
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";
import { SystemDataPanel } from "../ui/components/LegacyPanels";
import { requestRefreshBlockInspector } from "../../core/window-facade.ts";
import { handleOpenSettings } from "../../ui/toolbar-handlers";
import { runOptimizationMVP } from "../../optimization/optimizer-mvp.ts";
import { listDesignVariablesFromBlocks } from "../../optimization/design-variables.ts";
import { clearOptimizerStop, readDesktopSetting, writeDesktopSetting } from "../../src/desktop/ipc/client.ts";
import { isTauriRuntime } from "../../src/desktop/runtime.ts";

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const RENDER_SHOW_LABELS_KEY = 'coopt.render.showDesignIntentLabels';
const RENDER_SCALE_BAR_TARGET_WIDTH_PX = 240;
const RENDER_SURFACE_COLOR_PALETTE: Array<{ name: string; hex: string }> = [
  { name: 'Light Pink', hex: '#FFB6C1' },
  { name: 'Light Red', hex: '#FF6B6B' },
  { name: 'Light Orange', hex: '#FFA07A' },
  { name: 'Light Amber', hex: '#FFBF00' },
  { name: 'Light Yellow', hex: '#FFFF99' },
  { name: 'Light Lime', hex: '#CCFF66' },
  { name: 'Light Green', hex: '#90EE90' },
  { name: 'Light Mint', hex: '#98FF98' },
  { name: 'Light Cyan', hex: '#AFEEEE' },
  { name: 'Light Sky', hex: '#87CEEB' },
  { name: 'Light Blue', hex: '#ADD8E6' },
  { name: 'Light Indigo', hex: '#9FA8DA' },
  { name: 'Light Purple', hex: '#DDA0DD' },
  { name: 'Light Lavender', hex: '#E6E6FA' },
  { name: 'Light Peach', hex: '#FFDAB9' },
  { name: 'Light Gray', hex: '#D3D3D3' },
];

type RenderLensColorTarget = {
  label: string;
  key: string;
  keys: string[];
  frontSurfaceIndex0: number;
};

function isPlainObject(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseColorToInt(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(0xffffff, Math.floor(value)));
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const expanded = hex.split('').map((ch) => ch + ch).join('');
      const n = Number.parseInt(expanded, 16);
      return Number.isFinite(n) ? n : null;
    }
    if (hex.length === 6) {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  if (/^0x[0-9a-f]+$/i.test(s)) {
    const n = Number.parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, Math.floor(n))) : null;
}

function colorIntToHexString(value: number | null, fallback = '#00CCFF'): string {
  if (!Number.isFinite(Number(value))) return fallback;
  const safe = Math.max(0, Math.min(0xffffff, Math.floor(Number(value))));
  return `#${safe.toString(16).padStart(6, '0').toUpperCase()}`;
}

function surfaceColorKeyStable(surface: any, index0: number): string {
  try {
    const bid = String(surface?._blockId ?? '').trim();
    const role = String(surface?._surfaceRole ?? '').trim();
    if (bid && role) return `p:${bid}|${role}`;
  } catch (_) {}
  try {
    const sid = Number(surface?.id);
    if (Number.isFinite(sid)) return `id:${Math.floor(sid)}`;
  } catch (_) {}
  return `i:${Math.floor(Number(index0) || 0)}`;
}

function surfaceColorKeysAll(surface: any, index0: number): string[] {
  const keys: string[] = [];
  try {
    const bid = String(surface?._blockId ?? '').trim();
    const role = String(surface?._surfaceRole ?? '').trim();
    if (bid && role) keys.push(`p:${bid}|${role}`);
  } catch (_) {}
  try {
    const sid = Number(surface?.id);
    if (Number.isFinite(sid)) keys.push(`id:${Math.floor(sid)}`);
  } catch (_) {}
  keys.push(`i:${Math.floor(Number(index0) || 0)}`);
  return [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))];
}

function resolveOverrideColorHex(overrides: Record<string, any>, keys: string[]): string | null {
  for (const key of keys) {
    const parsed = parseColorToInt(overrides?.[key]);
    if (parsed !== null) return colorIntToHexString(parsed);
  }
  return null;
}

function loadSurfaceColorOverridesSafe(): Record<string, any> {
  try {
    const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveSurfaceColorOverridesSafe(overrides: Record<string, any>): void {
  try {
    localStorage.setItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch (_) {}
}

function formatRenderScaleLabelMm(distanceMm: number): string {
  const mm = Number(distanceMm);
  if (!Number.isFinite(mm) || mm <= 0) return 'Scale unavailable';
  if (mm >= 1000) {
    const m = mm / 1000;
    return m >= 10 ? `${Math.round(m)} m` : `${m.toFixed(1)} m`;
  }
  if (mm >= 1) {
    if (mm >= 100) return `${Math.round(mm)} mm`;
    if (mm >= 10) return `${mm.toFixed(1)} mm`;
    return `${mm.toFixed(2)} mm`;
  }
  const um = mm * 1000;
  if (um >= 100) return `${Math.round(um)} μm`;
  if (um >= 10) return `${um.toFixed(1)} μm`;
  return `${um.toFixed(2)} μm`;
}

function chooseRenderScaleBar(mmPerPixel: number): { label: string; widthPx: number } {
  const mmpp = Number(mmPerPixel);
  if (!Number.isFinite(mmpp) || mmpp <= 0) {
    return { label: 'Scale unavailable', widthPx: RENDER_SCALE_BAR_TARGET_WIDTH_PX };
  }

  const minDistanceMm = 0.001; // 1 μm
  const targetDistanceMm = Math.max(minDistanceMm, mmpp * RENDER_SCALE_BAR_TARGET_WIDTH_PX);
  const exponent = Math.round(Math.log10(targetDistanceMm));
  const snappedDistanceMm = Math.max(minDistanceMm, 10 ** exponent);

  return {
    label: formatRenderScaleLabelMm(snappedDistanceMm),
    widthPx: RENDER_SCALE_BAR_TARGET_WIDTH_PX,
  };
}

function isCoordBreakSurface(surface: any): boolean {
  const surfType = String(surface?.surfType || surface?.type || '').trim().toLowerCase();
  const objType = String(surface?.['object type'] || '').trim().toLowerCase();
  return (
    surfType === 'coord break' || surfType === 'coordinate break' ||
    surfType === 'cb' || surfType === 'coordtrans' ||
    surfType === 'coordinatebreak' || surfType === 'coord trans' ||
    surfType === 'coordinate transform' || surfType === 'ct' ||
    objType === 'coord break' || objType === 'coordinate break' ||
    objType === 'cb' || objType === 'coordtrans' ||
    objType === 'coordinatebreak'
  );
}

function isGapSurface(surface: any): boolean {
  const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
  if (blockType === 'gap' || blockType === 'airgap') return true;
  const objType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
  if (objType === 'gap' || objType === 'air gap' || objType === 'airgap') return true;
  const role = String(surface?._surfaceRole ?? '').trim().toLowerCase();
  if (role === 'gap' || role === 'airgap') return true;
  return false;
}

function isGlassMaterial(materialValue: any): boolean {
  const material = String(materialValue ?? '').trim().toUpperCase();
  if (!material) return false;
  return !(material === 'AIR' || material === '0' || material === 'MIRROR');
}

function isLensInterval(front: any, back: any): boolean {
  if (!front || !back) return false;
  if (String(front?.['object type'] ?? '').trim().toLowerCase() === 'object') return false;
  if (isGapSurface(front) || isGapSurface(back)) return false;
  if (isCoordBreakSurface(front) || isCoordBreakSurface(back)) return false;
  return isGlassMaterial(front?.material);
}

function buildRenderLensColorTargets(opticalSystemRows: any[]): RenderLensColorTarget[] {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return [];
  const targets: RenderLensColorTarget[] = [];
  let lensNo = 0;
  for (let i = 0; i < opticalSystemRows.length - 1; i++) {
    const front = opticalSystemRows[i];
    const back = opticalSystemRows[i + 1];
    if (!isLensInterval(front, back)) continue;
    lensNo += 1;
    targets.push({
      label: `Lens ${lensNo} (S${i + 1}-S${i + 2})`,
      key: surfaceColorKeyStable(front, i),
      keys: surfaceColorKeysAll(front, i),
      frontSurfaceIndex0: i,
    });
  }
  return targets;
}

// ---- Settings window page component ----
const FORCE_MODE_KEY = 'coopt.forceInfinitePupilMode';
const GLASS_MAP_MFR_KEY = 'coopt.glassMap.defaultManufacturers';
const DARK_MODE_KEY = 'coopt.darkMode';
const ALLOWED_MFR = ['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'Sumita', 'CDGM', 'Special'] as const;

function sanitizeForceModeValue(v: any): 'stop' | 'entrance' | '' {
  const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
  return (s === 'stop' || s === 'entrance') ? s : '';
}

function readForceModeFromUrl(): 'stop' | 'entrance' | '' {
  try {
    return sanitizeForceModeValue(new URL(window.location.href).searchParams.get('coopt_force_mode'));
  } catch (_) { return ''; }
}

function applyForceModeToWindowGlobals(m: 'stop' | 'entrance' | ''): void {
  const w = window as any;
  try {
    if (typeof w.__cooptSetForceInfinitePupilMode === 'function') {
      w.__cooptSetForceInfinitePupilMode(m);
      return;
    }
  } catch (_) {}
  try {
    if (m) { w.__COOPT_FORCE_INFINITE_PUPIL_MODE = m; }
    else { try { delete w.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { w.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; } }
  } catch (_) {}
}

function DesktopSettingsPage() {
  const [forceMode, setForceMode] = useState<'stop' | 'entrance' | ''>(readForceModeFromUrl);
  const [mfrs, setMfrs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(GLASS_MAP_MFR_KEY) || '[]'); } catch (_) { return []; }
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DARK_MODE_KEY) === 'true'; } catch (_) { return false; }
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    readDesktopSetting(FORCE_MODE_KEY).then((val) => {
      const m = sanitizeForceModeValue(val);
      if (m) { setForceMode(m); applyForceModeToWindowGlobals(m); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const handleForceModeChange = async (val: 'stop' | 'entrance' | '') => {
    setForceMode(val);
    applyForceModeToWindowGlobals(val);
    try { if (val) localStorage.setItem(FORCE_MODE_KEY, val); else localStorage.removeItem(FORCE_MODE_KEY); } catch (_) {}
    await writeDesktopSetting(FORCE_MODE_KEY, val || null);
    try {
      const w = window as any;
      if (typeof w.__cooptBroadcastForceInfinitePupilMode === 'function') w.__cooptBroadcastForceInfinitePupilMode(val);
    } catch (_) {}
  };

  const handleMfrChange = (mfr: string, checked: boolean) => {
    const next = checked ? [...mfrs, mfr] : mfrs.filter(m => m !== mfr);
    setMfrs(next);
    try { if (next.length) localStorage.setItem(GLASS_MAP_MFR_KEY, JSON.stringify(next)); else localStorage.removeItem(GLASS_MAP_MFR_KEY); } catch (_) {}
  };

  const handleDarkModeChange = (enabled: boolean) => {
    setDarkMode(enabled);
    try { localStorage.setItem(DARK_MODE_KEY, enabled ? 'true' : 'false'); } catch (_) {}
    try { document.body.classList.toggle('dark-mode', enabled); } catch (_) {}
    const o = (window as any).opener;
    try { if (o && typeof o.__cooptSetDarkMode === 'function') o.__cooptSetDarkMode(enabled); } catch (_) {}
  };

  const mfrSet = new Set(mfrs.map(s => String(s).toUpperCase()));

  return (
    <div style={{ height: '100vh', width: '100vw', fontFamily: 'Arial, sans-serif', background: '#f4f4f4', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 12, background: '#fff', flex: '1 1 auto', overflow: 'auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px 0' }}>Glass Map: Default Manufacturers</div>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.35, margin: '0 0 10px 0' }}>
          Choose which manufacturers are enabled by default when opening Glass Map.<br />
          If nothing is selected, Glass Map will show all manufacturers.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 14px 0' }}>
          {ALLOWED_MFR.map(mfr => (
            <label key={mfr}>
              <input type="checkbox" checked={mfrSet.has(mfr.toUpperCase())} onChange={e => handleMfrChange(mfr, e.target.checked)} />{' '}{mfr}
            </label>
          ))}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px 0' }}>Dark Mode</div>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.35, margin: '0 0 10px 0' }}>Enable VS Code-style dark mode for the entire UI.</div>
        <label style={{ margin: '8px 0 14px 0', display: 'block' }}>
          <input type="checkbox" checked={darkMode} onChange={e => handleDarkModeChange(e.target.checked)} />{' '}Enable Dark Mode
        </label>

        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px 0' }}>Infinite Field: Pupil Sampling Mode</div>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.35, margin: '0 0 10px 0' }}>
          Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.<br />
          This sets <code>__COOPT_FORCE_INFINITE_PUPIL_MODE</code> to <code>stop</code> or <code>entrance</code>.
        </div>
        {!loaded && <div style={{ fontSize: 12, color: '#888' }}>Loading…</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 12px 0' }}>
          {(['', 'stop', 'entrance'] as const).map(val => (
            <label key={val}>
              <input type="radio" name="force-mode" value={val} checked={forceMode === val} onChange={() => handleForceModeChange(val)} />
              {' '}{val === '' ? 'Auto (default)' : val === 'stop' ? <>Force <code>stop</code></> : <>Force <code>entrance</code></>}
            </label>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#666' }}>Note: Changes take effect on the next calculation.</div>
      </div>
    </div>
  );
}

export default function App() {
  const optimizeRowsSyncKey = 'coopt.optimizeRowsSync';
  const [renderWindowStatus, setRenderWindowStatus] = useState("Initializing...");
  const [renderViewAxis, setRenderViewAxis] = useState<'YZ' | 'XZ'>('YZ');
  const [renderViewMode, setRenderViewMode] = useState<'3D' | 'XZ' | 'YZ'>('3D');
  const [renderRayCount, setRenderRayCount] = useState(5);
  const [renderSurfaceColorsCollapsed, setRenderSurfaceColorsCollapsed] = useState(true);
  const [renderLensColorTargets, setRenderLensColorTargets] = useState<RenderLensColorTarget[]>([]);
  const [renderColorUiRevision, setRenderColorUiRevision] = useState(0);
  const [renderScaleLabel, setRenderScaleLabel] = useState('Scale unavailable');
  const [renderScaleBarWidthPx, setRenderScaleBarWidthPx] = useState(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
  const renderScaleRafRef = useRef<number | null>(null);
  const [renderShowDesignIntentLabels, setRenderShowDesignIntentLabels] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_SHOW_LABELS_KEY) !== 'false';
    } catch (_) {
      return true;
    }
  });
  const [astigChiefRayDefinition, setAstigChiefRayDefinition] = useState('stop-center');
  const [astigBeamPattern, setAstigBeamPattern] = useState<'cross' | 'grid' | 'annular'>('annular');
  const [astigRayCount, setAstigRayCount] = useState(30);
  const [astigRingCount, setAstigRingCount] = useState(32);
  const [astigStatus, setAstigStatus] = useState('');
  const [astigBusy, setAstigBusy] = useState(false);
  const [astigProgress, setAstigProgress] = useState(0);
  const [astigProgressText, setAstigProgressText] = useState('');
  const isRenderWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_render_window') === '1';
    } catch (_) {
      return false;
    }
  })();
  const analysisWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      const enabled = url.searchParams.get('coopt_analysis_window') === '1';
      const analysis = String(url.searchParams.get('coopt_analysis') || '').trim();
      return { enabled, analysis };
    } catch (_) {
      return { enabled: false, analysis: '' };
    }
  })();
  const isOptimizeWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_optimize_window') === '1';
    } catch (_) {
      return false;
    }
  })();
  const [optMethod, setOptMethod] = useState<'kkt' | 'lm' | 'cd'>('kkt');
  const [optMaxIterations, setOptMaxIterations] = useState(5000);
  const [optConvergenceProfile, setOptConvergenceProfile] = useState<'fast' | 'balanced' | 'deep'>('balanced');
  const [optAutoRenderOnAccept, setOptAutoRenderOnAccept] = useState(false);
  const [optRunning, setOptRunning] = useState(false);
  const [optStopRequested, setOptStopRequested] = useState(false);
  const [optimizeState, setOptimizeState] = useState<any>({
    status: 'idle',
    phase: 'ready',
    modeUsed: 'kkt',
    iterations: 0,
    variableCount: 0,
    requirementCount: 0,
    meritBefore: NaN,
    meritAfter: NaN,
    requirementScoreBefore: NaN,
    requirementScoreAfter: NaN,
    requirementScoreTable: NaN,
    best: NaN,
    acceptCount: 0,
    rejectCount: 0,
    issue: '-',
    percent: 0,
    progressEvents: [],
  });

  const countOptimizeFlags = (rows: any[]): number => {
    if (!Array.isArray(rows)) return 0;
    return rows.reduce((acc: number, row: any) => {
      if (!row || typeof row !== 'object') return acc;
      let c = 0;
      for (const k of Object.keys(row)) {
        if (!k.startsWith('optimize')) continue;
        const v = row[k];
        const t = String(v ?? '').trim().toLowerCase();
        if (v === true || v === 1 || t === 'v' || t === 'true' || t === '1') c += 1;
      }
      return acc + c;
    }, 0);
  };

  const getSystemConfigFromWindow = (targetWindow: any): any => {
    try {
      if (targetWindow && typeof targetWindow.loadSystemConfigurationsFromTableConfig === 'function') {
        return targetWindow.loadSystemConfigurationsFromTableConfig();
      }
      if (targetWindow && typeof targetWindow.loadSystemConfigurations === 'function') {
        return targetWindow.loadSystemConfigurations();
      }
    } catch (_) {}
    return null;
  };

  const getActiveConfigFromSystemConfig = (systemConfig: any): any => {
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return null;
    const activeId = systemConfig.activeConfigId;
    return systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
      || systemConfig.configurations[0]
      || null;
  };

  const countBlockOptimizeVariables = (targetWindow: any): number => {
    try {
      const systemConfig = getSystemConfigFromWindow(targetWindow);
      const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
      const allVars = listDesignVariablesFromBlocks(activeCfg || {});
      return Array.isArray(allVars) ? allVars.length : 0;
    } catch (_) {
      return 0;
    }
  };

  useEffect(() => {
    const optimizeStatus = String(optimizeState?.status || 'idle').toLowerCase();
    // Pre-run score probing must only run in the initial idle state.
    // Otherwise it can overwrite the final optimized score after stop/done.
    if (!isOptimizeWindowMode || optRunning || optimizeStatus !== 'idle') return;
    let cancelled = false;
    let retryTimer: any = null;

    const refreshPreRunScore = async (): Promise<boolean> => {
      try {
        const w = window as any;
        const sre = w.systemRequirementsEditor;
        if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
          const p = sre.evaluateAndUpdateNow({ reason: 'optimize-window-prerun', forceSilent: true, silent: true });
          if (p && typeof p.then === 'function') await p;
        }

        const cfg = (() => {
          try {
            if (typeof w.loadSystemConfigurationsFromTableConfig === 'function') {
              return w.loadSystemConfigurationsFromTableConfig();
            }
            if (typeof w.loadSystemConfigurations === 'function') {
              return w.loadSystemConfigurations();
            }
          } catch (_) {}
          return null;
        })();
        const activeConfigId = (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null)
          ? String(cfg.activeConfigId).trim()
          : '';

        const rows = (() => {
          try {
            if (sre && typeof sre.getData === 'function') {
              const d = sre.getData();
              if (Array.isArray(d)) return d;
            }
          } catch (_) {}
          try {
            if (Array.isArray(cfg?.systemRequirements)) {
              return cfg.systemRequirements;
            }
          } catch (_) {}
          return [];
        })();

        const opticalRows = await (async () => {
          try {
            if (typeof w.getOpticalSystemRows === 'function') {
              const d0 = w.getOpticalSystemRows(w.tableOpticalSystem);
              if (Array.isArray(d0) && d0.length > 0) return d0;
            }
            const table = w.tableOpticalSystem;
            if (table && typeof table.getData === 'function') {
              const d = await table.getData();
              if (Array.isArray(d)) return d;
            }
          } catch (_) {}
          try {
            const activeId = cfg?.activeConfigId;
            const activeCfg = Array.isArray(cfg?.configurations)
              ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
              : null;
            if (Array.isArray(activeCfg?.opticalSystem) && activeCfg.opticalSystem.length > 0) {
              return activeCfg.opticalSystem;
            }
            if (activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof w.expandBlocksToOpticalSystemRows === 'function') {
              const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
              if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
                return expanded.rows;
              }
            }
          } catch (_) {}
          return [];
        })();

        const parseLocalRows = (key: string) => {
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch (_) {
            return [];
          }
        };

        const sourceRows = (() => {
          try {
            const table = w.tableSource;
            if (table && typeof table.getData === 'function') {
              const d = table.getData();
              if (Array.isArray(d) && d.length > 0) return d;
            }
          } catch (_) {}
          try {
            if (Array.isArray(cfg?.source) && cfg.source.length > 0) {
              return cfg.source;
            }
          } catch (_) {}
          const v = parseLocalRows('tableData_source');
          return Array.isArray(v) ? v : [];
        })();

        const objectRows = (() => {
          try {
            const table = w.tableObject;
            if (table && typeof table.getData === 'function') {
              const d = table.getData();
              if (Array.isArray(d) && d.length > 0) return d;
            }
          } catch (_) {}
          try {
            const activeId = cfg?.activeConfigId;
            const activeCfg = Array.isArray(cfg?.configurations)
              ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
              : null;
            if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) {
              return activeCfg.object;
            }
          } catch (_) {}
          const v = parseLocalRows('tableData_object');
          return Array.isArray(v) ? v : [];
        })();

        const normalizeConfigId = (row: any): string => {
          try {
            if (sre && typeof sre._normalizeConfigId === 'function') {
              return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
            }
          } catch (_) {}
          const rawCfg = String(row?.configId ?? '').trim();
          return rawCfg || activeConfigId;
        };

        const enabledRows = Array.isArray(rows)
          ? rows.filter((row: any) => {
            const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
            const operand = String(row?.operand ?? '').trim();
            const weight = Number(row?.weight ?? 1);
            return enabled && !!operand && Number.isFinite(weight) && weight > 0;
          })
          : [];

        const activeRows = Array.isArray(enabledRows)
          ? enabledRows.filter((row: any) => {
            const reqCfg = normalizeConfigId(row);
            if (!activeConfigId) return true;
            return reqCfg === activeConfigId;
          })
          : [];

        let tableScore = Number.NaN;
        {
          let sum = 0;
          let cnt = 0;
          for (const row of activeRows) {
            const c = Number.isFinite(Number(row?._contribution))
              ? Number(row?._contribution)
              : Number(row?.score);
            if (Number.isFinite(c)) {
              if (c > 0) sum += c;
              cnt += 1;
            }
          }
          if (cnt > 0 && Number.isFinite(sum)) tableScore = sum;
        }

        // Use TS-side table score (same evaluation as "Update Requirement").
        let safeScore = Number.isFinite(tableScore) ? tableScore : Number.NaN;
        let variableCount = 0;
        if (!Number.isFinite(safeScore)) {
          let score = 0;
          let finiteCount = 0;
          for (const row of activeRows) {
            const c = Number.isFinite(Number(row?._contribution))
              ? Number(row?._contribution)
              : Number(row?.score);
            if (Number.isFinite(c)) {
              if (c > 0) score += c;
              finiteCount += 1;
            }
          }
          if (finiteCount > 0 && Number.isFinite(score)) safeScore = score;
        }
        variableCount = countBlockOptimizeVariables(w);

        if (!cancelled) {
          setOptimizeState((prev: any) => ({
            ...prev,
            requirementCount: activeRows.length,
            variableCount: variableCount > 0 ? variableCount : prev.variableCount,
            requirementScoreBefore: safeScore,
            requirementScoreAfter: safeScore,
            requirementScoreTable: tableScore,
            meritBefore: safeScore,
            meritAfter: safeScore,
            best: Number.isFinite(safeScore) ? safeScore : prev.best,
          }));
        }
        return Number.isFinite(safeScore) || Number.isFinite(tableScore);
      } catch (_) {
        return false;
      }
    };

    let attempts = 0;
    const maxAttempts = 50;
    const runWithRetry = async () => {
      if (cancelled || optRunning) return;
      const ok = await refreshPreRunScore();
      attempts += 1;
      if (!ok && attempts < maxAttempts && !cancelled && !optRunning) {
        retryTimer = setTimeout(() => {
          void runWithRetry();
        }, 200);
      }
    };

    void runWithRetry();
    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [isOptimizeWindowMode, optRunning, optMethod, optimizeState?.status]);


  useEffect(() => {
    if (isOptimizeWindowMode || analysisWindowMode.enabled || isRenderWindowMode || isSettingsWindowMode) return;

    let lastReqEvalAt = 0;
    const REQUIREMENT_EVAL_SYNC_INTERVAL_MS = 250;

    const requestRequirementReeval = async (reason: string, force = false) => {
      const now = Date.now();
      if (!force && (now - lastReqEvalAt) < REQUIREMENT_EVAL_SYNC_INTERVAL_MS) return;
      lastReqEvalAt = now;
      try {
        const w = window as any;
        const reqEditor = w.systemRequirementsEditor;
        if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
          const p = reqEditor.evaluateAndUpdateNow({ reason, forceSilent: true, silent: true });
          if (p && typeof p.then === 'function') await p;
        }
      } catch (_) {}
    };

    const waitRequirementEvalDone = async (startedAt: number, timeoutMs = 2000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const s = (window as any).__cooptLastRequirementsEval;
          const at = Number(s?.at ?? 0);
          const stage = String(s?.stage ?? '').trim().toLowerCase();
          if (at > startedAt && stage === 'done') return;
        } catch (_) {}
        if (Date.now() >= deadline) return;
        await new Promise((r) => setTimeout(r, 30));
      }
    };

    const readRequirementTableScoreFromHost = (): number => {
      try {
        const w = window as any;
        const sre = w.systemRequirementsEditor;
        if (!sre || typeof sre.getData !== 'function') return Number.NaN;
        const rr = sre.getData();
        if (!Array.isArray(rr) || rr.length === 0) return Number.NaN;

        const cfg = (() => {
          try {
            if (typeof w.loadSystemConfigurationsFromTableConfig === 'function') {
              return w.loadSystemConfigurationsFromTableConfig();
            }
            if (typeof w.loadSystemConfigurations === 'function') {
              return w.loadSystemConfigurations();
            }
          } catch (_) {}
          return null;
        })();

        const activeConfigId = (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null)
          ? String(cfg.activeConfigId).trim()
          : '';

        const normalizeConfigId = (row: any): string => {
          try {
            if (typeof sre._normalizeConfigId === 'function') {
              return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
            }
          } catch (_) {}
          const rawCfg = String(row?.configId ?? '').trim();
          return rawCfg || activeConfigId;
        };

        let sum = 0;
        let cnt = 0;
        for (const row of rr) {
          const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
          const operand = String(row?.operand ?? '').trim();
          const weight = Number(row?.weight ?? 1);
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
          const reqCfg = normalizeConfigId(row);
          if (activeConfigId && reqCfg !== activeConfigId) continue;
          const c = Number.isFinite(Number(row?._contribution))
            ? Number(row?._contribution)
            : Number(row?.score);
          if (Number.isFinite(c)) {
            if (c > 0) sum += c;
            cnt += 1;
          }
        }

        return (cnt > 0 && Number.isFinite(sum)) ? sum : Number.NaN;
      } catch (_) {
        return Number.NaN;
      }
    };

    const parseMaybeNumber = (v: any): any => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : v;
      const s = String(v ?? '').trim();
      if (!s) return '';
      if (/^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(e[-+]?\d+)?$/i.test(s)) return Number(s);
      return v;
    };

    const setParam = (block: any, key: string, value: any) => {
      if (!block || typeof block !== 'object' || !key) return;
      if (!block.parameters || typeof block.parameters !== 'object') block.parameters = {};
      block.parameters[key] = parseMaybeNumber(value);
    };

    const updateBlockByRole = (block: any, role: string, row: any) => {
      const blockType = String(block?.blockType ?? '');
      const r = String(role || '').trim();
      const radius = row?.radius;
      const thickness = row?.thickness;
      const material = row?.material;
      const conic = row?.conic;
      const surfType = row?.surfType;

      if (blockType === 'Lens') {
        if (r === 'front') {
          setParam(block, 'frontRadius', radius);
          setParam(block, 'centerThickness', thickness);
          setParam(block, 'material', material);
          setParam(block, 'frontConic', conic);
          setParam(block, 'frontSurfType', surfType);
          if (row?.radiusX !== undefined && row?.radiusX !== '') setParam(block, 'frontRadiusX', row.radiusX);
          if (row?.axis !== undefined && row?.axis !== '') setParam(block, 'frontAxis', row.axis);
          for (let i = 1; i <= 10; i++) {
            const key = `coef${i}`;
            if (Object.prototype.hasOwnProperty.call(row, key)) setParam(block, `frontCoef${i}`, (row as any)[key]);
          }
        } else if (r === 'back') {
          setParam(block, 'backRadius', radius);
          setParam(block, 'backConic', conic);
          setParam(block, 'backSurfType', surfType);
          if (row?.radiusX !== undefined && row?.radiusX !== '') setParam(block, 'backRadiusX', row.radiusX);
          if (row?.axis !== undefined && row?.axis !== '') setParam(block, 'backAxis', row.axis);
          for (let i = 1; i <= 10; i++) {
            const key = `coef${i}`;
            if (Object.prototype.hasOwnProperty.call(row, key)) setParam(block, `backCoef${i}`, (row as any)[key]);
          }
        }
      } else if (blockType === 'SingleSurface') {
        setParam(block, 'radius', radius);
        setParam(block, 'thickness', thickness);
        setParam(block, 'material', material);
        setParam(block, 'conic', conic);
        setParam(block, 'surfType', surfType);
        if (row?.radiusX !== undefined && row?.radiusX !== '') setParam(block, 'radiusX', row.radiusX);
        if (row?.radiusY !== undefined && row?.radiusY !== '') setParam(block, 'radiusY', row.radiusY);
        if (row?.axis !== undefined && row?.axis !== '') setParam(block, 'axis', row.axis);
        for (let i = 1; i <= 10; i++) {
          const key = `coef${i}`;
          if (Object.prototype.hasOwnProperty.call(row, key)) setParam(block, key, (row as any)[key]);
        }
      } else if (blockType === 'Mirror') {
        setParam(block, 'radius', radius);
        setParam(block, 'thickness', thickness);
        setParam(block, 'conic', conic);
        setParam(block, 'surfType', surfType);
        for (let i = 1; i <= 10; i++) {
          const key = `coef${i}`;
          if (Object.prototype.hasOwnProperty.call(row, key)) setParam(block, key, (row as any)[key]);
        }
      } else if (blockType === 'Doublet') {
        const idx = r === 's1' ? '1' : (r === 's2' ? '2' : (r === 's3' ? '3' : ''));
        if (!idx) return;
        setParam(block, `radius${idx}`, radius);
        setParam(block, `surf${idx}Conic`, conic);
        setParam(block, `surf${idx}SurfType`, surfType);
        if (idx === '1') {
          setParam(block, 'thickness1', thickness);
          setParam(block, 'material1', material);
        }
        if (idx === '2') {
          setParam(block, 'thickness2', thickness);
          setParam(block, 'material2', material);
        }
        for (let i = 1; i <= 10; i++) {
          const key = `coef${i}`;
          if (Object.prototype.hasOwnProperty.call(row, key)) setParam(block, `surf${idx}Coef${i}`, (row as any)[key]);
        }
      } else if (blockType === 'Triplet') {
        const idx = r === 's1' ? '1' : (r === 's2' ? '2' : (r === 's3' ? '3' : (r === 's4' ? '4' : '')));
        if (!idx) return;
        setParam(block, `radius${idx}`, radius);
        setParam(block, `surf${idx}Conic`, conic);
        setParam(block, `surf${idx}SurfType`, surfType);
        if (idx === '1') {
          setParam(block, 'thickness1', thickness);
          setParam(block, 'material1', material);
        }
        if (idx === '2') {
          setParam(block, 'thickness2', thickness);
          setParam(block, 'material2', material);
        }
        if (idx === '3') {
          setParam(block, 'thickness3', thickness);
          setParam(block, 'material3', material);
        }
        for (let i = 1; i <= 10; i++) {
          const key = `coef${i}`;
          if (Object.prototype.hasOwnProperty.call(row, key)) setParam(block, `surf${idx}Coef${i}`, (row as any)[key]);
        }
      } else if (blockType === 'Stop' && (r === 'stop' || r === 'single')) {
        setParam(block, 'semiDiameter', row?.semidia);
      }

      if (row?.semidia !== undefined && row?.semidia !== '' && r) {
        if (!block.aperture || typeof block.aperture !== 'object') block.aperture = {};
        block.aperture[r] = row.semidia;
      }
    };

    const syncGapBlocksFromRows = (rows: any[], blocks: any[]) => {
      if (!Array.isArray(rows) || !Array.isArray(blocks)) return 0;

      const normalizeType = (t: any) => String(t ?? '').trim().toLowerCase();
      const gapBlocks = blocks.filter((b: any) => {
        const t = normalizeType(b?.blockType);
        return t === 'gap' || t === 'airgap';
      });
      if (gapBlocks.length === 0) return 0;

      const usedRows = new Set<number>();
      const pickRowForGap = (gapBlockId: string): any => {
        if (gapBlockId) {
          for (let i = 0; i < rows.length; i++) {
            if (usedRows.has(i)) continue;
            const r = rows[i];
            if (!r || typeof r !== 'object') continue;
            if (String(r?._blockId ?? '').trim() === gapBlockId) {
              usedRows.add(i);
              return r;
            }
          }
        }

        for (let i = 0; i < rows.length; i++) {
          if (usedRows.has(i)) continue;
          const r = rows[i];
          if (!r || typeof r !== 'object') continue;
          if (r?.__cooptGapApplied === true || normalizeType(r?._blockType) === 'gap') {
            usedRows.add(i);
            return r;
          }
        }
        return null;
      };

      let touched = 0;
      for (const gb of gapBlocks) {
        const gapId = String(gb?.blockId ?? '').trim();
        const row = pickRowForGap(gapId);
        if (!row) continue;
        setParam(gb, 'thickness', row?.thickness);
        if (row?.material !== undefined) setParam(gb, 'material', row?.material);
        if (row?.abbe !== undefined && row?.abbe !== '') setParam(gb, 'abbe', row?.abbe);
        touched += 1;
      }
      return touched;
    };

    const syncRowsBackToActiveBlocks = (rows: any[]) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const w = window as any;
      try {
        const cfg = typeof w.loadSystemConfigurationsFromTableConfig === 'function'
          ? w.loadSystemConfigurationsFromTableConfig()
          : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
        if (!cfg || !Array.isArray(cfg.configurations)) return;
        const activeId = cfg.activeConfigId;
        const active = cfg.configurations.find((c: any) => String(c?.id) === String(activeId));
        if (!active || !Array.isArray(active.blocks) || active.blocks.length === 0) {
          return;
        }

        const blockById = new Map<string, any>();
        for (const b of active.blocks) {
          const id = String(b?.blockId ?? '').trim();
          if (id) blockById.set(id, b);
        }

        let touched = 0;
        for (const row of rows) {
          const blockId = String(row?._blockId ?? '').trim();
          const role = String(row?._surfaceRole ?? '').trim();
          if (!blockId || !role) continue;
          const block = blockById.get(blockId);
          if (!block) continue;
          updateBlockByRole(block, role, row);
          touched += 1;
        }

        touched += syncGapBlocksFromRows(rows, active.blocks);

        if (touched <= 0) return;

        if (typeof w.expandBlocksIntoConfiguration === 'function') {
          w.expandBlocksIntoConfiguration(active);
        } else if (typeof w.expandBlocksToOpticalSystemRows === 'function') {
          const expanded = w.expandBlocksToOpticalSystemRows(active.blocks);
          if (expanded && Array.isArray(expanded.rows)) {
            active.opticalSystem = expanded.rows;
          }
        }
        if (!active.metadata || typeof active.metadata !== 'object') active.metadata = {};
        active.metadata.modified = new Date().toISOString();

        if (typeof w.saveSystemConfigurationsFromTableConfig === 'function') {
          w.saveSystemConfigurationsFromTableConfig(cfg);
        } else if (typeof w.saveSystemConfigurations === 'function') {
          w.saveSystemConfigurations(cfg);
        }
      } catch (_) {}
    };

    const cloneJson = (v: any) => {
      try {
        return JSON.parse(JSON.stringify(v));
      } catch (_) {
        return null;
      }
    };

    const loadSystemConfigSnapshot = (): any => {
      const w = window as any;
      try {
        const cfg = typeof w.loadSystemConfigurationsFromTableConfig === 'function'
          ? w.loadSystemConfigurationsFromTableConfig()
          : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
        return cloneJson(cfg);
      } catch (_) {
        return null;
      }
    };

    const loadOpticalRowsSnapshot = (): any[] => {
      const w = window as any;
      try {
        const rows = typeof w.getOpticalSystemRows === 'function'
          ? w.getOpticalSystemRows(w.tableOpticalSystem)
          : [];
        return Array.isArray(rows) ? (cloneJson(rows) || []) : [];
      } catch (_) {
        return [];
      }
    };

    const applySystemConfigSnapshotSync = (snapshot: any): void => {
      const w = window as any;
      if (!snapshot || typeof snapshot !== 'object') return;
      try {
        const cloned = cloneJson(snapshot);
        if (!cloned) return;
        if (typeof w.saveSystemConfigurationsFromTableConfig === 'function') {
          w.saveSystemConfigurationsFromTableConfig(cloned);
        } else if (typeof w.saveSystemConfigurations === 'function') {
          w.saveSystemConfigurations(cloned);
        }
        if (typeof w.loadActiveConfigurationToTables === 'function') {
          w.loadActiveConfigurationToTables();
        }
        requestRefreshBlockInspector(w);
        if (typeof w.refreshAllUI === 'function') {
          w.refreshAllUI();
        }
      } catch (_) {}
    };

    const applyOpticalRowsSnapshotSync = (rowsSnapshot: any[]): void => {
      const w = window as any;
      if (!Array.isArray(rowsSnapshot) || rowsSnapshot.length === 0) return;
      try {
        const rows = cloneJson(rowsSnapshot) || [];
        const table = w.tableOpticalSystem;
        if (table && typeof table.replaceData === 'function') {
          table.replaceData(rows);
        } else if (table && typeof table.setData === 'function') {
          table.setData(rows);
        }
        syncRowsBackToActiveBlocks(rows);
        if (typeof w.loadActiveConfigurationToTables === 'function') {
          w.loadActiveConfigurationToTables();
        }
      } catch (_) {}
    };

    const recordOptimizationUndoFromSnapshots = (
      beforeSnapshot: any,
      beforeRowsSnapshot: any[],
      afterSnapshot: any,
      afterRowsSnapshot: any[],
      description = 'Optimization apply'
    ): void => {
      try {
        const beforeText = beforeSnapshot ? JSON.stringify(beforeSnapshot) : '';
        const afterText = afterSnapshot ? JSON.stringify(afterSnapshot) : '';
        const beforeRowsText = JSON.stringify(beforeRowsSnapshot || []);
        const afterRowsText = JSON.stringify(afterRowsSnapshot || []);
        const configChanged = !!beforeText && !!afterText && beforeText !== afterText;
        const rowsChanged = beforeRowsText !== afterRowsText;
        const changed = configChanged || rowsChanged;
        const undoHistory = (window as any).undoHistory;
        if (!changed || !undoHistory || typeof undoHistory.record !== 'function') return;
        const cmd = {
          id: `opt-main-apply-${Date.now()}`,
          description,
          timestamp: Date.now(),
          execute: () => {
            applySystemConfigSnapshotSync(afterSnapshot);
            applyOpticalRowsSnapshotSync(afterRowsSnapshot);
          },
          undo: () => {
            applySystemConfigSnapshotSync(beforeSnapshot);
            applyOpticalRowsSnapshotSync(beforeRowsSnapshot);
          },
        } as any;
        undoHistory.record(cmd);
      } catch (_) {}
    };

    (window as any).__cooptRecordOptimizationUndoFromSnapshots = (
      beforeSnapshot: any,
      beforeRowsSnapshot: any[],
      afterSnapshot: any,
      afterRowsSnapshot: any[],
      description = 'Optimization apply'
    ) => {
      recordOptimizationUndoFromSnapshots(beforeSnapshot, beforeRowsSnapshot, afterSnapshot, afterRowsSnapshot, description);
    };

    let lastOptimizeApplyToken: string | null = null;

    const applyOptimizedRows = async (
      rows: any[],
      applyToken = '',
      undoSnapshots?: {
        beforeConfig?: any;
        beforeRows?: any[];
        afterConfig?: any;
        afterRows?: any[];
      }
    ) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const w = window as any;
      let beforeSnapshot: any = null;
      let beforeRowsSnapshot: any[] = [];
      let afterSnapshot: any = null;
      let afterRowsSnapshot: any[] = [];
      const undoHistory = w.undoHistory;
      const prevIsExecuting = !!undoHistory?.isExecuting;
      try {
        if (applyToken && lastOptimizeApplyToken === applyToken) {
          return;
        }
        if (undoHistory) {
          undoHistory.isExecuting = true;
        }
        beforeSnapshot = loadSystemConfigSnapshot();
        beforeRowsSnapshot = loadOpticalRowsSnapshot();
        const table = w.tableOpticalSystem;
        if (table && typeof table.setData === 'function') {
          await table.setData(rows);
        }
        syncRowsBackToActiveBlocks(rows);
        afterSnapshot = loadSystemConfigSnapshot();
        afterRowsSnapshot = loadOpticalRowsSnapshot();

        if (applyToken) {
          lastOptimizeApplyToken = applyToken;
        }

        requestRefreshBlockInspector(w);
        if (typeof w.refreshAllUI === 'function') {
          w.refreshAllUI();
        }
        await requestRequirementReeval('optimize-storage-sync');
        if (typeof w.drawOpticalSystem === 'function') {
          w.drawOpticalSystem();
        }
      } catch (_) {}
      finally {
        if (undoHistory) {
          undoHistory.isExecuting = prevIsExecuting;
        }
      }

      try {
        recordOptimizationUndoFromSnapshots(
          undoSnapshots?.beforeConfig ?? beforeSnapshot,
          Array.isArray(undoSnapshots?.beforeRows) ? undoSnapshots?.beforeRows : beforeRowsSnapshot,
          undoSnapshots?.afterConfig ?? afterSnapshot,
          Array.isArray(undoSnapshots?.afterRows) ? undoSnapshots?.afterRows : afterRowsSnapshot,
          'Optimization apply'
        );
      } catch (_) {}
    };

    // Called by optimize popup to synchronously apply rows and get latest table score.
    (window as any).__cooptRefreshRequirementTableScoreForOptimize = async (rows: any[], reason = 'optimize-host-refresh') => {
      if (!Array.isArray(rows) || rows.length === 0) return Number.NaN;
      const startedAt = Date.now();
      await applyOptimizedRows(rows);
      await requestRequirementReeval(reason, true);
      await waitRequirementEvalDone(startedAt);
      return readRequirementTableScoreFromHost();
    };

    const applyRenderSync = (rows: any[]) => {
      try {
        const w = window as any;
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const prevRunning = g ? !!g.__cooptOptimizerIsRunning : false;
        if (g && rows.length > 0) g.__cooptOpticalSystemRowsOverride = rows;
        // Set optimizer flag so draw-cross handler skips loadActiveConfigurationToTables
        if (g) g.__cooptOptimizerIsRunning = true;
        try {
          if (typeof w.__cooptRenderWindowRedraw === 'function') {
            void Promise.resolve(w.__cooptRenderWindowRedraw(rows));
          } else if (typeof w.drawOpticalSystem === 'function') {
            w.drawOpticalSystem();
          }
        } catch (_) {}
        try {
          const popup = w.popup3DWindow;
          if (popup && !popup.closed) {
            if (typeof popup.__cooptRenderWindowRedraw === 'function') {
              void Promise.resolve(popup.__cooptRenderWindowRedraw(rows));
            } else if (typeof popup.postMessage === 'function') {
              popup.postMessage({ action: 'request-redraw' }, '*');
            }
          }
        } catch (_) {}
        // Restore flags after popup message roundtrip (~400 ms)
        setTimeout(() => {
          try {
            if (g) g.__cooptOptimizerIsRunning = prevRunning;
            if (g) g.__cooptOpticalSystemRowsOverride = null;
          } catch (_) {}
        }, 400);
      } catch (_) {}
    };

    let lastRenderSyncStamp = '';
    const applyRenderSyncPayload = (payload: any) => {
      try {
        const stamp = String(payload?.ts ?? payload?.token ?? '');
        if (stamp && stamp === lastRenderSyncStamp) return;
        if (stamp) lastRenderSyncStamp = stamp;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        applyRenderSync(rows);
      } catch (_) {}
    };

    const onStorage = (ev: StorageEvent) => {

      // Handle live render sync from the optimize window (Tauri WebviewWindow sends rows here)
      if (ev.key === 'coopt.renderSyncRequest' && ev.newValue && !isOptimizeWindowMode) {
        try {
          const payload = JSON.parse(ev.newValue);
          applyRenderSyncPayload(payload);
        } catch (_) {}
        return;
      }
      if (ev.key !== optimizeRowsSyncKey || !ev.newValue) return;
      try {
        const payload = JSON.parse(ev.newValue);
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const token = String(payload?.ts ?? payload?.token ?? '');
        const undoSnapshots = {
          beforeConfig: payload?.beforeConfigSnapshot,
          beforeRows: Array.isArray(payload?.beforeRowsSnapshot) ? payload.beforeRowsSnapshot : [],
          afterConfig: payload?.afterConfigSnapshot,
          afterRows: Array.isArray(payload?.afterRowsSnapshot) ? payload.afterRowsSnapshot : [],
        };
        void applyOptimizedRows(rows, token, undoSnapshots);
      } catch (_) {}
    };

    let tauriUnlisten: (() => void) | null = null;
    let tauriListenerCancelled = false;
    if (!isOptimizeWindowMode) {
      void (async () => {
        try {
          const mod = await import('@tauri-apps/api/event');
          if (tauriListenerCancelled || !mod || typeof (mod as any).listen !== 'function') return;
          const renderUnlisten = await (mod as any).listen('coopt-render-sync-request', (ev: any) => {
            try {
              applyRenderSyncPayload(ev?.payload);
            } catch (_) {}
          });
          const unlisten = await (mod as any).listen('coopt-optimize-rows-sync', (ev: any) => {
            try {
              const rows = Array.isArray(ev?.payload?.rows) ? ev.payload.rows : [];
              const token = String(ev?.payload?.ts ?? ev?.payload?.token ?? '');
              const undoSnapshots = {
                beforeConfig: ev?.payload?.beforeConfigSnapshot,
                beforeRows: Array.isArray(ev?.payload?.beforeRowsSnapshot) ? ev.payload.beforeRowsSnapshot : [],
                afterConfig: ev?.payload?.afterConfigSnapshot,
                afterRows: Array.isArray(ev?.payload?.afterRowsSnapshot) ? ev.payload.afterRowsSnapshot : [],
              };
              void applyOptimizedRows(rows, token, undoSnapshots);
            } catch (_) {}
          });
          if (tauriListenerCancelled) {
            try { unlisten(); } catch (_) {}
            try { renderUnlisten(); } catch (_) {}
            return;
          }
          tauriUnlisten = () => {
            try { unlisten(); } catch (_) {}
            try { renderUnlisten(); } catch (_) {}
          };
        } catch (_) {}
      })();
    }

    window.addEventListener('storage', onStorage);
    const renderSyncPollTimer = !isOptimizeWindowMode
      ? window.setInterval(() => {
          try {
            const raw = localStorage.getItem('coopt.renderSyncRequest');
            if (!raw) return;
            const payload = JSON.parse(raw);
            applyRenderSyncPayload(payload);
          } catch (_) {}
        }, 180)
      : null;
    return () => {
      window.removeEventListener('storage', onStorage);
      if (renderSyncPollTimer !== null) {
        try { window.clearInterval(renderSyncPollTimer); } catch (_) {}
      }
      tauriListenerCancelled = true;
      if (tauriUnlisten) {
        try { tauriUnlisten(); } catch (_) {}
      }
      try { delete (window as any).__cooptRecordOptimizationUndoFromSnapshots; } catch (_) {
        (window as any).__cooptRecordOptimizationUndoFromSnapshots = undefined;
      }
      try { delete (window as any).__cooptRefreshRequirementTableScoreForOptimize; } catch (_) {
        (window as any).__cooptRefreshRequirementTableScoreForOptimize = undefined;
      }
    };
  }, [isOptimizeWindowMode]);
  const isSettingsWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_settings_window') === '1';
    } catch (_) {
      return false;
    }
  })();

  const ensurePlotlyLoaded = async (): Promise<void> => {
    const w = window as any;
    if (w.Plotly && typeof w.Plotly.newPlot === 'function') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[data-coopt-plotly="1"]') as HTMLScriptElement | null;
      if (existing) {
        if (w.Plotly && typeof w.Plotly.newPlot === 'function') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdn.plot.ly/plotly-2.32.0.min.js';
      script.async = true;
      script.setAttribute('data-coopt-plotly', '1');
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
      document.head.appendChild(script);
    });

    if (!(window as any).Plotly || typeof (window as any).Plotly.newPlot !== 'function') {
      throw new Error('Plotly is unavailable');
    }
  };

  const ensureRenderCanvasAttached = (): boolean => {
    try {
      const w = window as any;
      const container = document.getElementById('threejs-canvas-container');
      if (!container) return false;

      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const canvas = renderer?.domElement;
      if (!renderer || !canvas) return false;

      if (canvas.parentElement !== container) {
        container.appendChild(canvas);
      }

      const width = Math.max(1, container.clientWidth || window.innerWidth || 1);
      const height = Math.max(1, container.clientHeight || (window.innerHeight - 44) || 1);
      if (typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(window.devicePixelRatio || 1);
      }
      if (typeof renderer.setSize === 'function') {
        renderer.setSize(width, height, false);
      }
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      return true;
    } catch (_) {
      return false;
    }
  };

  const syncOrthoBoundsToRendererAspect = (): void => {
    try {
      const w = window as any;
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      if (!camera?.isOrthographicCamera || !renderer || typeof renderer.getSize !== 'function') return;

      const THREERef = w.THREE;
      if (!THREERef?.Vector2) return;

      const size = renderer.getSize(new THREERef.Vector2());
      const width = Number(size?.x) || 0;
      const height = Number(size?.y) || 0;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return;

      const aspect = width / height;
      const currentHeight = (camera.top - camera.bottom) || 1;
      const centerX = (camera.left + camera.right) / 2;
      const centerY = (camera.top + camera.bottom) / 2;
      const nextWidth = currentHeight * aspect;

      camera.left = centerX - nextWidth / 2;
      camera.right = centerX + nextWidth / 2;
      camera.top = centerY + currentHeight / 2;
      camera.bottom = centerY - currentHeight / 2;
      camera.updateProjectionMatrix();
    } catch (_) {}
  };

  const collectLegacyCrossRays = async (opticalSystemRows: any[], axis: 'YZ' | 'XZ' | 'BOTH' = 'BOTH'): Promise<any[]> => {
    const w = window as any;
    try {
      const getObjectRows = w.getObjectRows;
      const objectRowsRaw = (typeof getObjectRows === 'function') ? (getObjectRows(w.tableObject) || []) : [];
      const objectRows = Array.isArray(objectRowsRaw) ? objectRowsRaw : [];

      const objectSurface = opticalSystemRows[0] || {};
      const thicknessRaw = objectSurface?.thickness;
      const thicknessStr = String(thicknessRaw ?? '').trim().toUpperCase();
      const thicknessVal = Number(thicknessRaw);
      const isInfiniteSystem = (
        thicknessRaw === Infinity ||
        thicknessStr === 'INF' ||
        thicknessStr === 'INFINITY' ||
        thicknessStr === '∞' ||
        (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
      );

      const primaryWavelength = (typeof w.getPrimaryWavelength === 'function')
        ? (Number(w.getPrimaryWavelength()) || 0.5876)
        : 0.5876;

      const toNumber = (value: any) => {
        const parsed = parseFloat(String(value ?? ''));
        return Number.isFinite(parsed) ? parsed : 0;
      };

      let crossBeamResult: any = null;
      const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
      if (isInfiniteSystem && typeof w.generateInfiniteSystemCrossBeam === 'function') {
        const objectAngles = (objectRows.length ? objectRows : [{}]).map((row: any) => ({
          x: toNumber(row?.xHeightAngle ?? row?.x),
          y: toNumber(row?.yHeightAngle ?? row?.y)
        }));

        const isImageRow = (row: any) => {
          const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
          const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
          return normalized === 'image' || normalized.startsWith('image');
        };
        const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => row && isImageRow(row));
        const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);

        crossBeamResult = await w.generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
          rayCount: renderRayCount,
          debugMode: false,
          wavelength: primaryWavelength,
          crossType,
          targetSurfaceIndex,
          angleUnit: 'deg',
          chiefZ: -20
        });
      } else if (typeof w.generateCrossBeam === 'function') {
        const allObjectPositions = (objectRows.length ? objectRows : [{}]).map((row: any, index: number) => {
          if (Array.isArray(row)) {
            return { x: toNumber(row[1]), y: toNumber(row[2]), z: 0, objectIndex: index };
          }
          return {
            x: toNumber(row?.xHeightAngle ?? row?.x ?? row?.height ?? row?.heightX),
            y: toNumber(row?.yHeightAngle ?? row?.y ?? row?.height ?? row?.heightY),
            z: 0,
            objectIndex: row?.objectIndex ?? index
          };
        });

        crossBeamResult = await w.generateCrossBeam(opticalSystemRows, allObjectPositions, {
          rayCount: renderRayCount,
          debugMode: false,
          wavelength: primaryWavelength,
          crossType
        });
      }

      if (!crossBeamResult || crossBeamResult.success === false) {
        return [];
      }

      let allRays: any[] = [];
      if (crossBeamResult.results && Array.isArray(crossBeamResult.results)) {
        crossBeamResult.results.forEach((result: any, resultIndex: number) => {
          if (result?.rays && Array.isArray(result.rays)) {
            const objectIndex = Number.isFinite(Number(result?.objectIndex))
              ? Number(result.objectIndex)
              : resultIndex;
            const normalized = result.rays.map((ray: any) => ({
              ...ray,
              objectIndex: Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : objectIndex,
              originalRay: {
                ...(ray?.originalRay || {}),
                objectIndex: Number.isFinite(Number(ray?.originalRay?.objectIndex))
                  ? Number(ray.originalRay.objectIndex)
                  : (Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : objectIndex)
              }
            }));
            allRays = allRays.concat(normalized);
          }
        });
      } else if (
        crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays) &&
        crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)
      ) {
        allRays = crossBeamResult.allTracedRays.map((tracedRay: any, index: number) => {
          const crossRay = crossBeamResult.allCrossBeamRays[index];
          if (crossRay) {
            tracedRay.type = crossRay.type;
            tracedRay.beamType = crossRay.beamType;
            tracedRay.objectIndex = tracedRay.objectIndex ?? crossRay.objectIndex;
            tracedRay.originalRay = tracedRay.originalRay || crossRay;
          }
          return tracedRay;
        });
      } else if (crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays)) {
        allRays = crossBeamResult.allCrossBeamRays;
      } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
        allRays = crossBeamResult.allTracedRays;
      } else if (crossBeamResult.tracedRays && Array.isArray(crossBeamResult.tracedRays)) {
        allRays = crossBeamResult.tracedRays;
      } else if (Array.isArray(crossBeamResult)) {
        allRays = crossBeamResult;
      }
      const normalizedAllRays = Array.isArray(allRays) ? allRays.map((ray: any) => {
        const inferredObjectIndex = Number.isFinite(Number(ray?.objectIndex))
          ? Number(ray.objectIndex)
          : (Number.isFinite(Number(ray?.originalRay?.objectIndex))
            ? Number(ray.originalRay.objectIndex)
            : 0);
        return {
          ...ray,
          objectIndex: inferredObjectIndex,
          originalRay: {
            ...(ray?.originalRay || {}),
            objectIndex: inferredObjectIndex
          }
        };
      }) : [];

      const desiredCount = Math.max(1, Number.parseInt(String(renderRayCount), 10) || 1);
      const grouped = new Map<number, any[]>();
      normalizedAllRays.forEach((ray: any) => {
        const objectIndex = Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : 0;
        if (!grouped.has(objectIndex)) grouped.set(objectIndex, []);
        grouped.get(objectIndex)!.push(ray);
      });

      const limitedRays: any[] = [];
      grouped.forEach((rays, objectIndex) => {
        const chief = rays.filter((r: any) => String(r?.originalRay?.type || r?.type || '').toLowerCase() === 'chief');
        const nonChief = rays.filter((r: any) => String(r?.originalRay?.type || r?.type || '').toLowerCase() !== 'chief');

        const ordered = [...chief, ...nonChief].map((r: any) => ({
          ...r,
          objectIndex,
          originalRay: {
            ...(r?.originalRay || {}),
            objectIndex
          }
        }));

        limitedRays.push(...ordered.slice(0, desiredCount));
      });

      return limitedRays;
    } catch (error) {
      console.error('[RenderWindow] Legacy cross-beam generation failed:', error);
      return [];
    }
  };

  const applyRenderWindowDirectCrossFill = (scene: any, axis: 'YZ' | 'XZ', opticalSystemRows: any[]): number => {
    const w = window as any;
    const THREE = w?.THREE;
    if (!scene || !THREE || !Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return 0;

    const toRemove: any[] = [];
    scene.traverse((child: any) => {
      if (child?.userData?.type === 'renderWindowDirectFill') {
        toRemove.push(child);
      }
    });
    [...new Set(toRemove)].forEach((obj: any) => {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
        else obj.material.dispose();
      }
    });

    const getSemidia = (surface: any): number | null => {
      const candidates: Array<{ value: any; isDiameter: boolean }> = [
        { value: surface?.semidia, isDiameter: false },
        { value: surface?.semiDiameter, isDiameter: false },
        { value: surface?.['semi-diameter'], isDiameter: false },
        { value: surface?.semi_diameter, isDiameter: false },
        { value: surface?.clearAperture, isDiameter: false },
        { value: surface?.Clear_Aperture, isDiameter: false },
        { value: surface?.diameter, isDiameter: true }
      ];
      for (const candidate of candidates) {
        const n = Number(candidate.value);
        const parsed = Number.isFinite(n) ? n : parseFloat(String(candidate.value ?? ''));
        if (Number.isFinite(parsed) && parsed > 0) {
          return candidate.isDiameter ? parsed * 0.5 : parsed;
        }
      }
      return null;
    };

    const readWorldPolylinePoints = (lineObj: any): any[] => {
      if (!lineObj?.geometry?.attributes?.position) return [];
      const attr = lineObj.geometry.attributes.position;
      const points: any[] = [];
      for (let idx = 0; idx < attr.count; idx++) {
        const p = new THREE.Vector3(attr.getX(idx), attr.getY(idx), attr.getZ(idx));
        if (typeof lineObj.localToWorld === 'function') {
          lineObj.localToWorld(p);
        }
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          points.push(p);
        }
      }
      return points;
    };

    const orientPolyline = (points: any[], startRef: any, endRef: any): any[] => {
      if (!Array.isArray(points) || points.length < 2 || !startRef || !endRef) return points || [];
      const d1 = points[0].distanceTo(startRef) + points[points.length - 1].distanceTo(endRef);
      const d2 = points[0].distanceTo(endRef) + points[points.length - 1].distanceTo(startRef);
      return d1 <= d2 ? points.slice() : points.slice().reverse();
    };

    const samplePolyline = (points: any[], count: number): any[] => {
      if (!Array.isArray(points) || points.length < 2 || count < 2) return [];
      const sampled: any[] = [];
      for (let s = 0; s < count; s++) {
        const t = s / (count - 1);
        const idx = Math.round(t * (points.length - 1));
        const p = points[Math.max(0, Math.min(idx, points.length - 1))];
        if (p) sampled.push(p.clone());
      }
      return sampled;
    };

    const surfaceOriginsZ: number[] = [];
    let zAccum = 0;
    for (let i = 0; i < opticalSystemRows.length; i++) {
      surfaceOriginsZ.push(zAccum);
      const tRaw = opticalSystemRows[i]?.thickness;
      const tNum = Number(tRaw);
      const tParsed = Number.isFinite(tNum) ? tNum : parseFloat(String(tRaw ?? ''));
      if (Number.isFinite(tParsed)) zAccum += tParsed;
    }

    const fillColor = 0x00ccff;
    const isWhiteLike = (value: number | null): boolean => {
      if (value === null || !Number.isFinite(value)) return false;
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return r >= 245 && g >= 245 && b >= 245;
    };
    const colorOverrides = loadSurfaceColorOverridesSafe();
    let createdCount = 0;

    const profileMap = new Map<number, any>();
    const connectionMap = new Map<number, any[]>();
    scene.traverse((child: any) => {
      const ud = child?.userData || {};
      if (ud.type === 'surfaceProfile' && ud.profileType === axis) {
        const surfaceIndex = Number(ud.surfaceIndex);
        if (Number.isFinite(surfaceIndex)) {
          profileMap.set(surfaceIndex, child);
        }
      }
      if (ud.type === 'connectionLine' && ud.direction === axis) {
        const surfaceIndex = Number(ud.surfaceIndex);
        if (Number.isFinite(surfaceIndex)) {
          if (!connectionMap.has(surfaceIndex)) connectionMap.set(surfaceIndex, []);
          connectionMap.get(surfaceIndex)!.push(child);
        }
      }
    });

    for (let i = 0; i < opticalSystemRows.length - 1; i++) {
      const front = opticalSystemRows[i];
      const back = opticalSystemRows[i + 1];
      if (!isLensInterval(front, back)) continue;

      const frontIndex = i + 1;
      const backIndex = i + 2;
      const frontLine = profileMap.get(frontIndex);
      const backLine = profileMap.get(backIndex);

      let frontPoints = frontLine ? readWorldPolylinePoints(frontLine) : [];
      let backPoints = backLine ? readWorldPolylinePoints(backLine) : [];

      let geometry: any = null;
      let frontNeg: any = null;
      let frontPos: any = null;
      let backNeg: any = null;
      let backPos: any = null;
      if (frontPoints.length >= 2 && backPoints.length >= 2) {
        const frontStart = frontPoints[0];
        const frontEnd = frontPoints[frontPoints.length - 1];
        const backStart = backPoints[0];
        const backEnd = backPoints[backPoints.length - 1];

        const forwardCost = frontStart.distanceToSquared(backStart) + frontEnd.distanceToSquared(backEnd);
        const reverseCost = frontStart.distanceToSquared(backEnd) + frontEnd.distanceToSquared(backStart);
        const alignedBack = orientPolyline(backPoints, frontStart, frontEnd);
        const backUsed = (forwardCost <= reverseCost) ? alignedBack : alignedBack.slice().reverse();

        frontNeg = frontPoints[0].clone();
        frontPos = frontPoints[frontPoints.length - 1].clone();
        backNeg = backUsed[0].clone();
        backPos = backUsed[backUsed.length - 1].clone();

        const sampleCount = Math.max(8, Math.min(48, Math.min(frontPoints.length, backUsed.length)));
        const sampledFront = samplePolyline(frontPoints, sampleCount);
        const sampledBack = samplePolyline(backUsed, sampleCount);

        if (sampledFront.length >= 2 && sampledBack.length >= 2 && sampledFront.length === sampledBack.length) {
          const vertexCount = sampledFront.length * 2;
          const positions = new Float32Array(vertexCount * 3);
          const triangles: number[] = [];

          for (let j = 0; j < sampledFront.length; j++) {
            const f = sampledFront[j];
            const b = sampledBack[j];
            const fi = j * 2;
            const bi = fi + 1;

            positions[fi * 3] = f.x;
            positions[fi * 3 + 1] = f.y;
            positions[fi * 3 + 2] = f.z;

            positions[bi * 3] = b.x;
            positions[bi * 3 + 1] = b.y;
            positions[bi * 3 + 2] = b.z;

            if (j < sampledFront.length - 1) {
              const a = fi;
              const bIdx = bi;
              const c = fi + 2;
              const d = bi + 2;
              triangles.push(a, bIdx, c);
              triangles.push(bIdx, d, c);
            }
          }

          if (triangles.length >= 3) {
            const indexArray = vertexCount > 65535 ? new Uint32Array(triangles) : new Uint16Array(triangles);
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
            geometry.computeVertexNormals();
          }
        }
      }

      if (!geometry) {
        const sd1 = getSemidia(front);
        const sd2 = getSemidia(back);
        if (!Number.isFinite(sd1) || !Number.isFinite(sd2) || (sd1 as number) <= 0 || (sd2 as number) <= 0) continue;

        const z1 = surfaceOriginsZ[i] ?? 0;
        const z2 = surfaceOriginsZ[i + 1] ?? z1;

        const positions = new Float32Array(12);
        if (axis === 'YZ') {
          positions.set([
            0, -(sd1 as number), z1,
            0, (sd1 as number), z1,
            0, -(sd2 as number), z2,
            0, (sd2 as number), z2
          ]);
        } else {
          positions.set([
            -(sd1 as number), 0, z1,
            (sd1 as number), 0, z1,
            -(sd2 as number), 0, z2,
            (sd2 as number), 0, z2
          ]);
        }

        const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        if (axis === 'YZ') {
          frontNeg = new THREE.Vector3(0, -(sd1 as number), z1);
          frontPos = new THREE.Vector3(0, (sd1 as number), z1);
          backNeg = new THREE.Vector3(0, -(sd2 as number), z2);
          backPos = new THREE.Vector3(0, (sd2 as number), z2);
        } else {
          frontNeg = new THREE.Vector3(-(sd1 as number), 0, z1);
          frontPos = new THREE.Vector3((sd1 as number), 0, z1);
          backNeg = new THREE.Vector3(-(sd2 as number), 0, z2);
          backPos = new THREE.Vector3((sd2 as number), 0, z2);
        }
      }

      const overrideKeys = surfaceColorKeysAll(front, i);
      let colorOverride: number | null = null;
      for (const key of overrideKeys) {
        const parsed = parseColorToInt(colorOverrides?.[key]);
        if (parsed !== null) {
          colorOverride = parsed;
          break;
        }
      }
      const lensColor = (colorOverride !== null && !isWhiteLike(colorOverride)) ? colorOverride : fillColor;

      const material = new THREE.MeshBasicMaterial({
        color: lensColor,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 60000;
      mesh.userData = {
        type: 'renderWindowDirectFill',
        axis,
        intervalIndex: i,
        isDebugOverlay: true
      };
      scene.add(mesh);
      createdCount += 1;

      const axisCoord = (p: any) => axis === 'YZ' ? Number(p?.y) : Number(p?.x);
      const sideLines = (connectionMap.get(frontIndex) || [])
        .map((lineObj: any) => {
          const pts = readWorldPolylinePoints(lineObj);
          if (pts.length < 3) return null;
          const avg = pts.reduce((sum: number, p: any) => sum + axisCoord(p), 0) / pts.length;
          return { pts, avg };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.avg - b.avg);

      const addLSideFill = (linePts: any[], frontEnd: any, backEnd: any) => {
        if (!linePts || linePts.length < 3 || !frontEnd || !backEnd) return;
        const p0 = linePts[0];
        const p1 = linePts[Math.floor(linePts.length / 2)];
        const p2 = linePts[linePts.length - 1];

        const directCost = p0.distanceToSquared(frontEnd) + p2.distanceToSquared(backEnd);
        const reverseCost = p0.distanceToSquared(backEnd) + p2.distanceToSquared(frontEnd);

        const f = (directCost <= reverseCost) ? p0 : p2;
        const b = (directCost <= reverseCost) ? p2 : p0;
        const elbow = p1;

        if (!elbow) return;

        const sidePositions = new Float32Array([
          f.x, f.y, f.z,
          elbow.x, elbow.y, elbow.z,
          b.x, b.y, b.z
        ]);
        const sideGeometry = new THREE.BufferGeometry();
        sideGeometry.setAttribute('position', new THREE.BufferAttribute(sidePositions, 3));
        sideGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
        sideGeometry.computeVertexNormals();

        const sideMaterial = new THREE.MeshBasicMaterial({
          color: lensColor,
          transparent: true,
          opacity: 0.52,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false
        });
        const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
        sideMesh.frustumCulled = false;
        sideMesh.renderOrder = 60001;
        sideMesh.userData = {
          type: 'renderWindowDirectFill',
          axis,
          intervalIndex: i,
          isEdgeLFill: true
        };
        scene.add(sideMesh);
      };

      if (sideLines.length >= 1) {
        addLSideFill(sideLines[0].pts, frontNeg, backNeg);
      }
      if (sideLines.length >= 2) {
        addLSideFill(sideLines[sideLines.length - 1].pts, frontPos, backPos);
      }
    }

    return createdCount;
  };

  const drawCrossSectionView = async (axis: 'YZ' | 'XZ'): Promise<boolean> => {
    const w = window as any;
    try {
      const cm = w.ConfigurationManager;
      if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
        await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
      }
    } catch (_) {}

    try {
      if (typeof w.initializeAllTables === 'function') w.initializeAllTables();
    } catch (_) {}

    ensureRenderCanvasAttached();

    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    } catch (_) {}

    let rows: any[] = [];
    try {
      if (typeof w.getOpticalSystemRows === 'function') {
        const r = w.getOpticalSystemRows(w.tableOpticalSystem);
        rows = Array.isArray(r) ? r : [];
      }
    } catch (_) {
      rows = [];
    }
    if (!rows.length) {
      setRenderWindowStatus('No optical data');
      return false;
    }

    try {
      const sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      if (sceneForDraw && typeof w.clearAllOpticalElements === 'function') {
        try { w.clearAllOpticalElements(sceneForDraw); } catch (_) {}
      }
      if (sceneForDraw) {
        try {
          const raysToRemove: any[] = [];
          sceneForDraw.traverse((child: any) => {
            if (child?.userData?.type === 'optical-ray' || child?.userData?.isRayLine) {
              raysToRemove.push(child);
            }
          });
          [...new Set(raysToRemove)].forEach((obj: any) => {
            sceneForDraw.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
              else obj.material.dispose();
            }
          });
        } catch (_) {}
      }
      if (typeof w.drawOpticalSystemSurfaces === 'function' && sceneForDraw) {
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rows,
          scene: sceneForDraw,
          crossSectionOnly: true,
          showSurfaceOrigins: false,
          showSemidiaRing: false,
          showMirrorBackText: false,
          showDesignIntentLabels: renderShowDesignIntentLabels,
          crossSectionDirection: axis,
          crossSectionCenterOffset: 0
        });
      }

      if (sceneForDraw) {
        try {
          sceneForDraw.traverse((child: any) => {
            const ud = child?.userData || {};
            if (ud.type === 'surfaceProfile' && (ud.profileType === 'YZ' || ud.profileType === 'XZ')) {
              child.visible = ud.profileType === axis;
            }
            if (ud.type === 'connectionLine' && (ud.direction === 'YZ' || ud.direction === 'XZ')) {
              child.visible = ud.direction === axis;
            }
          });
        } catch (_) {}
      }

      const legacyCrossRays = await collectLegacyCrossRays(rows, axis);
      if (legacyCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
        w.drawCrossBeamRays(legacyCrossRays, sceneForDraw);
      }

      let fillCount = 0;
      try {
        fillCount = applyRenderWindowDirectCrossFill(sceneForDraw, axis, rows);
      } catch (fillErr) {
        console.warn('[RenderWindow] Cross-section lens fill failed:', fillErr);
        fillCount = 0;
      }

      if (axis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
        w.setCameraForXZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
      } else if (axis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
        w.setCameraForYZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
      }

      syncOrthoBoundsToRendererAspect();
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }
      scheduleRenderScaleOverlayUpdate();

      setRenderWindowStatus(`Ready (${axis} section) fill=${fillCount} source=renderwindow-app`);
      return true;
    } catch (err) {
      console.error('[RenderWindow] Cross-section draw failed:', err);
      setRenderWindowStatus('Draw failed');
      return false;
    }
  };

  const drawRender3DView = async (): Promise<boolean> => {
    const w = window as any;

    try {
      ensureRenderCanvasAttached();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

      let rows: any[] = [];
      try {
        if (typeof w.getOpticalSystemRows === 'function') {
          const r = w.getOpticalSystemRows(w.tableOpticalSystem);
          rows = Array.isArray(r) ? r : [];
        }
      } catch (_) {
        rows = [];
      }

      if (!rows.length) {
        setRenderWindowStatus('No optical data');
        return false;
      }

      const sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      if (!sceneForDraw) {
        setRenderWindowStatus('Scene unavailable');
        return false;
      }

      if (typeof w.clearAllOpticalElements === 'function') {
        try { w.clearAllOpticalElements(sceneForDraw); } catch (_) {}
      }

      try {
        const raysToRemove: any[] = [];
        sceneForDraw.traverse((child: any) => {
          if (child?.userData?.type === 'optical-ray' || child?.userData?.isRayLine) {
            raysToRemove.push(child);
          }
        });
        [...new Set(raysToRemove)].forEach((obj: any) => {
          sceneForDraw.remove(obj);
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
            else obj.material.dispose();
          }
        });
      } catch (_) {}

      if (typeof w.drawOpticalSystemSurfaces === 'function') {
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rows,
          scene: sceneForDraw,
          crossSectionOnly: false,
          showSurfaceOrigins: false,
          showSemidiaRing: true,
          showMirrorBackText: false,
          showDesignIntentLabels: renderShowDesignIntentLabels,
          crossSectionDirection: 'YZ',
          crossSectionCenterOffset: 0
        });
      }

      const legacyCrossRays = await collectLegacyCrossRays(rows, 'BOTH');
      if (legacyCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
        w.drawCrossBeamRays(legacyCrossRays, sceneForDraw);
      }

      try {
        if (typeof w.setCameraForYZCrossSection === 'function') {
          w.setCameraForYZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
        } else if (typeof w.fitCameraToScene === 'function') {
          w.fitCameraToScene();
        } else if (typeof w.adjustCameraView === 'function') {
          const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
          const controls = w.controls || (typeof w.getControls === 'function' ? w.getControls() : null);
          const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
          w.adjustCameraView(sceneForDraw, camera, controls, renderer);
        }
      } catch (_) {}

      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }
      scheduleRenderScaleOverlayUpdate();

      setRenderWindowStatus('Ready (3D)');
      return true;
    } catch (err) {
      console.error('[RenderWindow] 3D draw failed:', err);
      setRenderWindowStatus('Draw failed');
      return false;
    }
  };

  const refreshRenderLensTargets = (rowsMaybe?: any[]): RenderLensColorTarget[] => {
    let rows = Array.isArray(rowsMaybe) ? rowsMaybe : [];
    if (!rows.length) {
      try {
        const w = window as any;
        if (typeof w.getOpticalSystemRows === 'function') {
          const fetched = w.getOpticalSystemRows(w.tableOpticalSystem);
          rows = Array.isArray(fetched) ? fetched : [];
        }
      } catch (_) {
        rows = [];
      }
    }
    const targets = buildRenderLensColorTargets(rows);
    setRenderLensColorTargets(targets);
    return targets;
  };

  const updateRenderScaleOverlay = () => {
    try {
      const w = window as any;
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      if (!camera?.isOrthographicCamera || !renderer) {
        setRenderScaleLabel((prev) => prev === 'Scale unavailable' ? prev : 'Scale unavailable');
        setRenderScaleBarWidthPx(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
        return;
      }

      const widthPx = Math.max(
        1,
        Number(renderer?.domElement?.clientWidth) || 0,
        Number(renderer?.domElement?.width) || 0
      );
      const baseWorldWidth = Math.abs((Number(camera.right) || 0) - (Number(camera.left) || 0));
      const zoom = Math.max(0.0001, Number(camera.zoom) || 1);
      const worldWidth = baseWorldWidth / zoom;
      if (!Number.isFinite(worldWidth) || worldWidth <= 0 || widthPx <= 0) {
        setRenderScaleLabel((prev) => prev === 'Scale unavailable' ? prev : 'Scale unavailable');
        setRenderScaleBarWidthPx(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
        return;
      }

      const mmPerPixel = worldWidth / widthPx;
      const scaleInfo = chooseRenderScaleBar(mmPerPixel);
      setRenderScaleLabel((prev) => prev === scaleInfo.label ? prev : scaleInfo.label);
      setRenderScaleBarWidthPx((prev) => Math.abs(prev - scaleInfo.widthPx) < 0.5 ? prev : scaleInfo.widthPx);
    } catch (_) {
      setRenderScaleLabel((prev) => prev === 'Scale unavailable' ? prev : 'Scale unavailable');
      setRenderScaleBarWidthPx(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
    }
  };

  const scheduleRenderScaleOverlayUpdate = () => {
    try {
      if (renderScaleRafRef.current !== null) {
        cancelAnimationFrame(renderScaleRafRef.current);
      }
      renderScaleRafRef.current = requestAnimationFrame(() => {
        renderScaleRafRef.current = null;
        updateRenderScaleOverlay();
      });
    } catch (_) {
      updateRenderScaleOverlay();
    }
  };

  const redrawCurrentRenderView = async () => {
    if (isTauriRuntime()) {
      console.log('[RenderColor][Tauri] redrawCurrentRenderView', { renderViewMode, renderViewAxis });
    }
    if (renderViewMode === 'XZ' || renderViewMode === 'YZ') {
      await drawCrossSectionView(renderViewMode);
      return;
    }
    await drawRender3DView();
  };

  useEffect(() => {
    if (!isRenderWindowMode) return;
    try {
      localStorage.setItem(RENDER_SHOW_LABELS_KEY, renderShowDesignIntentLabels ? 'true' : 'false');
    } catch (_) {}
    redrawCurrentRenderView().catch(() => {
      setRenderWindowStatus('Draw failed');
    });
  }, [renderShowDesignIntentLabels]);

  useEffect(() => {
    if (!isRenderWindowMode) return;

    let boundControls: any = null;
    const onViewChange = () => {
      scheduleRenderScaleOverlayUpdate();
    };
    const bindControls = () => {
      try {
        const w = window as any;
        const controls = w.controls || (typeof w.getControls === 'function' ? w.getControls() : null);
        if (controls === boundControls) return;
        if (boundControls && typeof boundControls.removeEventListener === 'function') {
          boundControls.removeEventListener('change', onViewChange);
        }
        boundControls = controls;
        if (boundControls && typeof boundControls.addEventListener === 'function') {
          boundControls.addEventListener('change', onViewChange);
        }
      } catch (_) {}
    };

    bindControls();
    const rebindTimer = window.setInterval(bindControls, 800);
    window.addEventListener('resize', onViewChange);
    window.addEventListener('wheel', onViewChange, { passive: true });
    scheduleRenderScaleOverlayUpdate();

    return () => {
      try { window.clearInterval(rebindTimer); } catch (_) {}
      try { window.removeEventListener('resize', onViewChange); } catch (_) {}
      try { window.removeEventListener('wheel', onViewChange as EventListener); } catch (_) {}
      try {
        if (boundControls && typeof boundControls.removeEventListener === 'function') {
          boundControls.removeEventListener('change', onViewChange);
        }
      } catch (_) {}
      try {
        if (renderScaleRafRef.current !== null) {
          cancelAnimationFrame(renderScaleRafRef.current);
          renderScaleRafRef.current = null;
        }
      } catch (_) {}
    };
  }, [isRenderWindowMode, renderViewMode, renderViewAxis]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    const w = window as any;
    w.__cooptRenderWindowRedraw = async (rows?: any[]) => {
      try {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const prevRunning = g ? !!g.__cooptOptimizerIsRunning : false;
        const prevOverride = g ? g.__cooptOpticalSystemRowsOverride : null;
        if (g && Array.isArray(rows) && rows.length > 0) {
          g.__cooptOpticalSystemRowsOverride = rows;
        }
        if (g) g.__cooptOptimizerIsRunning = true;
        try {
          await drawRender3DView();
        } finally {
          if (g) {
            g.__cooptOptimizerIsRunning = prevRunning;
            g.__cooptOpticalSystemRowsOverride = prevOverride;
          }
        }
      } catch (_) {}
    };
    return () => {
      try { delete (w as any).__cooptRenderWindowRedraw; } catch (_) {
        (w as any).__cooptRenderWindowRedraw = undefined;
      }
    };
  }, [isRenderWindowMode]);

  useEffect(() => {
    // FIRST: Signal that React is mounted so main.ts can start initializing
    // This breaks the deadlock where main.ts waits for React and React waits for main.ts
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));

    const w = window as any;
    
    const initializeAfterMainTS = (_mode: "main-ready" | "module-loaded" | "fallback") => {
      if (isRenderWindowMode) {
        const drawWithPreparedData = async (): Promise<boolean> => {
          const w = window as any;
          try {
            const cm = w.ConfigurationManager;
            if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
              await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
            }
          } catch (err) {
            console.warn('[RenderWindow] Configuration load failed before draw:', err);
          }

          try {
            if (typeof w.initializeAllTables === 'function') {
              w.initializeAllTables();
            }
          } catch (_) {}

          ensureRenderCanvasAttached();

          try {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          } catch (_) {}

          let rowCount = 0;
          try {
            if (typeof w.getOpticalSystemRows === 'function') {
              const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
              rowCount = Array.isArray(rows) ? rows.length : 0;
            }
          } catch (_) {}

          if (rowCount === 0) {
            setRenderWindowStatus('No optical data');
            setRenderLensColorTargets([]);
            return false;
          }

          try {
            if (typeof w.getOpticalSystemRows === 'function') {
              const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
              refreshRenderLensTargets(rows);
            }
          } catch (_) {
            refreshRenderLensTargets([]);
          }

          try {
            const ok = await drawRender3DView();
            if (!ok) {
              setRenderWindowStatus('Draw failed');
              return false;
            }
          } catch (err) {
            console.error('[RenderWindow] Failed to draw optical system:', err);
            setRenderWindowStatus('Draw failed');
            return false;
          }

          const hasCanvas = ensureRenderCanvasAttached() || !!document.querySelector('#threejs-canvas-container canvas');
          if (hasCanvas) {
            setRenderViewMode('3D');
            setRenderWindowStatus('Ready (3D)');
            return true;
          }

          const hasRenderer = !!(w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null));
          if (!hasRenderer) {
            setRenderWindowStatus('Renderer unavailable');
          } else if (!hasCanvas) {
            setRenderWindowStatus('Canvas unavailable');
          } else {
            setRenderWindowStatus('Draw unavailable');
          }
          return false;
        };

        setRenderWindowStatus('Initializing...');
        setTimeout(() => {
          drawWithPreparedData().catch(() => {
            setRenderWindowStatus('Draw unavailable');
          });
        }, 200);
        return;
      }
      
      // Load active configuration to tables (this expands Blocks to Optical System rows)
      if (typeof (window as any).loadActiveConfigurationToTables === 'function') {
        try {
          (window as any).loadActiveConfigurationToTables();
        } catch (err) {
          console.error("[React] Failed to load active configuration:", err);
        }
      }
      
      // Initialize tables
      if (typeof (window as any).initializeAllTables === 'function') {
        (window as any).initializeAllTables();
      }

      if (analysisWindowMode.enabled) {
        if (typeof (window as any).setupAnalysisWindows === 'function') {
          (window as any).setupAnalysisWindows();
        }
        return;
      }
      
      requestRefreshBlockInspector();
      
      // Ensure analysis windows are set up
      if (typeof (window as any).setupAnalysisWindows === 'function') {
        (window as any).setupAnalysisWindows();
      }
      if (typeof (window as any).setupOpticalSystemChangeListeners === 'function') {
        (window as any).setupOpticalSystemChangeListeners(null);
      }
      
      // Verify optical system data is available
      setTimeout(() => {
        const w = window as any;
        if (typeof w.getOpticalSystemRows === 'function' && w.tableOpticalSystem) {
          w.getOpticalSystemRows(w.tableOpticalSystem);
        }
      }, 200);
    };

    const isMainReady = () => !!w.__cooptMainReady;
    const isMainModuleLoaded = () => !!w.__cooptMainModuleLoaded || typeof w.getOpticalSystemRows === "function";

    if (isMainReady()) {
      setTimeout(() => initializeAfterMainTS("main-ready"), 0);
      return;
    }

    if (isMainModuleLoaded()) {
      setTimeout(() => initializeAfterMainTS("module-loaded"), 0);
      return;
    }

    let initialized = false;
    const completeInit = (mode: "main-ready" | "module-loaded" | "fallback") => {
      if (initialized) return;
      initialized = true;
      setTimeout(() => initializeAfterMainTS(mode), 0);
    };

    const onMainReady = () => completeInit("main-ready");
    const onMainModuleLoaded = () => completeInit("module-loaded");
    const onMainLoadFailed = (evt: Event) => {
      const detail = (evt as CustomEvent<any>)?.detail;
      console.error("[React] main.ts load failed", detail || { message: w.__cooptMainLoadError || "unknown" });
    };

    window.addEventListener("coopt:main-ready", onMainReady, { once: true });
    window.addEventListener("coopt:main-module-loaded", onMainModuleLoaded, { once: true });
    window.addEventListener("coopt:main-load-failed", onMainLoadFailed);

    const fallbackTimer = window.setTimeout(() => {
      if (initialized) return;
      const status = {
        getOpticalSystemRows: typeof w.getOpticalSystemRows,
        initializeAllTables: typeof w.initializeAllTables,
        loadActiveConfigurationToTables: typeof w.loadActiveConfigurationToTables,
        mainReadyFlag: !!w.__cooptMainReady,
        mainModuleLoaded: !!w.__cooptMainModuleLoaded,
        mainLoadError: w.__cooptMainLoadError || null
      };
      if (status.mainLoadError) {
        console.warn("[React] main bootstrap timeout after load error, proceeding with fallback", status);
      } else {
        console.info("[React] main bootstrap slow-start, proceeding with fallback", status);
      }
      completeInit("fallback");
    }, 30000);

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("coopt:main-ready", onMainReady);
      window.removeEventListener("coopt:main-module-loaded", onMainModuleLoaded);
      window.removeEventListener("coopt:main-load-failed", onMainLoadFailed);
    };
  }, [analysisWindowMode.enabled, isOptimizeWindowMode, isRenderWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    const onResize = () => {
      try {
        ensureRenderCanvasAttached();
        syncOrthoBoundsToRendererAspect();
        const w = window as any;
        const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
        const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
        const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
        if (renderer && scene && camera && typeof renderer.render === 'function') {
          renderer.render(scene, camera);
        }
      } catch (_) {}
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isRenderWindowMode, renderViewAxis]);

  // Settings window mode is fully handled by DesktopSettingsPage React component below.

  useEffect(() => {
    if (!isOptimizeWindowMode) return;
    try {
      const w = window as any;
      let rows = w.getOpticalSystemRows ? w.getOpticalSystemRows(w.tableOpticalSystem) : [];
      let reqRows: any[] = [];
      try {
        const cfg = typeof w.loadSystemConfigurationsFromTableConfig === 'function'
          ? w.loadSystemConfigurationsFromTableConfig()
          : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
        const activeId = cfg?.activeConfigId;
        const activeCfg = Array.isArray(cfg?.configurations)
          ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
          : null;
        if (activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof w.expandBlocksToOpticalSystemRows === 'function') {
          const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
          if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
            // Keep whichever representation preserves more optimize flags.
            if (countOptimizeFlags(expanded.rows) > countOptimizeFlags(rows)) {
              rows = expanded.rows;
            }
          }
        }
        if (Array.isArray(cfg?.systemRequirements)) {
          reqRows = cfg.systemRequirements;
        }
      } catch (_) {}
      if (!Array.isArray(reqRows) || reqRows.length === 0) {
        reqRows = (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.getData === 'function')
          ? w.systemRequirementsEditor.getData()
          : [];
      }
      const variableCount = countBlockOptimizeVariables(w);
      setOptimizeState((prev: any) => ({
        ...prev,
        variableCount,
        requirementCount: Array.isArray(reqRows) ? reqRows.length : 0,
      }));
    } catch (_) {}
    return () => {};
  }, [isOptimizeWindowMode]);

  useEffect(() => {
    if (!analysisWindowMode.enabled) return;
    if (analysisWindowMode.analysis === 'astigmatism') return;
    if (analysisWindowMode.analysis === 'mtf' || analysisWindowMode.analysis === 'through-focus-mtf' || analysisWindowMode.analysis === 'field-mtf' || analysisWindowMode.analysis === 'distortion' || analysisWindowMode.analysis === 'distortion-grid') return;

    let restoreOpener: (() => void) | null = null;
    let tauriCloseUnlisten: (() => void) | null = null;
    try {
      const openerDescriptor = Object.getOwnPropertyDescriptor(window, 'opener');
      Object.defineProperty(window, 'opener', {
        configurable: true,
        get: () => window,
      });
      restoreOpener = () => {
        try {
          if (openerDescriptor) {
            Object.defineProperty(window, 'opener', openerDescriptor);
          } else {
            delete (window as any).opener;
          }
        } catch (_) {}
      };
    } catch (_) {}

    if (isTauriRuntime()) {
      (async () => {
        try {
          const [{ getCurrentWindow }, { getCurrentWebviewWindow }] = await Promise.all([
            import('@tauri-apps/api/window'),
            import('@tauri-apps/api/webviewWindow'),
          ]);
          const currentWindow = getCurrentWindow();
          const currentWebview = getCurrentWebviewWindow();
          const bootstrapStartedAt = Date.now();

          console.log('ℹ️ [Analysis][Desktop] bootstrap window:', {
            label: currentWindow.label,
            webviewLabel: currentWebview.label,
            analysis: analysisWindowMode.analysis,
          });

          tauriCloseUnlisten = await currentWindow.onCloseRequested((event) => {
            const elapsed = Date.now() - bootstrapStartedAt;
            if (elapsed < 8000) {
              console.warn('⚠️ [Analysis][Desktop] unexpected close requested during bootstrap', {
                label: currentWindow.label,
                analysis: analysisWindowMode.analysis,
                elapsed,
              });
              event.preventDefault();
            }
          });
        } catch (err) {
          console.error('❌ [Analysis][Desktop] failed to attach close-request guard:', err);
        }
      })();
    }

    const analysisButtonMap: Record<string, string> = {
      'system-data': 'open-system-data-window-btn',
      'spot-diagram': 'open-spot-diagram-window-btn',
      'spherical-aberration': 'open-spherical-aberration-window-btn',
      'astigmatism': 'open-astigmatism-window-btn',
      'distortion': 'open-distortion-window-btn',
      'distortion-grid': 'open-distortion-grid-window-btn',
      'magnification-chromatic-aberration': 'open-magnification-chromatic-aberration-window-btn',
      'integrated-aberration': 'open-integrated-aberration-window-btn',
      'transverse-aberration': 'open-transverse-aberration-window-btn',
      'opd': 'open-opd-window-btn',
      'psf': 'open-psf-window-btn',
      'mtf': 'open-mtf-window-btn',
      'through-focus-spot': 'open-through-focus-spot-window-btn',
      'through-focus-mtf': 'open-through-focus-mtf-window-btn',
      'field-mtf': 'open-field-mtf-window-btn',
    };
    const analysisPopupTitleMap: Record<string, string> = {
      'system-data': 'System Data',
      'spot-diagram': 'Spot Diagram',
      'spherical-aberration': 'Spherical Aberration',
      'astigmatism': 'Astigmatism',
      'distortion': 'Distortion',
      'distortion-grid': 'Distortion Grid',
      'magnification-chromatic-aberration': 'Lateral Chromatic Aberration',
      'integrated-aberration': 'Integrated Aberration',
      'transverse-aberration': 'Transverse Aberration',
      'opd': 'Optical Path Difference',
      'psf': 'Point Spread Function',
      'mtf': 'Modulation Transfer Function',
      'through-focus-spot': 'Through-Focus Spot',
      'through-focus-mtf': 'Through-Focus MTF',
      'field-mtf': 'Object MTF',
    };

    const targetButtonId = analysisButtonMap[analysisWindowMode.analysis];
    const targetPopupTitle = analysisPopupTitleMap[analysisWindowMode.analysis];
    if (targetPopupTitle) {
      document.title = targetPopupTitle;
    }
    let disposed = false;
    let rafId = 0;
    let timeoutId = 0;
    let tries = 0;
    const maxTries = 180;

    const attemptLaunch = () => {
      if (disposed) return;
      if (analysisWindowMode.analysis === 'system-data') {
        return;
      }
      tries += 1;
      const w = window as any;
      try {
        if (typeof w.setupAnalysisWindows === 'function') {
          w.setupAnalysisWindows();
        }
      } catch (_) {}

      if (targetPopupTitle) {
        try {
          w.__preopenedAnalysisPopupMap = w.__preopenedAnalysisPopupMap || {};
          w.__preopenedAnalysisPopupMap[targetPopupTitle] = window;
        } catch (_) {}
      }

      const button = targetButtonId ? document.getElementById(targetButtonId) : null;
      if (button) {
        try {
          const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          button.dispatchEvent(clickEvent);
        } catch (_) {}
        return;
      }

      if (tries >= maxTries) {
        return;
      }
      rafId = window.requestAnimationFrame(attemptLaunch);
    };

    const onMainReady = () => {
      if (disposed) return;
      try { window.cancelAnimationFrame(rafId); } catch (_) {}
      rafId = window.requestAnimationFrame(attemptLaunch);
    };

    window.addEventListener('coopt:main-ready', onMainReady);
    timeoutId = window.setTimeout(() => {
      if (disposed) return;
      attemptLaunch();
    }, 0);
    rafId = window.requestAnimationFrame(attemptLaunch);

    return () => {
      disposed = true;
      try { window.removeEventListener('coopt:main-ready', onMainReady); } catch (_) {}
      try { window.cancelAnimationFrame(rafId); } catch (_) {}
      try { window.clearTimeout(timeoutId); } catch (_) {}
      if (targetPopupTitle) {
        try {
          const store = (window as any).__preopenedAnalysisPopupMap;
          if (store && store[targetPopupTitle] === window) {
            delete store[targetPopupTitle];
          }
        } catch (_) {}
      }
      if (tauriCloseUnlisten) {
        try { tauriCloseUnlisten(); } catch (_) {}
      }
      if (restoreOpener) restoreOpener();
    };
  }, [analysisWindowMode.enabled, analysisWindowMode.analysis]);

  if (isSettingsWindowMode) {
    return <DesktopSettingsPage />;
  }

  if (analysisWindowMode.analysis === 'mtf' || analysisWindowMode.analysis === 'through-focus-mtf' || analysisWindowMode.analysis === 'field-mtf') {
    return <MtfAnalysisPage type={analysisWindowMode.analysis as any} />;
  }

  if (analysisWindowMode.analysis === 'distortion' || analysisWindowMode.analysis === 'distortion-grid') {
    return <DistortionAnalysisPage type={analysisWindowMode.analysis as any} />;
  }

  if (isOptimizeWindowMode) {
    const percent = Number.isFinite(Number(optimizeState?.percent)) ? Math.max(0, Math.min(100, Number(optimizeState.percent))) : 0;

    const maybeAutoRender = async (_rows: any[]) => {
      if (!optAutoRenderOnAccept) return;
      try {
        const w = window as any;
        if (typeof w.drawOpticalSystem === 'function') {
          w.drawOpticalSystem();
        }
        const popup = w.popup3DWindow;
        if (popup && !popup.closed && typeof popup.postMessage === 'function') {
          popup.postMessage({ action: 'request-redraw' }, '*');
        }
      } catch (_) {}
    };

    const runOptimize = async () => {
      if (optRunning) return;
      const w = window as any;
      const hostWindow = (() => {
        try {
          const op = (window as any).opener;
          if (op && !op.closed) return op as any;
        } catch (_) {}
        return w;
      })();

      const cloneJsonLocal = (v: any) => {
        try { return JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
      };
      const captureHostOptimizeSnapshot = () => {
        try {
          const cfg = typeof hostWindow.loadSystemConfigurationsFromTableConfig === 'function'
            ? hostWindow.loadSystemConfigurationsFromTableConfig()
            : (typeof hostWindow.loadSystemConfigurations === 'function' ? hostWindow.loadSystemConfigurations() : null);
          const rows = typeof hostWindow.getOpticalSystemRows === 'function'
            ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
            : [];
          return {
            config: cloneJsonLocal(cfg),
            rows: Array.isArray(rows) ? (cloneJsonLocal(rows) || []) : [],
          };
        } catch (_) {
          return { config: null, rows: [] };
        }
      };

      // Snapshot at the exact Run-button click timing for deterministic Undo baseline.
      const clickSnapshot = captureHostOptimizeSnapshot();

      const maxIterations = Math.max(1, Math.floor(Number(optMaxIterations) || 1));

      let rows = w.getOpticalSystemRows ? w.getOpticalSystemRows(w.tableOpticalSystem) : [];
      if ((!Array.isArray(rows) || rows.length === 0) && hostWindow !== w) {
        try {
          rows = hostWindow.getOpticalSystemRows ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem) : [];
        } catch (_) {}
      }
      try {
        const cfg = typeof hostWindow.loadSystemConfigurationsFromTableConfig === 'function'
          ? hostWindow.loadSystemConfigurationsFromTableConfig()
          : (typeof hostWindow.loadSystemConfigurations === 'function' ? hostWindow.loadSystemConfigurations() : null);
        const activeId = cfg?.activeConfigId;
        const activeCfg = Array.isArray(cfg?.configurations)
          ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
          : null;
        if (activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof hostWindow.expandBlocksToOpticalSystemRows === 'function') {
          const expanded = hostWindow.expandBlocksToOpticalSystemRows(activeCfg.blocks);
          if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
            // Keep whichever representation preserves more optimize flags.
            if (countOptimizeFlags(expanded.rows) > countOptimizeFlags(rows)) {
              rows = expanded.rows;
            }
          }
        }
      } catch (_) {}
      if (!Array.isArray(rows) || rows.length === 0) {
        setOptimizeState((prev: any) => ({ ...prev, status: 'error', issue: 'No optical system data', phase: 'error' }));
        return;
      }

      const activeConfigId = (() => {
        try {
          const cfg = typeof hostWindow.loadSystemConfigurationsFromTableConfig === 'function'
            ? hostWindow.loadSystemConfigurationsFromTableConfig()
            : (typeof hostWindow.loadSystemConfigurations === 'function' ? hostWindow.loadSystemConfigurations() : null);
          if (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null) {
            return String(cfg.activeConfigId).trim();
          }
        } catch (_) {}
        return '';
      })();

      const normalizeRequirementConfigId = (row: any): string => {
        try {
          const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          const cfg = typeof hostWindow.loadSystemConfigurationsFromTableConfig === 'function'
            ? hostWindow.loadSystemConfigurationsFromTableConfig()
            : (typeof hostWindow.loadSystemConfigurations === 'function' ? hostWindow.loadSystemConfigurations() : null);
          if (sre && typeof sre._normalizeConfigId === 'function') {
            return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
          }
        } catch (_) {}
        const rawCfg = String(row?.configId ?? '').trim();
        return rawCfg || activeConfigId;
      };

      const collectSystemRequirementsRows = (): any[] => {
        try {
          const cfg = typeof hostWindow.loadSystemConfigurationsFromTableConfig === 'function'
            ? hostWindow.loadSystemConfigurationsFromTableConfig()
            : (typeof hostWindow.loadSystemConfigurations === 'function' ? hostWindow.loadSystemConfigurations() : null);
          if (Array.isArray(cfg?.systemRequirements) && cfg.systemRequirements.length > 0) {
            return cfg.systemRequirements;
          }
        } catch (_) {}
        try {
          const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (sre && typeof sre.getData === 'function') {
            const req = sre.getData();
            if (Array.isArray(req)) return req;
          }
        } catch (_) {}
        // 3rd fallback: read directly from shared 'systemRequirementsData' localStorage key.
        // This works in Tauri WebviewWindow where systemRequirementsEditor is not initialized.
        try {
          const rawReqs = localStorage.getItem('systemRequirementsData');
          if (rawReqs) {
            const parsed = JSON.parse(rawReqs);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
          }
        } catch (_) {}
        return [];
      };

      const countActiveRequirements = (rows: any[], strictActiveConfig = true): number => {
        if (!Array.isArray(rows) || rows.length === 0) return 0;
        return rows.reduce((acc: number, row: any) => {
          if (!row || typeof row !== 'object') return acc;
          const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
          const operand = String(row.operand ?? '').trim();
          const weight = Number(row.weight ?? 1);
          const reqCfg = normalizeRequirementConfigId(row);
          if (strictActiveConfig && activeConfigId && reqCfg !== activeConfigId) return acc;
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) return acc;
          return acc + 1;
        }, 0);
      };

      let systemRequirementsRows = collectSystemRequirementsRows();
      let activeRequirementCount = countActiveRequirements(systemRequirementsRows, true);

      if (activeRequirementCount <= 0) {
        try {
          const reqEditor = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
            const p = reqEditor.evaluateAndUpdateNow({ reason: 'optimize-prerun-guard', forceSilent: true, silent: true });
            if (p && typeof p.then === 'function') {
              await p;
            }
          }
        } catch (_) {}

        systemRequirementsRows = collectSystemRequirementsRows();
        activeRequirementCount = countActiveRequirements(systemRequirementsRows, true);
      }

      if (activeRequirementCount <= 0) {
        // Fallback: allow optimization to proceed when requirements exist but configId mapping is temporarily stale.
        activeRequirementCount = countActiveRequirements(systemRequirementsRows, false);
      }

      if (activeRequirementCount <= 0) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: 'No active System Requirements (check enabled/weight/operand)',
        }));
        return;
      }

      const optimizeVarCount = countBlockOptimizeVariables(hostWindow);
      if (optimizeVarCount <= 0) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: 'No optimize variables found (check Design Intent -> Optimize flags)',
          variableCount: 0,
        }));
        return;
      }

      (window as any).__cooptOptimizeStopRequested = false;
      try { (globalThis as any).__stopOptimization = false; } catch (_) {}
      try { await clearOptimizerStop(); } catch (_) {}
      try {
        const g = window as any;
        if (g.__cooptStopPulseTimer) {
          clearInterval(g.__cooptStopPulseTimer);
          g.__cooptStopPulseTimer = null;
        }
      } catch (_) {}
      setOptStopRequested(false);
      setOptRunning(true);
      setOptimizeState((prev: any) => ({
        ...prev,
        status: 'running',
        phase: 'starting',
        modeUsed: optMethod,
        iterations: 0,
        acceptCount: 0,
        rejectCount: 0,
        issue: '-',
        percent: 0,
        progressEvents: [],
      }));

      const sourceRows = (() => {
        try {
          const table = hostWindow.tableSource || w.tableSource;
          if (table && typeof table.getData === 'function') {
            const d = table.getData();
            if (Array.isArray(d)) return d;
          }
        } catch (_) {}
        return [];
      })();

      const objectRows = (() => {
        try {
          const table = hostWindow.tableObject || w.tableObject;
          if (table && typeof table.getData === 'function') {
            const d = table.getData();
            if (Array.isArray(d)) return d;
          }
        } catch (_) {}
        return [];
      })();

      try {
        if (typeof hostWindow.__cooptInitMeritFunctionEditor === 'function') {
          hostWindow.__cooptInitMeritFunctionEditor();
        }
      } catch (_) {}
      try {
        if (typeof w.__cooptInitMeritFunctionEditor === 'function') {
          w.__cooptInitMeritFunctionEditor();
        }
      } catch (_) {}

      try {
        let tsAcceptCount = 0;
        let tsRejectCount = 0;
        let tsBestScore = Number.POSITIVE_INFINITY;
        let tsBestRequirementScore = Number.POSITIVE_INFINITY;
        let lastAutoRenderAt = 0;
        const AUTO_RENDER_THROTTLE_MS = 120;
        let reqEvalInFlight = false;
        let lastReqEvalAt = 0;
        const REQ_EVAL_THROTTLE_MS = 220;

        const requestRenderSync = (rowsFromProgress?: any[]) => {
          const hasOpenRenderTarget = (() => {
            try {
              const hostPopup = hostWindow?.popup3DWindow;
              if (hostPopup && !hostPopup.closed) return true;
            } catch (_) {}
            try {
              const localPopup = (window as any)?.popup3DWindow;
              if (localPopup && !localPopup.closed) return true;
            } catch (_) {}
            return false;
          })();

          // Keep existing opt-in behavior for auto-opening Render window,
          // but always sync when a render popup is already open.
          if (!optAutoRenderOnAccept && !hasOpenRenderTarget) return;
          const now = Date.now();
          if ((now - lastAutoRenderAt) < AUTO_RENDER_THROTTLE_MS) return;
          lastAutoRenderAt = now;
          let rowsForRender: any[] = [];

          // Ensure Render window is opened/focused in desktop mode as auto-render target.
          if (optAutoRenderOnAccept) {
            try {
              const openRender = (hostWindow as any).__cooptOpenRenderWindow || (window as any).__cooptOpenRenderWindow;
              if (isTauriRuntime() && typeof openRender === 'function') {
                void Promise.resolve(openRender());
              } else if (typeof (hostWindow as any).handleRender3D === 'function') {
                (hostWindow as any).handleRender3D();
              } else {
                const openBtn = hostWindow?.document?.getElementById?.('open-3d-window-btn') as HTMLButtonElement | null;
                if (openBtn && typeof openBtn.click === 'function') {
                  openBtn.click();
                }
              }
            } catch (_) {}
          }

          // Signal the main window via localStorage (works across Tauri WebviewWindows
          // where hostWindow === w and direct DOM access is impossible).
          try {
            const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
            const localOverride = g && Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0
              ? g.__cooptOpticalSystemRowsOverride
              : null;
            const hostOverride = hostWindow && Array.isArray((hostWindow as any).__cooptOpticalSystemRowsOverride) && (hostWindow as any).__cooptOpticalSystemRowsOverride.length > 0
              ? (hostWindow as any).__cooptOpticalSystemRowsOverride
              : null;
            const tableRows = (typeof w.getOpticalSystemRows === 'function') ? w.getOpticalSystemRows(w.tableOpticalSystem) : [];
            const hostTableRows = (hostWindow !== w && typeof hostWindow.getOpticalSystemRows === 'function')
              ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
              : [];
            const progressRows = Array.isArray(rowsFromProgress) && rowsFromProgress.length > 0
              ? rowsFromProgress
              : null;
            const currentRows = progressRows ?? localOverride ?? hostOverride ?? tableRows ?? hostTableRows ?? [];
            rowsForRender = Array.isArray(currentRows) ? currentRows : [];
            const payload = { ts: now, rows: rowsForRender };
            localStorage.setItem('coopt.renderSyncRequest', JSON.stringify(payload));
            if (isTauriRuntime()) {
              void (async () => {
                try {
                  const core = await import('@tauri-apps/api/core');
                  if (core && typeof (core as any).invoke === 'function') {
                    await (core as any).invoke('sync_render_rows', { rows: rowsForRender });
                  }
                } catch (_) {}
                try {
                  const mod = await import('@tauri-apps/api/event');
                  if (mod && typeof (mod as any).emit === 'function') {
                    await (mod as any).emit('coopt-render-sync-request', payload);
                  }
                } catch (_) {}
              })();
            }
          } catch (_) {}

          // Guard the draw path so it prefers accepted rows during optimize progress sync.
          let prevHostRunning: any;
          let prevHostRowsOverride: any;
          let prevLocalRunning: any;
          let prevLocalRowsOverride: any;
          try {
            prevHostRunning = (hostWindow as any).__cooptOptimizerIsRunning;
            prevHostRowsOverride = (hostWindow as any).__cooptOpticalSystemRowsOverride;
            prevLocalRunning = (w as any).__cooptOptimizerIsRunning;
            prevLocalRowsOverride = (w as any).__cooptOpticalSystemRowsOverride;
            if (rowsForRender.length > 0) {
              (hostWindow as any).__cooptOpticalSystemRowsOverride = rowsForRender;
              (w as any).__cooptOpticalSystemRowsOverride = rowsForRender;
            }
            (hostWindow as any).__cooptOptimizerIsRunning = true;
            (w as any).__cooptOptimizerIsRunning = true;
          } catch (_) {}

          try {
            if (typeof hostWindow.drawOpticalSystem === 'function') {
              hostWindow.drawOpticalSystem();
            }
          } catch (_) {}
          try {
            const popup = hostWindow.popup3DWindow;
            if (popup && !popup.closed) {
              if (typeof popup.__cooptRenderWindowRedraw === 'function') {
                void Promise.resolve(popup.__cooptRenderWindowRedraw(rowsForRender));
              } else if (typeof popup.postMessage === 'function') {
                popup.postMessage({ action: 'request-redraw' }, '*');
              }
            }
          } catch (_) {}
          try {
            if (hostWindow !== w && typeof w.drawOpticalSystem === 'function') {
              w.drawOpticalSystem();
            }
          } catch (_) {}
          setTimeout(() => {
            try {
              (hostWindow as any).__cooptOptimizerIsRunning = prevHostRunning;
              (hostWindow as any).__cooptOpticalSystemRowsOverride = prevHostRowsOverride;
              (w as any).__cooptOptimizerIsRunning = prevLocalRunning;
              (w as any).__cooptOpticalSystemRowsOverride = prevLocalRowsOverride;
            } catch (_) {}
          }, 400);
        };

        const loadHostConfigSnapshot = () => {
          try {
            const cfg = typeof hostWindow.loadSystemConfigurationsFromTableConfig === 'function'
              ? hostWindow.loadSystemConfigurationsFromTableConfig()
              : (typeof hostWindow.loadSystemConfigurations === 'function' ? hostWindow.loadSystemConfigurations() : null);
            return cloneJsonLocal(cfg);
          } catch (_) {
            return null;
          }
        };

        const loadHostRowsSnapshot = () => {
          try {
            const r = typeof hostWindow.getOpticalSystemRows === 'function'
              ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
              : [];
            return Array.isArray(r) ? (cloneJsonLocal(r) || []) : [];
          } catch (_) {
            return [];
          }
        };

        const beforeHostConfigSnapshot = clickSnapshot?.config ?? loadHostConfigSnapshot();
        const beforeHostRowsSnapshot = clickSnapshot?.rows ?? loadHostRowsSnapshot();

        const getRequirementTableScoreSnapshot = () => {
          try {
            const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
            if (sre && typeof sre.getData === 'function') {
              const rr = sre.getData();
              if (Array.isArray(rr)) {
                let sum = 0;
                let cnt = 0;
                for (const row of rr) {
                  const weight = Number(row?.weight ?? 1);
                  const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
                  const operand = String(row?.operand ?? '').trim();
                  if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
                  const c = Number.isFinite(Number(row?._contribution)) ? Number(row._contribution) : Number(row?.score);
                  if (Number.isFinite(c) && c > 0) {
                    sum += c;
                    cnt += 1;
                  }
                }
                return {
                  score: (cnt > 0 && Number.isFinite(sum)) ? sum : Number.NaN,
                  reqCount: cnt,
                };
              }
            }
          } catch (_) {}
          return { score: Number.NaN, reqCount: Number.NaN };
        };

        const scheduleRequirementRefresh = () => {
          const now = Date.now();
          if (reqEvalInFlight) return;
          if ((now - lastReqEvalAt) < REQ_EVAL_THROTTLE_MS) return;
          lastReqEvalAt = now;
          reqEvalInFlight = true;

          void (async () => {
            try {
              const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
              if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
                const p = sre.evaluateAndUpdateNow({ reason: 'optimize-progress-live', forceSilent: true, silent: true });
                if (p && typeof (p as any).then === 'function') {
                  await p;
                }
              }

              const snap = getRequirementTableScoreSnapshot();
              const tableScore = Number(snap.score);
              if (!Number.isFinite(tableScore)) return;
              tsBestRequirementScore = Math.min(tsBestRequirementScore, tableScore);

              setOptimizeState((prev: any) => ({
                ...prev,
                meritAfter: tableScore,
                requirementScoreAfter: tableScore,
                requirementScoreTable: tableScore,
                best: Number.isFinite(tsBestRequirementScore)
                  ? tsBestRequirementScore
                  : prev.best,
              }));
            } catch (_) {
              // ignore live refresh failures and keep progress loop running
            } finally {
              reqEvalInFlight = false;
            }
          })();
        };

        const optimizerRunner = (() => {
          try {
            const hostOpt = hostWindow?.OptimizationMVP;
            if (hostWindow && hostWindow !== w && hostOpt && typeof hostOpt.run === 'function') {
              return {
                source: 'host-window',
                run: hostOpt.run.bind(hostOpt),
              };
            }
          } catch (_) {}
          return {
            source: 'local-window',
            run: runOptimizationMVP,
          };
        })();

        const tsResult: any = await optimizerRunner.run({
          opticalSystemRows: rows,
          sourceRows,
          objectRows,
          activeConfigId,
          systemRequirementsRows,
          method: optMethod,
          maxIterations,
          forceTs: true,
          shouldStop: () => !!(window as any).__cooptOptimizeStopRequested,
          onProgress: (ev: any) => {
            const phase = String(ev?.phase ?? 'running');
            const phaseLower = phase.toLowerCase();
            const iter = Number(ev?.iter ?? 0);
            scheduleRequirementRefresh();
            const snap = getRequirementTableScoreSnapshot();
            const progressCurrentScore = Number(ev?.current);
            const progressViolationScore = Number(ev?.violationScore);
            const tableScore = Number(snap.score);
            // ev.current = violationScore + softPenalty (total Requirement score)
            // ev.violationScore = hard violations only (fall back)
            const displayScore = Number.isFinite(progressCurrentScore)
              ? progressCurrentScore
              : (Number.isFinite(progressViolationScore)
                ? progressViolationScore
                : (Number.isFinite(tableScore) ? tableScore : Number.NaN));

            if (phaseLower === 'accept') tsAcceptCount += 1;
            if (phaseLower === 'reject') tsRejectCount += 1;
            if (Number.isFinite(displayScore)) {
              tsBestRequirementScore = Math.min(tsBestRequirementScore, displayScore);
            }

            if (phaseLower.includes('accept') || (ev as any)?.accepted === true) {
              requestRenderSync(Array.isArray((ev as any)?.rows) ? (ev as any).rows : undefined);
            }

            setOptimizeState((prev: any) => ({
              ...prev,
              status: 'running',
              phase,
              modeUsed: optMethod,
              iterations: iter,
              meritBefore: prev.meritBefore,
              meritAfter: Number.isFinite(displayScore) ? displayScore : prev.meritAfter,
              requirementScoreBefore: prev.requirementScoreBefore,
              requirementScoreAfter: Number.isFinite(displayScore) ? displayScore : prev.requirementScoreAfter,
              requirementScoreTable: Number.isFinite(displayScore) ? displayScore : prev.requirementScoreTable,
              acceptCount: tsAcceptCount,
              rejectCount: tsRejectCount,
              issue: '-',
              percent: maxIterations > 0 ? Math.round((Math.max(0, iter) / maxIterations) * 100) : 0,
              best: Number.isFinite(tsBestRequirementScore)
                ? tsBestRequirementScore
                : prev.best,
            }));
          },
        });

        if (!tsResult || tsResult.ok !== true) {
          throw new Error(`[${optimizerRunner.source}] ${String(tsResult?.reason || 'TS/WASM optimizer returned non-ok result')}`);
        }

        const tsIterations = Number(tsResult?.iterations ?? NaN);
        const tsAborted = !!(tsResult?.aborted || (window as any).__cooptOptimizeStopRequested);
        // Stop 時は iterations=0 でも正常系として扱い、Best 復元・同期処理を継続する。
        if ((!Number.isFinite(tsIterations) || tsIterations <= 0) && !tsAborted) {
          throw new Error(`TS/WASM optimizer produced no iterations (iterations=${String(tsResult?.iterations)})`);
        }

        let afterHostConfigSnapshot: any = null;
        let afterHostRowsSnapshot: any[] = [];
        try {
          afterHostConfigSnapshot = loadHostConfigSnapshot();
          afterHostRowsSnapshot = loadHostRowsSnapshot();
          if (typeof hostWindow.__cooptRecordOptimizationUndoFromSnapshots === 'function') {
            hostWindow.__cooptRecordOptimizationUndoFromSnapshots(
              beforeHostConfigSnapshot,
              beforeHostRowsSnapshot,
              afterHostConfigSnapshot,
              afterHostRowsSnapshot,
              'Optimization run'
            );
          }
        } catch (_) {}

        try {
          const rowsAfter = hostWindow.getOpticalSystemRows ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem) : [];
          if (Array.isArray(rowsAfter) && rowsAfter.length > 0) {
            await maybeAutoRender(rowsAfter);
            const applyToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(optimizeRowsSyncKey, JSON.stringify({
              rows: rowsAfter,
              token: applyToken,
              beforeConfigSnapshot: beforeHostConfigSnapshot,
              beforeRowsSnapshot: beforeHostRowsSnapshot,
              afterConfigSnapshot: afterHostConfigSnapshot,
              afterRowsSnapshot: afterHostRowsSnapshot,
            }));
            try {
              const mod = await import('@tauri-apps/api/event');
              if (mod && typeof (mod as any).emit === 'function') {
                await (mod as any).emit('coopt-optimize-rows-sync', {
                  rows: rowsAfter,
                  token: applyToken,
                  beforeConfigSnapshot: beforeHostConfigSnapshot,
                  beforeRowsSnapshot: beforeHostRowsSnapshot,
                  afterConfigSnapshot: afterHostConfigSnapshot,
                  afterRowsSnapshot: afterHostRowsSnapshot,
                });
              }
            } catch (_) {}
          }
        } catch (_) {}

        try {
          const reqEditor = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
            await reqEditor.evaluateAndUpdateNow({ reason: 'optimize-finished-sync', forceSilent: true, silent: true });
          }
        } catch (_) {}

        let finalTableScore = Number.NaN;
        try {
          const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (sre && typeof sre.getData === 'function') {
            const rr = sre.getData();
            if (Array.isArray(rr)) {
              let sum = 0;
              let cnt = 0;
              for (const row of rr) {
                const c = Number.isFinite(Number(row?._contribution)) ? Number(row._contribution) : Number(row?.score);
                if (Number.isFinite(c) && c > 0) { sum += c; cnt += 1; }
              }
              if (cnt > 0 && Number.isFinite(sum)) finalTableScore = sum;
            }
          }
        } catch (_) {}

        const finalScore = Number.isFinite(finalTableScore)
          ? finalTableScore
          : Number.NaN;
        const finalBest = Number.isFinite(finalScore)
          ? Math.min(
            Number.isFinite(tsBestRequirementScore) ? tsBestRequirementScore : finalScore,
            finalScore
          )
          : (Number.isFinite(tsBestRequirementScore) ? tsBestRequirementScore : Number.NaN);
        const aborted = tsAborted;

        setOptimizeState((prev: any) => ({
          ...prev,
          status: aborted ? 'stopped' : 'done',
          phase: aborted ? 'stopped' : 'done',
          issue: aborted ? 'Stopped by user' : '-',
          iterations: Number.isFinite(tsIterations) ? tsIterations : prev.iterations,
          variableCount: Number.isFinite(Number(tsResult?.variables)) ? Number(tsResult.variables) : prev.variableCount,
          requirementCount: Number.isFinite(Number(tsResult?.hardViolations?.length))
            ? Number(tsResult.hardViolations.length)
            : prev.requirementCount,
          requirementScoreAfter: Number.isFinite(finalScore) ? finalScore : prev.requirementScoreAfter,
          requirementScoreTable: Number.isFinite(finalTableScore)
            ? finalTableScore
            : (Number.isFinite(finalScore) ? finalScore : prev.requirementScoreTable),
          meritAfter: Number.isFinite(finalTableScore) ? finalTableScore
            : (Number.isFinite(finalScore) ? finalScore : prev.meritAfter),
          best: Number.isFinite(finalBest) ? finalBest : prev.best,
          percent: 100,
        }));

      } catch (tsErr) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: (tsErr as any)?.message || String(tsErr),
          percent: 100,
        }));
      } finally {
        try { await clearOptimizerStop(); } catch (_) {}
        try {
          const g = window as any;
          if (g.__cooptStopPulseTimer) {
            clearInterval(g.__cooptStopPulseTimer);
            g.__cooptStopPulseTimer = null;
          }
        } catch (_) {}
        setOptRunning(false);
        setOptStopRequested(false);
        (window as any).__cooptOptimizeStopRequested = false;
        try { (globalThis as any).__stopOptimization = false; } catch (_) {}
        try {
          (window as any).__cooptOptimizerIsRunning = false;
          if (hostWindow && hostWindow !== w) {
            hostWindow.__cooptOptimizerIsRunning = false;
          }
        } catch (_) {}
      }
    };

    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#f4f4f4', color: '#222', padding: 12, boxSizing: 'border-box', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: '0 0 auto' }}>Optimize Progress</div>
          <div style={{ height: 6, background: '#eceef2', borderRadius: 999, overflow: 'hidden', flex: '1 1 auto', minWidth: 120 }}>
            <div style={{ width: `${percent}%`, height: '100%', background: '#4f8cff', transition: 'width 120ms linear' }} />
          </div>
          <div style={{ fontSize: 12, color: '#666', flex: '0 0 auto' }}>{optRunning ? 'Running' : String(optimizeState?.status || 'Idle')}</div>
        </div>
        <div style={{ fontSize: 12, color: '#555' }}>Updates per candidate evaluation (±step)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" disabled={optRunning} onClick={() => { void runOptimize(); }} style={{ padding: '6px 10px' }}>Run</button>
          <button type="button" disabled={!optRunning} onClick={() => {
            (window as any).__cooptOptimizeStopRequested = true;
            try { (globalThis as any).__stopOptimization = true; } catch (_) {}
            setOptStopRequested(true);
            try {
              const wAny = window as any;
              if (wAny.OptimizationMVP && typeof wAny.OptimizationMVP.stop === 'function') {
                wAny.OptimizationMVP.stop();
              }
              const op = wAny.opener;
              if (op && !op.closed && op.OptimizationMVP && typeof op.OptimizationMVP.stop === 'function') {
                op.OptimizationMVP.stop();
              }
            } catch (_) {}
            setOptimizeState((prev: any) => ({ ...prev, phase: 'stopping', issue: 'Stop requested...' }));
          }} style={{ padding: '6px 10px' }}>Stop</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            Method
            <select value={optMethod} disabled={optRunning} onChange={(e) => setOptMethod((e.target.value as 'kkt' | 'lm' | 'cd'))} style={{ padding: '4px 6px' }}>
              <option value="kkt">Augmented Lagrangian (AL)</option>
              <option value="lm">Levenberg-Marquardt (LM)</option>
              <option value="cd">Coordinate Descent (CD)</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            Max Iterations
            <input
              type="number"
              min={1}
              step={1}
              value={optMaxIterations}
              disabled={optRunning}
              onChange={(e) => {
                const n = Number(e.target.value);
                setOptMaxIterations(Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1);
              }}
              style={{ width: 100, padding: '4px 6px' }}
            />
          </label>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            Convergence
            <select value={optConvergenceProfile} disabled={optRunning} onChange={(e) => setOptConvergenceProfile(e.target.value as 'fast' | 'balanced' | 'deep')} style={{ padding: '4px 6px' }}>
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="deep">Deep</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={optAutoRenderOnAccept} disabled={optRunning} onChange={(e) => setOptAutoRenderOnAccept(!!e.target.checked)} style={{ width: 16, height: 16 }} />
            Auto-render on Accept
          </label>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Phase</span><span>{String(optimizeState?.phase || '-')}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Decision</span><span>{String(optimizeState?.phase === 'accept' ? 'ACCEPT' : optimizeState?.phase === 'reject' ? 'REJECT' : '-')}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Accept/Reject</span><span>{`${Number(optimizeState?.acceptCount || 0)} / ${Number(optimizeState?.rejectCount || 0)}`}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Iter</span><span>{String(optimizeState?.iterations ?? 0)}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Vars</span><span>{String(optimizeState?.variableCount ?? 0)}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Req</span><span>{String(optimizeState?.requirementCount ?? '-')}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Score</span><span>{Number.isFinite(Number(optimizeState?.meritAfter)) ? Number(optimizeState.meritAfter).toFixed(6) : '-'}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Best</span><span>{Number.isFinite(Number(optimizeState?.best)) ? Number(optimizeState.best).toFixed(6) : '-'}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Issue</span><span>{String(optimizeState?.issue || '-')}</span></div>
        </div>
      </div>
    );
  }

  useEffect(() => {
    if (!(analysisWindowMode.enabled && analysisWindowMode.analysis === 'astigmatism')) return;
    setAstigBusy(false);
    setAstigProgress(0);
    setAstigProgressText('');
    setAstigStatus('Press Show to render');
  }, [analysisWindowMode.enabled, analysisWindowMode.analysis]);

  if (analysisWindowMode.enabled && analysisWindowMode.analysis === 'system-data') {
    const isBrowserSystemDataPage = !isTauriRuntime();

    return (
      <>
        <div style={{ height: '100vh', width: '100vw', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
          <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
            <SystemDataPanel visible />
          </div>
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
        </div>
      </>
    );
  }

  if (analysisWindowMode.enabled && analysisWindowMode.analysis === 'astigmatism') {
    const rerenderAstigmatism = async () => {
      const w = window as any;
      if (typeof w.showAstigmatismDiagram !== 'function') {
        setAstigStatus('Astigmatism function unavailable');
        return;
      }
      setAstigBusy(true);
      setAstigProgress(0);
      setAstigProgressText('Preparing...');
      setAstigStatus('');
      try {
        await ensurePlotlyLoaded();
        await Promise.resolve(w.showAstigmatismDiagram({
          containerId: 'analysis-astig-container',
          chiefRayDefinition: astigChiefRayDefinition,
          pattern: astigBeamPattern,
          rayCount: astigRayCount,
          ringCount: astigRingCount,
          onProgress: ({ percent, message }: { percent?: number; message?: string }) => {
            let nextPercent: number | null = null;
            if (typeof percent === 'number' && Number.isFinite(percent)) {
              nextPercent = Math.max(0, Math.min(100, percent));
              setAstigProgress(nextPercent);
            }
            if (typeof message === 'string' && message.trim()) {
              setAstigProgressText(message);
            } else if (nextPercent !== null) {
              setAstigProgressText(`${Math.round(nextPercent)}%`);
            }
          },
        }));
        setAstigProgress(100);
        setAstigProgressText('Done');
        await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
        setAstigProgress(0);
        setAstigProgressText('');
      } catch (err) {
        setAstigProgressText('');
        setAstigStatus(`Astigmatism error: ${(err as any)?.message || String(err)}`);
      } finally {
        setAstigBusy(false);
      }
    };

    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
        <div style={{ padding: '10px 12px', background: '#f8f8f8', borderBottom: '1px solid #ddd', display: 'flex', gap: 10, alignItems: 'center' }}>
          <label htmlFor="analysis-astig-chief-ray" style={{ fontSize: 12, color: '#333' }}>Chief ray:</label>
          <select
            id="analysis-astig-chief-ray"
            value={astigChiefRayDefinition}
            onChange={(e) => setAstigChiefRayDefinition(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          >
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
          </select>
          <label htmlFor="analysis-astig-beam-pattern" style={{ fontSize: 12, color: '#333' }}>Beam:</label>
          <select
            id="analysis-astig-beam-pattern"
            value={astigBeamPattern}
            onChange={(e) => setAstigBeamPattern(e.target.value as 'cross' | 'grid' | 'annular')}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          >
            <option value="cross">Cross</option>
            <option value="grid">Grid</option>
            <option value="annular">Annular</option>
          </select>
          <label htmlFor="analysis-astig-ray-count" style={{ fontSize: 12, color: '#333' }}>Rays:</label>
          <input
            id="analysis-astig-ray-count"
            type="number"
            min={9}
            max={2001}
            step={1}
            value={astigRayCount}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isFinite(parsed)) return;
              setAstigRayCount(Math.max(9, Math.min(2001, Math.round(parsed))));
            }}
            style={{ width: 88, padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          />
          {astigBeamPattern === 'annular' && (
            <>
              <label htmlFor="analysis-astig-ring-count" style={{ fontSize: 12, color: '#333' }}>Rings:</label>
              <input
                id="analysis-astig-ring-count"
                type="number"
                min={1}
                max={64}
                step={1}
                value={astigRingCount}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setAstigRingCount(Math.max(1, Math.min(64, Math.round(parsed))));
                }}
                style={{ width: 78, padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
              />
            </>
          )}
          <button
            type="button"
            onClick={rerenderAstigmatism}
            disabled={astigBusy}
            style={{ padding: '6px 10px', border: '1px solid #bbb', borderRadius: 4, background: '#f8f8f8', cursor: astigBusy ? 'default' : 'pointer', fontSize: 12 }}
          >
            {astigBusy ? 'Rendering...' : 'Show'}
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: astigStatus.startsWith('Astigmatism error:') ? '#b00020' : '#666' }}>
            {astigStatus || ''}
          </span>
        </div>
        {(astigBusy || !!astigProgressText) && (
          <>
            <div style={{ padding: '6px 12px', fontSize: 12, color: '#333', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}>{Math.round(astigProgress)}%</span>
              <span>{astigProgressText || 'Calculating...'}</span>
            </div>
            <div style={{ height: 4, background: '#e6e6e6', width: '100%' }}>
              <div
                style={{
                  height: '100%',
                  width: `${astigProgress}%`,
                  background: '#1677ff',
                  transition: 'width 120ms linear'
                }}
              />
            </div>
          </>
        )}
        <div id="analysis-astig-container" style={{ flex: 1, minHeight: 0, background: 'white' }} />
      </div>
    );
  }

  if (analysisWindowMode.enabled) {
    return (
      <>
        <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f4f4', color: '#444', fontSize: 13 }}>
          Launching analysis window...
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
          <LegacyPanels />
        </div>
      </>
    );
  }

  if (isRenderWindowMode) {

    const handleRenderDraw = async () => {
      try {
        const w = window as any;
        try {
          const cm = w.ConfigurationManager;
          if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
            await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
          }
        } catch (_) {}

        try {
          if (typeof w.initializeAllTables === 'function') {
            w.initializeAllTables();
          }
        } catch (_) {}

        ensureRenderCanvasAttached();

        try {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        } catch (_) {}

        let rowCount = 0;
        try {
          if (typeof w.getOpticalSystemRows === 'function') {
            const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
            rowCount = Array.isArray(rows) ? rows.length : 0;
          }
        } catch (_) {}

        if (rowCount === 0) {
          setRenderWindowStatus('No optical data');
          setRenderLensColorTargets([]);
          return;
        }

        try {
          if (typeof w.getOpticalSystemRows === 'function') {
            const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
            refreshRenderLensTargets(rows);
          }
        } catch (_) {
          refreshRenderLensTargets([]);
        }

        const ok = await drawRender3DView();
        if (!ok) return;

        ensureRenderCanvasAttached();
        setRenderViewMode('3D');
        setRenderWindowStatus('Ready (3D)');
      } catch (err) {
        console.error('[RenderWindow] Manual draw failed:', err);
        setRenderWindowStatus('Draw failed');
      }
    };

    const handleViewXZ = () => {
      setRenderViewAxis('XZ');
      setRenderViewMode('XZ');
      refreshRenderLensTargets();
      drawCrossSectionView('XZ').catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleViewYZ = () => {
      setRenderViewAxis('YZ');
      setRenderViewMode('YZ');
      refreshRenderLensTargets();
      drawCrossSectionView('YZ').catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleSetLensColor = (target: RenderLensColorTarget, colorHex: string | null) => {
      const keys = Array.isArray(target?.keys) ? target.keys : [target?.key];
      const validKeys = [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))];
      if (validKeys.length === 0) return;
      if (isTauriRuntime()) {
        console.log('[RenderColor][Tauri] handleSetLensColor:start', {
          label: target?.label,
          colorHex,
          validKeys,
        });
      }
      const next = { ...loadSurfaceColorOverridesSafe() };
      if (!colorHex) {
        for (const k of validKeys) delete next[k];
      } else {
        for (const k of validKeys) next[k] = colorHex;
      }
      saveSurfaceColorOverridesSafe(next);
      if (isTauriRuntime()) {
        const probe = validKeys.reduce((acc: Record<string, any>, k) => {
          acc[k] = next[k];
          return acc;
        }, {});
        console.log('[RenderColor][Tauri] handleSetLensColor:saved', {
          probe,
          overrideCount: Object.keys(next).length,
        });
      }
      setRenderColorUiRevision((v) => v + 1);
      redrawCurrentRenderView().catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleResetAllLensColors = () => {
      const next = { ...loadSurfaceColorOverridesSafe() };
      for (const target of renderLensColorTargets) {
        const keys = Array.isArray(target?.keys) ? target.keys : [target?.key];
        for (const k of keys) {
          const kk = String(k || '').trim();
          if (kk) delete next[kk];
        }
      }
      saveSurfaceColorOverridesSafe(next);
      setRenderColorUiRevision((v) => v + 1);
      redrawCurrentRenderView().catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleToggleRenderLabels = (enabled: boolean) => {
      setRenderShowDesignIntentLabels(enabled);
      try {
        localStorage.setItem(RENDER_SHOW_LABELS_KEY, enabled ? 'true' : 'false');
      } catch (_) {}
    };

    return (
      <>
        <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', margin: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #ddd', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={handleRenderDraw}>Render</button>
            <button type="button" onClick={handleViewXZ}>X-Z View</button>
            <button type="button" onClick={handleViewYZ}>Y-Z View</button>
            <label htmlFor="render-ray-count-input" style={{ marginLeft: 12, fontSize: 12, fontWeight: 500 }}>Raynum</label>
            <input
              id="render-ray-count-input"
              type="number"
              min={1}
              max={10001}
              step={1}
              value={renderRayCount}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                  setRenderRayCount(parsed);
                } else if (e.target.value === '') {
                  setRenderRayCount(5);
                }
              }}
              style={{ width: 84 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={renderShowDesignIntentLabels}
                onChange={(e) => handleToggleRenderLabels(e.target.checked)}
              />
              Labels
            </label>
            <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12, color: '#666' }}>{renderWindowStatus}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff' }}>
              <div id="threejs-canvas-container" aria-label="Optical system 3D canvas" style={{ width: '100%', height: '100%', minHeight: 0 }} />
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: 14,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  alignItems: 'center',
                }}
              >
                <div style={{ position: 'relative', width: `${renderScaleBarWidthPx}px`, height: 14 }}>
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: '2px solid #111827' }} />
                  {Array.from({ length: 11 }).map((_, idx) => {
                    const isMajor = idx === 0 || idx === 10;
                    const isMid = idx === 5;
                    return (
                      <div
                        key={idx}
                        style={{
                          position: 'absolute',
                          left: `${(idx / 10) * 100}%`,
                          bottom: 0,
                          width: 0,
                          height: isMajor ? 12 : (isMid ? 9 : 6),
                          borderLeft: '2px solid #111827',
                          transform: idx === 10 ? 'translateX(-2px)' : 'none',
                        }}
                      />
                    );
                  })}
                </div>
                <span style={{ width: `${renderScaleBarWidthPx}px`, fontSize: 11, lineHeight: 1, color: '#111827', fontWeight: 600, textShadow: '0 0 2px rgba(255,255,255,0.95)', textAlign: 'right' }}>{renderScaleLabel}</span>
              </div>
            </div>
            <div
              style={{
                width: renderSurfaceColorsCollapsed ? 34 : 274,
                borderLeft: '1px solid #ddd',
                background: '#fafafa',
                display: 'flex',
                flexDirection: 'column',
                transition: 'width 120ms ease',
                overflow: 'hidden',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setRenderSurfaceColorsCollapsed((prev) => {
                    const next = !prev;
                    if (!next) refreshRenderLensTargets();
                    return next;
                  });
                }}
                title={renderSurfaceColorsCollapsed ? 'Open surface colors' : 'Collapse surface colors'}
                style={{
                  width: '100%',
                  border: 0,
                  borderBottom: '1px solid #e3e3e3',
                  background: '#f0f0f0',
                  textAlign: 'left',
                  padding: renderSurfaceColorsCollapsed ? '10px 8px' : '10px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {renderSurfaceColorsCollapsed ? '▶' : '▼ Surface Colors'}
              </button>

              {!renderSurfaceColorsCollapsed && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #ececec' }}>
                    <button type="button" onClick={() => { refreshRenderLensTargets(); }} style={{ fontSize: 11, padding: '4px 8px' }}>Refresh</button>
                    <button type="button" onClick={handleResetAllLensColors} style={{ fontSize: 11, padding: '4px 8px' }}>Reset All</button>
                  </div>
                  <div style={{ padding: 8, overflow: 'auto', flex: 1, minHeight: 0 }}>
                    {renderLensColorTargets.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#777' }}>No lens intervals detected.</div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '4px 2px', borderBottom: '1px solid #ddd' }}>Lens</th>
                            <th style={{ textAlign: 'left', padding: '4px 2px', borderBottom: '1px solid #ddd' }}>Color</th>
                          </tr>
                        </thead>
                        <tbody>
                          {renderLensColorTargets.map((target) => {
                            const overrides = loadSurfaceColorOverridesSafe();
                            const selectedHex = resolveOverrideColorHex(overrides, target.keys) || '#00CCFF';
                            return (
                              <tr key={`${target.key}-${target.frontSurfaceIndex0}`}>
                                <td style={{ padding: '5px 2px', borderBottom: '1px solid #eee' }}>{target.label}</td>
                                <td style={{ padding: '5px 2px', borderBottom: '1px solid #eee' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <select
                                      value={resolveOverrideColorHex(loadSurfaceColorOverridesSafe(), target.keys) ?? ''}
                                      onChange={(e) => handleSetLensColor(target, e.target.value || null)}
                                      style={{ flex: 1, minWidth: 0, fontSize: 11, backgroundColor: selectedHex }}
                                    >
                                      <option value="">Default</option>
                                      {RENDER_SURFACE_COLOR_PALETTE.map((entry) => (
                                        <option key={entry.hex} value={entry.hex}>{entry.name}</option>
                                      ))}
                                    </select>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
          <LegacyPanels />
        </div>
      </>
    );
  }

  return (
    <>
      <MainToolbar />
      <ConfigurationSection />
      <SourceObjectSection />
      <DesignIntentSection />
      <RequirementsSection />
      <LegacyPanels />
    </>
  );
}
