// Glass map (Abbe diagram) popup window using Plotly.
// ES module entry point.

import { getAllGlassDatabases } from './glass.js';

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function buildGlassPoints() {
  const dbs = getAllGlassDatabases();
  /** @type {Array<{name:string, manufacturer:string, nd:number, vd:number, price:number|null}>} */
  const points = [];

  for (const db of dbs) {
    if (!Array.isArray(db)) continue;
    for (const g of db) {
      if (!g || typeof g !== 'object') continue;
      const nd = g.nd;
      const vd = g.vd;
      if (!isFiniteNumber(nd) || !isFiniteNumber(vd)) continue;
      if (vd <= 0 || nd <= 0) continue;

      points.push({
        name: String(g.name ?? ''),
        manufacturer: (String(g.manufacturer ?? 'Unknown').trim() || 'Unknown'),
        nd,
        vd,
        price: isFiniteNumber(g.price) ? Number(g.price) : null,
      });
    }
  }

  return points;
}

function findPlotlyScriptSrc() {
  const script = document.querySelector('script[src*="plotly" i]');
  return script && script.src ? script.src : null;
}

/**
 * Open a popup window containing an Abbe diagram (Vd vs nd) for all glasses.
 *
 * @param {(region: { ndMin:number, ndMax:number, vdMin:number, vdMax:number }) => void} onRegionSelected
 * @param {(glass: { name:string, manufacturer:string, price:(number|null) }) => (boolean|void)} [onGlassSelected]
 * @returns {Window|null}
 */
export function openGlassMapWindow(onRegionSelected, onGlassSelected) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('openGlassMapWindow must be called in a browser');
  }
  if (typeof onRegionSelected !== 'function') {
    throw new TypeError('openGlassMapWindow(onRegionSelected): onRegionSelected must be a function');
  }
  if (typeof onGlassSelected !== 'undefined' && typeof onGlassSelected !== 'function') {
    throw new TypeError('openGlassMapWindow(onRegionSelected, onGlassSelected): onGlassSelected must be a function');
  }

  const points = buildGlassPoints();
  const plotlySrc = findPlotlyScriptSrc();

  const w = window.open('', 'coopt_glass_map', 'popup=yes,width=800,height=600');
  if (!w) {
    alert('Popup was blocked. Please allow popups for this site and try again.');
    return null;
  }

  w.__COOPT_GLASS_POINTS__ = points;
  w.__COOPT_ON_REGION_SELECTED__ = onRegionSelected;
  w.__COOPT_ON_GLASS_SELECTED__ = typeof onGlassSelected === 'function' ? onGlassSelected : null;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Glass Map</title>
  <style>
    html, body { height: 100%; margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .wrap { height: 100%; display: flex; flex-direction: column; }
    .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(0,0,0,0.1); }
    .toolbar button { padding: 6px 10px; }
    .hint { color: rgba(0,0,0,0.7); font-size: 12px; }
    .header { padding: 10px 10px 0; }
    .title { font-size: 22px; font-weight: 600; color: rgba(0,0,0,0.85); margin: 0 0 6px; }
    .note { font-size: 12px; color: #666; margin: 0 0 10px; padding: 8px 12px; background-color: #f9f9f9; border-left: 3px solid #007acc; border-radius: 3px; }
    #plot { flex: 1; min-height: 0; }
  </style>
  ${plotlySrc ? `<script src="${plotlySrc}"></script>` : ''}
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <button id="apply" disabled>Apply Region</button>
      <span class="hint">Drag a box to select a region (Box Select is active by default).</span>
    </div>
    <div class="header">
      <div class="title">Glass Map</div>
      <div class="note"><strong>Note:</strong> Set default manufacturers in Settings.<br>Price indices differ by manufacturer (e.g., HOYA uses a vendor-specific index).</div>
    </div>
    <div id="plot"></div>
  </div>

  <script>
    (function() {
      const points = window.__COOPT_GLASS_POINTS__ || [];
      const applyBtn = document.getElementById('apply');

      let lastRegion = null;

      function ensurePlotlyReady() {
        if (window.Plotly) return Promise.resolve(window.Plotly);
        try {
          if (window.opener && window.opener.Plotly) {
            window.Plotly = window.opener.Plotly;
            return Promise.resolve(window.Plotly);
          }
        } catch (e) {}
        return new Promise((resolve, reject) => {
          const start = Date.now();
          const timer = setInterval(() => {
            if (window.Plotly) {
              clearInterval(timer);
              resolve(window.Plotly);
              return;
            }
            if (Date.now() - start > 8000) {
              clearInterval(timer);
              reject(new Error('Plotly failed to load in popup window'));
            }
          }, 50);
        });
      }

      function splitByPrice(points) {
        const priced = [];
        const missing = [];
        for (const p of points) {
          if (Number.isFinite(p.price)) priced.push(p);
          else missing.push(p);
        }
        return { priced, missing };
      }

      function makeHover(p) {
        const priceStr = Number.isFinite(p.price) ? p.price.toFixed(4) : 'null';
        return (
          String(p.manufacturer) + ' ' + String(p.name) +
          '<br>n<sub>d</sub>=' + Number(p.nd).toFixed(5) +
          '<br>V<sub>d</sub>=' + Number(p.vd).toFixed(2) +
          '<br>price=' + priceStr
        );
      }

      function groupByManufacturer(points) {
        /** @type {Map<string, any[]>} */
        const m = new Map();
        for (const p of points) {
          const key = (String(p?.manufacturer ?? 'Unknown').trim() || 'Unknown');
          const arr = m.get(key);
          if (arr) arr.push(p);
          else m.set(key, [p]);
        }
        return m;
      }

      function getDefaultManufacturerSelectionUpper() {
        // Settings key written by the main app Settings popup.
        const KEY = 'coopt.glassMap.defaultManufacturers';
        try {
          const raw = localStorage.getItem(KEY);
          if (!raw) return new Set();
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return new Set();
          const s = new Set();
          for (const v of parsed) {
            const name = String(v ?? '').trim();
            if (!name) continue;
            s.add(name.toUpperCase());
          }
          return s;
        } catch (_) {
          return new Set();
        }
      }

      function renderPlot(Plotly) {
        const { priced, missing } = splitByPrice(points);

        const pricedX = priced.map(p => p.vd);
        const pricedY = priced.map(p => p.nd);
        const pricedC = priced.map(p => p.price);
        const pricedText = priced.map(makeHover);

        const missingX = missing.map(p => p.vd);
        const missingY = missing.map(p => p.nd);
        const missingText = missing.map(makeHover);

        const pricedMin = pricedC.length ? Math.min.apply(null, pricedC) : 0;
        const pricedMax = pricedC.length ? Math.max.apply(null, pricedC) : 1;

        // Match PSF Intensity colorscale (low->high: blue->green->red).
        const PRICE_COLORSCALE = [
          [0.0, 'rgb(0, 0, 255)'],
          [0.5, 'rgb(0, 255, 0)'],
          [1.0, 'rgb(255, 0, 0)']
        ];

        const traces = [];

        // Always show the price colorbar, independent of manufacturer toggles.
        // Keep the marker fully transparent and outside fixed axis ranges.
        traces.push({
          type: 'scatter',
          mode: 'markers',
          name: 'price',
          showlegend: false,
          x: [0, 0],
          y: [0, 0],
          hoverinfo: 'skip',
          marker: {
            size: 1,
            opacity: 0,
            color: [pricedMin, pricedMax],
            cmin: pricedMin,
            cmax: pricedMax,
            colorscale: PRICE_COLORSCALE,
            showscale: true,
            colorbar: { title: 'price' },
            line: { width: 0 }
          }
        });

        // Per-manufacturer traces so legend can toggle vendors (useful when nd/vd overlap).
        const byMfr = groupByManufacturer(points);
        const manufacturers = Array.from(byMfr.keys()).sort((a, b) => a.localeCompare(b));

        const defaultSelectedUpper = getDefaultManufacturerSelectionUpper();
        const hasDefaultSelection = defaultSelectedUpper && defaultSelectedUpper.size > 0;

        for (const mfr of manufacturers) {
          const arr = byMfr.get(mfr) || [];
          const pricedLocal = arr.filter(p => Number.isFinite(p.price));
          const missingLocal = arr.filter(p => !Number.isFinite(p.price));

          const mfrUpper = String(mfr).toUpperCase();
          const isSelected = !hasDefaultSelection || defaultSelectedUpper.has(mfrUpper);
          const initialVisible = isSelected ? true : 'legendonly';

          // Legend entry: always black marker; when toggled off, Plotly greys it.
          traces.push({
            type: 'scatter',
            mode: 'markers',
            name: mfr,
            legendgroup: mfr,
            showlegend: true,
            visible: initialVisible,
            // Plotly may hide legend items for traces with zero points.
            // Keep a single dummy point outside the fixed axis ranges.
            x: [0],
            y: [0],
            hoverinfo: 'skip',
            marker: { size: 8, color: 'rgb(0,0,0)' }
          });

          if (pricedLocal.length > 0) {
            traces.push({
              type: 'scattergl',
              mode: 'markers',
              name: mfr,
              legendgroup: mfr,
              showlegend: false,
              visible: initialVisible,
              x: pricedLocal.map(p => p.vd),
              y: pricedLocal.map(p => p.nd),
              customdata: pricedLocal.map(p => [p.name, p.manufacturer, Number.isFinite(p.price) ? p.price : null]),
              text: pricedLocal.map(makeHover),
              hoverinfo: 'text',
              marker: {
                size: 7,
                opacity: 0.9,
                color: pricedLocal.map(p => p.price),
                cmin: pricedMin,
                cmax: pricedMax,
                colorscale: PRICE_COLORSCALE,
                showscale: false,
                line: { width: 0 }
              }
            });
          }

          if (missingLocal.length > 0) {
            traces.push({
              type: 'scattergl',
              mode: 'markers',
              name: mfr,
              legendgroup: mfr,
              showlegend: false,
              visible: initialVisible,
              x: missingLocal.map(p => p.vd),
              y: missingLocal.map(p => p.nd),
              customdata: missingLocal.map(p => [p.name, p.manufacturer, null]),
              text: missingLocal.map(makeHover),
              hoverinfo: 'text',
              marker: {
                size: 7,
                opacity: 0.75,
                color: 'rgba(160,160,160,0.9)',
                line: { width: 0 }
              }
            });
          }
        }

        const layout = {
          margin: { l: 60, r: 30, t: 70, b: 55 },
          dragmode: 'select',
          xaxis: {
            title: { text: 'V<sub>d</sub>' },
            range: [95, 15],
            zeroline: false,
            showgrid: true
          },
          yaxis: {
            title: { text: 'n<sub>d</sub>' },
            range: [1.3, 2.2],
            zeroline: false,
            showgrid: true
          },
          legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', groupclick: 'togglegroup' }
        };

        const config = {
          displayModeBar: true,
          responsive: true
        };

        const plotEl = document.getElementById('plot');

        Plotly.newPlot(plotEl, traces, layout, config);

        // Attach event handlers only when Plotly has augmented the div.
        if (plotEl && typeof plotEl.on === 'function') {
          // Double-click on a point: propose replacing current material in the opener.
          // Plotly's built-in plotly_doubleclick event doesn't provide point info reliably,
          // so we detect a double-click via two plotly_click events close in time.
          let lastClickAt = 0;
          let lastClickKey = '';
          plotEl.on('plotly_click', function(ev) {
            try {
              const pt = ev && ev.points && ev.points[0] ? ev.points[0] : null;
              const cd = pt && pt.customdata ? pt.customdata : null;
              if (!cd || cd.length < 2) return;

              const name = String(cd[0] ?? '').trim();
              const manufacturer = String(cd[1] ?? 'Unknown').trim() || 'Unknown';
              const price = Number.isFinite(cd[2]) ? Number(cd[2]) : null;
              if (!name) return;

              const now = Date.now();
              const key = manufacturer + '\\n' + name;
              const isDouble = (now - lastClickAt) < 350 && key === lastClickKey;
              lastClickAt = now;
              lastClickKey = key;
              if (!isDouble) return;

              if (typeof window.__COOPT_ON_GLASS_SELECTED__ === 'function') {
                const shouldClose = window.__COOPT_ON_GLASS_SELECTED__({ name, manufacturer, price });
                if (shouldClose !== false) window.close();
              }
            } catch (_) {
              // ignore
            }
          });

          plotEl.on('plotly_selected', function(ev) {
          lastRegion = null;
          applyBtn.disabled = true;
          if (!ev || !ev.range || !ev.range.x || !ev.range.y) return;

          const x0 = ev.range.x[0];
          const x1 = ev.range.x[1];
          const y0 = ev.range.y[0];
          const y1 = ev.range.y[1];

          const vdMin = Math.min(x0, x1);
          const vdMax = Math.max(x0, x1);
          const ndMin = Math.min(y0, y1);
          const ndMax = Math.max(y0, y1);

          if (![vdMin, vdMax, ndMin, ndMax].every(Number.isFinite)) return;

          lastRegion = { ndMin, ndMax, vdMin, vdMax };
          applyBtn.disabled = false;

          // Clear selection visuals (box/selected points) while keeping lastRegion.
          try {
            if (window.Plotly && plotEl) {
              window.Plotly.restyle(plotEl, { selectedpoints: [null] });
            }
          } catch (_) {}
          });
        }

        applyBtn.addEventListener('click', function() {
          if (!lastRegion) return;
          try {
            if (typeof window.__COOPT_ON_REGION_SELECTED__ === 'function') {
              window.__COOPT_ON_REGION_SELECTED__(lastRegion);
            }
          } finally {
            window.close();
          }
        });
      }

      ensurePlotlyReady()
        .then(renderPlot)
        .catch((err) => {
          console.error(err);
          document.getElementById('plot').innerHTML = '<div style="padding:12px">Failed to load Plotly.</div>';
        });
    })();
  </script>
</body>
</html>`;

  try {
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (err) {
    console.error('Failed to initialize popup window', err);
    try { w.close(); } catch (_) {}
    alert('Failed to initialize popup window.');
    return null;
  }

  return w;
}
