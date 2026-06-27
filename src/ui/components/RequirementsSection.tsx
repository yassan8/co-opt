import { useEffect } from 'react';

function isAnalysisPopupContext(): boolean {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('coopt_analysis_window') === '1';
  } catch (_) {
    return false;
  }
}

export default function RequirementsSection() {
  useEffect(() => {
    if (isAnalysisPopupContext()) return;
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
    if (isAnalysisPopupContext()) return null;
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

  const handleAddMemo = () => {
    const editor = (window as any).systemRequirementsEditor;
    if (editor && typeof editor.addMemoRow === 'function') {
      editor.addMemoRow();
    } else {
      console.error('[RequirementsSection] Editor or addMemoRow method not available');
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

  const handleSetAllRequirementOn = async () => {
    const editor = await waitForRequirementsEditorReady();
    if (editor && typeof editor.setAllEnabled === 'function') {
      try {
        editor.setAllEnabled(true);
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in setAllEnabled(true):', err);
      }
      return;
    }
    console.error('[RequirementsSection] ❌ Editor or setAllEnabled method not available');
  };

  const handleSetAllRequirementOff = async () => {
    const editor = await waitForRequirementsEditorReady();
    if (editor && typeof editor.setAllEnabled === 'function') {
      try {
        editor.setAllEnabled(false);
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in setAllEnabled(false):', err);
      }
      return;
    }
    console.error('[RequirementsSection] ❌ Editor or setAllEnabled method not available');
  };

  const handleNormalizeRequirementWeights = async () => {
    const editor = await waitForRequirementsEditorReady();
    if (editor && typeof editor.normalizeWeightsForUnitScore === 'function') {
      try {
        const result = await editor.normalizeWeightsForUnitScore();
        console.info('[RequirementsSection] normalizeWeightsForUnitScore:', result);
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in normalizeWeightsForUnitScore:', err);
      }
      return;
    }
    console.error('[RequirementsSection] ❌ Editor or normalizeWeightsForUnitScore method not available');
  };

  const handleSetAllRequirementWeightsToOne = async () => {
    const editor = await waitForRequirementsEditorReady();
    if (editor && typeof editor.setAllWeights === 'function') {
      try {
        const result = editor.setAllWeights(1);
        console.info('[RequirementsSection] setAllWeights(1):', result);
      } catch (err) {
        console.error('[RequirementsSection] ❌ Error in setAllWeights(1):', err);
      }
      return;
    }
    console.error('[RequirementsSection] ❌ Editor or setAllWeights method not available');
  };

  return (
    <section className="merit-function-section requirements-section ide-section-card" id="requirements-container" aria-label="Requirements">
      <h2 className="section-title">Requirements</h2>
      <div className="merit-function-buttons-container ide-toolbar" role="toolbar" aria-label="Requirements controls">
        <button id="add-requirement-btn" type="button" onClick={handleAddRequirement}>Add Requirement</button>
        <button id="add-memo-btn" type="button" onClick={handleAddMemo} title="Add a memo / note row (not evaluated)">Add Memo</button>
        <button id="delete-requirement-btn" type="button" onClick={handleDeleteRequirement}>Delete Requirement</button>
        <button id="update-requirement-btn" type="button" onClick={handleUpdateRequirement}>Update Requirement</button>
        <button id="set-all-requirement-on-btn" type="button" onClick={handleSetAllRequirementOn}>All On</button>
        <button id="set-all-requirement-off-btn" type="button" onClick={handleSetAllRequirementOff}>All Off</button>
        <button id="set-all-requirement-weight-one-btn" type="button" onClick={handleSetAllRequirementWeightsToOne}>All Weight=1</button>
        <button id="normalize-requirement-weight-btn" type="button" onClick={handleNormalizeRequirementWeights} title="Set each positive current Score to 1 by adjusting Weight">Normalize Score=1</button>
      </div>

      <div className="requirements-layout">
        <div className="requirements-list-panel" aria-label="Requirements list">
          <div className="requirements-list-header">
            <span>Requirement List</span>
            <span className="requirements-list-meta">Always visible</span>
          </div>
          <div id="table-system-requirements" className="ide-table-container"></div>
        </div>

        <div id="requirement-inspector" className="operand-inspector requirement-inspector" style={{ display: "none" }}>
          <h3>Requirement Detail / Inspector</h3>
          <div id="requirement-inspector-content"></div>
        </div>
      </div>
    </section>
  );
}
