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
            <div className="design-intent-zoom-value-row">
              <div id="design-intent-zoom-value" className="design-intent-zoom-value">0.00</div>
              <div className="design-intent-zoom-hint">Zoom x drives the active zoom laws and immediately redraws Render.</div>
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
              <label htmlFor="design-intent-zoom-laws" className="design-intent-zoom-label">Law Definitions</label>
              <textarea id="design-intent-zoom-laws" className="design-intent-zoom-textarea" spellCheck={false}></textarea>
              <div className="design-intent-zoom-actions">
                <div className="design-intent-zoom-hint">Example: A=0:43.36, B=0.01*A*A+2*A+3 or A=0:0,0.5:12,1:43.36</div>
                <button id="design-intent-zoom-apply-laws" type="button">Apply Laws</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}