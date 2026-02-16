export default function ConfigurationSection() {
  return (
    <section className="configuration-section ide-section-card" aria-label="Configuration">
      <h2 className="section-title">Configuration</h2>
      <div className="merit-function-help">
        <strong>Note:</strong> Source and Requirements are shared across configurations.
      </div>
      <div className="configuration-controls ide-toolbar" role="toolbar" aria-label="Configuration controls">
        <select id="config-select"></select>
        <button id="add-config-btn" type="button">➕ Add Configuration</button>
        <button id="delete-config-btn" type="button">🗑️ Delete Configuration</button>
        <button id="duplicate-config-btn" type="button">📋 Duplicate Configuration</button>
        <button id="rename-config-btn" type="button">✏️ Rename Configuration</button>
      </div>
      <div id="config-info" className="config-info"></div>
    </section>
  );
}
