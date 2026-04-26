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
              <div
                id="design-intent-zoom-law-error"
                style={{ display: 'none', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #fecaca', background: '#fff1f2', color: '#991b1b', fontSize: 12, lineHeight: 1.4 }}
              />
              <div className="design-intent-zoom-actions">
                <div className="design-intent-zoom-hint">
                  camComp(B, phiB, phiC, zObj, zImg, zB0, zC0, zCseed) returns the C-group offset.
                  If phiB or phiC are not defined explicitly, they are auto-derived from the current zoom groups by paraxial power.
                  Example: const zObj=-120, const zImg=189.438757, const zB0=20, const zC0=52, const zCseed=52, B=0:0,1:43.36, C=camComp(B, phiB, phiC, zObj, zImg, zB0, zC0, zCseed).
                  Meaning: B=current B offset, phiB/phiC=group power, zObj=object plane Z, zImg=image plane Z, zB0/zC0=group reference Z at B=0 and C=0, zCseed=preferred starting root near the expected C position.
                </div>
                <button id="design-intent-zoom-apply-laws" type="button">Apply Laws</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}