export function setupAnalysisWindows() {
        // System Data popup window button
        const openSystemDataWindowBtn = document.getElementById('open-system-data-window-btn');
        if (openSystemDataWindowBtn) {
                openSystemDataWindowBtn.addEventListener('click', () => {
                        if (window.__systemDataPopup && !window.__systemDataPopup.closed) {
                                try { window.__systemDataPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'System Data', 'width=1200,height=600');
                        window.__systemDataPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>System Data</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        .controls {
            padding: 10px 12px;
            background: white;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
        }
        .content {
            flex: 1 1 auto;
            padding: 10px 12px;
            min-height: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        textarea {
            flex: 1 1 auto;
            width: 100%;
            resize: none;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 12px;
            line-height: 1.4;
            border: 1px solid #bbb;
            border-radius: 4px;
            padding: 10px;
            box-sizing: border-box;
            min-height: 0;
            background: white;
        }
    </style>
</head>
<body>
    <div class="header">System Data</div>
    <div class="controls">
        <button id="popup-calculate-paraxial">Calculate Paraxial</button>
        <button id="popup-calculate-seidel">Aberration Coefficients</button>
        <button id="popup-calculate-seidel-afocal">Aberration Coefficients (Afocal)</button>
        <label for="popup-reference-focal-length">Reference Focal Length:</label>
        <input type="text" id="popup-reference-focal-length" placeholder="Auto" style="width: 80px;" />
        <button id="popup-coord-transform">Coord Transform</button>
        <br>
        <label for="popup-transform-surface-select">Transform at surface:</label>
        <select id="popup-transform-surface-select" style="margin-right: 8px;">
            <option value="">Select surface...</option>
        </select>
        <button id="popup-show-local-coords-btn">Show Local Coords</button>
        <button id="popup-cancel-transform-btn" style="display:none;">Cancel</button>
        <button id="popup-save-local-coords-btn" style="display:none;">Save as JSON</button>
    </div>
    <div class="content">
        <div id="popup-transform-error-bar" style="display:none; padding:8px 12px; margin-bottom:8px; background:#fff3cd; border:1px solid #ffc107; border-radius:3px; color:#856404;">
            <strong>Error:</strong> <span id="popup-transform-error-text"></span>
        </div>
        <div id="popup-transform-progress-wrapper" style="display:none; padding:8px 12px; border-bottom:1px solid #eee; background:#fff; margin-bottom:8px;">
            <div id="popup-transform-progress-text">Calculating...</div>
            <progress id="popup-transform-progressbar" max="100" value="0" style="width:100%; margin-top:4px;"></progress>
        </div>
        <textarea id="popup-system-data" placeholder="System information will appear here..."></textarea>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const ref = getOpenerEl('reference-focal-length');
            const src = getOpenerEl('system-data');
            const popupRef = document.getElementById('popup-reference-focal-length');
            const popupText = document.getElementById('popup-system-data');

            if (popupRef && ref && popupRef.value !== ref.value) {
                popupRef.value = ref.value;
            }
            if (popupText && src && popupText.value !== src.value) {
                popupText.value = src.value;
            }
        }

        function triggerOpenerClick(id) {
            const btn = getOpenerEl(id);
            if (btn) {
                btn.click();
                // allow async handlers to update textarea
                setTimeout(syncFromOpener, 50);
                setTimeout(syncFromOpener, 200);
            }
        }

        document.getElementById('popup-calculate-paraxial').addEventListener('click', () => triggerOpenerClick('calculate-paraxial-btn'));
        document.getElementById('popup-calculate-seidel').addEventListener('click', () => triggerOpenerClick('calculate-seidel-btn'));
        document.getElementById('popup-calculate-seidel-afocal').addEventListener('click', () => triggerOpenerClick('calculate-seidel-afocal-btn'));
        document.getElementById('popup-coord-transform').addEventListener('click', () => triggerOpenerClick('coord-transform-btn'));

        document.getElementById('popup-reference-focal-length').addEventListener('input', (e) => {
            const value = e.target.value;
            const ref = getOpenerEl('reference-focal-length');
            if (ref) ref.value = value;
            try {
                localStorage.setItem('systemData', JSON.stringify({ referenceFocalLength: value }));
            } catch (_) {}
        });

        // Coordinate transformation controls in popup
        const popupTransformSurfaceSelect = document.getElementById('popup-transform-surface-select');
        const popupShowLocalCoordsBtn = document.getElementById('popup-show-local-coords-btn');
        const popupCancelTransformBtn = document.getElementById('popup-cancel-transform-btn');
        const popupSaveLocalCoordsBtn = document.getElementById('popup-save-local-coords-btn');
        const popupErrorBar = document.getElementById('popup-transform-error-bar');
        const popupErrorText = document.getElementById('popup-transform-error-text');
        const popupProgressWrapper = document.getElementById('popup-transform-progress-wrapper');
        const popupProgressText = document.getElementById('popup-transform-progress-text');
        const popupProgressBar = document.getElementById('popup-transform-progressbar');

        function showPopupError(message) {
            if (popupErrorBar && popupErrorText) {
                popupErrorText.textContent = message;
                popupErrorBar.style.display = '';
            }
        }

        function hidePopupError() {
            if (popupErrorBar) popupErrorBar.style.display = 'none';
        }

        function setPopupProgress(percent, message) {
            if (popupProgressWrapper) popupProgressWrapper.style.display = 'block';
            if (popupProgressBar && Number.isFinite(percent)) {
                popupProgressBar.value = Math.max(0, Math.min(100, percent));
            }
            if (popupProgressText && message) popupProgressText.textContent = message;
        }

        function hidePopupProgress() {
            if (popupProgressWrapper) popupProgressWrapper.style.display = 'none';
        }

        // Update surface select from opener
        function updatePopupSurfaceSelect() {
            if (!popupTransformSurfaceSelect) return;
            try {
                const getOpticalSystemRows = window.opener && window.opener.getOpticalSystemRows;
                if (typeof getOpticalSystemRows !== 'function') return;
                
                const opticalSystemRows = getOpticalSystemRows();
                if (!opticalSystemRows || opticalSystemRows.length === 0) return;
                
                popupTransformSurfaceSelect.innerHTML = '<option value="">Select surface...</option>';
                
                opticalSystemRows.forEach((row, index) => {
                    const objectType = String(row?.['object type'] ?? row?.object ?? '').toLowerCase();
                    if (objectType === 'object') return;
                    
                    const surfType = String(row?.surfType ?? row?.type ?? '').toLowerCase();
                    if (surfType === 'ct' || surfType === 'coordtrans' || surfType === 'coordinatebreak' ||
                        surfType === 'coord trans' || surfType === 'coordinate break') {
                        return;
                    }
                    
                    const option = document.createElement('option');
                    option.value = index;
                    
                    let label = 'Surf ' + index;
                    if (row.comment) label += ': ' + row.comment;
                    else if (row.material && row.material !== 'AIR') label += ': ' + row.material;
                    
                    option.textContent = label;
                    popupTransformSurfaceSelect.appendChild(option);
                });
            } catch (error) {
                console.error('Error updating popup surface select:', error);
            }
        }

        // Show Local Coords button
        if (popupShowLocalCoordsBtn) {
            popupShowLocalCoordsBtn.addEventListener('click', async function() {
                hidePopupError();
                
                try {
                    const surfaceIndex = parseInt(popupTransformSurfaceSelect?.value);
                    if (!surfaceIndex && surfaceIndex !== 0) {
                        showPopupError('Please select a surface first.');
                        return;
                    }
                    
                    const calculateAllSurfacesLocalCoordinates = window.opener && window.opener.calculateAllSurfacesLocalCoordinates;
                    const getOpticalSystemRows = window.opener && window.opener.getOpticalSystemRows;
                    const tableOpticalSystem = window.opener && window.opener.tableOpticalSystem;
                    
                    if (typeof calculateAllSurfacesLocalCoordinates !== 'function') {
                        showPopupError('Coordinate transformation function not available.');
                        return;
                    }
                    
                    if (typeof getOpticalSystemRows !== 'function') {
                        showPopupError('Optical system data not available.');
                        return;
                    }
                    
                    const opticalSystemRows = getOpticalSystemRows();
                    if (!opticalSystemRows || opticalSystemRows.length === 0) {
                        showPopupError('No optical system data. Please load or create an optical system.');
                        return;
                    }
                    
                    popupShowLocalCoordsBtn.disabled = true;
                    if (popupCancelTransformBtn) popupCancelTransformBtn.style.display = '';
                    if (popupSaveLocalCoordsBtn) popupSaveLocalCoordsBtn.style.display = 'none';
                    
                    if (window.opener) window.opener._transformCalculationCancelled = false;
                    
                    const result = await calculateAllSurfacesLocalCoordinates(
                        opticalSystemRows,
                        surfaceIndex,
                        (percent, message) => setPopupProgress(percent, message)
                    );
                    
                    if (window.opener) {
                        window.opener._cachedLocalCoords = result;
                        window.opener._showLocalCoords = true;
                    }
                    
                    if (tableOpticalSystem) {
                        tableOpticalSystem.redraw();
                    }
                    
                    if (popupSaveLocalCoordsBtn) popupSaveLocalCoordsBtn.style.display = '';
                    
                    hidePopupProgress();
                    
                } catch (error) {
                    console.error('Coordinate transformation error:', error);
                    showPopupError(error.message || 'Failed to calculate local coordinates.');
                    hidePopupProgress();
                } finally {
                    popupShowLocalCoordsBtn.disabled = false;
                    if (popupCancelTransformBtn) popupCancelTransformBtn.style.display = 'none';
                }
            });
        }

        // Cancel button
        if (popupCancelTransformBtn) {
            popupCancelTransformBtn.addEventListener('click', function() {
                if (window.opener) window.opener._transformCalculationCancelled = true;
                if (popupCancelTransformBtn) popupCancelTransformBtn.style.display = 'none';
                hidePopupProgress();
                showPopupError('Calculation cancelled by user.');
            });
        }

        // Save as JSON button
        if (popupSaveLocalCoordsBtn) {
            popupSaveLocalCoordsBtn.addEventListener('click', function() {
                try {
                    const data = window.opener && window.opener._cachedLocalCoords;
                    if (!data) {
                        showPopupError('No coordinate data to save. Please calculate first.');
                        return;
                    }
                    
                    const json = JSON.stringify(data, null, 2);
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    const surfaceIndex = data.metadata?.targetSurfaceIndex ?? 'unknown';
                    const filename = 'local-coords-surf' + surfaceIndex + '-' + timestamp + '.json';
                    
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    
                    URL.revokeObjectURL(url);
                    
                } catch (error) {
                    console.error('Save error:', error);
                    showPopupError('Failed to save JSON file: ' + error.message);
                }
            });
        }

        // Update surface select on load and periodically
        updatePopupSurfaceSelect();
        setInterval(updatePopupSurfaceSelect, 1000);

        // Keep in sync with the main window.
        setInterval(syncFromOpener, 500);
        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Spot Diagram popup window button
        const openSpotDiagramWindowBtn = document.getElementById('open-spot-diagram-window-btn');
        if (openSpotDiagramWindowBtn) {
                openSpotDiagramWindowBtn.addEventListener('click', () => {
                        if (window.__spotDiagramPopup && !window.__spotDiagramPopup.closed) {
                                try { window.__spotDiagramPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Spot Diagram', 'width=800,height=600');
                        window.__spotDiagramPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Spot Diagram</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        .controls {
            padding: 10px 12px;
            background: white;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input, .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .pattern-btn.active { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            background: white;
        }
        #popup-spot-diagram-container {
            min-height: 100%;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Spot Diagram</div>
    <div class="controls">
        <label for="popup-spot-diagram-config-select">Config:</label>
        <select id="popup-spot-diagram-config-select"></select>

        <label for="popup-surface-number-select">Surf:</label>
        <select id="popup-surface-number-select"></select>

        <label for="popup-ray-count-input">Ray number:</label>
        <input type="number" id="popup-ray-count-input" value="501" min="1" max="10001" step="1" />

        <label for="popup-ring-count-select">Ring count:</label>
        <select id="popup-ring-count-select">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10" selected>10</option>
            <option value="12">12</option>
            <option value="15">15</option>
            <option value="16">16</option>
            <option value="20">20</option>
            <option value="24">24</option>
            <option value="32">32</option>
        </select>

        <label>Ray pattern:</label>
        <button id="popup-annular-pattern-btn" class="pattern-btn active" type="button">Annular</button>
        <button id="popup-grid-pattern-btn" class="pattern-btn" type="button">Rectangle</button>

        <button id="popup-show-spot-diagram-btn" type="button">Show spot diagram</button>
    </div>
    <div class="note">
        Note: Select a surface where rays can reach (usually Image surface or earlier).
    </div>
    <div id="popup-spot-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-spot-progress-text" style="margin-bottom: 6px;">Calculating spot diagram...</div>
        <progress id="popup-spot-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-spot-diagram-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncSurfaceOptionsFromOpener() {
            const openerSelect = getOpenerEl('surface-number-select');
            const popupSelect = document.getElementById('popup-surface-number-select');
            if (!popupSelect) return;

            const normalizeLabel = (text) => {
                const t = String(text || '').trim();
                // Drop leading "Surf N:" / "Surface N:" / "面 N" etc.
                return t
                    .replace(/^Surf\s*\d+\s*[:\-]?\s*/i, '')
                    .replace(/^Surface\s*\d+\s*[:\-]?\s*/i, '')
                    .replace(/^面\s*\d+\s*[:\-]?\s*/i, '')
                    .trim();
            };

            const prevValue = popupSelect.value;
            const prevText = popupSelect.options && popupSelect.selectedIndex >= 0
                ? popupSelect.options[popupSelect.selectedIndex]?.textContent
                : '';
            const prevKey = normalizeLabel(prevText);
            const prevWasLast = popupSelect.options && popupSelect.options.length > 0
                ? popupSelect.selectedIndex === (popupSelect.options.length - 1)
                : false;

            popupSelect.innerHTML = '';
            if (!openerSelect || !openerSelect.options) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Select Surf';
                popupSelect.appendChild(opt);
                return;
            }

            for (const o of openerSelect.options) {
                const opt = document.createElement('option');
                opt.value = o.value;
                // Replace Japanese "面" prefix and "Surface" prefix with "Surf".
                const label = (o.textContent || '').replace(/^面\s*/,'Surf ').replace(/^Surface\s*/,'Surf ');
                opt.textContent = label;
                popupSelect.appendChild(opt);
            }

            // Preserve selection robustly across insert/delete (e.g., Image surface shifts index).
            const hasValue = (v) => Array.from(popupSelect.options || []).some((opt) => String(opt.value) === String(v));
            if (prevValue !== '' && hasValue(prevValue)) {
                popupSelect.value = prevValue;
                return;
            }
            if (prevKey) {
                const opts = Array.from(popupSelect.options || []);
                const match = opts.find((opt) => normalizeLabel(opt.textContent) === prevKey);
                if (match) {
                    popupSelect.value = match.value;
                    return;
                }
            }
            if (prevWasLast && popupSelect.options && popupSelect.options.length > 0) {
                popupSelect.selectedIndex = popupSelect.options.length - 1;
                return;
            }
            // Fallback: mirror opener selection.
            popupSelect.value = openerSelect.value;
        }

        function syncConfigOptionsFromOpener() {
            const openerCfg = getOpenerEl('spot-diagram-config-select');
            const popupCfg = document.getElementById('popup-spot-diagram-config-select');
            if (!popupCfg) return;

            popupCfg.innerHTML = '';
            if (!openerCfg || !openerCfg.options) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Current';
                popupCfg.appendChild(opt);
                return;
            }

            for (const o of openerCfg.options) {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.textContent || '';
                popupCfg.appendChild(opt);
            }

            popupCfg.value = openerCfg.value;
        }

        function syncInputsFromOpener() {
            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const popupRay = document.getElementById('popup-ray-count-input');
            const popupRing = document.getElementById('popup-ring-count-select');

            if (popupRay && openerRay && popupRay.value !== openerRay.value) popupRay.value = openerRay.value;
            if (popupRing && openerRing && popupRing.value !== openerRing.value) popupRing.value = openerRing.value;

            // pattern
            const annular = getOpenerEl('annular-pattern-btn');
            const grid = getOpenerEl('grid-pattern-btn');
            const popupAnnular = document.getElementById('popup-annular-pattern-btn');
            const popupGrid = document.getElementById('popup-grid-pattern-btn');
            if (popupAnnular && popupGrid) {
                const isAnnular = !!annular && annular.classList.contains('active');
                popupAnnular.classList.toggle('active', isAnnular);
                popupGrid.classList.toggle('active', !isAnnular);
            }
        }

        function syncConfigToOpener() {
            const popupCfg = document.getElementById('popup-spot-diagram-config-select');
            const openerCfg = getOpenerEl('spot-diagram-config-select');
            if (!popupCfg || !openerCfg) return;
            openerCfg.value = popupCfg.value;
            try {
                openerCfg.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (_) {
                // ignore
            }
        }

        document.getElementById('popup-spot-diagram-config-select').addEventListener('change', () => {
            syncConfigToOpener();
            // surface options depend on config, so resync
            syncSurfaceOptionsFromOpener();
        });

        function setPopupPattern(isAnnular) {
            const popupAnnular = document.getElementById('popup-annular-pattern-btn');
            const popupGrid = document.getElementById('popup-grid-pattern-btn');
            popupAnnular.classList.toggle('active', isAnnular);
            popupGrid.classList.toggle('active', !isAnnular);

            const openerAnnular = getOpenerEl('annular-pattern-btn');
            const openerGrid = getOpenerEl('grid-pattern-btn');
            if (isAnnular && openerAnnular) openerAnnular.click();
            if (!isAnnular && openerGrid) openerGrid.click();
        }

        document.getElementById('popup-annular-pattern-btn').addEventListener('click', () => setPopupPattern(true));
        document.getElementById('popup-grid-pattern-btn').addEventListener('click', () => setPopupPattern(false));

        document.getElementById('popup-show-spot-diagram-btn').addEventListener('click', async () => {
            const popupContainer = document.getElementById('popup-spot-diagram-container');
            if (popupContainer) popupContainer.innerHTML = '';

            // Ensure surface indices/options are up-to-date (CB insert/delete shifts indices).
            try { syncSurfaceOptionsFromOpener(); } catch (_) {}

            const progressWrapper = document.getElementById('popup-spot-progress-wrapper');
            const progressBarEl = document.getElementById('popup-spot-progressbar');
            const progressTextEl = document.getElementById('popup-spot-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const openerSurface = getOpenerEl('surface-number-select');
            const openerCfg = getOpenerEl('spot-diagram-config-select');
            const popupRay = document.getElementById('popup-ray-count-input');
            const popupRing = document.getElementById('popup-ring-count-select');
            const popupSurface = document.getElementById('popup-surface-number-select');
            const popupCfg = document.getElementById('popup-spot-diagram-config-select');

            if (openerRay && popupRay) openerRay.value = popupRay.value;
            if (openerRing && popupRing) openerRing.value = popupRing.value;
            if (openerSurface && popupSurface) openerSurface.value = popupSurface.value;
            if (openerCfg && popupCfg) {
                openerCfg.value = popupCfg.value;
                try { openerCfg.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
            }

            if (!window.opener || typeof window.opener.showSpotDiagram !== 'function') {
                if (popupContainer) popupContainer.textContent = 'showSpotDiagram is not available in the main window.';
                return;
            }

            try {
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };

                await window.opener.showSpotDiagram({
                    surfaceIndex: popupSurface && popupSurface.value !== '' ? parseInt(popupSurface.value, 10) : undefined,
                    rayCount: popupRay && popupRay.value !== '' ? parseInt(popupRay.value, 10) : undefined,
                    ringCount: popupRing && popupRing.value !== '' ? parseInt(popupRing.value, 10) : undefined,
                    configId: popupCfg && popupCfg.value !== '' ? String(popupCfg.value) : undefined,
                    containerElement: popupContainer,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (e) {
                if (popupContainer) popupContainer.textContent = String(e && e.message ? e.message : e);
                setProgress(100, 'Failed');
            }
        });

        function syncAll() {
            syncConfigOptionsFromOpener();
            syncSurfaceOptionsFromOpener();
            syncInputsFromOpener();
        }

        // Allow the opener to request a resync after table edits (e.g., CB insert/delete).
        try {
            window.__cooptSpotPopupSyncAll = syncAll;
        } catch (_) {}
        window.addEventListener('message', (ev) => {
            try {
                const data = ev && ev.data;
                if (!data || data.action !== 'coopt-spot-sync') return;
                syncAll();
            } catch (_) {
                // ignore
            }
        });

        window.addEventListener('focus', syncAll);
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Spherical Aberration (Longitudinal Aberration) popup window button
        const openSphericalAberrationWindowBtn = document.getElementById('open-spherical-aberration-window-btn');
        if (openSphericalAberrationWindowBtn) {
                openSphericalAberrationWindowBtn.addEventListener('click', () => {
                        if (window.__sphericalAberrationPopup && !window.__sphericalAberrationPopup.closed) {
                                try { window.__sphericalAberrationPopup.focus(); } catch (_) {}
                    try {
                        if (typeof window.__sphericalAberrationPopup.renderSphericalAberration === 'function') {
                            window.__sphericalAberrationPopup.renderSphericalAberration();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Spherical Aberration', 'width=800,height=600');
                        window.__sphericalAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Spherical Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 90px;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            background: white;
        }
        #popup-longitudinal-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Spherical Aberration</div>
    <div class="controls">
        <label for="popup-longitudinal-ray-count-input">Ray number:</label>
        <input type="number" id="popup-longitudinal-ray-count-input" value="20" min="1" max="1001" step="1" />
        <span class="note-inline" style="font-size:12px;color:#666;">(Always normalized by stop diameter)</span>
        <button id="popup-show-spherical-aberration-btn" type="button">Show spherical aberration diagram</button>
    </div>
    <div id="popup-spherical-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-spherical-progress-text" style="margin-bottom: 6px;">Calculating spherical aberration...</div>
        <progress id="popup-spherical-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="note">
        Note: X-axis is longitudinal aberration (mm), Y-axis is normalized pupil coordinate.
    </div>
    <div class="content">
        <div id="popup-longitudinal-aberration-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerRay = getOpenerEl('longitudinal-ray-count-input');
            const popupRay = document.getElementById('popup-longitudinal-ray-count-input');
            if (openerRay && popupRay) {
                popupRay.value = openerRay.value;
            }
        }

        window.renderSphericalAberration = async () => {
            const progressWrapper = document.getElementById('popup-spherical-progress-wrapper');
            const progressBarEl = document.getElementById('popup-spherical-progressbar');
            const progressTextEl = document.getElementById('popup-spherical-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const popupRay = document.getElementById('popup-longitudinal-ray-count-input');
            const rayCount = popupRay ? parseInt(popupRay.value, 10) : 51;
            const openerRay = getOpenerEl('longitudinal-ray-count-input');
            if (openerRay && Number.isFinite(rayCount)) {
                openerRay.value = String(rayCount);
            }

            const containerEl = document.getElementById('popup-longitudinal-aberration-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                if (!window.opener || typeof window.opener.showLongitudinalAberrationDiagram !== 'function') {
                    throw new Error('showLongitudinalAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showLongitudinalAberrationDiagram({
                    rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                    containerElement: containerEl,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate spherical aberration diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-spherical-aberration-btn').addEventListener('click', () => {
            window.renderSphericalAberration();
        });

        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderSphericalAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Astigmatism popup window button
        const openAstigmatismWindowBtn = document.getElementById('open-astigmatism-window-btn');
        if (openAstigmatismWindowBtn) {
                openAstigmatismWindowBtn.addEventListener('click', () => {
                        if (window.__astigmatismPopup && !window.__astigmatismPopup.closed) {
                                try { window.__astigmatismPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof window.__astigmatismPopup.renderAstigmatism === 'function') {
                                                window.__astigmatismPopup.renderAstigmatism();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Astigmatism', 'width=800,height=600');
                        window.__astigmatismPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Astigmatism</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-astigmatic-field-curves-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Astigmatism</div>
    <div class="controls">
        <label for="popup-astigmatism-chief-ray" style="font-size:12px;color:#333;white-space:nowrap;">Chief ray:</label>
        <select id="popup-astigmatism-chief-ray" style="padding:5px 8px;font-size:12px;border:1px solid #bbb;border-radius:4px;background:white;">
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
            <option value="stop-center-image">Stop center (image plane)</option>
            <option value="beam-midpoint-image">Beam midpoint (image plane)</option>
            <option value="beam-centroid-image">Beam centroid (image plane)</option>
        </select>
        <button id="popup-show-astigmatism-btn" type="button">Show astigmatism diagram</button>
    </div>
    <div id="popup-astigmatism-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-astigmatism-progress-text" style="margin-bottom: 6px;">Calculating astigmatism...</div>
        <progress id="popup-astigmatism-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="note">
        Note: Astigmatism diagram shows sagittal and meridional focal positions across field.
    </div>
    <div class="content">
        <div id="popup-astigmatic-field-curves-container"></div>
    </div>

    <script>
        window.renderAstigmatism = async () => {
            const containerEl = document.getElementById('popup-astigmatic-field-curves-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-astigmatism-progress-wrapper');
            const progressBarEl = document.getElementById('popup-astigmatism-progressbar');
            const progressTextEl = document.getElementById('popup-astigmatism-progress-text');
            const chiefRaySelect = document.getElementById('popup-astigmatism-chief-ray');
            const chiefRayDefinition = (chiefRaySelect && chiefRaySelect.value) ? chiefRaySelect.value : 'stop-center';

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.showAstigmatismDiagram !== 'function') {
                    throw new Error('showAstigmatismDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showAstigmatismDiagram({
                    containerElement: containerEl,
                    onProgress,
                    chiefRayDefinition,
                    logChiefRayDefinition: true,
                    useActiveConfigSnapshot: true
                });
                setProgress(100, 'Done');
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate astigmatism diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-astigmatism-btn').addEventListener('click', () => {
            window.renderAstigmatism();
        });

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderAstigmatism(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Distortion popup window button
        const openDistortionWindowBtn = document.getElementById('open-distortion-window-btn');
        if (openDistortionWindowBtn) {
                openDistortionWindowBtn.addEventListener('click', () => {
                        if (window.__distortionPopup && !window.__distortionPopup.closed) {
                                try { window.__distortionPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof window.__distortionPopup.renderDistortion === 'function') {
                                                window.__distortionPopup.renderDistortion();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Distortion', 'width=800,height=600');
                        window.__distortionPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Distortion</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        .plot-area { flex: 1 1 auto; min-height: 0; }
        #popup-distortion-grid-area { display: none; border-top: 1px solid #eee; }
        #popup-distortion-percent { height: 100%; }
        #popup-distortion-grid { height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Distortion</div>
    <div class="controls">
        <button id="popup-show-distortion-btn" type="button">Show distortion diagram</button>
        <label for="popup-distortion-grid-size">Grid Size:</label>
        <select id="popup-distortion-grid-size">
            <option value="10">10×10</option>
            <option value="15">15×15</option>
            <option value="20" selected>20×20</option>
            <option value="25">25×25</option>
            <option value="30">30×30</option>
            <option value="35">35×35</option>
            <option value="40">40×40</option>
            <option value="45">45×45</option>
            <option value="50">50×50</option>
        </select>
        <button id="popup-show-distortion-grid-btn" type="button">Show grid distortion</button>
    </div>
    <div id="popup-distortion-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-distortion-progress-text" style="margin-bottom: 6px;">Calculating distortion...</div>
        <progress id="popup-distortion-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-distortion-percent-area" class="plot-area"><div id="popup-distortion-percent"></div></div>
        <div id="popup-distortion-grid-area" class="plot-area"><div id="popup-distortion-grid"></div></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerGrid = getOpenerEl('grid-size-select');
            const popupGrid = document.getElementById('popup-distortion-grid-size');
            if (openerGrid && popupGrid) {
                popupGrid.value = openerGrid.value;
            }
        }

        function resizePlots() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const a = document.getElementById('popup-distortion-percent');
                const b = document.getElementById('popup-distortion-grid');
                if (a) plotly.Plots.resize(a);
                if (b) plotly.Plots.resize(b);
            } catch (_) {}
        }

        function setGridVisible(visible) {
            const gridArea = document.getElementById('popup-distortion-grid-area');
            const percentArea = document.getElementById('popup-distortion-percent-area');
            if (!gridArea || !percentArea) return;

            if (visible) {
                gridArea.style.display = 'block';
                percentArea.style.flex = '1 1 50%';
                gridArea.style.flex = '1 1 50%';
            } else {
                gridArea.style.display = 'none';
                percentArea.style.flex = '1 1 auto';
            }

            // Let layout settle, then resize plots
            setTimeout(resizePlots, 0);
        }

        window.renderDistortion = async () => {
            const percentEl = document.getElementById('popup-distortion-percent');
            if (percentEl) percentEl.innerHTML = '';
            // Default to full-height distortion plot
            setGridVisible(false);

            const progressWrapper = document.getElementById('popup-distortion-progress-wrapper');
            const progressBarEl = document.getElementById('popup-distortion-progressbar');
            const progressTextEl = document.getElementById('popup-distortion-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.generateDistortionPlots !== 'function') {
                    throw new Error('generateDistortionPlots is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.generateDistortionPlots({ targetElement: percentEl, onProgress });
                setProgress(100, 'Done');
                setTimeout(resizePlots, 0);
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (percentEl) {
                    percentEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate distortion diagram. Check console.</div>';
                }
            }
        };

        window.renderGridDistortion = async () => {
            const gridEl = document.getElementById('popup-distortion-grid');
            if (gridEl) gridEl.innerHTML = '';
            // Split view when grid is requested
            setGridVisible(true);

            const progressWrapper = document.getElementById('popup-distortion-progress-wrapper');
            const progressBarEl = document.getElementById('popup-distortion-progressbar');
            const progressTextEl = document.getElementById('popup-distortion-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const gridSizeEl = document.getElementById('popup-distortion-grid-size');
            const gridSize = gridSizeEl ? parseInt(gridSizeEl.value, 10) : 20;
            const openerGrid = getOpenerEl('grid-size-select');
            if (openerGrid && Number.isFinite(gridSize)) openerGrid.value = String(gridSize);

            try {
                if (!window.opener || typeof window.opener.generateGridDistortionPlot !== 'function') {
                    throw new Error('generateGridDistortionPlot is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.generateGridDistortionPlot({ gridSize: Number.isFinite(gridSize) ? gridSize : 20, targetElement: gridEl, onProgress });
                setProgress(100, 'Done');
                setTimeout(resizePlots, 0);
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (gridEl) {
                    gridEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate grid distortion. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-distortion-btn').addEventListener('click', () => window.renderDistortion());
        document.getElementById('popup-show-distortion-grid-btn').addEventListener('click', () => window.renderGridDistortion());
        window.addEventListener('resize', resizePlots);
        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open (distortion percent)
        window.addEventListener('load', () => {
            try { window.renderDistortion(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Integrated Aberration popup window button
        const openIntegratedAberrationWindowBtn = document.getElementById('open-integrated-aberration-window-btn');
        if (openIntegratedAberrationWindowBtn) {
                openIntegratedAberrationWindowBtn.addEventListener('click', () => {
                        if (window.__integratedAberrationPopup && !window.__integratedAberrationPopup.closed) {
                                try { window.__integratedAberrationPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof window.__integratedAberrationPopup.renderIntegratedAberration === 'function') {
                                                window.__integratedAberrationPopup.renderIntegratedAberration();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Integrated Aberration', 'width=800,height=600');
                        window.__integratedAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Integrated Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-integrated-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Integrated Aberration</div>
    <div class="controls">
        <button id="popup-show-integrated-aberration-btn" type="button">Show integrated aberration diagram</button>
    </div>
    <div id="popup-integrated-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-integrated-progress-text" style="margin-bottom: 6px;">Calculating integrated aberration...</div>
        <progress id="popup-integrated-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-integrated-aberration-container"></div>
    </div>

    <script>
        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-integrated-aberration-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window.renderIntegratedAberration = async () => {
            const containerEl = document.getElementById('popup-integrated-aberration-container');
            if (containerEl) containerEl.innerHTML = '';
            resizePlot();

            const progressWrapper = document.getElementById('popup-integrated-progress-wrapper');
            const progressBarEl = document.getElementById('popup-integrated-progressbar');
            const progressTextEl = document.getElementById('popup-integrated-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.showIntegratedAberrationDiagram !== 'function') {
                    throw new Error('showIntegratedAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showIntegratedAberrationDiagram({ containerElement: containerEl, onProgress });
                setProgress(100, 'Done');
                resizePlot();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate integrated aberration diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-integrated-aberration-btn').addEventListener('click', () => {
            window.renderIntegratedAberration();
        });

        window.addEventListener('resize', resizePlot);

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderIntegratedAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Optical Path Difference (OPD) popup window button
        const openOpdWindowBtn = document.getElementById('open-opd-window-btn');
        if (openOpdWindowBtn) {
                openOpdWindowBtn.addEventListener('click', () => {
                        if (window.__opdPopup && !window.__opdPopup.closed) {
                    // Always reopen fresh so stale about:blank popup code can't persist.
                    try { window.__opdPopup.close(); } catch (_) {}
                    window.__opdPopup = null;
                        }

                        const popup = window.open('', 'Optical Path Difference', 'width=800,height=600');
                        window.__opdPopup = popup;

                        try { popup.document.open(); } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Optical Path Difference</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-wavefront-container { flex: 1 1 auto; min-height: 0; }
        #popup-wavefront-container-stats { flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #333; border-top: 1px solid #eee; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Optical Path Difference</div>
    <div class="controls">
        <label for="popup-wavefront-object-select">Object:</label>
        <select id="popup-wavefront-object-select"></select>
        <label for="popup-wavefront-plot-type-select">Plot type:</label>
        <select id="popup-wavefront-plot-type-select">
            <option value="surface">3D Surface</option>
            <option value="heatmap">Heatmap</option>
            <option value="multifield">Multi-field Comparison</option>
        </select>
        <label for="popup-wavefront-grid-size-select">Grid size:</label>
        <select id="popup-wavefront-grid-size-select">
            <option value="16">16x16</option>
            <option value="32">32x32</option>
            <option value="64" selected>64x64</option>
            <option value="128">128x128</option>
            <option value="256">256x256</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-zernike-fit-checkbox" type="checkbox" />
            Zernike (calc)
        </label>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-opd-remove-ptd-checkbox" type="checkbox" />
            Remove P/T/D
        </label>
        <button id="popup-show-wavefront-btn" type="button">Show wavefront diagram</button>
        <button id="popup-stop-opd-btn" type="button" disabled>Stop</button>
    </div>
    <div id="popup-opd-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-opd-progress-text" style="margin-bottom: 6px;">Calculating OPD...</div>
        <progress id="popup-opd-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-wavefront-container"></div>
        <div id="popup-wavefront-container-stats"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncObjectOptionsFromOpener() {
            const openerSelect = getOpenerEl('wavefront-object-select');
            const popupSelect = document.getElementById('popup-wavefront-object-select');
            if (!popupSelect) return;

            const current = popupSelect.value;
            const nextOptions = [];

            // MTF-style: build from opener.getObjectRows() first.
            let opener = null;
            try { opener = window.opener || null; } catch (_) { opener = null; }
            let objects = [];
            if (opener && typeof opener.getObjectRows === 'function') {
                try { objects = opener.getObjectRows(opener.tableObject); } catch (_) { objects = []; }
            }
            if (Array.isArray(objects) && objects.length > 0) {
                const toFiniteNumber = (v) => {
                    const n = (typeof v === 'number') ? v : parseFloat(v);
                    return (Number.isFinite(n) ? n : NaN);
                };
                const pickNumber = (obj, keys, fallback) => {
                    for (let i = 0; i < keys.length; i++) {
                        const k = keys[i];
                        if (!k) continue;
                        const raw = obj ? obj[k] : undefined;
                        if (raw === undefined || raw === null || raw === '') continue;
                        const n = toFiniteNumber(raw);
                        if (Number.isFinite(n)) return n;
                    }
                    return fallback;
                };
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    nextOptions.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }

            // Fallback: clone opener select.
            if (nextOptions.length === 0 && openerSelect && openerSelect.options) {
                Array.from(openerSelect.options).forEach(opt => {
                    nextOptions.push({ value: String(opt.value), label: String(opt.textContent ?? '') });
                });
            }
            // Last fallback: placeholder + schedule a retry (opener tables may not be ready yet).
            if (nextOptions.length === 0) {
                nextOptions.push({ value: '0', label: '1' });
                setTimeout(() => {
                    try { syncObjectOptionsFromOpener(); } catch (_) {}
                }, 250);
            }

            popupSelect.innerHTML = '';
            for (const opt of nextOptions) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                popupSelect.appendChild(o);
            }

            if (current && Array.from(popupSelect.options).some(o => o.value === current)) {
                popupSelect.value = current;
            } else if (openerSelect && openerSelect.value && Array.from(popupSelect.options).some(o => o.value === openerSelect.value)) {
                popupSelect.value = openerSelect.value;
            } else {
                popupSelect.value = popupSelect.options[0]?.value ?? '0';
            }
        }

        function syncInputsFromOpener() {
            const openerPlotType = getOpenerEl('wavefront-plot-type-select');
            const openerGrid = getOpenerEl('wavefront-grid-size-select');
            const openerRemovePtd = getOpenerEl('opd-remove-ptd-checkbox');
            const popupPlotType = document.getElementById('popup-wavefront-plot-type-select');
            const popupGrid = document.getElementById('popup-wavefront-grid-size-select');
            const popupRemovePtd = document.getElementById('popup-opd-remove-ptd-checkbox');
            if (openerPlotType && popupPlotType) popupPlotType.value = openerPlotType.value;
            if (openerGrid && popupGrid) popupGrid.value = openerGrid.value;
            if (popupRemovePtd) popupRemovePtd.checked = !!(openerRemovePtd && openerRemovePtd.checked);
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-wavefront-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window.renderOPD = async () => {
            const containerEl = document.getElementById('popup-wavefront-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-opd-progress-wrapper');
            const progressBarEl = document.getElementById('popup-opd-progressbar');
            const progressTextEl = document.getElementById('popup-opd-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const popupObject = document.getElementById('popup-wavefront-object-select');
            const popupPlotType = document.getElementById('popup-wavefront-plot-type-select');
            const popupGrid = document.getElementById('popup-wavefront-grid-size-select');
            const popupZernikeFit = document.getElementById('popup-zernike-fit-checkbox');
            const popupRemovePtd = document.getElementById('popup-opd-remove-ptd-checkbox');

            const objectIndex = (() => {
                if (!popupObject) return 0;
                const v = parseInt(String(popupObject.value), 10);
                if (Number.isFinite(v)) return v;
                const idx = Number(popupObject.selectedIndex);
                return Number.isFinite(idx) && idx >= 0 ? idx : 0;
            })();
            const plotType = popupPlotType ? popupPlotType.value : 'surface';
            const gridSize = popupGrid ? parseInt(popupGrid.value, 10) : 64;
            const opdDisplayMode = (popupRemovePtd && popupRemovePtd.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';

            const openerObject = getOpenerEl('wavefront-object-select');
            const openerPlotType = getOpenerEl('wavefront-plot-type-select');
            const openerGrid = getOpenerEl('wavefront-grid-size-select');
            const openerRemovePtd = getOpenerEl('opd-remove-ptd-checkbox');
            if (openerObject && Number.isFinite(objectIndex)) openerObject.value = String(objectIndex);
            if (openerPlotType) openerPlotType.value = plotType;
            if (openerGrid && Number.isFinite(gridSize)) openerGrid.value = String(gridSize);
            if (openerRemovePtd) openerRemovePtd.checked = (opdDisplayMode === 'pistonTiltDefocusRemoved');

            try {
                const computeInPopup = false;
                
                // Create cancel token (reuse PSF helper if available, or inline)
                const createCancelToken = window.opener.createCancelToken || (() => {
                    let aborted = false;
                    let reason = null;
                    const listeners = [];
                    return {
                        get aborted() { return aborted; },
                        get reason() { return reason; },
                        abort(r = 'User requested stop') {
                            if (aborted) return;
                            aborted = true;
                            reason = r;
                            listeners.forEach(fn => { try { fn(r); } catch (_) {} });
                        },
                        onAbort(fn) { listeners.push(fn); }
                    };
                });
                
                const popupCancelToken = createCancelToken();
                window.__popupOpdCancelToken = popupCancelToken;
                
                const stopBtn = document.getElementById('popup-stop-opd-btn');
                
                
                if (stopBtn) {
                    stopBtn.disabled = false;
                    stopBtn.textContent = 'Stop';
                }

                setProgress(0, 'Starting...');

                // NOTE: Wavefront generator supports only options.onProgress (same as PSF)
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                
                try {
                    if (!window.opener || typeof window.opener.showWavefrontDiagram !== 'function') {
                        throw new Error('showWavefrontDiagram is not available on opener');
                    }
                    await window.opener.showWavefrontDiagram(plotType, 'opd', Number.isFinite(gridSize) ? gridSize : 64, Number.isFinite(objectIndex) ? objectIndex : 0, {
                        containerElement: containerEl,
                        cancelToken: popupCancelToken,
                        onProgress,
                        opdDisplayMode
                    });

                    // Optional: Zernike fit + push report to System Data
                    const shouldZernikeFit = !!(popupZernikeFit && popupZernikeFit.checked);
                    if (shouldZernikeFit) {
                        try {
                            if (String(plotType) === 'multifield') {
                                setProgress(100, 'Zernike fit is not available for Multi-field');
                            } else {
                                setProgress(98, 'Zernike fitting...');

                                const opener = window.opener;
                                const map = opener ? opener.__lastWavefrontMap : null;
                                const meta = opener ? opener.__lastWavefrontMeta : null;
                                if (!map || map?.error) {
                                    throw new Error('No valid wavefrontMap to fit');
                                }

                                const coordsAll = Array.isArray(map?.pupilCoordinates) ? map.pupilCoordinates : [];
                                const opdsAll = Array.isArray(map?.raw?.opds) ? map.raw.opds : (Array.isArray(map?.opds) ? map.opds : []);
                                const n = Math.min(coordsAll.length, opdsAll.length);
                                if (!n) {
                                    throw new Error('No OPD samples found');
                                }

                                // Filter out invalid samples for fitting
                                const coords = [];
                                const opds = [];
                                for (let i = 0; i < n; i++) {
                                    const c = coordsAll[i];
                                    const v = opdsAll[i];
                                    const x = Number(c?.x);
                                    const y = Number(c?.y);
                                    const opd = Number(v);
                                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(opd)) continue;
                                    coords.push({ x, y });
                                    opds.push(opd);
                                }
                                if (coords.length < 5) {
                                    throw new Error('Not enough valid samples for Zernike fitting');
                                }

                                const wavelength = Number(meta?.wavelength) || (() => {
                                    try {
                                        const w = Number(opener?.getPrimaryWavelength?.());
                                        if (Number.isFinite(w) && w > 0) return w;
                                    } catch (_) {}
                                    return 0.5876;
                                })();

                                const opticalSystemRows = (typeof opener?.getOpticalSystemRows === 'function')
                                    ? opener.getOpticalSystemRows()
                                    : null;
                                const calculator = opener?.createOPDCalculator
                                    ? opener.createOPDCalculator(opticalSystemRows, wavelength)
                                    : null;
                                const analyzer = opener?.createWavefrontAnalyzer
                                    ? opener.createWavefrontAnalyzer(calculator)
                                    : null;

                                if (!analyzer || typeof analyzer.fitZernikePolynomials !== 'function' || typeof analyzer.formatZernikeReportText !== 'function') {
                                    throw new Error('Wavefront analyzer is not available for Zernike fitting');
                                }

                                const maxNoll = Math.max(1, Math.min(37, opds.length));
                                const fit = analyzer.fitZernikePolynomials({ pupilCoordinates: coords, opds }, maxNoll);

                                // Store coefficients for the main window Zernike Fit button
                                try {
                                    opener.__lastWavefrontMap = opener.__lastWavefrontMap || map;
                                    opener.__lastWavefrontMap.zernike = fit;
                                    opener.__lastWavefrontMap.statistics = opener.__lastWavefrontMap.statistics || (map.statistics || {});
                                    opener.__lastWavefrontMap.statistics.skipZernikeFit = false;
                                } catch (_) {}

                                // Build a lightweight report map so formatting can rely on aligned sample arrays
                                const reportMap = {
                                    ...map,
                                    pupilCoordinates: coords,
                                    raw: { ...(map.raw || {}), opds },
                                    opds,
                                    zernike: fit
                                };

                                const reportText = analyzer.formatZernikeReportText(reportMap, { maxNoll });

                                const pushSystemData = (text) => {
                                    try {
                                        const ta = opener?.document?.getElementById?.('system-data');
                                        if (!ta || typeof ta.value !== 'string') return false;
                                        // Replace (clear then push) so each run shows only the latest report.
                                        ta.value = String(text || '');
                                        return true;
                                    } catch (_) {
                                        return false;
                                    }
                                };

                                const tryOpenSystemDataWindow = () => {
                                    try {
                                        const w = opener?.__systemDataPopup;
                                        if (w && !w.closed) {
                                            try { w.focus(); } catch (_) {}
                                            return true;
                                        }
                                    } catch (_) {}

                                    // Some browsers block popups triggered by synthetic clicks.
                                    // We still try the main-window button first, but fall back to
                                    // opening the System Data window directly from this user action.
                                    try {
                                        const btn = opener?.document?.getElementById?.('open-system-data-window-btn');
                                        if (btn) {
                                            btn.click();
                                            // If the click worked, the opener should set __systemDataPopup.
                                            try {
                                                const w = opener?.__systemDataPopup;
                                                if (w && !w.closed) {
                                                    try { w.focus(); } catch (_) {}
                                                    return true;
                                                }
                                            } catch (_) {}
                                        }
                                    } catch (_) {}

                                    // Fallback: open and render a minimal System Data popup directly.
                                    try {
                                        const popup = opener?.open?.('', 'System Data', 'width=1200,height=600');
                                        if (!popup) return false;
                                        try { opener.__systemDataPopup = popup; } catch (_) {}
                                        try { popup.document.open(); } catch (_) {}

                                        const html = [
                                            '<!DOCTYPE html>',
                                            '<html>',
                                            '<head>',
                                            '  <meta charset="UTF-8" />',
                                            '  <title>System Data</title>',
                                            '  <style>',
                                            '    html, body { height: 100%; }',
                                            '    body { margin: 0; font-family: Arial, sans-serif; display: flex; flex-direction: column; height: 100vh; background: #f4f4f4; }',
                                            '    .header { padding: 10px 12px; background: white; color: #333; font-weight: 600; border-bottom: 1px solid #ddd; }',
                                            '    .content { flex: 1 1 auto; padding: 10px 12px; min-height: 0; display: flex; }',
                                            '    textarea { flex: 1 1 auto; width: 100%; resize: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; line-height: 1.4; border: 1px solid #bbb; border-radius: 4px; padding: 10px; box-sizing: border-box; min-height: 0; background: white; }',
                                            '  </style>',
                                            '</head>',
                                            '<body onload="(function(){function getOpenerEl(id){try{return window.opener&&window.opener.document?window.opener.document.getElementById(id):null;}catch(e){return null;}}function sync(){var src=getOpenerEl(\\\'system-data\\\');var dst=document.getElementById(\\\'popup-system-data\\\');if(dst&&src&&dst.value!==src.value){dst.value=src.value;}}setInterval(sync,500);window.addEventListener(\\\'focus\\\',sync);sync();})();">',
                                            '  <div class="header">System Data</div>',
                                            '  <div class="content">',
                                            '    <textarea id="popup-system-data" placeholder="System information will appear here..."></textarea>',
                                            '  </div>',
                                            '</body>',
                                            '</html>'
                                        ].join('\\n');

                                        popup.document.write(html);
                                        try { popup.document.close(); } catch (_) {}
                                        try { popup.focus(); } catch (_) {}
                                        return true;
                                    } catch (_) {}

                                    return false;
                                };

                                const pushed = pushSystemData(reportText);
                                const opened = tryOpenSystemDataWindow();
                                if (pushed && opened) {
                                    setProgress(100, 'Zernike report pushed to System Data');
                                } else if (pushed) {
                                    setProgress(100, 'Zernike report pushed. See System data.');
                                } else {
                                    setProgress(100, 'Zernike fit done (could not write System Data). See System data.');
                                }
                            }
                        } catch (e) {
                            setProgress(100, 'Zernike fit failed. See console.');
                        }
                    }

                    if (!shouldZernikeFit) setProgress(100, 'Done');
                    resizePlot();
                } catch (err) {
                    if (err?.message?.includes('Cancelled')) {
                        setProgress(100, 'Cancelled');
                        console.log('🛑 OPD calculation cancelled by user');
                    } else {
                        throw err;
                    }
                } finally {
                    if (stopBtn) {
                        stopBtn.disabled = true;
                        stopBtn.textContent = 'Stop';
                    }
                    window.__popupOpdCancelToken = null;
                }
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate OPD diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-wavefront-btn').addEventListener('click', () => window.renderOPD());
        document.getElementById('popup-stop-opd-btn').addEventListener('click', () => {
            console.log('🛑 Popup OPD Stop button clicked');
            const token = window.__popupOpdCancelToken;
            if (token && typeof token.abort === 'function') {
                token.abort('Stopped by user');
                const stopBtn = document.getElementById('popup-stop-opd-btn');
                if (stopBtn) {
                    stopBtn.disabled = true;
                    stopBtn.textContent = 'Stopping...';
                }
            }
        });

        function syncAll() {
            syncObjectOptionsFromOpener();
            syncInputsFromOpener();
        }
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncAll);
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Point Spread Function popup window button
        const openPsfWindowBtn = document.getElementById('open-psf-window-btn');
        if (openPsfWindowBtn) {
                openPsfWindowBtn.addEventListener('click', () => {
                        if (window.__psfPopup && !window.__psfPopup.closed) {
                                // Always reopen fresh so stale about:blank popup code can't persist.
                                try { window.__psfPopup.close(); } catch (_) {}
                                window.__psfPopup = null;
                        }

                        const popup = window.open('', 'Point Spread Function', 'width=800,height=600');
                        if (!popup || !popup.document) {
                            try { popup?.close(); } catch (_) {}
                            alert('Popup could not be opened. Please allow popups for this site.');
                            return;
                        }
                        window.__psfPopup = popup;

                        try { popup.document.open(); } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Point Spread Function</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-psf-container { flex: 1 1 auto; min-height: 0; }
        #popup-psf-container-stats { flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #333; border-top: 1px solid #eee; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Point Spread Function</div>
    <div class="controls">
        <label for="popup-psf-object-select">Object:</label>
        <select id="popup-psf-object-select"><option value="0">1</option></select>
        <label for="popup-psf-sampling-select" title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
        <select id="popup-psf-sampling-select" title="Auto: pad to at least 512. None: no padding (FFT size = OPD grid). Or choose an explicit FFT size.">
            <option value="auto">Auto (≥512)</option>
            <option value="none">None</option>
            <option value="512">512</option>
            <option value="1024" selected>1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
        </select>
        <label for="popup-psf-zernike-sampling-select">OPD grid:</label>
        <select id="popup-psf-zernike-sampling-select" title="Ray-traced OPD grid size (number of rays traced across pupil)">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256">256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label><input type="checkbox" id="popup-psf-log-scale-checkbox"> Log scale</label>
        <label><input type="checkbox" id="popup-psf-remove-ptd-checkbox"> Remove P/T/D</label>
        <label><input type="checkbox" id="popup-psf-force-wasm-checkbox"> Force WASM</label>
        <button id="popup-show-psf-btn" type="button">Show PSF</button>
        <button id="popup-stop-psf-btn" type="button" disabled>Stop</button>
    </div>
    <div class="note">
        Note: PSF is calculated from OPD data using Fourier transform. Generate OPD data first.
    </div>
    <div id="popup-psf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-psf-progress-text" style="margin-bottom: 6px;">Calculating PSF...</div>
        <progress id="popup-psf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-psf-container"></div>
        <div id="popup-psf-container-stats"></div>
    </div>
        <script>
        // Debug: confirm the popup script version in console.
                // build tag intentionally not shown
        function isIOSLike() {
            try {
                const ua = String(navigator.userAgent || '');
                if (/iPad|iPhone|iPod/i.test(ua)) return true;
                // iPadOS 13+ may masquerade as Mac
                if (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1) return true;
            } catch (_) {}
            return false;
        }

        function createCancelToken() {
            return {
                aborted: false,
                reason: null,
                _listeners: [],
                abort(reason = 'User requested stop') {
                    if (this.aborted) return;
                    this.aborted = true;
                    this.reason = reason;
                    const ls = Array.isArray(this._listeners) ? this._listeners.slice() : [];
                    for (const fn of ls) {
                        try { fn(reason); } catch (_) {}
                    }
                },
                onAbort(fn) {
                    if (typeof fn !== 'function') return;
                    if (this.aborted) {
                        try { fn(this.reason); } catch (_) {}
                        return;
                    }
                    this._listeners.push(fn);
                }
            };
        }

        let activeCancelToken = null;

        let __psfObjectSyncRetries = 0;
        const __psfScheduleObjectResync = () => {
            // On some loads, the opener's Tabulator may not be ready yet; retry briefly.
            if (__psfObjectSyncRetries >= 60) return;
            const delay = Math.min(2000, 150 + (__psfObjectSyncRetries * 150));
            __psfObjectSyncRetries++;
            setTimeout(() => {
                try { syncObjectOptionsFromOpener(); } catch (_) {}
            }, delay);
        };

        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncObjectOptionsFromOpener() {
            const openerPsfSelect = getOpenerEl('psf-object-select');
            const openerWavefrontSelect = getOpenerEl('wavefront-object-select');
            const openerSelect = openerWavefrontSelect || openerPsfSelect;
            const popupSelect = document.getElementById('popup-psf-object-select');
            if (!popupSelect) return;

            const toFiniteNumber = (v) => {
                const n = (typeof v === 'number') ? v : parseFloat(v);
                return Number.isFinite(n) ? n : NaN;
            };
            const pickNumber = (obj, keys, fallback) => {
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (!k) continue;
                    const raw = obj ? obj[k] : undefined;
                    if (raw === undefined || raw === null || raw === '') continue;
                    const n = toFiniteNumber(raw);
                    if (Number.isFinite(n)) return n;
                }
                return fallback;
            };

            const current = popupSelect.value;
            const nextOptions = [];

            // OPD/MTF-style: build options from opener.getObjectRows() first.
            let opener = null;
            try { opener = window.opener || null; } catch (_) { opener = null; }
            let objects = [];
            if (opener && typeof opener.getObjectRows === 'function') {
                try {
                    objects = opener.getObjectRows(opener.tableObject);
                    if (!Array.isArray(objects) || objects.length === 0) objects = [];
                } catch (_) {
                    objects = [];
                }
            }
            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(
                        (obj.position !== undefined && obj.position !== null) ? obj.position :
                        (obj.object !== undefined && obj.object !== null) ? obj.object :
                        (obj.Object !== undefined && obj.Object !== null) ? obj.Object :
                        (obj.objectType !== undefined && obj.objectType !== null) ? obj.objectType :
                        'Point'
                    );
                    const x = pickNumber(obj, ['x', 'X', 'xFieldAngle', 'xAngle', 'xHeightAngle', 'XHeightAngle', 'x_height_angle', 'x_field_angle', 'x_angle'], 0);
                    const y = pickNumber(obj, ['y', 'Y', 'yFieldAngle', 'yAngle', 'yHeightAngle', 'YHeightAngle', 'y_height_angle', 'y_field_angle', 'y_angle', 'fieldAngle', 'angle'], 0);
                    nextOptions.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }

            // Fallback: clone opener select options if present (but ignore single placeholder).
            if (nextOptions.length === 0 && openerSelect && openerSelect.options && openerSelect.options.length > 0) {
                const opts = Array.from(openerSelect.options);
                let looksLikePlaceholder = false;
                if (opts.length === 1) {
                    const t = String(opts[0].textContent || '').trim().toLowerCase();
                    looksLikePlaceholder = (t === '0' || t === 'object 1' || t === 'object1');
                }
                if (!looksLikePlaceholder) {
                    const normalizeLabel = (label) => {
                        const s = String(label || '').trim();
                        // Convert e.g. "Object1 : Angle (...)" / "Object 1: ..." / "object1" => "1: ..." / "1"
                        const m = s.match(/^object\s*(\d+)\s*[:：]?\s*(.*)$/i);
                        if (m) {
                            const n = m[1];
                            const rest = String(m[2] || '').trim();
                            return rest ? (n + ': ' + rest) : String(n);
                        }
                        return s;
                    };
                    opts.forEach(opt => {
                        const raw = String((opt.textContent !== undefined && opt.textContent !== null) ? opt.textContent : '');
                        nextOptions.push({ value: String(opt.value), label: normalizeLabel(raw) });
                    });
                }
            }

            if (nextOptions.length === 0) {
                nextOptions.push({ value: '0', label: '1' });
                __psfScheduleObjectResync();
            } else {
                __psfObjectSyncRetries = 0;
            }

            popupSelect.innerHTML = '';
            for (const opt of nextOptions) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                popupSelect.appendChild(o);
            }

            if (current && Array.from(popupSelect.options).some(o => o.value === current)) {
                popupSelect.value = current;
                return;
            }
            const preferred = (openerPsfSelect && openerPsfSelect.value)
                ? openerPsfSelect.value
                : (openerSelect && openerSelect.value ? openerSelect.value : '');
            if (preferred && Array.from(popupSelect.options).some(o => o.value === preferred)) {
                popupSelect.value = preferred;
            } else {
                const firstOpt = (popupSelect.options && popupSelect.options.length > 0) ? popupSelect.options[0] : null;
                popupSelect.value = (firstOpt && firstOpt.value !== undefined && firstOpt.value !== null) ? firstOpt.value : '0';
            }
        }

        function syncInputsFromOpener() {
            const openerZeroPad = getOpenerEl('psf-zeropad-select');
            const openerZernikeSampling = getOpenerEl('psf-zernike-sampling-select');
            const openerLog = getOpenerEl('psf-log-scale-checkbox');
            const openerRemovePtd = getOpenerEl('psf-remove-ptd-checkbox');
            const popupSampling = document.getElementById('popup-psf-sampling-select');
            const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
            const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
            const popupRemovePtd = document.getElementById('popup-psf-remove-ptd-checkbox');
            if (openerZeroPad && popupSampling && openerZeroPad.value) {
                if (Array.from(popupSampling.options || []).some(o => String(o.value) === String(openerZeroPad.value))) {
                    popupSampling.value = openerZeroPad.value;
                }
            }
            if (popupZernikeSampling && openerZernikeSampling && openerZernikeSampling.value) popupZernikeSampling.value = openerZernikeSampling.value;
            // Default: Log scale should start unchecked for PSF.
            try {
                if (openerLog) openerLog.checked = false;
                if (popupLog) popupLog.checked = false;
            } catch (_) {}
            try {
                if (popupRemovePtd) popupRemovePtd.checked = !!(openerRemovePtd && openerRemovePtd.checked);
            } catch (_) {}
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-psf-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window.renderPSF = async () => {
            const containerEl = document.getElementById('popup-psf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-psf-progress-wrapper');
            const progressEl = document.getElementById('popup-psf-progress');
            const progressTextEl = document.getElementById('popup-psf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const stopBtn = document.getElementById('popup-stop-psf-btn');
            if (stopBtn) {
                stopBtn.disabled = false;
            }

            activeCancelToken = createCancelToken();

            const popupObject = document.getElementById('popup-psf-object-select');
            const popupSampling = document.getElementById('popup-psf-sampling-select');
            const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
            const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
            const popupRemovePtd = document.getElementById('popup-psf-remove-ptd-checkbox');
            const popupForceWasm = document.getElementById('popup-psf-force-wasm-checkbox');

            let objectIndex = popupObject ? parseInt(popupObject.value, 10) : 0;
            if (!Number.isFinite(objectIndex) && popupObject && Number.isFinite(popupObject.selectedIndex)) {
                objectIndex = popupObject.selectedIndex;
            }
            const zernikeSampling = popupZernikeSampling ? parseInt(popupZernikeSampling.value, 10) : 128;
            const zeroPadRaw = popupSampling ? String(popupSampling.value || 'auto') : 'auto';
            const logScale = !!(popupLog && popupLog.checked);
            const opdDisplayMode = (popupRemovePtd && popupRemovePtd.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';
            const forceWasm = !!(popupForceWasm && popupForceWasm.checked);
            const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);

            const openerObject = getOpenerEl('psf-object-select');
            const openerSampling = getOpenerEl('psf-sampling-select');
            const openerZeroPad = getOpenerEl('psf-zeropad-select');
            const openerZernikeSampling = getOpenerEl('psf-zernike-sampling-select');
            const openerLog = getOpenerEl('psf-log-scale-checkbox');
            const openerRemovePtd = getOpenerEl('psf-remove-ptd-checkbox');
            if (openerObject && Number.isFinite(objectIndex)) openerObject.value = String(objectIndex);
            if (openerSampling && Number.isFinite(zernikeSampling)) openerSampling.value = String(zernikeSampling);
            if (openerZeroPad && zeroPadRaw) {
                if (Array.from(openerZeroPad.options || []).some(o => String(o.value) === String(zeroPadRaw))) {
                    openerZeroPad.value = zeroPadRaw;
                }
            }
            try {
                if (openerRemovePtd) openerRemovePtd.checked = (opdDisplayMode === 'pistonTiltDefocusRemoved');
            } catch (_) {}
            if (openerZernikeSampling && Number.isFinite(zernikeSampling)) openerZernikeSampling.value = String(zernikeSampling);
            if (openerLog) openerLog.checked = logScale;

            try {
                setProgress(0, 'Starting...');
                // Allow the popup to paint the progress UI before heavy computation begins.
                await new Promise(r => setTimeout(r, 0));

                const onProgress = (evt) => {
                    try {
                        const p = Number(evt && evt.percent);
                        const msg = (evt && evt.message) || (evt && evt.phase) || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };

                // Always compute inside the popup to avoid background throttling of the opener
                // when the main window is hidden/minimized/unfocused.
                {
                    const CACHE_BUSTER = '2026-01-14b';
                    const moduleURL = (relPath) => {
                        const baseHref = (() => {
                            try {
                                return (window.opener && window.opener.location && window.opener.location.href)
                                    ? window.opener.location.href
                                    : window.location.href;
                            } catch (_) {
                                return window.location.href;
                            }
                        })();
                        const url = new URL(relPath, baseHref);
                        if (!url.searchParams.has('v')) url.searchParams.set('v', CACHE_BUSTER);
                        return url.href;
                    };

                    const throwIfCancelled = (token) => {
                        if (token && token.aborted) {
                            const err = new Error(String(token.reason || 'Cancelled'));
                            err.code = 'CANCELLED';
                            throw err;
                        }
                    };
                    const raceWithCancel = async (promise, token) => {
                        if (!token) return await promise;
                        throwIfCancelled(token);
                        const cancelPromise = new Promise((_, reject) => {
                            token.onAbort((reason) => {
                                const err = new Error(String(reason || 'Cancelled'));
                                err.code = 'CANCELLED';
                                reject(err);
                            });
                        });
                        return await Promise.race([promise, cancelPromise]);
                    };

                    const [{ getOpticalSystemRows, getObjectRows, getSourceRows }, { PSFPlotter }, { createOPDCalculator, WavefrontAberrationAnalyzer }, { PSFCalculator }, { calculateFocalLength, findStopSurfaceIndex }, { DEFAULT_STOP_SEMI_DIAMETER }] = await Promise.all([
                        import(moduleURL('./utils/data-utils.js')),
                        import(moduleURL('./evaluation/psf/psf-plot.js')),
                        import(moduleURL('./evaluation/wavefront/wavefront.js')),
                        import(moduleURL('./evaluation/psf/psf-calculator.js')),
                        import(moduleURL('./raytracing/core/ray-paraxial.js')),
                        import(moduleURL('./data/block-schema.js'))
                    ]);

                    const cloneRows = (rows) => {
                        if (!Array.isArray(rows)) return rows;
                        try {
                            if (typeof structuredClone === 'function') return structuredClone(rows);
                        } catch (_) {}
                        try {
                            return JSON.parse(JSON.stringify(rows));
                        } catch (_) {
                            return rows;
                        }
                    };

                    const opticalSystemRows = (() => {
                        try {
                            if (window.opener && typeof window.opener.getOpticalSystemRows === 'function') {
                                // Prefer live Tabulator table data if available.
                                const r = window.opener.getOpticalSystemRows(window.opener.tableOpticalSystem);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return getOpticalSystemRows(window.tableOpticalSystem);
                    })();

                    const objects = (() => {
                        try {
                            if (window.opener && typeof window.opener.getObjectRows === 'function') {
                                const r = window.opener.getObjectRows(window.opener.tableObject);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return getObjectRows(window.tableObject);
                    })();

                    const sources = (() => {
                        try {
                            if (window.opener && typeof window.opener.getSourceRows === 'function') {
                                const r = window.opener.getSourceRows(window.opener.tableSource);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return getSourceRows ? getSourceRows(window.tableSource) : [];
                    })();
                    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) throw new Error('No optical system data (popup).');
                    if (!Array.isArray(objects) || objects.length === 0) throw new Error('No object data (popup).');

                    const toFiniteNumber = (v) => {
                        const n = (typeof v === 'number') ? v : parseFloat(v);
                        return (Number.isFinite(n) ? n : NaN);
                    };
                    const pickNumber = (obj, keys, fallback) => {
                        for (let i = 0; i < keys.length; i++) {
                            const k = keys[i];
                            if (!k) continue;
                            const raw = obj ? obj[k] : undefined;
                            if (raw === undefined || raw === null || raw === '') continue;
                            const n = toFiniteNumber(raw);
                            if (Number.isFinite(n)) return n;
                        }
                        return fallback;
                    };

                    let idx = Number.isFinite(objectIndex) ? objectIndex : 0;
                    // If the select values are 1-based for any reason, normalize.
                    if ((idx >= objects.length) && idx > 0 && (idx - 1) < objects.length) idx = idx - 1;
                    if (idx < 0) idx = 0;
                    const selectedObject = objects[idx];
                    if (!selectedObject) throw new Error('Selected object not found (popup).');

                    const primaryWl = (() => {
                        try {
                            if (window.opener && typeof window.opener.getPrimaryWavelength === 'function') {
                                const v = Number(window.opener.getPrimaryWavelength());
                                if (Number.isFinite(v) && v > 0) return v;
                            }
                        } catch (_) {}
                        return NaN;
                    })();
                    const s0 = (sources && sources.length > 0) ? sources[0] : null;
                    const wl0 = (s0 && s0.wavelength !== undefined && s0.wavelength !== null) ? Number(s0.wavelength) : NaN;
                    const wavelength = Number.isFinite(primaryWl) ? primaryWl : (Number.isFinite(wl0) ? wl0 : 0.5876);

                    // Match showPSFDiagram(): build a fieldSetting compatible with eva-wavefront.js.
                    const objectX = pickNumber(selectedObject, ['x', 'X', 'xFieldAngle', 'xAngle', 'xHeightAngle', 'XHeightAngle', 'x_height_angle', 'x_field_angle', 'x_angle'], 0);
                    const objectY = pickNumber(selectedObject, ['y', 'Y', 'yFieldAngle', 'yAngle', 'yHeightAngle', 'YHeightAngle', 'y_height_angle', 'y_field_angle', 'y_angle', 'fieldAngle', 'angle'], 0);
                    const objectTypeRaw = String(
                        (selectedObject && selectedObject.position !== undefined && selectedObject.position !== null) ? selectedObject.position :
                        (selectedObject && selectedObject.object !== undefined && selectedObject.object !== null) ? selectedObject.object :
                        (selectedObject && selectedObject.Object !== undefined && selectedObject.Object !== null) ? selectedObject.Object :
                        (selectedObject && selectedObject.objectType !== undefined && selectedObject.objectType !== null) ? selectedObject.objectType :
                        'Point'
                    );
                    const objectType = objectTypeRaw;
                    const objectTypeLower = String(objectTypeRaw).toLowerCase();
                    let fieldAngle = { x: 0, y: 0 };
                    let xHeight = 0;
                    let yHeight = 0;
                    if (/\\bangle\\b/.test(objectTypeLower)) {
                        fieldAngle = { x: Number(objectX) || 0, y: Number(objectY) || 0 };
                        xHeight = 0;
                        yHeight = 0;
                    } else {
                        fieldAngle = { x: 0, y: 0 };
                        xHeight = Number(objectX) || 0;
                        yHeight = Number(objectY) || 0;
                    }
                    const fieldSetting = {
                        objectIndex: idx,
                        type: objectType,
                        fieldAngle,
                        xHeight,
                        yHeight,
                        wavelength
                    };

                    const getActiveConfigLabel = () => {
                        try {
                            if (typeof localStorage === 'undefined') return '';
                            const raw = localStorage.getItem('systemConfigurations');
                            if (!raw) return '';
                            const sys = JSON.parse(raw);
                            const activeId = sys?.activeConfigId;
                            const cfg = Array.isArray(sys?.configurations)
                                ? sys.configurations.find(c => String(c?.id) === String(activeId))
                                : null;
                            if (!cfg) return (activeId !== undefined && activeId !== null) ? ('id=' + activeId) : '';
                            return ('id=' + cfg.id + ' name=' + (cfg.name || '')).trim();
                        } catch (_) {
                            return '';
                        }
                    };

                    const calcFNV1a32 = (str) => {
                        let hash = 0x811c9dc5;
                        for (let i = 0; i < str.length; i++) {
                            hash ^= str.charCodeAt(i);
                            hash = Math.imul(hash, 0x01000193);
                        }
                        return (hash >>> 0).toString(16);
                    };

                    const summarizeOpticalSystemRows = (rows) => {
                        if (!Array.isArray(rows) || rows.length === 0) return { checksum: '0' };
                        const parts = [];
                        for (const r of rows) {
                            if (!r) continue;
                            const obj = r['object type'] ?? r.object ?? r.Object ?? '';
                            const radius = r.radius ?? r.Radius ?? '';
                            const thickness = r.thickness ?? r.Thickness ?? '';
                            const material = r.material ?? r.Material ?? '';
                            const semidia = r.semidia ?? r.semidiameter ?? r.SemiDia ?? '';
                            const id = r.id ?? '';
                            parts.push(String(id) + '|' + String(obj) + '|' + String(radius) + '|' + String(thickness) + '|' + String(material) + '|' + String(semidia));
                        }
                        return { checksum: calcFNV1a32(parts.join(';')) };
                    };

                    if (PSF_DEBUG) {
                        try {
                            const fa = (fieldSetting && fieldSetting.fieldAngle && typeof fieldSetting.fieldAngle === 'object')
                                ? fieldSetting.fieldAngle
                                : { x: 0, y: 0 };
                            const line = '🧭 [PSF popup] objectIndex=' + idx + ' type=' + objectType +
                                ' fieldAngle=(' + (Number(fa.x) || 0) + ',' + (Number(fa.y) || 0) + ')' +
                                ' height=(' + (Number(fieldSetting && fieldSetting.xHeight) || 0) + ',' + (Number(fieldSetting && fieldSetting.yHeight) || 0) + ')' +
                                ' wl=' + (Number(wavelength) || 0);
                            console.log(line);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(line);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    }

                    if (PSF_DEBUG) {
                        try {
                            const summary = summarizeOpticalSystemRows(opticalSystemRows);
                            const idLine = '🧾 [PSF popup] activeConfig=' + (getActiveConfigLabel() || '(none)') +
                                ' rows=' + (Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0) +
                                ' checksum=' + (summary && summary.checksum ? summary.checksum : '0');
                            console.log(idLine);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(idLine);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    }

                    // Also log PSF physical scale inputs (pupil diameter / focal length) once available.
                    // This is critical when the plot auto-normalizes intensity and hides differences.
                    const logScaleInputs = (pupilDiameterMm, focalLengthMm, stopIndex) => {
                        if (!PSF_DEBUG) return;
                        try {
                            const line = '📏 [PSF popup] pupilDiameterMm=' + (Number(pupilDiameterMm) || 0) +
                                ' focalLengthMm=' + (Number(focalLengthMm) || 0) +
                                ' stopIndex=' + (Number.isFinite(Number(stopIndex)) ? Number(stopIndex) : -1);
                            console.log(line);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(line);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    };

                    const opdCalculator = createOPDCalculator(opticalSystemRows, wavelength);
                    const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);
                    
                    // CRITICAL: Force stop mode to match render behavior
                    // PSF calculation should use same pupil sampling as render, not entrance pupil
                    try {
                        if (fieldSetting.type === 'Angle' || !fieldSetting.height) {
                            opdCalculator._setInfinitePupilMode(fieldSetting, 'stop');
                            if (PSF_DEBUG) console.log('🔑 [PSF Popup] Forced stop mode for infinite field');
                        }
                    } catch (e) {
                    }
                    
                    onProgress({ percent: 0, phase: 'opd', message: 'OPD...' });
                    const wavefrontGridSize = Number.isFinite(zernikeSampling)
                        ? Math.max(16, Math.floor(Number(zernikeSampling)))
                        : 128;
                    const wavefrontMap = await raceWithCancel(analyzer.generateWavefrontMap(fieldSetting, wavefrontGridSize, 'circular', {
                        // Match OPD display pipeline:
                        // - referenceSphere
                        // - no Zernike fit
                        // - piston+tilt removed (display)
                        recordRays: false,
                        progressEvery: 0,
                        renderFromZernike: false,
                        skipZernikeFit: true,
                        opdMode: 'referenceSphere',
                        opdDisplayMode,
                        diagnoseDiscontinuities: PSF_DEBUG,
                        diagTopK: 8,
                        cancelToken: activeCancelToken,
                        onProgress: (evt) => {
                            const p = Number(evt && evt.percent);
                            const msg = (evt && evt.message) || (evt && evt.phase) || 'OPD...';
                            const phase = (evt && evt.phase) ? evt.phase : 'opd';
                            if (Number.isFinite(p)) onProgress({ percent: Math.max(0, Math.min(80, p * 0.8)), phase, message: msg });
                            else onProgress({ percent: null, phase, message: msg });
                        }
                    }), activeCancelToken);
                    throwIfCancelled(activeCancelToken);

                    if (wavefrontMap && wavefrontMap.error) {
                        const err = new Error((wavefrontMap.error && wavefrontMap.error.message) ? wavefrontMap.error.message : 'Wavefront generation failed (popup).');
                        err.code = 'WAVEFRONT_UNAVAILABLE';
                        err.wavefrontError = wavefrontMap.error;
                        throw err;
                    }

                    if (PSF_DEBUG) {
                    }
                    
                    // CRITICAL: Use actual entrance pupil radius for spatial frequency scaling
                    // In entrance pupil mode, pupilPhysicalRadiusMm (stop radius) != actual entrance pupil radius
                    const actualPupilRadiusMm = (wavefrontMap.pupilSamplingMode === 'entrance' && 
                                                  Number.isFinite(wavefrontMap.entranceEffectiveRadiusMm))
                        ? wavefrontMap.entranceEffectiveRadiusMm
                        : wavefrontMap.pupilPhysicalRadiusMm;
                    

                    // Convert to PSF calculator format (gridData)
                    // Build OPD grid from the wavefront map samples (piston+tilt removed display OPD).
                    const gridSize = wavefrontGridSize;
                    const s = Math.max(2, Math.floor(Number(gridSize)));
                    const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
                    const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
                    const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));
                    const xCoords = new Float32Array(s);
                    const yCoords = new Float32Array(s);

                    const pupilRange = (Number.isFinite(Number(wavefrontMap?.pupilRange)) && Number(wavefrontMap.pupilRange) > 0)
                        ? Number(wavefrontMap.pupilRange)
                        : 1.0;
                    for (let i = 0; i < s; i++) {
                        const t = (i / (s - 1 || 1)) * 2 - 1;
                        xCoords[i] = t * pupilRange;
                        yCoords[i] = t * pupilRange;
                    }

                    const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
                    const opdMicrons = (wavefrontMap?.display && Array.isArray(wavefrontMap.display.opds))
                        ? wavefrontMap.display.opds
                        : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
                    const n = Math.min(coords.length, opdMicrons.length);
                    for (let k = 0; k < n; k++) {
                        const c = coords[k];
                        const ix = Number.isInteger(c?.ix) ? c.ix : null;
                        const iy = Number.isInteger(c?.iy) ? c.iy : null;
                        if (ix === null || iy === null) continue;
                        if (ix < 0 || ix >= s || iy < 0 || iy >= s) continue;
                        const vMicrons = Number(opdMicrons[k]);
                        if (!Number.isFinite(vMicrons)) continue;
                        maskGrid[iy][ix] = true;
                        opdGrid[iy][ix] = vMicrons;
                        ampGrid[iy][ix] = 1.0;
                    }

                    const opdData = {
                        gridSize: s,
                        wavelength: wavelength,
                        gridData: {
                            opd: opdGrid,
                            amplitude: ampGrid,
                            pupilMask: maskGrid,
                            xCoords,
                            yCoords
                        }
                    };
                    
                    if (PSF_DEBUG) try {
                        let valid = 0;
                        let sum = 0;
                        let sum2 = 0;
                        let min = Infinity;
                        let max = -Infinity;
                        for (let iy = 0; iy < s; iy++) {
                            for (let ix = 0; ix < s; ix++) {
                                if (!maskGrid[iy][ix]) continue;
                                const v = Number(opdGrid[iy][ix]);
                                if (!Number.isFinite(v)) continue;
                                valid++;
                                sum += v;
                                sum2 += v * v;
                                if (v < min) min = v;
                                if (v > max) max = v;
                            }
                        }
                        const mean = valid ? (sum / valid) : NaN;
                        const rms = valid ? Math.sqrt(Math.max(0, sum2 / valid - mean * mean)) : NaN;
                        const ptp = (Number.isFinite(min) && Number.isFinite(max)) ? (max - min) : NaN;
                        const rmsW = (Number.isFinite(rms) && Number.isFinite(wavelength) && wavelength > 0) ? (rms / wavelength) : NaN;
                        const ptpW = (Number.isFinite(ptp) && Number.isFinite(wavelength) && wavelength > 0) ? (ptp / wavelength) : NaN;
                        const line = '📌 [PSF popup] OPD grid stats: valid=' + valid + '/' + (s * s) +
                            ' (' + (100 * valid / (s * s)).toFixed(1) + '%)' +
                            ' rms=' + (Number.isFinite(rms) ? rms.toExponential(3) : String(rms)) + 'µm' +
                            ' (' + (Number.isFinite(rmsW) ? rmsW.toExponential(3) : String(rmsW)) + 'λ)' +
                            ' ptp=' + (Number.isFinite(ptp) ? ptp.toExponential(3) : String(ptp)) + 'µm' +
                            ' (' + (Number.isFinite(ptpW) ? ptpW.toExponential(3) : String(ptpW)) + 'λ)';
                        console.log(line);
                        try {
                            if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                window.opener.console.log(line);
                            }
                        } catch (_) {}
                        if (wavefrontMap?.pupilMaskStats) {
                            console.log('📌 [PSF popup] pupilMaskStats:', wavefrontMap.pupilMaskStats);
                        }

                        try {
                            const mode = wavefrontMap && wavefrontMap.pupilSamplingMode;
                            const bestEffort = !!(wavefrontMap && wavefrontMap.bestEffortVignettedPupil);
                            if (mode) {
                                const msg = '📌 [PSF popup] pupilSamplingMode=' + String(mode) + (bestEffort ? ' (bestEffortVignettedPupil=true)' : '');
                                console.log(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(msg);
                                    }
                                } catch (_) {}
                            }

                            const reasons = (wavefrontMap && wavefrontMap.invalidReasonCounts) ? wavefrontMap.invalidReasonCounts : null;
                            const top = reasons
                                ? Object.entries(reasons).sort((a, b) => ((b && b[1]) || 0) - ((a && a[1]) || 0)).slice(0, 8)
                                : [];
                            if (top.length) {
                                const msg = '📌 [PSF popup] invalid reasons top: ' + top.map((kv) => String(kv && kv[0]) + ':' + String(kv && kv[1])).join(', ');
                                console.log(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(msg);
                                    }
                                } catch (_) {}
                            }
                        } catch (_) {}
                    } catch (_) {}

                    let pupilDiameterMm = actualPupilRadiusMm * 2;  // Use actual entrance pupil diameter
                    let focalLengthMm = 100.0;
                    let stopIndexForLog = -1;
                    
                    // Get stop diameter for PSF calculation
                    // CRITICAL: Always use stop diameter for Strehl ratio calculation
                    // Entrance pupil radius is only for understanding vignetting, not for defining diffraction limit
                    let stopDiameterMm = 24.0;  // Default
                    try {
                        const stopIndex = findStopSurfaceIndex(opticalSystemRows);
                        stopIndexForLog = stopIndex;
                        const stopRow = (stopIndex >= 0 && opticalSystemRows && opticalSystemRows.length > stopIndex) ? opticalSystemRows[stopIndex] : null;
                        const sdRaw =
                            (stopRow && stopRow.semidia !== undefined && stopRow.semidia !== null) ? stopRow.semidia :
                            (stopRow && stopRow.Semidia !== undefined && stopRow.Semidia !== null) ? stopRow.Semidia :
                            (stopRow && stopRow['Semi Diameter'] !== undefined && stopRow['Semi Diameter'] !== null) ? stopRow['Semi Diameter'] :
                            (stopRow && stopRow.aperture !== undefined && stopRow.aperture !== null) ? stopRow.aperture :
                            (stopRow && stopRow.Aperture !== undefined && stopRow.Aperture !== null) ? stopRow.Aperture :
                            NaN;
                        const sd = Math.abs(parseFloat(sdRaw));
                        if (Number.isFinite(sd) && sd > 0) {
                            const isApertureField = stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined);
                            const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
                            if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) stopDiameterMm = stopRadiusMm * 2;
                        }
                    } catch (_) {}
                    
                    // In entrance pupil mode, keep actualPupilRadiusMm for understanding
                    // but use stopDiameterMm for PSF calculation to maintain consistent diffraction limit
                    if (wavefrontMap.pupilSamplingMode === 'entrance') {
                        pupilDiameterMm = stopDiameterMm;
                    } else {
                        pupilDiameterMm = stopDiameterMm;  // Use stop diameter in stop mode too
                    }
                    
                    try {
                        const fl = calculateFocalLength(opticalSystemRows, wavelength);
                        if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) focalLengthMm = Math.abs(fl);
                    } catch (_) {}

                    logScaleInputs(pupilDiameterMm, focalLengthMm, stopIndexForLog);

                    if (!window.__popupPsfCalculator) window.__popupPsfCalculator = new PSFCalculator();
                    const psfCalculator = window.__popupPsfCalculator;
                    const psfSamplingSize = Number.isFinite(zernikeSampling) ? zernikeSampling : 128;
                    const zeroPadTo = (zeroPadRaw === 'none')
                        ? psfSamplingSize
                        : (zeroPadRaw === 'auto')
                            ? 0
                            : (Number.isFinite(parseInt(zeroPadRaw)) ? parseInt(zeroPadRaw) : 0);
                    const psfResult = await raceWithCancel(psfCalculator.calculatePSF(opdData, {
                        samplingSize: psfSamplingSize,
                        zeroPadTo,
                        pupilDiameter: pupilDiameterMm,
                        focalLength: focalLengthMm,
                        forceImplementation: forceWasm ? 'wasm' : null,
                        // Zernike render removes piston+tilt (Noll 1..3) by design.
                        // Still safe to leave removeTilt=true for robustness; but keep it off to preserve definition.
                        removeTilt: false,
                        onProgress: (evt) => {
                            const p = Number(evt && evt.percent);
                            const msg = (evt && evt.message) || (evt && evt.phase) || 'PSF...';
                            const phase = (evt && evt.phase) ? evt.phase : 'psf';
                            if (!Number.isFinite(p)) { onProgress({ percent: null, phase, message: msg }); return; }
                            onProgress({ percent: 80 + 0.2 * p, phase, message: msg });
                        }
                    }), activeCancelToken);
                    throwIfCancelled(activeCancelToken);

                    const plotter = new PSFPlotter(containerEl);
                    await plotter.plot2DPSF(psfResult, { logScale, title: 'Point Spread Function' });
                }

                setProgress(100, 'Done');
                resizePlot();
                hideProgress();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    const msg = String((err && err.message) || err || 'Unknown error');
                    const stack = String((err && err.stack) || '');
                    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => {
                        switch (ch) {
                            case '&': return '&amp;';
                            case '<': return '&lt;';
                            case '>': return '&gt;';
                            case '"': return '&quot;';
                            case "'": return '&#39;';
                            default: return ch;
                        }
                    });
                    const details = escapeHtml(msg + (stack ? '\\n\\n' + stack : ''));
                    containerEl.innerHTML =
                        '<div style="padding:20px;color:red;font-family:Arial;">' +
                            '<div style="font-weight:bold;margin-bottom:8px;">Failed to generate PSF</div>' +
                            '<pre style="white-space:pre-wrap;word-break:break-word;">' + details + '</pre>' +
                        '</div>';
                }
            } finally {
                try {
                    if (stopBtn) stopBtn.disabled = true;
                } catch (_) {}
            }
        };

        document.getElementById('popup-show-psf-btn').addEventListener('click', () => window.renderPSF());

        document.getElementById('popup-stop-psf-btn').addEventListener('click', () => {
            try {
                if (activeCancelToken && typeof activeCancelToken.abort === 'function') {
                    activeCancelToken.abort('Stopped by user');
                }
            } catch (_) {}
        });

        function syncAll() {
            syncObjectOptionsFromOpener();
            syncInputsFromOpener();
        }
        // Expose for opener-triggered refresh when reusing an existing popup window.
        window.syncAll = syncAll;
        window.syncObjectOptionsFromOpener = syncObjectOptionsFromOpener;
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncAll);
        syncAll();

        // Do not auto-render on open; user triggers calculation via "Show PSF".
        window.addEventListener('load', () => {
            try {
                const popupSampling = document.getElementById('popup-psf-sampling-select');
                const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
                const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
                if (popupSampling) popupSampling.value = '1024';
                if (popupZernikeSampling) popupZernikeSampling.value = '128';
                if (popupLog) popupLog.checked = false;
            } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Modulation Transfer Function (MTF) popup window button
        const openMtfWindowBtn = document.getElementById('open-mtf-window-btn');
        if (openMtfWindowBtn) {
                openMtfWindowBtn.addEventListener('click', () => {
                        if (window.__mtfPopup && !window.__mtfPopup.closed) {
                                try { window.__mtfPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Modulation Transfer Function', 'width=800,height=600');
                        window.__mtfPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Modulation Transfer Function</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 120px;
        }
        .controls input[type="checkbox"] {
            width: auto;
            padding: 0;
            border: none;
            background: transparent;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-mtf-container { flex: 1 1 auto; min-height: 0; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Modulation Transfer Function</div>
    <div class="controls">
        <label for="popup-mtf-wavelength-select">Wavelength:</label>
        <select id="popup-mtf-wavelength-select"></select>
        <label for="popup-mtf-object-select">Object:</label>
        <select id="popup-mtf-object-select"></select>
        <label for="popup-mtf-max-freq-input">Max (lp/mm):</label>
        <input id="popup-mtf-max-freq-input" type="number" min="0" step="1" value="100" />
        <label for="popup-mtf-sampling-select">Sampling:</label>
        <select id="popup-mtf-sampling-select">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-mtf-remove-ptd-checkbox" type="checkbox" />
            Remove P/T/D
        </label>
        <button id="popup-show-mtf-btn" type="button">Show MTF</button>
    </div>
    <div class="note">
        Note: MTF is computed from PSF via Fourier transform.
    </div>
    <div id="popup-mtf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-mtf-progress-text" style="margin-bottom: 6px;">Calculating MTF...</div>
        <progress id="popup-mtf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-mtf-container"></div>
    </div>

    <script>
        function safeCall(fn, fallback) {
            try { return fn(); } catch (_) { return fallback; }
        }

        function getOpener() {
            try { return window.opener || null; } catch (_) { return null; }
        }

        function getPrimaryWavelength() {
            const opener = getOpener();
            if (!opener) return null;
            if (typeof opener.getPrimaryWavelength !== 'function') return null;
            const v = Number(safeCall(() => opener.getPrimaryWavelength(), 0));
            return Number.isFinite(v) && v > 0 ? v : null;
        }

        function buildWavelengthOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getSourceRows = opener.getSourceRows;
            const sources = (typeof getSourceRows === 'function')
                ? safeCall(() => getSourceRows(opener.tableSource), [])
                : [];
            const primary = getPrimaryWavelength();
            const out = [{ value: 'all', label: 'All' }];
            if (Array.isArray(sources) && sources.length > 0) {
                for (let i = 0; i < sources.length; i++) {
                    const wl = Number(sources[i]?.wavelength);
                    if (!Number.isFinite(wl) || wl <= 0) continue;
                    const nm = wl * 1000;
                    const label = Number.isFinite(primary) && Math.abs(wl - primary) < 1e-9
                        ? (nm.toFixed(1) + ' nm (primary)')
                        : (nm.toFixed(1) + ' nm');
                    out.push({ value: String(wl), label });
                }
            }
            if (out.length === 1) {
                out.push({ value: String(primary || 0.5876), label: (((primary || 0.5876) * 1000).toFixed(1) + ' nm') });
            }
            return out;
        }

        function buildObjectOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getObjectRows = opener.getObjectRows;
            const objects = (typeof getObjectRows === 'function')
                ? safeCall(() => getObjectRows(opener.tableObject), [])
                : [];
            const out = [];
            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    out.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }
            if (out.length === 0) out.push({ value: '0', label: '0' });
            return out;
        }

        function populateSelect(selectEl, options) {
            if (!selectEl) return;
            const current = selectEl.value;
            selectEl.innerHTML = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                selectEl.appendChild(o);
            }
            if (current && Array.from(selectEl.options).some(o => o.value === current)) {
                selectEl.value = current;
            }
        }

        function syncAllOptions() {
            const wlSel = document.getElementById('popup-mtf-wavelength-select');
            const prevWl = wlSel ? wlSel.value : '';
            populateSelect(wlSel, buildWavelengthOptions());
            // Default to Primary (not All) on first open.
            if (wlSel && (!prevWl || !Array.from(wlSel.options).some(o => o.value === prevWl))) {
                const primary = getPrimaryWavelength();
                if (Number.isFinite(primary) && Array.from(wlSel.options).some(o => o.value === String(primary))) {
                    wlSel.value = String(primary);
                } else {
                    // Fallback to first numeric wavelength if present
                    const firstNumeric = Array.from(wlSel.options).find(o => o.value !== 'all');
                    if (firstNumeric) wlSel.value = firstNumeric.value;
                }
            }
            populateSelect(document.getElementById('popup-mtf-object-select'), buildObjectOptions());
        }

        window.renderMTF = async () => {
            const containerEl = document.getElementById('popup-mtf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-mtf-progress-wrapper');
            const progressEl = document.getElementById('popup-mtf-progress');
            const progressTextEl = document.getElementById('popup-mtf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const wlSel = document.getElementById('popup-mtf-wavelength-select');
            const objSel = document.getElementById('popup-mtf-object-select');
            const maxEl = document.getElementById('popup-mtf-max-freq-input');
            const samplingEl = document.getElementById('popup-mtf-sampling-select');
            const removePtdEl = document.getElementById('popup-mtf-remove-ptd-checkbox');

            const wlValue = wlSel ? String(wlSel.value) : '';
            const primary = getPrimaryWavelength();
            const wavelength = (wlValue === 'all') ? 'all' : Number(wlValue);
            const objectIndex = objSel ? parseInt(objSel.value, 10) : 0;
            const maxFreq = maxEl ? Number(maxEl.value) : 100;
            const sampling = samplingEl ? Number(samplingEl.value) : 256;
            const opdDisplayMode = (removePtdEl && removePtdEl.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';

            try {
                const opener = getOpener();
                if (!opener || typeof opener.showMTFDiagram !== 'function') {
                    throw new Error('showMTFDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                // Allow the popup to paint the progress UI before heavy computation begins.
                await new Promise(r => setTimeout(r, 0));
                await opener.showMTFDiagram({
                    wavelengthMicrons: (wavelength === 'all') ? 'all' : (Number.isFinite(wavelength) ? wavelength : (primary || 0.5876)),
                    objectIndex: Number.isFinite(objectIndex) ? objectIndex : 0,
                    maxFrequencyLpmm: Number.isFinite(maxFreq) ? maxFreq : 100,
                    samplingSize: Number.isFinite(sampling) ? sampling : 256,
                    opdDisplayMode,
                    onProgress: (evt) => {
                        try {
                            const p = Number(evt?.percent);
                            const msg = evt?.message || evt?.phase || 'Working...';
                            if (Number.isFinite(p)) setProgress(p, msg);
                            else setProgress(undefined, msg);
                        } catch (_) {}
                    },
                    containerElement: containerEl
                });
                setProgress(100, 'Done');
                hideProgress();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate MTF. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-mtf-btn').addEventListener('click', () => window.renderMTF());
        window.addEventListener('focus', syncAllOptions);
        window.addEventListener('load', () => syncAllOptions());
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Transverse Aberration popup window button
        const openTransverseAberrationWindowBtn = document.getElementById('open-transverse-aberration-window-btn');
        if (openTransverseAberrationWindowBtn) {
                openTransverseAberrationWindowBtn.addEventListener('click', () => {
                        if (window.__transverseAberrationPopup && !window.__transverseAberrationPopup.closed) {
                                try { window.__transverseAberrationPopup.focus(); } catch (_) {}
                    try {
                        if (typeof window.__transverseAberrationPopup.renderTransverseAberration === 'function') {
                            window.__transverseAberrationPopup.renderTransverseAberration();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Transverse Aberration', 'width=800,height=600');
                        window.__transverseAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Transverse Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 90px;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-transverse-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Transverse Aberration</div>
    <div class="controls">
        <label for="popup-transverse-ray-count-input">Ray number:</label>
        <input type="number" id="popup-transverse-ray-count-input" value="101" min="1" max="1001" step="1" />
        <span class="note-inline" style="font-size:12px;color:#666;">(Always normalized by stop diameter)</span>
        <button id="popup-show-transverse-aberration-btn" type="button">Show transverse aberration diagram</button>
    </div>
    <div id="popup-transverse-progress-wrapper" style="display:none;padding:10px 12px;border-bottom:1px solid #eee;background:#fff;">
        <div id="popup-transverse-progress-text" style="margin-bottom: 6px; font-size:12px; color:#555;">Starting...</div>
        <progress id="popup-transverse-progressbar" value="0" max="100" style="display:block;width:calc(100% + 24px);margin-left:-12px;height:14px;"></progress>
    </div>
    <div class="note">
        Note: X-axis is transverse aberration (μm), Y-axis is normalized pupil coordinate.
    </div>
    <div class="content">
        <div id="popup-transverse-aberration-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerRay = getOpenerEl('transverse-ray-count-input');
            const popupRay = document.getElementById('popup-transverse-ray-count-input');
            if (openerRay && popupRay) {
                popupRay.value = openerRay.value;
            }
        }

        window.renderTransverseAberration = async () => {
            const progressWrap = document.getElementById('popup-transverse-progress-wrapper');
            const progressBar = document.getElementById('popup-transverse-progressbar');
            const progressText = document.getElementById('popup-transverse-progress-text');
            const setProgress = (percent, message) => {
                try {
                    if (progressWrap) progressWrap.style.display = 'block';
                    if (progressBar && Number.isFinite(percent)) progressBar.value = Math.max(0, Math.min(100, percent));
                    if (progressText) progressText.textContent = message || '';
                } catch (_) {}
            };
            const onProgress = (evt) => {
                const p = Number(evt?.percent);
                const msg = (evt && (evt.message || evt.phase)) ? String(evt.message || evt.phase) : '';
                setProgress(Number.isFinite(p) ? p : 0, msg);
            };

            const popupRay = document.getElementById('popup-transverse-ray-count-input');
            const rayCount = popupRay ? parseInt(popupRay.value, 10) : 51;
            const openerRay = getOpenerEl('transverse-ray-count-input');
            if (openerRay && Number.isFinite(rayCount)) {
                openerRay.value = String(rayCount);
            }

            const containerEl = document.getElementById('popup-transverse-aberration-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                if (!window.opener || typeof window.opener.showTransverseAberrationDiagram !== 'function') {
                    throw new Error('showTransverseAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                await window.opener.showTransverseAberrationDiagram({
                    rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                    containerElement: containerEl,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (err) {
                console.error(err);
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate transverse aberration diagram. Check console.</div>';
                }
                setProgress(100, 'Failed');
            }
        };

        document.getElementById('popup-show-transverse-aberration-btn').addEventListener('click', () => {
            window.renderTransverseAberration();
        });

        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderTransverseAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Settings popup (environment settings)
        const openSettingsBtn = document.getElementById('open-settings-btn');
        if (openSettingsBtn) {
                openSettingsBtn.addEventListener('click', () => {
                        if (window.__settingsPopup && !window.__settingsPopup.closed) {
                                try { window.__settingsPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Settings', 'width=520,height=340');
                        window.__settingsPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Settings</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .content {
            padding: 12px;
            background: #fff;
            flex: 1 1 auto;
            overflow: auto;
        }
        .section-title { font-size: 13px; font-weight: 600; color: #333; margin: 0 0 8px 0; }
        .help { font-size: 12px; color: #666; margin: 0 0 10px 0; line-height: 1.35; }
        .radio-group { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px 0; }
        label { font-size: 13px; color: #333; }
        .footer {
            padding: 10px 12px;
            border-top: 1px solid #ddd;
            background: #f8f8f8;
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        button:hover { background: #e9e9e9; }
        code { font-family: Menlo, Consolas, monospace; font-size: 12px; }
    </style>
</head>
<body>
    <div class="header">Settings</div>
    <div class="content">
        <div class="section-title">Glass Map: Default Manufacturers</div>
        <div class="help">
            Choose which manufacturers are enabled by default when opening Glass Map.
            <br />If nothing is selected, Glass Map will show all manufacturers.
        </div>

        <div class="checkbox-group" style="display:flex;flex-direction:column;gap:8px;margin:8px 0 14px 0;">
            <label><input type="checkbox" class="glassmap-mfr-cb" value="SCHOTT" /> SCHOTT</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="HOYA" /> HOYA</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="HIKARI" /> HIKARI</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="OHARA" /> OHARA</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="Sumita" /> Sumita</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="CDGM" /> CDGM</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="Special" /> Special</label>
        </div>

        <div class="section-title">Dark Mode</div>
        <div class="help">
            Enable VS Code-style dark mode for the entire UI.
        </div>
        <label style="margin: 8px 0 14px 0; display: block;">
            <input type="checkbox" id="dark-mode-cb" /> Enable Dark Mode
        </label>

        <div class="section-title">Infinite Field: Pupil Sampling Mode</div>
        <div class="help">
            Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.
            <br />
            This sets <code>__COOPT_FORCE_INFINITE_PUPIL_MODE</code> to <code>stop</code> or <code>entrance</code>.
        </div>

        <div class="radio-group">
            <label><input type="radio" name="force-mode" value="" /> Auto (default)</label>
            <label><input type="radio" name="force-mode" value="stop" /> Force <code>stop</code></label>
            <label><input type="radio" name="force-mode" value="entrance" /> Force <code>entrance</code></label>
        </div>

        <div class="help" style="margin-top: 6px;">
            Note: Changes take effect on the next calculation.
        </div>
    </div>
    <div class="footer">
        <button id="close-btn" type="button">Close</button>
    </div>

    <script>
        const KEY = 'coopt.forceInfinitePupilMode';
        const GLASS_MAP_MFR_KEY = 'coopt.glassMap.defaultManufacturers';
        const DARK_MODE_KEY = 'coopt.darkMode';
        const sanitize = (v) => {
            const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
            return (s === 'stop' || s === 'entrance') ? s : '';
        };

        const sanitizeMfrList = (list) => {
            if (!Array.isArray(list)) return [];
            const allow = new Set(['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'SUMITA', 'CDGM', 'SPECIAL']);
            const out = [];
            for (const v of list) {
                const s = String(v ?? '').trim();
                if (!s) continue;
                const upper = s.toUpperCase();
                if (!allow.has(upper)) continue;
                // Preserve canonical casing used in the checkboxes.
                if (upper === 'SUMITA') out.push('Sumita');
                else if (upper === 'SPECIAL') out.push('Special');
                else out.push(upper);
            }
            // Deduplicate
            return Array.from(new Set(out));
        };

        function getOpener() {
            try { return window.opener || null; } catch (_) { return null; }
        }

        function getCurrent() {
            const o = getOpener();
            try {
                const fromOpener = o && typeof o.__cooptGetForceInfinitePupilMode === 'function'
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
            const radios = document.querySelectorAll('input[name="force-mode"]');
            radios.forEach(r => {
                r.checked = (sanitize(r.value) === cur);
                if (cur === '' && sanitize(r.value) === '') r.checked = true;
            });

            // Glass Map manufacturers
            let stored = [];
            try {
                stored = sanitizeMfrList(JSON.parse(localStorage.getItem(GLASS_MAP_MFR_KEY) || '[]'));
            } catch (_) {
                stored = [];
            }
            const storedSet = new Set(stored.map(s => String(s).toUpperCase()));
            document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
                const v = String(cb.value || '');
                cb.checked = storedSet.has(v.toUpperCase());
            });

            // Dark Mode
            const darkModeCb = document.getElementById('dark-mode-cb');
            if (darkModeCb) {
                let isDark = false;
                try {
                    isDark = localStorage.getItem(DARK_MODE_KEY) === 'true';
                } catch (_) {}
                darkModeCb.checked = isDark;
            }
        }

        function saveGlassMapMfrSelection() {
            const selected = [];
            document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
                if (cb.checked) selected.push(cb.value);
            });
            const sanitized = sanitizeMfrList(selected);
            try {
                if (sanitized.length) localStorage.setItem(GLASS_MAP_MFR_KEY, JSON.stringify(sanitized));
                else localStorage.removeItem(GLASS_MAP_MFR_KEY);
            } catch (_) {}
        }

        function applyDarkMode(enabled) {
            const o = getOpener();
            try {
                if (o && typeof o.__cooptSetDarkMode === 'function') {
                    o.__cooptSetDarkMode(enabled);
                }
            } catch (_) {}
            
            try {
                localStorage.setItem(DARK_MODE_KEY, enabled ? 'true' : 'false');
            } catch (_) {}
        }

        document.querySelectorAll('input[name="force-mode"]').forEach(r => {
            r.addEventListener('change', () => {
                if (r.checked) applyMode(r.value);
            });
        });

        document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                saveGlassMapMfrSelection();
            });
        });

        const darkModeCb = document.getElementById('dark-mode-cb');
        if (darkModeCb) {
            darkModeCb.addEventListener('change', () => {
                applyDarkMode(darkModeCb.checked);
            });
        }

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
                });
        }

        // Dark Mode initialization
        (() => {
                const DARK_MODE_KEY = 'coopt.darkMode';
                
                function applyDarkModeClass(enabled) {
                        if (enabled) {
                                document.body.classList.add('dark-mode');
                        } else {
                                document.body.classList.remove('dark-mode');
                        }
                }
                
                function loadDarkMode() {
                        try {
                                const stored = localStorage.getItem(DARK_MODE_KEY);
                                return stored === 'true';
                        } catch (_) {
                                return false;
                        }
                }
                
                // Expose to Settings popup
                window.__cooptSetDarkMode = (enabled) => {
                        applyDarkModeClass(enabled);
                };
                
                // Apply on load
                applyDarkModeClass(loadDarkMode());
        })();
}

// ============================================================================
// COORDINATE TRANSFORMATION UI CONTROLS
// ============================================================================

/**
 * Setup coordinate transformation controls (surface select, show/cancel/save buttons)
 */
