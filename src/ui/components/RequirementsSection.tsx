import { useEffect } from 'react';

export default function RequirementsSection() {
  useEffect(() => {
    // The editor will be reinitialized by __cooptInitSystemRequirementsEditor
    // which is triggered by the initialization system
    try {
      const init = (window as any).__cooptInitSystemRequirementsEditor;
      if (typeof init === 'function') {
        init();
      }
    } catch (_) {}
  }, []);

  const waitForRequirementsEditorReady = async () => {
    const w = window as any;
    const start = Date.now();
    const maxWaitMs = 2500;
    const intervalMs = 50;
    while (Date.now() - start <= maxWaitMs) {
      try {
        if (typeof w.__cooptInitSystemRequirementsEditor === 'function') {
          w.__cooptInitSystemRequirementsEditor();
        }
      } catch (_) {}
      const editor = w.systemRequirementsEditor;
      if (editor && (typeof editor.updateAllConfigsAndEvaluate === 'function' || typeof editor.evaluateAndUpdateNow === 'function')) {
        return editor;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return w.systemRequirementsEditor || null;
  };

  // React-style button handlers
  const handleAddRequirement = () => {
    const editor = (window as any).systemRequirementsEditor;
    if (editor && typeof editor.addRequirement === 'function') {
      editor.addRequirement();
    } else {
      console.error('[RequirementsSection] Editor or addRequirement method not available');
    }
  };

  const handleDeleteRequirement = () => {
    const editor = (window as any).systemRequirementsEditor;
    if (editor && typeof editor.deleteRequirement === 'function') {
      editor.deleteRequirement();
    } else {
      console.error('[RequirementsSection] Editor or deleteRequirement method not available');
    }
  };

  const handleUpdateRequirement = async () => {
    const editor = await waitForRequirementsEditorReady();
    if (editor && typeof editor.updateAllConfigsAndEvaluate === 'function') {
      try {
        await editor.updateAllConfigsAndEvaluate();
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in updateAllConfigsAndEvaluate:', err);
      }
      return;
    }
    if (editor && typeof editor.evaluateAndUpdateNow === 'function') {
      try {
        await editor.evaluateAndUpdateNow({ reason: 'update-button-fallback' });
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
