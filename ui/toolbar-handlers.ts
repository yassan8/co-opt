/**
 * Toolbar button handlers
 * Extracted from dom-event-handlers.ts for use in React components
 */

import { BLOCK_SCHEMA_VERSION, deriveBlocksFromLegacyOpticalSystemRows } from '../data/block-schema.ts';
import { loadSystemConfigurations, saveSystemConfigurations, clearAllPersistedState } from '../data/table-configuration.ts';
import { parseZMXArrayBufferToOpticalSystemRows } from '../import-export/zemax-import.ts';
import { getLoadedFileName, setLoadedFileName } from './loaded-file-storage.ts';
import { openJsonFromNativeDialog, openTextFromNativeDialog, saveJsonFromNativeDialog, saveTextFromNativeDialog } from '../src/desktop/adapters/file.ts';
import { basenameFromPath, isTauriRuntime } from '../src/desktop/runtime.ts';
import { generateZmxText, getDefaultProject, getNewProjectTemplate, parseZmxText, recommendWavefrontGrid, runAnalysisPreview, runOptimizerStep } from '../src/desktop/ipc/client.ts';
import { buildShareUrlFromCompressedString, encodeAllDataToCompressedString } from '../utils/url-share.ts';

declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

export function handleNewFile(): void {
  if (!isTauriRuntime() && !confirm('Create new file? Current data will be cleared.')) return;
  
  try {
    if (isTauriRuntime()) {
      (async () => {
        try {
          const { project } = await getNewProjectTemplate();
          if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
            await (window as any).__loadAllDataObjectIntoApp(project, { filename: 'new-project-template.json' });
          }
          setLoadedFileName('new-project-template.json');
          try {
            window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
          } catch (_) {}
          console.log('✅ [New File] Loaded Rust template project.');
        } catch (desktopErr) {
          console.error('❌ [New File] Rust template load failed:', desktopErr);
          alert(`New file failed: ${(desktopErr as Error)?.message || String(desktopErr)}`);
        }
      })();
      return;
    }

    console.log('🔵 [New File] Clearing localStorage and creating default configuration...');
    clearAllPersistedState();
    
    const defaultConfig = {
      id: 1,
      name: 'Config 1',
      schemaVersion: BLOCK_SCHEMA_VERSION,
      blocks: [
        {
          blockId: 'ObjectSurface-1',
          blockType: 'ObjectSurface',
          role: null,
          constraints: {},
          parameters: { objectDistanceMode: 'INF' },
          variables: {},
          metadata: { source: 'default' }
        },
        {
          blockId: 'Stop-1',
          blockType: 'Stop',
          role: null,
          constraints: {},
          parameters: { semiDiameter: 10 },
          variables: {},
          metadata: { source: 'default' }
        },
        {
          blockId: 'ImageSurface-1',
          blockType: 'ImageSurface',
          role: null,
          constraints: {},
          parameters: { semidiaMode: 'Manual' },
          variables: {},
          metadata: { source: 'default' }
        }
      ],
      source: [
        { id: 1, wavelength: 0.4358343, weight: 1, primary: '', angle: 0 },
        { id: 2, wavelength: 0.5875618, weight: 1, primary: 'Primary Wavelength', angle: 0 },
        { id: 3, wavelength: 0.6562725, weight: 1, primary: '', angle: 0 }
      ],
      object: [
        { id: 1, xHeightAngle: 0, yHeightAngle: 0, position: 'Angle', angle: 0 },
        { id: 2, xHeightAngle: 0, yHeightAngle: 17.05, position: 'Angle', angle: 0 }
      ],
      opticalSystem: [],
      systemData: { referenceFocalLength: '' },
      metadata: {
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        locked: false
      },
      meritFunction: []
    };
    
    const systemConfig = {
      configurations: [defaultConfig],
      activeConfigId: 1,
      meritFunction: [],
      systemRequirements: [],
      optimizationRules: {}
    };
    
    saveSystemConfigurations(systemConfig);
    console.log('✅ [New File] Default configuration created, reloading...');
    location.reload();
  } catch (err) {
    console.error('❌ Failed to create new file:', err);
    alert('Failed to create new file. See console for details.');
  }
}

function getSanitizedConfigurationsForExport(): any {
  const parsedConfig = (() => {
    try {
      if (typeof localStorage === 'undefined') return null;
      return loadSystemConfigurations();
    } catch {
      return null;
    }
  })();
  
  const sanitizedConfig = parsedConfig ? JSON.parse(JSON.stringify(parsedConfig)) : null;
  if (sanitizedConfig) {
    try { delete sanitizedConfig.meritFunction; } catch (_) {}
    try { delete sanitizedConfig.systemRequirements; } catch (_) {}
    try {
      if (Array.isArray(sanitizedConfig.configurations)) {
        for (const cfg of sanitizedConfig.configurations) {
          if (cfg && typeof cfg === 'object') {
            try { delete cfg.source; } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
  return sanitizedConfig;
}

function buildAllDataForExport(): any {
  const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement;
  const referenceFocalLength = refFLInput ? refFLInput.value : '';

  let opticalSystemData = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
  
  try {
    const systemConfig = (typeof w.loadSystemConfigurations === 'function') 
      ? w.loadSystemConfigurations() 
      : null;
    const activeId = systemConfig?.activeConfigId;
    const activeCfg = Array.isArray(systemConfig?.configurations)
      ? (systemConfig.configurations.find((c: any) => String(c?.id) === String(activeId)) || systemConfig.configurations[0])
      : null;
    
    const configurationHasBlocks = (cfg: any) => {
      try {
        return cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0;
      } catch (_) { return false; }
    };
    
    if (activeCfg && configurationHasBlocks(activeCfg)) {
      if (typeof w.expandBlocksToOpticalSystemRows === 'function') {
        const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
        if (expanded && Array.isArray(expanded.rows)) {
          opticalSystemData = expanded.rows;
        }
      }
    }
  } catch (_) {}

  return {
    source: w.tableSource ? w.tableSource.getData() : [],
    object: w.tableObject ? w.tableObject.getData() : [],
    opticalSystem: opticalSystemData,
    meritFunction: w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [],
    systemRequirements: w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : [],
    systemData: {
      referenceFocalLength: referenceFocalLength
    },
    configurations: getSanitizedConfigurationsForExport()
  };
}

export function handleSave(): void {
  try {
    if (document.activeElement) (document.activeElement as HTMLElement).blur();

    const allData = buildAllDataForExport();
    const serialized = JSON.stringify(allData, null, 2);

    if (isTauriRuntime()) {
      (async () => {
        try {
          const savedPath = await saveJsonFromNativeDialog(serialized);
          if (!savedPath) return;
          const filename = basenameFromPath(savedPath);
          setLoadedFileName(filename);
          try {
            window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
          } catch (_) {}
          console.log('✅ データが保存されました:', savedPath);
        } catch (nativeErr) {
          console.error('❌ Native save failed:', nativeErr);
          alert(`Native save failed: ${(nativeErr as Error)?.message || String(nativeErr)}`);
        }
      })();
      return;
    }

    const loadedFileName = getLoadedFileName();
    let defaultName = 'optical_system_data';
    
    if (loadedFileName) {
      defaultName = loadedFileName.replace(/\.json$/i, '');
    }

    let filename = prompt(
      "保存するファイル名を入力してください（拡張子 .json は自動で付きます）\n\n" +
      "※ダウンロードフォルダに既存ファイルがある場合はブラウザが自動的に連番を付けます",
      defaultName
    );
    
    if (!filename) return;
    if (!filename.endsWith('.json')) filename += '.json';

    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    setLoadedFileName(filename);
    try {
      window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
    } catch (_) {}
    console.log('✅ データが保存されました:', filename);
  } catch (err) {
    console.error('❌ Failed to save:', err);
    alert(`Save failed: ${(err as Error)?.message || String(err)}`);
  }
}

export async function handleLoadDefault(): Promise<void> {
  if (!isTauriRuntime() && !confirm('Load default optical system? Current data will be replaced.')) return;
  
  try {
    if (isTauriRuntime()) {
      const { project } = await getDefaultProject();
      if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
        await (window as any).__loadAllDataObjectIntoApp(project, { filename: 'default-load.json' });
      }
      return;
    }

    let response = await fetch('/co-opt/defaults/default-load.json');
    if (!response.ok) {
      response = await fetch('/defaults/default-load.json');
    }
    if (!response.ok) {
      throw new Error(`Failed to load default system: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
      await (window as any).__loadAllDataObjectIntoApp(data, { filename: 'default-load.json' });
    }
  } catch (err) {
    console.error('❌ Failed to load default system:', err);
    alert('Failed to load default optical system. Check console for details.');
  }
}

export function handleLoad(): void {
  if (isTauriRuntime()) {
    (async () => {
      try {
        const picked = await openJsonFromNativeDialog();
        if (!picked) return;
        const data = JSON.parse(picked.content);
        if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
          await (window as any).__loadAllDataObjectIntoApp(data, { filename: basenameFromPath(picked.path) });
        }
        console.log('✅ File loaded:', picked.path);
      } catch (err) {
        console.error('❌ Failed to load file (native):', err);
        alert(`Load failed: ${(err as Error)?.message || String(err)}`);
      }
    })();
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
        await (window as any).__loadAllDataObjectIntoApp(data, { filename: file.name });
      }
      console.log('✅ File loaded:', file.name);
    } catch (err) {
      console.error('❌ Failed to load file:', err);
      alert(`Load failed: ${(err as Error)?.message || String(err)}`);
    }
  };
  
  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
}

export function handleClearStorage(): void {
  if (!isTauriRuntime() && !confirm(
    '⚠️ ローカルストレージをクリアします。すべての未保存データが失われます。\n\n' +
    'Clear localStorage? All unsaved data will be lost.'
  )) return;
  
  try {
    clearAllPersistedState();
    console.log('✅ localStorage cleared');
    alert('Storage cleared. Page will reload.');
    location.reload();
  } catch (err) {
    console.error('❌ Failed to clear storage:', err);
    alert(`Clear storage failed: ${(err as Error)?.message || String(err)}`);
  }
}

export async function handleShareUrl(): Promise<void> {
  try {
    if (document.activeElement) (document.activeElement as HTMLElement).blur();

    let compressed: string;
    try {
      const allData = buildAllDataForExport();
      compressed = encodeAllDataToCompressedString(allData);
    } catch (encodeErr) {
      alert((encodeErr as Error)?.message || 'Failed to generate share URL');
      return;
    }

    const base = `${location.origin}${location.pathname}`;
    const url = buildShareUrlFromCompressedString(compressed, base);

    const urlLength = url.length;
    if (urlLength > 30000) {
      alert(`Share URL is too long (${urlLength} chars). Please use Save instead.`);
      return;
    }
    if (urlLength >= 2000) {
      const ok = confirm(`Share URL is long (${urlLength} chars) and may not work in some apps.\n\nContinue?`);
      if (!ok) return;
    }

    try {
      await navigator.clipboard.writeText(url);
      alert('Share URL copied to clipboard.');
    } catch (_) {
      prompt('Copy this URL:', url);
    }
  } catch (err) {
    alert(`Share failed: ${(err as Error)?.message || String(err)}`);
  }
}

function __coopt_isInfLike(value: any): boolean {
  if (value === Infinity) return true;
  const s = String(value ?? '').trim().toUpperCase();
  return s === 'INF' || s === 'INFINITY' || s === '∞';
}

function __coopt_buildFallbackBlocksFromRows(rows: any[]): any[] {
  const safeRows = Array.isArray(rows) ? rows : [];
  const blocks: any[] = [];

  const inferImageSemidia = (): number | null => {
    for (let idx = safeRows.length - 1; idx >= 0; idx--) {
      const row = safeRows[idx] || {};
      const raw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const first = safeRows[0] || {};
  const objectDistanceMode = __coopt_isInfLike(first?.thickness) ? 'INF' : 'Finite';
  const objectDistanceVal = Number(first?.thickness);
  blocks.push({
    blockId: 'ObjectSurface-1',
    blockType: 'ObjectSurface',
    role: null,
    constraints: {},
    parameters: objectDistanceMode === 'INF'
      ? { objectDistanceMode: 'INF' }
      : { objectDistanceMode: 'Finite', objectDistance: Number.isFinite(objectDistanceVal) ? objectDistanceVal : 10 },
    variables: {},
    metadata: { source: 'zemax-fallback' }
  });

  let stopCount = 0;
  let singleCount = 0;
  let gapCount = 0;

  const end = Math.max(1, safeRows.length - 1);
  for (let i = 1; i < end; i++) {
    const row = safeRows[i] || {};
    const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
    const isStop = objType === 'stop' || objType === 'sto';

    if (isStop) {
      stopCount++;
      const stopSemidiaRaw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
      const sdNum = Number(stopSemidiaRaw);
      blocks.push({
        blockId: `Stop-${stopCount}`,
        blockType: 'Stop',
        role: null,
        constraints: {},
        parameters: Number.isFinite(sdNum) && sdNum > 0 ? { semiDiameter: sdNum } : {},
        variables: {},
        metadata: { source: 'zemax-fallback' }
      });

      const tRaw = row?.thickness;
      const tNum = Number(tRaw);
      const hasGap = __coopt_isInfLike(tRaw) || (Number.isFinite(tNum) && Math.abs(tNum) > 1e-12);
      if (hasGap) {
        gapCount++;
        blocks.push({
          blockId: `Gap-${gapCount}`,
          blockType: 'Gap',
          role: null,
          constraints: {},
          parameters: { thickness: __coopt_isInfLike(tRaw) ? 'INF' : tNum, material: 'AIR' },
          variables: {},
          metadata: { source: 'zemax-fallback', from: 'stop-thickness' }
        });
      }
      continue;
    }

    singleCount++;
    const surfTypeRaw = String(row?.surfType ?? '').trim();
    const surfType = surfTypeRaw || 'Spherical';
    const radius = __coopt_isInfLike(row?.radius) ? 'INF' : (String(row?.radius ?? '').trim() === '' ? 'INF' : row.radius);
    const tRaw = row?.thickness;
    const tNum = Number(tRaw);
    const thickness = __coopt_isInfLike(tRaw) ? 'INF' : (Number.isFinite(tNum) ? tNum : 0);
    const material = String(row?.material ?? '').trim();
    const conicNum = Number(row?.conic);

    const params: any = {
      radius,
      thickness,
      material,
      surfType,
      conic: Number.isFinite(conicNum) ? conicNum : 0,
      semidia: row?.semidia ?? ''
    };

    if (surfType === 'Toric') {
      params.radiusX = __coopt_isInfLike(row?.radiusX) ? 'INF' : (String(row?.radiusX ?? '').trim() === '' ? 'INF' : row.radiusX);
      params.radiusY = __coopt_isInfLike(row?.radiusY) ? 'INF' : (String(row?.radiusY ?? '').trim() === '' ? 'INF' : row.radiusY);
      const axisNum = Number(row?.axis);
      params.axis = Number.isFinite(axisNum) ? axisNum : 0;
    }

    for (let k = 1; k <= 10; k++) {
      const n = Number(row?.[`coef${k}`]);
      params[`coef${k}`] = Number.isFinite(n) ? n : 0;
    }

    blocks.push({
      blockId: `SingleSurface-${singleCount}`,
      blockType: 'SingleSurface',
      role: null,
      constraints: {},
      parameters: params,
      variables: {},
      metadata: { source: 'zemax-fallback', rowIndex: i }
    });
  }

  const imageSemidia = inferImageSemidia();
  blocks.push({
    blockId: 'ImageSurface-1',
    blockType: 'ImageSurface',
    role: null,
    constraints: {},
    parameters: Number.isFinite(imageSemidia as any) && (imageSemidia as number) > 0
      ? { semidia: imageSemidia, semidiaMode: 'Auto', optimizeSemiDia: 'A' }
      : { semidiaMode: 'Auto', optimizeSemiDia: 'A' },
    variables: {},
    metadata: { source: 'zemax-fallback' }
  });

  return blocks;
}

function __coopt_normalizeObjectDistanceInBlocks(blocks: any[]): any[] {
  if (!Array.isArray(blocks)) return [];

  let hasObjectSurface = false;
  for (const block of blocks) {
    if (!block || block.blockType !== 'ObjectSurface') continue;
    hasObjectSurface = true;
    const params = (block.parameters && typeof block.parameters === 'object')
      ? block.parameters
      : (block.parameters = {});

    const modeRaw = String(params.objectDistanceMode ?? '').trim();
    const infMode = __coopt_isInfLike(modeRaw);
    if (infMode) {
      params.objectDistanceMode = 'INF';
      const dInf = Number(params.objectDistance);
      params.objectDistance = Number.isFinite(dInf) ? dInf : 10;
      continue;
    }

    params.objectDistanceMode = 'Finite';
    const d = Number(params.objectDistance);
    params.objectDistance = Number.isFinite(d) ? d : 10;
  }

  if (!hasObjectSurface) {
    blocks.unshift({
      blockId: 'ObjectSurface-1',
      blockType: 'ObjectSurface',
      role: null,
      constraints: {},
      parameters: { objectDistanceMode: 'Finite', objectDistance: 10 },
      variables: {},
      metadata: { source: 'zemax-fallback', inserted: true }
    });
  }

  return blocks;
}

export function handleImportZemax(): void {
  if (isTauriRuntime()) {
    (async () => {
      try {
        const picked = await openTextFromNativeDialog({
          filters: [{ name: 'Zemax', extensions: ['zmx'] }],
        });
        if (!picked) return;

        const encoded = new TextEncoder().encode(picked.content);
        const arrayBuffer = encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        ) as ArrayBuffer;

        const syntheticFile = { name: basenameFromPath(picked.path), size: encoded.byteLength } as const;
        console.log('📥 [Zemax Import] Selected file:', syntheticFile.name, `(${syntheticFile.size} bytes)`);

        const now = new Date().toISOString();
          let parsed: any;
          try {
            parsed = await parseZmxText({ text: picked.content });
          } catch (rustParseErr) {
            console.warn('⚠️ [Zemax Import] Rust parser failed, fallback to TS parser:', rustParseErr);
            const encoded = new TextEncoder().encode(picked.content);
            const arrayBuffer = encoded.buffer.slice(
              encoded.byteOffset,
              encoded.byteOffset + encoded.byteLength,
            ) as ArrayBuffer;
            parsed = parseZMXArrayBufferToOpticalSystemRows(arrayBuffer);
          }

        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Invalid Zemax parse result.');
        }

        console.log('📥 [Zemax Import] Parsed:', {
          rows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0,
          sourceRows: Array.isArray(parsed?.sourceRows) ? parsed.sourceRows.length : 0,
          objectRows: Array.isArray(parsed?.objectRows) ? parsed.objectRows.length : 0,
          issues: Array.isArray(parsed?.issues) ? parsed.issues.length : 0
        });

        const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
        const sourceRows = Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [];
        const objectRows = Array.isArray(parsed?.objectRows) ? parsed.objectRows : [];
        const parsedStopIndex = rows.findIndex((r: any) => {
          const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
          return ot === 'stop';
        });
        const stopSemidiaWasMissing = (() => {
          if (parsedStopIndex < 0) return false;
          const stopRow = rows[parsedStopIndex] || {};
          const raw = stopRow?.semidia ?? stopRow?.semiDiameter ?? stopRow?.semiDia ?? stopRow?.['semi diameter'] ?? stopRow?.['Semi Diameter'];
          if (raw === null || raw === undefined) return true;
          const s = String(raw).trim();
          if (s === '') return true;
          const n = Number(s);
          return !(Number.isFinite(n) && n > 0);
        })();

        let blocks: any[] = [];
        try {
          const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
          const fatals = Array.isArray(derived?.issues)
            ? derived.issues.filter((it: any) => it?.severity === 'fatal')
            : [];
          if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0) {
            blocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
          } else {
            blocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(rows));
            if (fatals.length > 0) {
              console.warn('⚠️ [Zemax Import] deriveBlocks had fatals; fallback blocks generated:', fatals);
            }
          }
        } catch (e) {
          console.warn('⚠️ [Zemax Import] deriveBlocks failed; fallback blocks generated:', e);
          blocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(rows));
        }

        const payload = {
          configurations: [{
            id: 1,
            name: 'Config 1',
            schemaVersion: BLOCK_SCHEMA_VERSION,
            blocks,
            source: sourceRows,
            object: objectRows,
            opticalSystem: rows,
            meritFunction: [],
            systemData: { referenceFocalLength: '' },
            metadata: {
              created: now,
              modified: now,
              locked: false,
              importedFrom: 'zemax'
            }
          }],
          activeConfigId: 1,
          meritFunction: [],
          systemRequirements: [],
          optimizationRules: {}
        };

        if (typeof (window as any).__loadAllDataObjectIntoApp !== 'function') {
          throw new Error('App loader is not ready. Please reload and try again.');
        }
        const loaded = await (window as any).__loadAllDataObjectIntoApp(payload, { filename: syntheticFile.name });
        if (!loaded) {
          throw new Error('Zemax import parsed, but app load step returned false.');
        }

        try {
          if (typeof (window as any).autoCalculateMissingSemidia === 'function') {
            (window as any).autoCalculateMissingSemidia(sourceRows, objectRows, {
              entrancePupilDiameterMm: Number(parsed?.entrancePupilDiameterMm),
              stopSemidiaWasMissing
            });
          }
        } catch (_) {}

        try {
          if (typeof (window as any).calculateImageSemiDiaFromChiefRays === 'function') {
            const tryAutoImageSemidia = (triesLeft: number) => {
              setTimeout(() => {
                try {
                  Promise.resolve((window as any).calculateImageSemiDiaFromChiefRays())
                    .then((ok: any) => {
                      if (ok === true) {
                        try {
                          if (typeof (window as any).refreshBlockInspector === 'function') {
                            (window as any).refreshBlockInspector();
                          }
                        } catch (_) {}
                        try {
                          if (typeof (window as any).refreshAllUI === 'function') {
                            (window as any).refreshAllUI();
                          }
                        } catch (_) {}
                        return;
                      }
                      if (triesLeft > 0) {
                        tryAutoImageSemidia(triesLeft - 1);
                      }
                    })
                    .catch(() => {
                      if (triesLeft > 0) {
                        tryAutoImageSemidia(triesLeft - 1);
                      }
                    });
                } catch (_) {
                  if (triesLeft > 0) {
                    tryAutoImageSemidia(triesLeft - 1);
                  }
                }
              }, 200);
            };
            tryAutoImageSemidia(4);
          }
        } catch (_) {}

        if (Array.isArray(parsed?.issues)) {
          const fatal = parsed.issues.filter((it: any) => it?.severity === 'fatal');
          if (fatal.length > 0) {
            console.warn('⚠️ Zemax import issues:', fatal);
          }
        }
        console.log('✅ Zemax file imported:', syntheticFile.name);
      } catch (err) {
        console.error('❌ Zemax import failed:', err);
        alert(`Import failed: ${(err as Error)?.message || String(err)}`);
      }
    })();
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zmx';
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];

    try {
      if (input.parentNode) input.parentNode.removeChild(input);
    } catch (_) {}

    if (!file) return;

    try {
      console.log('📥 [Zemax Import] Selected file:', file.name, `(${file.size} bytes)`);
      const arrayBuffer = await file.arrayBuffer();
      const now = new Date().toISOString();
      const parsed: any = parseZMXArrayBufferToOpticalSystemRows(arrayBuffer);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid Zemax parse result.');
      }

      console.log('📥 [Zemax Import] Parsed:', {
        rows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0,
        sourceRows: Array.isArray(parsed?.sourceRows) ? parsed.sourceRows.length : 0,
        objectRows: Array.isArray(parsed?.objectRows) ? parsed.objectRows.length : 0,
        issues: Array.isArray(parsed?.issues) ? parsed.issues.length : 0
      });

      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      const sourceRows = Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [];
      const objectRows = Array.isArray(parsed?.objectRows) ? parsed.objectRows : [];
      const parsedStopIndex = rows.findIndex((r: any) => {
        const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
        return ot === 'stop';
      });
      const stopSemidiaWasMissing = (() => {
        if (parsedStopIndex < 0) return false;
        const stopRow = rows[parsedStopIndex] || {};
        const raw = stopRow?.semidia ?? stopRow?.semiDiameter ?? stopRow?.semiDia ?? stopRow?.['semi diameter'] ?? stopRow?.['Semi Diameter'];
        if (raw === null || raw === undefined) return true;
        const s = String(raw).trim();
        if (s === '') return true;
        const n = Number(s);
        return !(Number.isFinite(n) && n > 0);
      })();

      let blocks: any[] = [];
      try {
        const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
        const fatals = Array.isArray(derived?.issues)
          ? derived.issues.filter((it: any) => it?.severity === 'fatal')
          : [];
        if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0) {
          blocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
        } else {
          blocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(rows));
          if (fatals.length > 0) {
            console.warn('⚠️ [Zemax Import] deriveBlocks had fatals; fallback blocks generated:', fatals);
          }
        }
      } catch (e) {
        console.warn('⚠️ [Zemax Import] deriveBlocks failed; fallback blocks generated:', e);
        blocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(rows));
      }

      const payload = {
        configurations: [{
          id: 1,
          name: 'Config 1',
          schemaVersion: BLOCK_SCHEMA_VERSION,
          blocks,
          source: sourceRows,
          object: objectRows,
          opticalSystem: rows,
          meritFunction: [],
          systemData: { referenceFocalLength: '' },
          metadata: {
            created: now,
            modified: now,
            locked: false,
            importedFrom: 'zemax'
          }
        }],
        activeConfigId: 1,
        meritFunction: [],
        systemRequirements: [],
        optimizationRules: {}
      };

      if (typeof (window as any).__loadAllDataObjectIntoApp !== 'function') {
        throw new Error('App loader is not ready. Please reload and try again.');
      }
      const loaded = await (window as any).__loadAllDataObjectIntoApp(payload, { filename: file.name });
      if (!loaded) {
        throw new Error('Zemax import parsed, but app load step returned false.');
      }

      try {
        if (typeof (window as any).autoCalculateMissingSemidia === 'function') {
          (window as any).autoCalculateMissingSemidia(sourceRows, objectRows, {
            entrancePupilDiameterMm: Number(parsed?.entrancePupilDiameterMm),
            stopSemidiaWasMissing
          });
        }
      } catch (_) {}

      try {
        if (typeof (window as any).calculateImageSemiDiaFromChiefRays === 'function') {
          const tryAutoImageSemidia = (triesLeft: number) => {
            setTimeout(() => {
              try {
                Promise.resolve((window as any).calculateImageSemiDiaFromChiefRays())
                  .then((ok: any) => {
                    if (ok === true) {
                      try {
                        if (typeof (window as any).refreshBlockInspector === 'function') {
                          (window as any).refreshBlockInspector();
                        }
                      } catch (_) {}
                      try {
                        if (typeof (window as any).refreshAllUI === 'function') {
                          (window as any).refreshAllUI();
                        }
                      } catch (_) {}
                      return;
                    }
                    if (triesLeft > 0) {
                      tryAutoImageSemidia(triesLeft - 1);
                    }
                  })
                  .catch(() => {
                    if (triesLeft > 0) {
                      tryAutoImageSemidia(triesLeft - 1);
                    }
                  });
              } catch (_) {
                if (triesLeft > 0) {
                  tryAutoImageSemidia(triesLeft - 1);
                }
              }
            }, 200);
          };
          tryAutoImageSemidia(4);
        }
      } catch (_) {}

      if (Array.isArray(parsed?.issues)) {
        const fatal = parsed.issues.filter((it: any) => it?.severity === 'fatal');
        if (fatal.length > 0) {
          console.warn('⚠️ Zemax import issues:', fatal);
        }
      }
      console.log('✅ Zemax file imported:', file.name);
    } catch (err) {
      console.error('❌ Zemax import failed:', err);
      alert(`Import failed: ${(err as Error)?.message || String(err)}`);
    }
  };
  
  document.body.appendChild(input);
  input.click();
}

export function handleExportZemax(): void {
  try {
    const opticalSystemRows = (window as any).getOpticalSystemRows 
      ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem) 
      : [];
    const sourceRows = (window as any).tableSource && typeof (window as any).tableSource.getData === 'function'
      ? (window as any).tableSource.getData()
      : [];
    const objectRows = (window as any).tableObject && typeof (window as any).tableObject.getData === 'function'
      ? (window as any).tableObject.getData()
      : [];
    
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
      alert('No optical system data to export');
      return;
    }

    const loaded = String(getLoadedFileName() ?? '').replace(/\s*\(surfaces only\)\s*$/i, '').trim();
    const defaultFilename = loaded
      ? (/\.json$/i.test(loaded) ? loaded.replace(/\.json$/i, '.zmx') : (/\.zmx$/i.test(loaded) ? loaded : `${loaded}.zmx`))
      : 'co-opt-export.zmx';

    let filename = prompt(
      'Zemaxエクスポートのファイル名を入力してください（.zmx は自動補完）',
      defaultFilename
    );
    if (!filename) return;
    filename = filename.trim();
    if (!filename) return;
    if (!/\.zmx$/i.test(filename)) filename += '.zmx';
    
    if (isTauriRuntime()) {
      (async () => {
        try {
          const generated = await generateZmxText({
            opticalSystemRows,
            sourceRows,
            objectRows,
            title: 'co-opt export',
            units: 'MM',
          });
          const savedPath = await saveTextFromNativeDialog(generated.zmxText, {
            filters: [{ name: 'Zemax', extensions: ['zmx'] }],
          });
          if (!savedPath) return;
          console.log('✅ Zemax file exported successfully:', savedPath);
        } catch (nativeErr) {
          console.error('❌ Native Zemax export failed:', nativeErr);
          alert(`Export failed: ${(nativeErr as Error)?.message || String(nativeErr)}`);
        }
      })();
      return;
    }

    if (typeof (window as any).generateZMXText === 'function') {
      const zmxText = (window as any).generateZMXText(opticalSystemRows, {
        sourceRows,
        objectRows
      });

      if (typeof (window as any).downloadZMX === 'function') {
        (window as any).downloadZMX(zmxText, filename);
        console.log('✅ Zemax file exported successfully');
      } else {
        console.error('❌ downloadZMX function not available');
        alert('Export function not available');
      }
    } else {
      console.error('❌ generateZMXText function not available');
      alert('Export function not available');
    }
  } catch (err) {
    console.error('❌ Zemax export failed:', err);
    alert(`Export failed: ${(err as Error)?.message || String(err)}`);
  }
}

// Note: Optimize button handler is very complex and should remain in dom-event-handlers.ts
// We'll trigger it through a window function
export function handleOptimize(): void {
  if (!isTauriRuntime()) {
    alert('Desktop Rust optimizer is required. Please run in Tauri desktop mode.');
    return;
  }

  (async () => {
    try {
      const opticalSystemRows = (window as any).getOpticalSystemRows
        ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem)
        : [];

      if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        alert('最適化対象の光学系データがありません。');
        return;
      }

      const result = await runOptimizerStep({
        opticalSystemRows,
        maxIterations: 24,
      });

      console.log('✅ [Optimize][Rust]', result);
      alert(
        [
          'Rust optimizer step completed',
          `iterations: ${result.iterations}`,
          `variables: ${result.variableCount}`,
          `merit: ${result.meritBefore.toFixed(6)} -> ${result.meritAfter.toFixed(6)}`,
          result.converged ? 'status: converged' : 'status: in-progress',
        ].join('\n')
      );
    } catch (err) {
      console.error('❌ [Optimize][Rust] failed:', err);
      alert(`Rust optimize failed: ${(err as Error)?.message || String(err)}`);
    }
  })();
}

export function handleRender3D(): void {
  const w = window as any;
  if (w.__render3DInProgress) {
    return;
  }
  w.__render3DInProgress = true;

  try {
    if (isTauriRuntime()) {
      (async () => {
        try {
          try {
            const cm = (window as any).ConfigurationManager;
            if (cm && typeof cm.saveCurrentToActiveConfiguration === 'function') {
              cm.saveCurrentToActiveConfiguration();
            }
          } catch (_) {}

          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const label = 'render-window';
          const existing = await WebviewWindow.getByLabel(label);
          if (existing) {
            await existing.setFocus();
            return;
          }

          const url = new URL(window.location.href);
          url.searchParams.set('coopt_render_window', '1');

          const created = new WebviewWindow(label, {
            title: 'Render Optical System',
            url: url.toString(),
            width: 1100,
            height: 760,
            resizable: true,
            focus: true,
          });

          created.once('tauri://error', (error) => {
            console.error('❌ [Render3D][Desktop] failed to create render window:', error);
            alert('Failed to open Render window.');
          });
        } catch (err) {
          console.error('❌ [Render3D][Desktop] WebviewWindow error:', err);
          alert('Failed to open Render window.');
        }
      })();
      return;
    }

    const existingPopup = w.popup3DWindow;
    if (existingPopup && !existingPopup.closed) {
      try {
        existingPopup.focus();
        return;
      } catch (_) {}
    }

    const preopenedPopup = window.open('', 'popup-3d-optical-system', 'width=800,height=600')
      || window.open('about:blank', '_blank', 'width=800,height=600');

    if (!preopenedPopup) {
      alert('Popup blocked. Please allow popups for this site.');
      return;
    }
    w.popup3DWindow = preopenedPopup;

    // Ensure legacy popup infrastructure is bound first
    if (typeof w.setupOpticalSystemChangeListeners === 'function' && !w.__opticalSystemChangeListenersBound) {
      w.setupOpticalSystemChangeListeners(w.scene || null);
    }

    // Delegate to the proven legacy popup renderer path
    if (typeof w.__open3DWindowLegacy === 'function') {
      w.__open3DWindowLegacy(preopenedPopup);
      return;
    }

    // Safety fallback if legacy bridge is unavailable
    if (typeof w.initialize3DPopup === 'function') {
      w.initialize3DPopup(preopenedPopup);
      return;
    }

    try { preopenedPopup.close(); } catch (_) {}
    alert('Failed to initialize Render window. Please retry after app startup finishes.');
  } finally {
    w.__render3DInProgress = false;
  }
}

type AnalysisWindowKey =
  | 'system-data'
  | 'spot-diagram'
  | 'spherical-aberration'
  | 'astigmatism'
  | 'distortion'
  | 'distortion-grid'
  | 'magnification-chromatic-aberration'
  | 'integrated-aberration'
  | 'transverse-aberration'
  | 'opd'
  | 'psf'
  | 'mtf'
  | 'through-focus-spot'
  | 'through-focus-mtf'
  | 'field-mtf';

const ANALYSIS_WINDOW_SIZE_MAP: Record<AnalysisWindowKey, { width: number; height: number; title: string }> = {
  'system-data': { width: 1200, height: 760, title: 'System Data' },
  'spot-diagram': { width: 980, height: 760, title: 'Spot Diagram' },
  'spherical-aberration': { width: 980, height: 760, title: 'Spherical Aberration' },
  'astigmatism': { width: 980, height: 760, title: 'Astigmatism' },
  'distortion': { width: 980, height: 760, title: 'Distortion' },
  'distortion-grid': { width: 980, height: 760, title: 'Distortion Grid' },
  'magnification-chromatic-aberration': { width: 980, height: 760, title: 'Lateral Chromatic Aberration' },
  'integrated-aberration': { width: 980, height: 760, title: 'Integrated Aberration' },
  'transverse-aberration': { width: 980, height: 760, title: 'Transverse Aberration' },
  'opd': { width: 980, height: 760, title: 'Optical Path Difference' },
  'psf': { width: 980, height: 760, title: 'Point Spread Function' },
  'mtf': { width: 980, height: 760, title: 'Modulation Transfer Function' },
  'through-focus-spot': { width: 1100, height: 820, title: 'Through-Focus Spot' },
  'through-focus-mtf': { width: 1100, height: 820, title: 'Through-Focus MTF' },
  'field-mtf': { width: 1100, height: 820, title: 'Object MTF' },
};

function isAnalysisWindowContext(): boolean {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('coopt_analysis_window') === '1';
  } catch (_) {
    return false;
  }
}

async function openDesktopAnalysisWindow(kind: AnalysisWindowKey): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = `analysis-${kind}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return true;
  }

  const url = new URL(window.location.href);
  url.searchParams.set('coopt_analysis_window', '1');
  url.searchParams.set('coopt_analysis', kind);

  const winCfg = ANALYSIS_WINDOW_SIZE_MAP[kind] || { width: 980, height: 760, title: 'Analysis' };
  new WebviewWindow(label, {
    title: winCfg.title,
    url: url.toString(),
    width: winCfg.width,
    height: winCfg.height,
    resizable: true,
    focus: true,
  });
  return true;
}

export function handleSystemData(): void {
  console.log('[SystemData] Button clicked');
  const w = window as any;

  if (isTauriRuntime() && !isAnalysisWindowContext()) {
    (async () => {
      try {
        await openDesktopAnalysisWindow('system-data');
      } catch (err) {
        console.error('❌ [SystemData][Desktop] WebviewWindow error:', err);
      }
    })();
    return;
  }
  
  // Ensure event listeners are set up first
  if (typeof w.setupAnalysisWindows === 'function' && typeof w.setupOpticalSystemChangeListeners === 'function') {
    if (!w.__opticalSystemChangeListenersBound) {
      console.log('[SystemData] Setting up optical system change listeners');
      w.setupOpticalSystemChangeListeners(w.scene || null);
    }
  }
  
  if (w.__systemDataPopup && !w.__systemDataPopup.closed) {
    try { 
      console.log('[SystemData] Existing popup found, focusing');
      w.__systemDataPopup.focus(); 
    } catch (_) {}
    return;
  }
  
  // Open popup directly
  const popup = window.open('', 'System Data', 'width=1200,height=600');
  if (!popup) {
    alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
    return;
  }
  
  w.__systemDataPopup = popup;
  
  // Initialize the popup
  if (typeof w.initializeSystemDataPopup === 'function') {
    w.initializeSystemDataPopup(popup);
  } else {
    // Fallback: trigger the button's event listener
    const btn = document.getElementById('open-system-data-window-btn');
    if (btn) {
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      // Temporarily remove React's onClick to avoid recursion
      const reactOnClick = (btn as any).onclick;
      (btn as any).onclick = null;
      btn.dispatchEvent(clickEvent);
      setTimeout(() => {
        (btn as any).onclick = reactOnClick;
      }, 0);
    }
  }
}

export function handleAnalysisSelect(selectedValue: string): void {
  const value = String(selectedValue || '').trim();
  if (!value) return;

  const analysisPopupConfigMap: Record<string, { key: string; title: string; features: string }> = {
    'spot-diagram': { key: 'spot-diagram', title: 'Spot Diagram', features: 'width=800,height=600' },
    'spherical-aberration': { key: 'spherical-aberration', title: 'Spherical Aberration', features: 'width=800,height=600' },
    'astigmatism': { key: 'astigmatism', title: 'Astigmatism', features: 'width=800,height=600' },
    'distortion': { key: 'distortion', title: 'Distortion', features: 'width=800,height=600' },
    'distortion-grid': { key: 'distortion-grid', title: 'Distortion Grid', features: 'width=800,height=600' },
    'magnification-chromatic-aberration': { key: 'magnification-chromatic-aberration', title: 'Lateral Chromatic Aberration', features: 'width=800,height=600' },
    'integrated-aberration': { key: 'integrated-aberration', title: 'Integrated Aberration', features: 'width=800,height=600' },
    'transverse-aberration': { key: 'transverse-aberration', title: 'Transverse Aberration', features: 'width=800,height=600' },
    'opd': { key: 'opd', title: 'Optical Path Difference', features: 'width=800,height=600' },
    'psf': { key: 'psf', title: 'Point Spread Function', features: 'width=800,height=600' },
    'mtf': { key: 'mtf', title: 'Modulation Transfer Function', features: 'width=800,height=600' },
    'through-focus-spot': { key: 'through-focus-spot', title: 'Through-Focus Spot', features: 'width=980,height=700' },
    'through-focus-mtf': { key: 'through-focus-mtf', title: 'Through-Focus MTF', features: 'width=900,height=680' },
    'field-mtf': { key: 'field-mtf', title: 'Object MTF', features: 'width=900,height=650' }
  };

  const analysisButtonMap: Record<string, string> = {
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
    'field-mtf': 'open-field-mtf-window-btn'
  };

  const buttonId = analysisButtonMap[value];

  const mappedAnalysisKind = (
    value in ANALYSIS_WINDOW_SIZE_MAP ? value : null
  ) as AnalysisWindowKey | null;

  if (isTauriRuntime() && !isAnalysisWindowContext() && mappedAnalysisKind && buttonId) {
    (async () => {
      try {
        await openDesktopAnalysisWindow(mappedAnalysisKind);
      } catch (err) {
        console.error('❌ [Analysis][Desktop] WebviewWindow error:', err);
      }
    })();
    return;
  }

  if (buttonId) {
    const w = window as any;
    let preopenedPopup: Window | null = null;
    let popupConsumedByHandler = false;
    try {
      const cfg = analysisPopupConfigMap[value];
      if (cfg) {
        const preopened = window.open('', cfg.title, cfg.features);
        if (preopened) {
          preopenedPopup = preopened;
          w.__preopenedAnalysisPopupMap = w.__preopenedAnalysisPopupMap || {};
          w.__preopenedAnalysisPopupMap[cfg.title] = preopened;
        }
      }
    } catch (_) {}

    try {
      if (typeof w.setupAnalysisWindows === 'function') {
        w.setupAnalysisWindows();
      }
    } catch (_) {}

    const button = document.getElementById(buttonId);
    if (button) {
      const originalWindowOpen = window.open;
      try {
        if (preopenedPopup) {
          (window as any).open = (...args: any[]) => {
            if (!popupConsumedByHandler) {
              popupConsumedByHandler = true;
              try { preopenedPopup!.focus(); } catch (_) {}
              return preopenedPopup;
            }
            return originalWindowOpen.apply(window, args as any);
          };
        }

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        button.dispatchEvent(clickEvent);
      } finally {
        (window as any).open = originalWindowOpen;
        if (preopenedPopup && !popupConsumedByHandler) {
          try { preopenedPopup.close(); } catch (_) {}
        }
      }
    }
  }

  if (isTauriRuntime()) {
    (async () => {
      try {
        const purpose = (value === 'opd' || value === 'psf' || value === 'mtf')
          ? 'high-quality'
          : 'interactive';
        const rec = await recommendWavefrontGrid({
          purpose,
          fieldAngleDeg: 0,
        });
        try {
          (window as any).__cooptRustAnalysisRecommendation = rec;
        } catch (_) {}
        console.log('✅ [Analysis][Rust] grid recommendation:', rec);

        if (value === 'opd' || value === 'psf' || value === 'mtf') {
          const opticalSystemRows = (window as any).getOpticalSystemRows
            ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem)
            : [];
          const sourceRows = (window as any).tableSource && typeof (window as any).tableSource.getData === 'function'
            ? (window as any).tableSource.getData()
            : [];
          const objectRows = (window as any).tableObject && typeof (window as any).tableObject.getData === 'function'
            ? (window as any).tableObject.getData()
            : [];

          const preview = await runAnalysisPreview({
            kind: value as 'opd' | 'psf' | 'mtf',
            opticalSystemRows,
            sourceRows,
            objectRows,
          });
          try {
            (window as any).__cooptRustAnalysisPreview = preview;
          } catch (_) {}
          console.log('✅ [Analysis][Rust] preview:', preview);
        }
      } catch (err) {
        console.error('❌ [Analysis][Rust] recommendation failed:', err);
      }
    })();
  }
}

export function handleOpenSettings(): void {
  const sanitizeMode = (v: any): string => {
    const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
    return (s === 'stop' || s === 'entrance') ? s : '';
  };

  const getCurrentMode = (): string => {
    try {
      if (typeof window.__cooptGetForceInfinitePupilMode === 'function') {
        const m = sanitizeMode(window.__cooptGetForceInfinitePupilMode());
        if (m) return m;
      }
    } catch (_) {}
    try {
      return sanitizeMode(localStorage.getItem('coopt.forceInfinitePupilMode'));
    } catch (_) {
      return '';
    }
  };

  const applyMode = (mode: string): void => {
    const m = sanitizeMode(mode);
    try {
      if (typeof window.__cooptSetForceInfinitePupilMode === 'function') {
        window.__cooptSetForceInfinitePupilMode(m);
      } else {
        if (m) {
          window.__COOPT_FORCE_INFINITE_PUPIL_MODE = m;
          window.COOPT_FORCE_INFINITE_PUPIL_MODE = m;
        } else {
          try { delete window.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { window.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
          try { delete window.COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { window.COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
        }
      }
    } catch (_) {}
    try {
      if (m) localStorage.setItem('coopt.forceInfinitePupilMode', m);
      else localStorage.removeItem('coopt.forceInfinitePupilMode');
    } catch (_) {}
  };

  const showFallbackModal = (): void => {
    const existing = document.getElementById('coopt-settings-fallback-modal') as HTMLElement | null;
    if (existing) {
      existing.style.display = 'flex';
      const cur = getCurrentMode();
      existing.querySelectorAll('input[name="coopt-force-mode"]').forEach((n) => {
        const r = n as HTMLInputElement;
        const v = sanitizeMode(r.value);
        r.checked = (v === cur) || (cur === '' && v === '');
      });
      return;
    }

    const modal = document.createElement('div');
    modal.id = 'coopt-settings-fallback-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:2400;';
    modal.innerHTML = `
      <div style="width:520px;max-width:92vw;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,0.22);font-family:Arial,sans-serif;">
        <div style="padding:10px 12px;background:#f8f8f8;border-bottom:1px solid #ddd;font-weight:600;">Settings</div>
        <div style="padding:12px;">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Infinite Field: Pupil Sampling Mode</div>
          <div style="font-size:12px;color:#666;line-height:1.35;margin-bottom:10px;">Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.<br />Note: Changes take effect on the next calculation.</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <label><input type="radio" name="coopt-force-mode" value="" /> Auto (default)</label>
            <label><input type="radio" name="coopt-force-mode" value="stop" /> Force stop</label>
            <label><input type="radio" name="coopt-force-mode" value="entrance" /> Force entrance</label>
          </div>
        </div>
        <div style="padding:10px 12px;background:#f8f8f8;border-top:1px solid #ddd;display:flex;justify-content:flex-end;">
          <button id="coopt-settings-fallback-close" type="button" style="padding:6px 10px;border:1px solid #bbb;background:#f8f8f8;border-radius:4px;cursor:pointer;">Close</button>
        </div>
      </div>
    `;

    const hide = () => { modal.style.display = 'none'; };
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) hide();
    });
    const closeBtn = modal.querySelector('#coopt-settings-fallback-close') as HTMLButtonElement | null;
    if (closeBtn) closeBtn.addEventListener('click', hide);
    modal.querySelectorAll('input[name="coopt-force-mode"]').forEach((n) => {
      const r = n as HTMLInputElement;
      r.addEventListener('change', () => {
        if (r.checked) applyMode(r.value);
      });
    });

    document.body.appendChild(modal);
    const cur = getCurrentMode();
    modal.querySelectorAll('input[name="coopt-force-mode"]').forEach((n) => {
      const r = n as HTMLInputElement;
      const v = sanitizeMode(r.value);
      r.checked = (v === cur) || (cur === '' && v === '');
    });
  };

  try {
    const existing = window.__settingsPopup;
    if (existing && !existing.closed) {
      try { existing.focus(); } catch (_) {}
      return;
    }
  } catch (_) {}

  const popup = window.open('about:blank', 'Settings', 'width=520,height=340');
  if (!popup) {
    showFallbackModal();
    return;
  }
  window.__settingsPopup = popup;

  popup.document.write(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Settings</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f4f4f4; }
    .header { padding: 10px 12px; background: #f8f8f8; border-bottom: 1px solid #ddd; font-weight: 600; }
    .content { padding: 12px; background: #fff; }
    .section-title { font-size: 13px; font-weight: 600; margin: 0 0 8px 0; }
    .help { font-size: 12px; color: #666; line-height: 1.35; margin: 0 0 10px 0; }
    .radio-group { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px 0; }
    .footer { padding: 10px 12px; border-top: 1px solid #ddd; background: #f8f8f8; display: flex; justify-content: flex-end; }
    button { padding: 6px 10px; border: 1px solid #bbb; background: #f8f8f8; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">Settings</div>
  <div class="content">
    <div class="section-title">Infinite Field: Pupil Sampling Mode</div>
    <div class="help">
      Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.
      <br />
      Auto uses the default pipeline behavior.
    </div>
    <div class="radio-group">
      <label><input type="radio" name="force-mode" value="" /> Auto (default)</label>
      <label><input type="radio" name="force-mode" value="stop" /> Force stop</label>
      <label><input type="radio" name="force-mode" value="entrance" /> Force entrance</label>
    </div>
    <div class="help">Note: Changes take effect on the next calculation.</div>
  </div>
  <div class="footer">
    <button id="close-btn" type="button">Close</button>
  </div>
  <script>
    const KEY = 'coopt.forceInfinitePupilMode';
    const sanitize = (v) => {
      const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
      return (s === 'stop' || s === 'entrance') ? s : '';
    };
    const getOpener = () => { try { return window.opener || null; } catch (_) { return null; } };

    function getCurrent() {
      const o = getOpener();
      try {
        const fromOpener = (o && typeof o.__cooptGetForceInfinitePupilMode === 'function')
          ? sanitize(o.__cooptGetForceInfinitePupilMode())
          : sanitize(o?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? o?.COOPT_FORCE_INFINITE_PUPIL_MODE);
        if (fromOpener) return fromOpener;
      } catch (_) {}
      try { return sanitize(localStorage.getItem(KEY)); } catch (_) { return ''; }
    }

    function applyMode(mode) {
      const m = sanitize(mode);
      const o = getOpener();
      try {
        if (o && typeof o.__cooptSetForceInfinitePupilMode === 'function') {
          o.__cooptSetForceInfinitePupilMode(m);
        } else if (o) {
          if (m) {
            o.__COOPT_FORCE_INFINITE_PUPIL_MODE = m;
            o.COOPT_FORCE_INFINITE_PUPIL_MODE = m;
          } else {
            try { delete o.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { o.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
            try { delete o.COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { o.COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
          }
        }
      } catch (_) {}
      try {
        if (m) localStorage.setItem(KEY, m);
        else localStorage.removeItem(KEY);
      } catch (_) {}
    }

    function syncUI() {
      const cur = getCurrent();
      document.querySelectorAll('input[name="force-mode"]').forEach((r) => {
        const v = sanitize(r.value);
        r.checked = (v === cur) || (cur === '' && v === '');
      });
    }

    document.querySelectorAll('input[name="force-mode"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) applyMode(r.value);
      });
    });
    document.getElementById('close-btn').addEventListener('click', () => {
      try { window.close(); } catch (_) {}
    });
    window.addEventListener('focus', syncUI);
    syncUI();
  </script>
</body>
</html>
  `);

  try { popup.document.close(); } catch (_) {}
}
