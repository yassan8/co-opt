/**
 * UI Update Module
 * Handles updating UI elements based on data changes
 */

import { generateSurfaceOptions } from '../evaluation/spot-diagram.js';

/**
 * Update surface number select options
 */
export function updateSurfaceNumberSelect() {
    const surfaceNumberSelect = document.getElementById('surface-number-select');
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
        const d1 = window.tableOpticalSystem?.getData?.();
        if (Array.isArray(d1) && d1.length > 0) opticalSystemData = d1;
    } catch (_) {}
    if (!opticalSystemData) {
        try {
            const d2 = window.opticalSystemTabulator?.getData?.();
            if (Array.isArray(d2) && d2.length > 0) opticalSystemData = d2;
        } catch (_) {}
    }
    if (!opticalSystemData || opticalSystemData.length === 0) {
        return;
    }
    
    // Add options using Spot Diagram's CB-invariant surface ids.
    const opts = generateSurfaceOptions(opticalSystemData);
    let imageValue = null;
    let lastValue = null;
    for (const o of opts) {
        const option = document.createElement('option');
        option.value = o.value;
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
        const p = window.__spotDiagramPopup;
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
export function updateAllUIElements() {
    updateSurfaceNumberSelect();
}

/**
 * Initialize UI event listeners
 */
export function initializeUIEventListeners() {
    // Event listeners initialization can be added here if needed
}
