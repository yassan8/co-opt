export default function ConfigurationSection() {
  return (
    <section className="configuration-section ide-section-card" aria-label="Configuration">
      <div className="configuration-controls ide-toolbar" role="toolbar" aria-label="Configuration controls">
        <button id="add-config-btn" type="button">➕ Add</button>
        <button id="delete-config-btn" type="button">🗑️ Delete</button>
        <button id="duplicate-config-btn" type="button">📋 Duplicate</button>
        <button id="rename-config-btn" type="button">✏️ Rename</button>
      </div>
      <div id="config-order-list" className="config-order-list" aria-label="Configuration order"></div>
      <div id="config-info" className="config-info"></div>
      <div className="configuration-note">
        <strong>Note:</strong> Source and Requirements are shared across configurations.
      </div>
    </section>
  );
}
