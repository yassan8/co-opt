export default function MainToolbar() {
  return (
    <div className="top-buttons-container">
      <div className="top-file-row" id="loaded-file-display">
        <span className="top-file-icon">📁</span>
        <span id="loaded-file-name" className="top-file-name">
          No file loaded
        </span>
        <button id="open-settings-btn" className="top-settings-btn" title="Settings">
          ⚙️
        </button>
        <button id="toggle-toolbar-btn" className="top-toggle-btn" title="Toggle toolbar">
          ▼
        </button>
      </div>
      <div className="top-buttons-row" id="top-buttons-row">
        <div className="button-group">
          <span className="button-group-label">File</span>
          <button id="new-file-btn">New</button>
          <button id="save-all-btn">Save</button>
          <button id="load-all-btn">Load</button>
          <button id="load-default-btn">Load Default System</button>
          <button id="share-url-btn">Share</button>
          <button id="clear-storage-btn">Clear Chashe</button>
        </div>

        <div className="button-group">
          <span className="button-group-label">Data</span>
          <button
            id="import-zemax-btn"
            title="Import a Zemax .zmx file (minimal subset)"
          >
            Import Zemax
          </button>
          <button
            id="export-zemax-btn"
            title="Export current optical system as Zemax .zmx"
          >
            Export Zemax
          </button>
        </div>

        <div className="button-group">
          <span className="button-group-label">View</span>
          <button id="open-3d-window-btn" title="Render 3D view in popup window">
            Render
          </button>
          <button
            id="open-system-data-window-btn"
            title="Open System Data in popup window"
          >
            System Data
          </button>
        </div>

        <div className="button-group">
          <span className="button-group-label">Tools</span>
          <button id="undo-btn" title="Undo (Ctrl+Z / Cmd+Z)" disabled>
            ↶ Undo
          </button>
          <button id="redo-btn" title="Redo (Ctrl+Y / Cmd+Shift+Z)" disabled>
            ↷ Redo
          </button>
          <button
            id="optimize-design-intent-btn"
            title="Optimize marked variables (V) to satisfy Requirements (all scenarios)."
          >
            Optimize
          </button>
        </div>

        <div className="button-group">
          <span className="button-group-label">Analysis</span>
          <select id="analysis-select" style={{ minWidth: 180 }}>
            <option value="">Select Analysis...</option>
            <option value="spot-diagram">Spot Diagram</option>
            <option value="spherical-aberration">Spherical Aberration</option>
            <option value="astigmatism">Astigmatism</option>
            <option value="distortion">Distortion</option>
            <option value="integrated-aberration">Integrated Aberration</option>
            <option value="transverse-aberration">Transverse Aberration</option>
            <option value="opd">Optical Path Difference</option>
            <option value="psf">Point Spread Function</option>
            <option value="mtf">Modulation Transfer Function</option>
          </select>
        </div>
      </div>

      <div style={{ display: "none" }}>
        <button
          id="open-spot-diagram-window-btn"
          title="Open Spot Diagram in popup window"
        >
          Spot Diagram
        </button>
        <button
          id="open-spherical-aberration-window-btn"
          title="Open Spherical Aberration in popup window"
        >
          Spherical Aberration
        </button>
        <button
          id="open-astigmatism-window-btn"
          title="Open Astigmatism in popup window"
        >
          Astigmatism
        </button>
        <button
          id="open-distortion-window-btn"
          title="Open Distortion in popup window"
        >
          Distortion
        </button>
        <button
          id="open-integrated-aberration-window-btn"
          title="Open Integrated Aberration in popup window"
        >
          Integrated Aberration
        </button>
        <button
          id="open-transverse-aberration-window-btn"
          title="Open Transverse Aberration in popup window"
        >
          Transverse Aberration
        </button>
        <button
          id="open-opd-window-btn"
          title="Open Optical Path Difference in popup window"
        >
          Optical Path Difference
        </button>
        <button
          id="open-psf-window-btn"
          title="Open Point Spread Function in popup window"
        >
          Point Spread Function
        </button>
        <button
          id="open-mtf-window-btn"
          title="Open Modulation Transfer Function in popup window"
        >
          Modulation Transfer Function
        </button>
      </div>
    </div>
  );
}
