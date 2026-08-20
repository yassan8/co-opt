export default function DesignIntentSection({ hideTable }: { hideTable?: boolean } = {}) {
  return (
    <section
      className="optical-system-section ide-section-card"
      id="design-intent-container"
      aria-label="Design Intent"
    >
      <div id="design-intent-toolbar" className="optical-system-buttons-container ide-toolbar" role="toolbar" aria-label="Design Intent controls">
        <div className="di-add-control">
          <label htmlFor="design-intent-add-block-type">Add block</label>
          <select id="design-intent-add-block-type" aria-label="Block type">
            <optgroup label="Planes">
              <option value="ObjectPlane">Object Surface</option>
              <option value="ImagePlane">Image Surface</option>
            </optgroup>
            <optgroup label="Optical elements">
              <option value="SingleSurface">Single Surface</option>
              <option value="Lens">Lens</option>
              <option value="Paraxial">Paraxial</option>
              <option value="Doublet">Doublet</option>
              <option value="Triplet">Triplet</option>
              <option value="Mirror">Mirror</option>
            </optgroup>
            <optgroup label="Spacing and coordinates">
              <option value="Gap">Gap</option>
              <option value="Stop">Stop</option>
              <option value="CoordTrans">Coordinate Transform</option>
            </optgroup>
          </select>
          <button id="design-intent-add-block-btn" className="di-primary-button" type="button">Add</button>
        </div>

        <button id="design-intent-delete-block-btn" className="di-delete-button" type="button" title="Delete the selected block">
          Delete
        </button>

        <button id="design-intent-auto-set-apertures-btn" type="button" title="Calculate apertures for the current field conditions">
          Auto apertures
        </button>

        <details className="di-more-actions">
          <summary>More</summary>
          <div className="di-more-actions__menu" role="group" aria-label="Bulk parameter actions">
            <div className="di-more-actions__title">Bulk parameter mode</div>
            <button id="design-intent-param-all-on-btn" type="button">Enable all</button>
            <button id="design-intent-param-all-off-btn" type="button">Disable all</button>
          </div>
        </details>
      </div>

      <div
        id="import-analyze-mode-banner"
        className="merit-function-help"
        style={{ display: "none" }}
      >
        <strong>Import / Analyze Mode</strong>
        <br />
        Imported optical systems are analyzed as surfaces.
        <br />
        （読み込み済み光学系は Surface として解析されます）
        <br />
        Design Intent (Blocks) is partial or unavailable.
        <br />
        （Design Intent（Blocks）は部分的、または利用できません）
        <br />
        <br />
        This optical system contains elements that cannot be represented as design blocks (e.g. cemented lenses).
        <br />
        （Blocks に表現できない要素を含みます：例：セメント接合レンズ）
        <br />
        <br />
        You can analyze and edit surfaces, but the design intent is not fully available.
        <br />
        （Surface の解析・編集は可能ですが、設計意図は完全には利用できません）
      </div>

      {!hideTable && (
        <div className="block-inspector-panel">
          <div id="block-inspector" className="block-inspector" role="listbox" aria-label="Design blocks"></div>
        </div>
      )}

      {!hideTable && <div id="table-optical-system" className="di-derived-surface-host" aria-hidden="true"></div>}
    </section>
  );
}
