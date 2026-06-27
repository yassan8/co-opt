export default function SourceObjectSection() {
  return (
    <section className="source-object-container" aria-label="Source and Object">
      <div className="source-section ide-section-card">
        <h2 className="section-title">Source</h2>
        <div className="source-object-toolbar ide-toolbar" role="toolbar" aria-label="Source controls">
          <button id="add-source-btn" type="button">Add Source</button>
          <button id="delete-source-btn" type="button">Delete Source</button>
        </div>
        <div id="table-source" className="ide-table-container"></div>
      </div>

      <div className="object-section ide-section-card">
        <h2 className="section-title">Object</h2>
        <div className="source-object-toolbar ide-toolbar" role="toolbar" aria-label="Object controls">
          <button id="add-object-btn" type="button">Add Object</button>
          <button id="delete-object-btn" type="button">Delete Object</button>
          <button id="object-angle-btn" type="button">Angle</button>
        {/* <button id="object-height-circle-btn">Height Circle</button> */}
          <button id="object-height-rect-btn" type="button">Height Rect</button>
          <button id="object-image-height-btn" type="button">Image Height</button>
        </div>
        <div id="table-object" className="ide-table-container"></div>
      </div>
    </section>
  );
}
