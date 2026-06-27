export default function DesignIntentSection() {
  return (
    <section className="optical-system-section ide-section-card" id="design-intent-container" aria-label="Design Intent">
      <h2 className="section-title">Design Intent</h2>
      <div id="design-intent-toolbar" className="optical-system-buttons-container ide-toolbar" role="toolbar" aria-label="Design Intent controls">
        <select id="design-intent-add-block-type" aria-label="Block type">
          <option value="ObjectPlane">ObjectSurface</option>
          <option value="SingleSurface">SingleSurface</option>
          <option value="Lens">Lens</option>
          <option value="Paraxial">Paraxial</option>
          <option value="Doublet">Doublet</option>
          <option value="Triplet">Triplet</option>
          <option value="CoordTrans">CoordTrans</option>
          <option value="Gap">Gap</option>
          <option value="Stop">Stop</option>
          <option value="Mirror">Mirror</option>
          <option value="ImagePlane">ImageSurface</option>
        </select>
        <button id="design-intent-add-block-btn" type="button">Add Block</button>
        <button id="design-intent-delete-block-btn" type="button">Delete Block</button>
        <button id="design-intent-generate-zoom-scenarios-btn" type="button">Generate W/M/T</button>
        <button id="design-intent-param-all-on-btn" type="button">Parameter All ON</button>
        <button id="design-intent-param-all-off-btn" type="button">Parameter All OFF</button>
        <button id="design-intent-auto-set-apertures-btn" type="button">Auto-set apertures</button>
        <label className="design-intent-toolbar-toggle" htmlFor="design-intent-quick-editor-toggle">
          <input id="design-intent-quick-editor-toggle" type="checkbox" aria-label="Quick editor" />
          <span>Quick editor</span>
        </label>
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

      <div id="design-intent-blocks-panel" className="block-inspector-panel" aria-label="Block Inspector">
        <div id="block-inspector" className="block-inspector" role="listbox" aria-label="Design blocks"></div>
      </div>

      <div id="apply-reason-section" className="apply-reason-section" style={{ display: "none" }}>
        <div className="apply-reason-title">適用理由（参照用 / 読み取り専用）</div>
        <div className="apply-reason-help">
          セルを選択または編集すると、対象 Block（_blockId）に対する最新の評価要約（LCA/TCA 寄与）が表示されます。
          ※評価は「Aberration Coefficients」実行時に更新されます。
        </div>
        <textarea
          id="apply-reason-text"
          rows={6}
          cols={100}
          readOnly
          placeholder="ここに適用理由（評価要約）が表示されます…"
        ></textarea>
      </div>

      <div id="table-optical-system" className="ide-table-container"></div>
    </section>
  );
}
