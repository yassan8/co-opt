import { useEffect } from 'react';

export default function RequirementsSection() {
  useEffect(() => {
    console.log('[RequirementsSection] Component mounted');
    // The editor will be reinitialized by __cooptInitSystemRequirementsEditor
    // which is triggered by the initialization system
    try {
      const init = (window as any).__cooptInitSystemRequirementsEditor;
      if (typeof init === 'function') {
        init();
      }
    } catch (_) {}
  }, []);

  // React-style button handlers
  const handleAddRequirement = () => {
    console.log('[RequirementsSection] Add button clicked (React handler)');
    const editor = (window as any).systemRequirementsEditor;
    if (editor && typeof editor.addRequirement === 'function') {
      editor.addRequirement();
    } else {
      console.error('[RequirementsSection] Editor or addRequirement method not available');
    }
  };

  const handleDeleteRequirement = () => {
    console.log('[RequirementsSection] Delete button clicked (React handler)');
    const editor = (window as any).systemRequirementsEditor;
    if (editor && typeof editor.deleteRequirement === 'function') {
      editor.deleteRequirement();
    } else {
      console.error('[RequirementsSection] Editor or deleteRequirement method not available');
    }
  };

  const handleUpdateRequirement = async () => {
    console.log('[RequirementsSection] ========================================');
    console.log('[RequirementsSection] Update button clicked (React handler)!');
    console.log('[RequirementsSection] ========================================');
    const editor = (window as any).systemRequirementsEditor;
    console.log('[RequirementsSection] Editor exists:', !!editor);
    console.log('[RequirementsSection] Editor type:', typeof editor);
    if (editor) {
      console.log('[RequirementsSection] updateAllConfigsAndEvaluate exists:', typeof editor.updateAllConfigsAndEvaluate);
      console.log('[RequirementsSection] Editor keys:', Object.keys(editor).slice(0, 10));
    }
    if (editor && typeof editor.updateAllConfigsAndEvaluate === 'function') {
      try {
        console.log('[RequirementsSection] ✅ Calling updateAllConfigsAndEvaluate...');
        await editor.updateAllConfigsAndEvaluate();
        console.log('[RequirementsSection] ✅ updateAllConfigsAndEvaluate completed');
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in updateAllConfigsAndEvaluate:', err);
      }
      return;
    }
    if (editor && typeof editor.evaluateAndUpdateNow === 'function') {
      try {
        console.log('[RequirementsSection] ✅ Calling evaluateAndUpdateNow...');
        await editor.evaluateAndUpdateNow({ reason: 'update-button-fallback' });
        console.log('[RequirementsSection] ✅ evaluateAndUpdateNow completed');
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in evaluateAndUpdateNow:', err);
      }
      return;
    } else {
      console.error('[RequirementsSection] ❌ Editor or updateAllConfigsAndEvaluate method not available');
    }
  };

  return (
    <div className="merit-function-section">
      <h2>Requirements</h2>
      <div className="merit-function-buttons-container">
        <button onClick={handleAddRequirement}>Add Requirement</button>
        <button onClick={handleDeleteRequirement}>Del Requirement</button>
        <button onClick={handleUpdateRequirement}>Update Requirement</button>
      </div>

      {/* Progress bar container - will be populated by the editor */}
      <div id="requirements-progress-wrap" style={{ display: 'none', marginTop: '6px' }}>
        <div id="requirements-progress-label" className="merit-function-help"></div>
        <progress id="requirements-progress" max={1} value={0} style={{ width: '320px' }}></progress>
      </div>

      <div id="table-system-requirements"></div>

      <div id="requirement-inspector" className="operand-inspector" style={{ display: "none" }}>
        <h3>Requirement Detail / Inspector</h3>
        <div id="requirement-inspector-content"></div>
      </div>
    </div>
  );
}
