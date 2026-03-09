import { useEffect } from 'react';

export function SystemDataPanel({ visible = false }: { visible?: boolean }) {
  return (
    <div className={`system-section ${visible ? 'system-section-window-fit' : ''}`} style={{ display: visible ? 'flex' : 'none' }}>
      <h2>System Data</h2>

      <div
        id="transform-error-bar"
        className="merit-function-help"
        style={{ display: 'none', borderLeftColor: '#dc3545', marginBottom: 10 }}
      >
        <strong>Error:</strong> <span id="transform-error-text"></span>
      </div>

      <div
        id="transform-progress-wrapper"
        style={{
          display: 'none',
          padding: '8px 12px',
          borderBottom: '1px solid #eee',
          background: '#fff',
          marginBottom: 10,
        }}
      >
        <div id="transform-progress-text">Calculating...</div>
        <progress id="transform-progressbar" max={100} value={0} style={{ width: '100%', marginTop: 4 }}></progress>
      </div>

      <div className="system-controls">
        <button id="calculate-paraxial-btn">Calculate Paraxial</button>
        <button id="calculate-seidel-btn">Aberration Coefficients</button>
        <button id="calculate-seidel-afocal-btn">Aberration Coefficients (Afocal)</button>
        <label htmlFor="reference-focal-length">Reference Focal Length:</label>
        <input type="text" id="reference-focal-length" placeholder="Auto" style={{ width: '80px' }} />
        <button id="coord-transform-btn">Coord Transform</button>
      </div>
      <textarea id="system-data" rows={15} cols={100} placeholder="System information will appear here..."></textarea>
    </div>
  );
}

export default function LegacyPanels() {
  useEffect(() => {
    // Re-initialize event listeners when component mounts
    if (typeof window !== 'undefined') {
      const meritEditor = (window as any).meritFunctionEditor;
      if (meritEditor && typeof meritEditor.initializeEventListeners === 'function') {
        meritEditor.initializeEventListeners();
      }
    }
  }, []);

  // React-style Merit Function button handlers
  const handleAddOperand = () => {
    console.log('[LegacyPanels] Add Term button clicked (React handler)');
    const editor = (window as any).meritFunctionEditor;
    if (editor && typeof editor.addOperand === 'function') {
      editor.addOperand();
    } else {
      console.error('[LegacyPanels] Merit Function Editor or addOperand method not available');
    }
  };

  const handleDeleteOperand = () => {
    console.log('[LegacyPanels] Delete Term button clicked (React handler)');
    const editor = (window as any).meritFunctionEditor;
    if (editor && typeof editor.deleteOperand === 'function') {
      editor.deleteOperand();
    } else {
      console.error('[LegacyPanels] Merit Function Editor or deleteOperand method not available');
    }
  };

  const handleCalculateMerit = () => {
    console.log('[LegacyPanels] Calculate Evaluation button clicked (React handler)');
    const editor = (window as any).meritFunctionEditor;
    if (editor && typeof editor.calculateMerit === 'function') {
      editor.calculateMerit();
    } else {
      console.error('[LegacyPanels] Merit Function Editor or calculateMerit method not available');
    }
  };

  return (
    <>
      <div className="merit-function-section" style={{ display: "none" }}>
        <h2>System Evaluation</h2>
        <div className="merit-function-help">
          <strong>Note:</strong> This evaluation encodes design intent. Optimization is optional and always explicit.
          <br />
          <strong>Terminology / 用語:</strong>
          Target = requirement value（要求値／目標の数字）, Weight = scoring weight（評価の重み／採点上の重要度）.
        </div>
        <div className="merit-function-buttons-container">
          <button onClick={handleAddOperand}>Add Term</button>
          <button onClick={handleDeleteOperand}>Delete Term</button>
          <button onClick={handleCalculateMerit}>Calculate Evaluation</button>
        </div>
        <div id="table-merit-function"></div>
        <div className="merit-summary">
          <strong>Requirements Score:</strong> <span id="total-merit-value">0.000</span>
        </div>
        <div id="operand-inspector" className="operand-inspector" style={{ display: "none" }}>
          <h3>Evaluation Detail / Inspector</h3>
          <div id="inspector-content"></div>
        </div>

        <div id="block-contribution-section" className="block-contribution-section" style={{ display: "none" }}>
          <h3>Block Contribution Summary</h3>
          <div className="merit-function-help">
            <strong>Note:</strong> Updated when running “Aberration Coefficients”. Aggregated by expanded-row provenance (_blockId).
          </div>
          <textarea
            id="block-contribution-summary"
            rows={10}
            cols={100}
            readOnly
            placeholder="Block contribution summary will appear here..."
          ></textarea>
        </div>
      </div>

      <SystemDataPanel />

      {false && (
      <div className="draw-system-container">
        <div className="draw-section">
          <div id="threejs-canvas-container" aria-label="Optical system 3D canvas" />

          <div className="spot-diagram-section" style={{ display: "none" }}>
            <h2>Spot Diagram</h2>
            <div className="spot-diagram-controls">
              <label htmlFor="surface-number-select">Surface number:</label>
              <select id="surface-number-select">
                <option value="">Select surface...</option>
              </select>
              <label htmlFor="ray-count-input">Ray number:</label>
              <input type="number" id="ray-count-input" defaultValue={501} min={1} max={10001} step={1} />
              <label htmlFor="ring-count-select">Ring count:</label>
              <select id="ring-count-select" defaultValue="10">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
                <option value="6">6</option>
                <option value="7">7</option>
                <option value="8">8</option>
                <option value="9">9</option>
                <option value="10">10</option>
                <option value="12">12</option>
                <option value="15">15</option>
                <option value="16">16</option>
                <option value="20">20</option>
                <option value="24">24</option>
                <option value="32">32</option>
              </select>
              <span className="ray-count-note ring-count-note">(Limited by available rays)</span>

              <div className="ray-pattern-controls">
                <label>Ray pattern:</label>
                <button id="annular-pattern-btn" className="pattern-btn active">
                  Annular
                </button>
                <button id="grid-pattern-btn" className="pattern-btn">
                  Rectangle
                </button>
              </div>

              <button id="show-spot-diagram-btn" title="Generate spot diagram for the selected surface">
                Show spot diagram
              </button>
            </div>
            <div className="spot-diagram-help">
              <strong>Note:</strong>
              • Select a surface where rays can reach (usually Image surface or earlier)
              • If you get "rays not reaching surface" error, try selecting an earlier surface
              • Higher ray count provides better accuracy but takes longer to compute
            </div>
            <div id="spot-diagram-container"></div>
          </div>

          <div className="longitudinal-aberration-section" style={{ display: "none" }}>
            <h2>Spherical Aberration Diagram</h2>
            <div className="longitudinal-aberration-help">
              <strong>Note:</strong> Spherical aberration shows the axial displacement of focus along the optical axis (X-axis: longitudinal aberration, Y-axis: normalized pupil coordinate).
            </div>
            <div className="longitudinal-aberration-controls">
              <label htmlFor="longitudinal-ray-count-input">Ray number:</label>
              <input type="number" id="longitudinal-ray-count-input" defaultValue={100} min={1} max={1001} step={1} />
              <span className="note">(Always normalized by stop diameter)</span>
              <label htmlFor="longitudinal-reference-focus-mode" style={{ marginLeft: 10 }}>Reference focus:</label>
              <select id="longitudinal-reference-focus-mode" defaultValue="current-paraxial">
                <option value="primary-paraxial">Primary paraxial</option>
                <option value="current-paraxial">Current paraxial</option>
                <option value="chief-ray">Chief ray</option>
              </select>
              <button id="show-longitudinal-aberration-diagram-btn">Show spherical aberration diagram</button>
            </div>
            <div id="longitudinal-aberration-container"></div>
          </div>

          <div className="transverse-aberration-section" style={{ display: "none" }}>
            <h2>Transverse Aberration Diagram</h2>
            <div className="transverse-aberration-controls">
              <label htmlFor="transverse-ray-count-input">Ray number:</label>
              <input type="number" id="transverse-ray-count-input" defaultValue={101} min={9} max={10001} step={1} />
              <span className="note">(Always normalized by stop diameter)</span>
              <button id="show-transverse-aberration-diagram-btn">Show transverse aberration diagram</button>
            </div>
            <div id="transverse-aberration-container"></div>
          </div>

          <div className="astigmatism-section" style={{ display: "none" }}>
            <h2>Astigmatism Diagram</h2>
            <div className="astigmatism-help">
              <strong>Note:</strong> Astigmatism diagram shows the sagittal and meridional focal positions across different field angles.
            </div>
            <div className="astigmatism-controls">
              <label htmlFor="astigmatism-chief-ray-mode" style={{ marginRight: 8 }}>
                Chief Ray Definition:
              </label>
              <select id="astigmatism-chief-ray-mode" defaultValue="stopCenter">
                <option value="stopCenter">① 絞り中央通過 (Stop Center)</option>
                <option value="beamCenter">② 光束巾の真ん中 (Beam Center)</option>
                <option value="centroid">③ 光束の重心 (Centroid)</option>
              </select>
              <button id="show-astigmatism-diagram-btn" style={{ marginLeft: 12 }}>Show astigmatism diagram</button>
            </div>
            <div id="astigmatism-progress-wrapper" style={{ display: "none", margin: "8px 0" }}>
              <div id="astigmatism-progress-text" style={{ marginBottom: 6, fontSize: 12, color: "#333" }}>
                Calculating astigmatism...
              </div>
              <progress id="astigmatism-progressbar" max={100} value={0} style={{ width: "100%" }}></progress>
            </div>
            <div id="astigmatism-container"></div>
            <div id="astigmatic-field-curves-container"></div>
          </div>

          <div className="distortion-section" style={{ display: "none" }}>
            <h2>Distortion Diagram</h2>
            <div className="distortion-help">
              <strong>Note:</strong> Distortion shows the deviation of real image height from ideal (paraxial) image height.
              Field angles are automatically detected from Object table.
            </div>
            <div className="distortion-controls">
              <button id="show-distortion-diagram-btn">Show distortion diagram</button>
            </div>
            <div id="distortion-percent"></div>
          </div>

          <div className="distortion-grid-section" style={{ display: "none" }}>
            <h2>Distortion Grid</h2>
            <div className="distortion-help">
              <strong>Note:</strong> Distortion Grid plots ideal grid lines and traced image points.
            </div>
            <div className="distortion-controls">
              <label htmlFor="grid-size-select" style={{ marginLeft: 20 }}>
                Grid Size:
              </label>
              <select id="grid-size-select" defaultValue="20">
                <option value="10">10×10</option>
                <option value="15">15×15</option>
                <option value="20">20×20</option>
                <option value="25">25×25</option>
                <option value="30">30×30</option>
                <option value="35">35×35</option>
                <option value="40">40×40</option>
                <option value="45">45×45</option>
                <option value="50">50×50</option>
              </select>
              <button id="show-distortion-grid-btn">Show grid distortion</button>
            </div>
            <div id="distortion-grid"></div>
          </div>

          <div className="magnification-chromatic-aberration-section" style={{ display: "none" }}>
            <h2>Lateral Chromatic Aberration</h2>
            <div className="magnification-chromatic-aberration-help">
              <strong>Note:</strong> Lateral displacement is plotted relative to d-line at each object value.
            </div>
            <div className="magnification-chromatic-aberration-controls">
              <label htmlFor="mca-xmin-input">Lateral displacement:</label>
              <input type="number" id="mca-xmin-input" defaultValue={-0.05} step={0.01} />
              <span>to</span>
              <input type="number" id="mca-xmax-input" defaultValue={0.05} step={0.01} />
              <span className="note">(mm)</span>
              <label htmlFor="mca-point-count-input" style={{ marginLeft: 10 }}>Points:</label>
              <input type="number" id="mca-point-count-input" defaultValue={21} min={2} max={201} step={1} />
              <button id="show-magnification-chromatic-aberration-btn">Show lateral chromatic aberration</button>
            </div>
            <div id="mca-progress-wrapper" style={{ display: "none", margin: "8px 0" }}>
              <div id="mca-progress-text" style={{ marginBottom: 6, fontSize: 12, color: "#333" }}>
                Calculating lateral chromatic aberration...
              </div>
              <progress id="mca-progressbar" max={100} value={0} style={{ width: "100%" }}></progress>
            </div>
            <div id="magnification-chromatic-aberration-container"></div>
          </div>

          <section className="diagram-section" style={{ display: "none" }}>
            <h2>Integrated Aberration Diagram</h2>
            <div className="distortion-help">
              <strong>Note:</strong> This diagram combines Spherical Aberration, Astigmatic Field Curves, and Distortion in one view.
            </div>
            <div className="distortion-controls">
              <button id="show-integrated-aberration-btn">Show integrated aberration diagram</button>
            </div>
          </section>

          <div className="wavefront-aberration-section" style={{ display: "none" }}>
            <h2>Optical Path Difference</h2>
            <div className="wavefront-aberration-controls">
              <label htmlFor="wavefront-object-select">Object:</label>
              <select id="wavefront-object-select">
                <option value="0">Object 1</option>
                <option value="1">Object 2</option>
                <option value="2">Object 3</option>
                <option value="3">Object 4</option>
                <option value="4">Object 5</option>
              </select>
              <label htmlFor="wavefront-plot-type-select">Plot type:</label>
              <select id="wavefront-plot-type-select">
                <option value="surface">3D Surface</option>
                <option value="heatmap">Heatmap</option>
                <option value="multifield">Multi-field Comparison</option>
              </select>
              <label htmlFor="wavefront-grid-size-select">Grid size:</label>
              <select id="wavefront-grid-size-select" defaultValue="64">
                <option value="16">16x16</option>
                <option value="32">32x32</option>
                <option value="64">64x64</option>
                <option value="128">128x128</option>
                <option value="256">256x256</option>
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" id="opd-remove-ptd-checkbox" />
                Remove P/T/D
              </label>
              <button id="show-wavefront-diagram-btn">Show wavefront diagram</button>
              <button id="stop-opd-btn" type="button" disabled>
                Stop
              </button>
              <button id="zernike-fit-btn">Zernike Fit</button>
            </div>
            <div id="opd-progress" style={{ margin: "8px 0", fontSize: 13, color: "#666" }}></div>
            <div id="wavefront-container"></div>
            <div id="wavefront-container-stats"></div>
          </div>

          <div className="psf-section" style={{ display: "none" }}>
            <h2>Point Spread Function</h2>
            <div className="psf-controls">
              <label htmlFor="psf-object-select">Object:</label>
              <select id="psf-object-select">
                <option value="0">Object 1</option>
              </select>
              <label htmlFor="psf-sampling-select">FFT grid:</label>
              <select id="psf-sampling-select" defaultValue="64">
                <option value="32">32x32</option>
                <option value="64">64x64</option>
                <option value="128">128x128</option>
                <option value="256">256x256</option>
                <option value="512">512x512</option>
                <option value="1024">1024x1024</option>
                <option value="2048">2048x2048</option>
                <option value="4096">4096x4096</option>
              </select>
              <label
                htmlFor="psf-zeropad-select"
                title="Zero-padding increases PSF sampling resolution by enlarging FFT size without increasing OPD ray grid."
              >
                Zero pad:
              </label>
              <select
                id="psf-zeropad-select"
                title="Auto: pad to at least 512. None: no padding (fast). Or choose an explicit FFT size."
                defaultValue="auto"
              >
                <option value="auto">Auto (≥512)</option>
                <option value="none">None</option>
                <option value="512">512</option>
                <option value="1024">1024</option>
                <option value="2048">2048</option>
                <option value="4096">4096</option>
              </select>
              <label htmlFor="psf-zernike-sampling-select">OPD grid:</label>
              <select
                id="psf-zernike-sampling-select"
                title="Ray-traced OPD grid size (number of rays traced across pupil)"
                defaultValue="64"
              >
                <option value="32">32x32</option>
                <option value="64">64x64</option>
                <option value="128">128x128</option>
                <option value="256">256x256</option>
                <option value="512">512x512</option>
                <option value="1024">1024x1024</option>
                <option value="2048">2048x2048</option>
                <option value="4096">4096x4096</option>
              </select>
              <label>
                <input type="checkbox" id="psf-log-scale-checkbox" />
                Log scale
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" id="psf-remove-ptd-checkbox" />
                Remove P/T/D
              </label>
              <label htmlFor="psf-performance-select">Calculator:</label>
              <select id="psf-performance-select" defaultValue="auto">
                <option value="auto">Auto (WASM preferred)</option>
                <option value="wasm">Force WASM</option>
                <option value="javascript">Force JavaScript</option>
              </select>
              <button id="show-psf-btn" title="Calculate and display PSF from OPD data">
                Show PSF
              </button>
              <button id="stop-psf-btn" title="Stop the current PSF calculation" disabled>
                Stop
              </button>
              <span id="psf-pipeline-badge" title="PSF execution route">
                Unified pipeline: Ready
              </span>
            </div>
            <div className="psf-help" style={{ fontSize: 12, color: "#666", margin: "10px 0" }}>
              <strong>Note:</strong> PSF is calculated from OPD data using Fourier transform. Generate OPD data first using the Optical Path Difference section above.
            </div>
            <div id="psf-container"></div>
            <div id="psf-container-stats"></div>
            <div
              id="psf-benchmark-results"
              style={{
                marginTop: 10,
                padding: 10,
                border: "1px solid #ddd",
                borderRadius: 5,
                display: "none",
              }}
            >
              <h4>Benchmark Results</h4>
              <div id="psf-benchmark-details"></div>
            </div>
          </div>
        </div>
      </div>
      )}

      <footer
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
          padding: "12px 0",
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12 }}>
          <a
            href="https://x.com/yassan_8"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X profile: @yassan_8"
            title="X: @yassan_8"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: "block" }}>
              <path
                fill="currentColor"
                d="M18.9 2H22l-6.8 7.8L23 22h-6.7l-5.2-6.7L5.3 22H2l7.4-8.5L1 2h6.8l4.7 6.1L18.9 2zm-1.2 18h1.7L7.1 3.9H5.3L17.7 20z"
              />
            </svg>
            <span>@yassan_8</span>
          </a>
          <span style={{ opacity: 0.8 }}>Contact: For inquiries, please reach out via X.</span>
        </div>
        <div
          style={{
            fontSize: 11,
            textAlign: "center",
            maxWidth: 800,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}
        >
          <div style={{ color: "black" }}>
            <strong>Privacy Policy:</strong> We use Google Analytics to improve our service, but no personally identifiable information is collected.
          </div>
          <div style={{ color: "black" }}>Also, your design data is processed locally and never sent to our server.</div>
        </div>
      </footer>
    </>
  );
}
