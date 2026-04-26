export default function ZoomSection() {
  return (
    <section className="ide-section-card" id="zoom-container" aria-label="Zoom">
      <h2 className="section-title">Zoom</h2>

      <div className="design-intent-zoom-panel" aria-label="Zoom Control">
        <div className="design-intent-zoom-card">
          <div className="design-intent-zoom-header">
            <div>
              <div className="design-intent-zoom-title">Zoom Controller</div>
              <div id="design-intent-zoom-config-name" className="design-intent-zoom-meta">Active config</div>
            </div>
            <button id="design-intent-zoom-refresh" type="button">Refresh</button>
          </div>

          <div id="design-intent-zoom-empty" className="design-intent-zoom-empty">
            No zoom controller on the active configuration.
          </div>

          <div id="design-intent-zoom-body">
            <div className="design-intent-zoom-guide" aria-label="Zoom usage guide">
              <div className="design-intent-zoom-guide-title">Quick Start</div>
              <div className="design-intent-zoom-guide-step">
                <strong>1. Define the zoom law.</strong> Put the main zoom-group motion in Law Definitions. Use direct tables like `B=0:0,1:43.36` or solve the compensator with `camComp(...)`. `camComp(...)` returns a C-group offset, so the rendered C start position still comes from `zC0`.
              </div>
              <div className="design-intent-zoom-guide-step">
                <strong>2. Add optical compensation motion.</strong> In Optical Compensation Links, list the groups you want to move linearly with the slider as `Group=scale`, then set the physical stroke in mm.
              </div>
              <div className="design-intent-zoom-guide-step">
                <strong>3. Drag the slider and inspect Focus Drift.</strong> The chart shows image-plane drift versus zoom position. Zero crossings mean the focus shift passes through 0 mm; collision warnings mean some gap went negative.
              </div>
            </div>

            <div className="design-intent-zoom-value-row">
              <div id="design-intent-zoom-value" className="design-intent-zoom-value">0.00</div>
              <div className="design-intent-zoom-hint">`Zoom x` is the normalized zoom position. Moving it applies the current zoom laws and the linked compensation stroke immediately.</div>
            </div>
            <input id="design-intent-zoom-slider" type="range" min="0" max="1" step="0.001" defaultValue="0" />

            <div className="design-intent-zoom-chip-section">
              <div className="design-intent-zoom-label">Zoom Groups</div>
              <div id="design-intent-zoom-group-chips" className="design-intent-zoom-chips"></div>
            </div>

            <div className="design-intent-zoom-chip-section">
              <div className="design-intent-zoom-label">Zoom Laws</div>
              <div id="design-intent-zoom-law-chips" className="design-intent-zoom-chips"></div>
            </div>

            <div className="design-intent-zoom-chip-section">
              <label htmlFor="design-intent-zoom-laws" className="design-intent-zoom-label">Step 1. Zoom Laws</label>
              <div className="design-intent-zoom-hint design-intent-zoom-hint-block">
                Use this field for the zoom path itself. Each line defines one group offset. Example: `B=0:0,1:43.36` moves group B from 0 mm to 43.36 mm as the slider goes from 0 to 1. If you use `camComp(...)`, remember that it returns `ΔzC`; the absolute baseline for C is still `zC0`.
              </div>
              <textarea id="design-intent-zoom-laws" className="design-intent-zoom-textarea" spellCheck={false} placeholder="B=0:0,1:43.36&#10;const zCbase=zC0&#10;C=camComp(B, phiB, phiC, zObj, zImg, zB0, zCbase, zCbase)"></textarea>
              <div
                id="design-intent-zoom-law-error"
                style={{ display: 'none', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #fecaca', background: '#fff1f2', color: '#991b1b', fontSize: 12, lineHeight: 1.4 }}
              />
              <div className="design-intent-zoom-actions">
                <div className="design-intent-zoom-hint">
                  `camComp(B, phiB, phiC, zObj, zImg, zB0, zC0, [zCseed])` solves the compensator-group offset that restores focus and auto-switches between finite and infinite object modes using the current ObjectSurface settings. The important part is that it returns `ΔzC`, not the absolute C-group position. The rendered C baseline comes from `zC0`, so changing `zObj` changes the imaging condition but does not directly move the C start position on screen. `zImg`, `zB0`, and `zC0` are auto-derived from the current baseline layout when you reference those names directly. `zCseed` is optional and only biases which quadratic root is chosen; if omitted, `zC0` is used.
                </div>
                <button id="design-intent-zoom-apply-laws" type="button">Apply Laws</button>
              </div>
            </div>

            <div className="design-intent-zoom-chip-section">
              <label htmlFor="design-intent-zoom-linked-groups" className="design-intent-zoom-label">Step 2. Optical Compensation Links</label>
              <div className="design-intent-zoom-hint design-intent-zoom-hint-block">
                Use this field when you want several groups to share one physical compensation stroke. This is separate from the zoom law table above and is applied as a linear Δz term.
              </div>
              <textarea id="design-intent-zoom-linked-groups" className="design-intent-zoom-textarea design-intent-zoom-textarea-compact" spellCheck={false} placeholder="B=1&#10;C=1&#10;D=-0.5"></textarea>
              <div className="design-intent-zoom-grid">
                <label className="design-intent-zoom-field">
                  <span className="design-intent-zoom-label">Compensation Stroke [mm]</span>
                  <input id="design-intent-zoom-comp-stroke" type="number" step="0.01" />
                </label>
                <label className="design-intent-zoom-field">
                  <span className="design-intent-zoom-label">Chart Samples</span>
                  <input id="design-intent-zoom-comp-samples" type="number" min="5" max="201" step="1" />
                </label>
              </div>
              <div className="design-intent-zoom-actions">
                <div className="design-intent-zoom-hint">
                  Each line is `Group=scale`. `1` means move with the full stroke, `-1` means move in the opposite direction, `0.5` means half stroke.
                </div>
                <button id="design-intent-zoom-apply-comp" type="button">Apply Links</button>
              </div>
            </div>

            <div className="design-intent-zoom-chip-section">
              <div className="design-intent-zoom-label">Step 3. Focus Drift Check</div>
              <div className="design-intent-zoom-hint design-intent-zoom-hint-block">
                Use this chart to judge whether the compensation motion is working. Smaller span is better; a zero crossing means the system comes back into focus somewhere along the zoom stroke.
              </div>
              <div id="design-intent-zoom-comp-summary" className="design-intent-zoom-summary"></div>
              <div id="design-intent-zoom-comp-alert" className="design-intent-zoom-alert" style={{ display: 'none' }}></div>
              <div id="design-intent-zoom-comp-chart" className="design-intent-zoom-chart" aria-label="Zoom position versus focus shift chart"></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}