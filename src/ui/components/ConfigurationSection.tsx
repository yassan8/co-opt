export default function ConfigurationSection() {
  return (
    <div className="configuration-section">
      <h2>Configuration</h2>
      <div className="merit-function-help">
        <strong>Note:</strong> Source and Requirements are shared across configurations.
      </div>
      <div className="configuration-controls">
        <select id="config-select"></select>
        <button id="add-config-btn">➕ Add</button>
        <button id="delete-config-btn">🗑️ Delete</button>
        <button id="duplicate-config-btn">📋 Duplicate</button>
        <button id="rename-config-btn">✏️ Rename</button>
      </div>
      <div id="config-info" className="config-info"></div>
    </div>
  );
}
