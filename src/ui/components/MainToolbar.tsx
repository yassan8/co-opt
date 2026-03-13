import { useEffect, useState } from 'react';
import { 
  handleNewFile, 
  handleSave, 
  handleLoad, 
  handleLoadDefault, 
  handleClearStorage,
  handleShareUrl,
  handleImportZemax,
  handleExportZemax,
  handleOptimize,
  handleRender3D,
  handleSystemData,
  handleAnalysisSelect,
  handleOpenSettings
} from '../../../ui/toolbar-handlers';
import { getLoadedFileName, getLoadedFileWarn } from '../../../ui/loaded-file-storage';
import { getToolbarCollapsed, setToolbarCollapsed } from '../../../ui/toolbar-collapsed-storage';

export default function MainToolbar() {
  const resolveToolbarCollapsed = () => {
    return getToolbarCollapsed();
  };

  const resolveLoadedFileName = () => {
    try {
      const name = getLoadedFileName();
      const warn = getLoadedFileWarn();
      if (name) {
        const suffix = warn ? ' (surfaces only)' : '';
        return {
          text: `${name}${suffix}`,
          color: warn ? '#b45309' : '#1a4d8f'
        };
      }
    } catch (_) {}
    return { text: 'No file loaded', color: '#999' };
  };

  const [{ text: loadedFileText, color: loadedFileColor }, setLoadedFile] = useState(resolveLoadedFileName);
  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(resolveToolbarCollapsed);

  useEffect(() => {
    const refresh = () => {
      setLoadedFile(resolveLoadedFileName());
    };

    refresh();

    window.addEventListener('coopt:loaded-file-updated', refresh as EventListener);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('coopt:loaded-file-updated', refresh as EventListener);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    setToolbarCollapsed(isToolbarCollapsed);
  }, [isToolbarCollapsed]);

  const handleUndoClick = () => {
    if (window.undoHistory) {
      window.undoHistory.undo();
    }
  };

  const handleRedoClick = () => {
    if (window.undoHistory) {
      window.undoHistory.redo();
    }
  };

  const handleToggleToolbar = () => {
    setIsToolbarCollapsed((prev) => !prev);
  };
  
  return (
    <div className="top-buttons-container">
      <div className="top-file-row" id="loaded-file-display">
        <span className="top-file-icon">📁</span>
        <span id="loaded-file-name" className="top-file-name" style={{ color: loadedFileColor }}>
          {loadedFileText}
        </span>
        <button id="open-settings-btn" className="top-settings-btn" title="Settings" onClick={handleOpenSettings} type="button">
          ⚙️
        </button>
        <button
          id="toggle-toolbar-btn"
          className={`top-toggle-btn${isToolbarCollapsed ? ' collapsed' : ''}`}
          title="Toggle toolbar"
          onClick={handleToggleToolbar}
          data-toggle-handled="react"
          type="button"
        >
          ▼
        </button>
      </div>
      <div
        className={`top-buttons-row${isToolbarCollapsed ? ' collapsed' : ''}`}
        id="top-buttons-row"
      >
        <div className="button-group">
          <span className="button-group-label">File</span>
          <button id="new-file-btn" onClick={handleNewFile} data-react-handled="1">New File</button>
          <button id="save-all-btn" onClick={handleSave} data-react-handled="1">Save File</button>
          <button id="load-all-btn" onClick={handleLoad} data-react-handled="1">Load File</button>
          <button id="load-default-btn" onClick={handleLoadDefault} data-react-handled="1">Load Default</button>
          <button id="share-url-btn" onClick={handleShareUrl} data-react-handled="1">Share URL</button>
          <button id="clear-storage-btn" onClick={handleClearStorage}>Clear Cache</button>
        </div>

        <div className="button-group">
          <span className="button-group-label">Data</span>
          <button
            id="import-zemax-btn"
            title="Import a Zemax .zmx file (minimal subset)"
            onClick={handleImportZemax}
            data-react-handled="1"
          >
            Import Zemax
          </button>
          <button
            id="export-zemax-btn"
            title="Export current optical system as Zemax .zmx"
            onClick={handleExportZemax}
            data-react-handled="1"
          >
            Export Zemax
          </button>
        </div>

        <div className="button-group">
          <span className="button-group-label">View</span>
          <button id="open-3d-window-btn" title="Render 3D view in popup window" onClick={handleRender3D} data-react-handled="1">
            Open Render
          </button>
          <button
            id="open-system-data-window-btn"
            title="Open System Data in popup window"
            onClick={handleSystemData}
            data-react-handled="1"
            type="button"
          >
            Open System Data
          </button>
        </div>

        <div className="button-group">
          <span className="button-group-label">Tools</span>
          <button id="undo-btn" title="Undo (Ctrl+Z / Cmd+Z)" onClick={handleUndoClick}>
            ↶ Undo
          </button>
          <button id="redo-btn" title="Redo (Ctrl+Y / Cmd+Shift+Z)" onClick={handleRedoClick}>
            ↷ Redo
          </button>
          <button
            id="optimize-design-intent-btn"
            title="Optimize marked variables (V) to satisfy Requirements (all scenarios)."
            onClick={handleOptimize}
            data-react-handled="1"
          >
            Optimize
          </button>
        </div>

        <div className="button-group">
          <span className="button-group-label">Analysis</span>
          <select
            id="analysis-select"
            style={{ minWidth: 180 }}
            data-react-handled="1"
            onChange={(event) => {
              const value = event.currentTarget.value;
              handleAnalysisSelect(value);
              event.currentTarget.value = '';
            }}
          >
            <option value="">Select Analysis</option>
            <option value="spot-diagram">Spot Diagram</option>
            <option value="spherical-aberration">Spherical Aberration</option>
            <option value="astigmatism">Astigmatism</option>
            <option value="distortion">Distortion</option>
            <option value="distortion-grid">Distortion Grid</option>
            <option value="magnification-chromatic-aberration">Lateral Chromatic Aberration</option>
            <option value="integrated-aberration">Integrated Aberration</option>
            <option value="transverse-aberration">Transverse Aberration</option>
            <option value="opd">Optical Path Difference</option>
            <option value="psf">Point Spread Function</option>
            <option value="mtf">Modulation Transfer Function</option>
            <option value="through-focus-spot">Through-Focus Spot</option>
            <option value="through-focus-mtf">Through-Focus MTF</option>
            <option value="field-mtf">Object MTF</option>
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
          id="open-through-focus-spot-window-btn"
          title="Open Through-Focus Spot in popup window"
        >
          Through-Focus Spot
        </button>
        <button
          id="open-through-focus-mtf-window-btn"
          title="Open Through-Focus MTF in popup window"
        >
          Through-Focus MTF
        </button>
        <button
          id="open-field-mtf-window-btn"
          title="Open Object MTF in popup window"
        >
          Object MTF
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
          id="open-distortion-grid-window-btn"
          title="Open Distortion Grid in popup window"
        >
          Distortion Grid
        </button>
        <button
          id="open-magnification-chromatic-aberration-window-btn"
          title="Open Lateral Chromatic Aberration in popup window"
        >
          Lateral Chromatic Aberration
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
