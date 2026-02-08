export default function SourceObjectSection() {
  return (
    <div className="source-object-container">
      <div className="source-section">
        <h2>Source</h2>
        <button id="add-source-btn">Add Source</button>
        <button id="delete-source-btn">Del Source</button>
        <div id="table-source"></div>
      </div>

      <div className="object-section">
        <h2>Object</h2>
        <button id="add-object-btn">Add Object</button>
        <button id="delete-object-btn">Del Object</button>
        <button id="object-angle-btn">Angle</button>
        {/* <button id="object-height-circle-btn">Height Circle</button> */}
        <button id="object-height-rect-btn">Height Rect</button>
        <div id="table-object"></div>
      </div>
    </div>
  );
}
