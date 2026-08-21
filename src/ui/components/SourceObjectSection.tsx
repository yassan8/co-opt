export function SourceSection() {
  return (
    <section className="source-section source-field-section ide-section-card" aria-label="Source">
      <div className="source-object-toolbar ide-toolbar window-commandbar" role="toolbar" aria-label="Source controls">
        <button id="add-source-btn" className="window-primary-action" type="button">Add source</button>
        <button id="delete-source-btn" className="window-quiet-action" type="button">Delete selected</button>
      </div>
      <div id="table-source" className="ide-table-container"></div>
    </section>
  );
}

export function FieldSection() {
  return (
    <section className="field-section object-section source-field-section ide-section-card" aria-label="Field">
      <div className="source-object-toolbar ide-toolbar window-commandbar" role="toolbar" aria-label="Field controls">
        <button id="add-object-btn" className="window-primary-action" type="button">Add field</button>
        <div className="window-segmented-control" role="group" aria-label="Field coordinate type">
          <button id="object-angle-btn" type="button">Angle</button>
          {/* <button id="object-height-circle-btn">Height Circle</button> */}
          <button id="object-height-rect-btn" type="button">Object height</button>
          <button id="object-image-height-btn" type="button">Image height</button>
        </div>
        <details className="window-action-menu">
          <summary aria-label="More field actions">More</summary>
          <div className="window-action-menu__panel" role="group" aria-label="Field actions" onClick={(event) => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; }}>
            <button id="delete-object-btn" className="is-danger" type="button">Delete selected</button>
          </div>
        </details>
      </div>
      <div id="table-object" className="ide-table-container"></div>
    </section>
  );
}

export default function SourceObjectSection() {
  return (
    <section className="source-object-container" aria-label="Source and Field">
      <SourceSection />
      <FieldSection />
    </section>
  );
}
