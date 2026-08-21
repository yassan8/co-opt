export default function ConfigurationSection() {
  return (
    <section className="configuration-section ide-section-card" aria-label="Configuration">
      <div className="configuration-controls ide-toolbar window-commandbar" role="toolbar" aria-label="Configuration controls">
        <button id="add-config-btn" className="window-primary-action" type="button">Add configuration</button>
        <details className="window-action-menu">
          <summary aria-label="More configuration actions">More</summary>
          <div className="window-action-menu__panel" role="group" aria-label="Configuration actions" onClick={(event) => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; }}>
            <button id="duplicate-config-btn" type="button">Duplicate</button>
            <button id="rename-config-btn" type="button">Rename</button>
            <button id="delete-config-btn" className="is-danger" type="button">Delete</button>
          </div>
        </details>
      </div>
      <div id="config-order-list" className="config-order-list" aria-label="Configuration order"></div>
      <div id="config-info" className="config-info"></div>
      <div className="configuration-note">
        Source and Requirements are shared across configurations.
      </div>
    </section>
  );
}
