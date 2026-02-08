export default function DesignIntentSection() {
  return (
    <div className="optical-system-section">
      <h2>Design Intent</h2>
      <div id="design-intent-toolbar" className="optical-system-buttons-container">
        <select id="design-intent-add-block-type">
          <option value="ObjectPlane">ObjectSurface</option>
          <option value="SingleSurface">SingleSurface</option>
          <option value="Lens">Lens</option>
          <option value="Doublet">Doublet</option>
          <option value="Triplet">Triplet</option>
          <option value="CoordTrans">CoordTrans</option>
          <option value="Gap">Gap</option>
          <option value="Stop">Stop</option>
          <option value="Mirror">Mirror</option>
          <option value="ImagePlane">ImageSurface</option>
        </select>
        <button id="design-intent-add-block-btn">Add</button>
        <button id="design-intent-delete-block-btn">Delete</button>
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

      <div className="block-inspector-panel">
        <div id="block-inspector" className="block-inspector"></div>
      </div>

      <div className="expanded-optical-system-header">
        <h2 className="optical-system-title">Expanded Optical System (from Blocks)</h2>
        <button id="toggle-expanded-optical-system-btn" aria-expanded="true">
          Collapse
        </button>
      </div>
      <div id="expanded-optical-system-content">
        <div className="optical-system-buttons-container">
          <button id="add-optical-system-btn">Add Surf</button>
          <button id="delete-optical-system-row-btn">Del Surf</button>
          <button id="apply-to-design-intent-btn">Apply to Design Intent</button>
          <button id="find-glass-btn">🔍 Find Glass</button>
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

        <div className="optical-system-divider"></div>

        <div id="table-optical-system"></div>
      </div>
    </div>
  );
}
