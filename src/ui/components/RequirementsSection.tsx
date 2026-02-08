export default function RequirementsSection() {
  console.log("[RequirementsSection] Component rendering");
  return (
    <div className="merit-function-section" style={{ border: "3px solid green", padding: "10px", margin: "10px" }}>
      <h2 style={{ color: "green", fontSize: "24px" }}>Requirements</h2>
      <div className="merit-function-buttons-container">
        <button id="add-requirement-btn">Add Requirement</button>
        <button id="delete-requirement-btn">Del Requirement</button>
        <button id="update-requirement-btn">Update Requirement</button>
      </div>

      <div id="table-system-requirements"></div>

      <div id="requirement-inspector" className="operand-inspector" style={{ display: "none" }}>
        <h3>Requirement Detail / Inspector</h3>
        <div id="requirement-inspector-content"></div>
      </div>
    </div>
  );
}
