// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * UI Update Module
 * Handles updating UI elements based on data changes
 */

import { generateSurfaceOptions } from '../evaluation/spot-diagram.js';

/**
 * Update surface number select options
 */
export function updateSurfaceNumberSelect(): void {
    const surfaceNumberSelect = document.getElementById('surface-number-select') as HTMLSelectElement | null;
    if (!surfaceNumberSelect) return;

    const prevSelectedOption = surfaceNumberSelect.selectedOptions && surfaceNumberSelect.selectedOptions.length > 0
        ? surfaceNumberSelect.selectedOptions[0]
        : null;
    const prevRowId = (prevSelectedOption && prevSelectedOption.dataset && prevSelectedOption.dataset.rowId)
        ? String(prevSelectedOption.dataset.rowId)
        : '';
    const prevValue = (surfaceNumberSelect.value !== undefined && surfaceNumberSelect.value !== null)
        ? String(surfaceNumberSelect.value)
        : '';
    
    // Clear existing options
    surfaceNumberSelect.innerHTML = '<option value="">Select Surf</option>';
    
    // Get optical system data.
    // Some builds / UI paths still use the legacy Tabulator instance (opticalSystemTabulator).
    // Prefer the modern table when present, but fall back so Surf updates without reload.
    let opticalSystemData = null;
    try {
        const d1 = w.tableOpticalSystem?.getData?.();
        if (Array.isArray(d1) && d1.length > 0) opticalSystemData = d1;
    } catch (_) {}
    if (!opticalSystemData) {
        try {
            const d2 = w.opticalSystemTabulator?.getData?.();
            if (Array.isArray(d2) && d2.length > 0) opticalSystemData = d2;
        } catch (_) {}
    }
    if (!opticalSystemData || opticalSystemData.length === 0) {
        return;
    }
    
    // Add options using Spot Diagram's CB-invariant surface ids.
    const opts = generateSurfaceOptions(opticalSystemData);
    let imageValue: string | null = null;
    let lastValue: string | null = null;
    for (const o of opts) {
        const option = document.createElement('option');
        option.value = String(o.value);
        option.textContent = o.label;
        if (o.rowId !== undefined && o.rowId !== null && String(o.rowId) !== '') {
            option.dataset.rowId = String(o.rowId);
        }
        if (Number.isInteger(o.rowIndex)) {
            option.dataset.rowIndex = String(o.rowIndex);
        }
        if (typeof o.label === 'string' && o.label.includes('(Image)')) {
            imageValue = String(o.value);
        }
        lastValue = String(o.value);
        surfaceNumberSelect.appendChild(option);
    }

    // Prefer stable selection by rowId (survives CB insert/delete shifting Surf numbers).
    let restored = false;
    if (prevRowId) {
        for (const opt of surfaceNumberSelect.options) {
            if (opt && opt.dataset && String(opt.dataset.rowId || '') === prevRowId) {
                surfaceNumberSelect.value = String(opt.value);
                restored = true;
                break;
            }
        }
    }
    if (!restored) {
        const hasPrev = prevValue !== '' && surfaceNumberSelect.querySelector(`option[value="${CSS.escape(prevValue)}"]`);
        if (hasPrev) surfaceNumberSelect.value = prevValue;
        else if (imageValue !== null) surfaceNumberSelect.value = imageValue;
        else if (lastValue !== null) surfaceNumberSelect.value = lastValue;
    }

    // Notify Spot Diagram popup (if open) to resync Surf options.
    try {
        const p = w.__spotDiagramPopup;
        if (p && !p.closed) {
            if (typeof p.__cooptSpotPopupSyncAll === 'function') {
                p.__cooptSpotPopupSyncAll();
            } else if (typeof p.postMessage === 'function') {
                p.postMessage({ action: 'coopt-spot-sync' }, '*');
            }
        }
    } catch (_) {}
}

/**
 * Update UI elements when data changes
 */
export function updateAllUIElements(): void {
    updateSurfaceNumberSelect();
}

/**
 * Initialize UI event listeners
 */
export function initializeUIEventListeners(): void {
    // Event listeners initialization can be added here if needed
}
