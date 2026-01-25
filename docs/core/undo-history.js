/**
 * Undo/Redo System for Co-Opt
 * Implements Command Pattern for system-wide undo functionality
 */

// ============================================================================
// Base Command Class
// ============================================================================

class Command {
  constructor(description, timestamp) {
    this.id = this.generateUUID();
    this.description = description;
    this.timestamp = timestamp || Date.now();
  }
  
  generateUUID() {
    return 'cmd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  execute() {
    throw new Error('execute() must be implemented by subclass');
  }
  
  undo() {
    throw new Error('undo() must be implemented by subclass');
  }
  
  redo() {
    return this.execute();
  }
}

// ============================================================================
// Specific Command Types
// ============================================================================

/**
 * Command for setting a block parameter in Design Intent
 */
class SetBlockParameterCommand extends Command {
  constructor(configId, blockId, parameterPath, oldValue, newValue) {
    super(`Set ${blockId}.${parameterPath} from ${oldValue} to ${newValue}`);
    this.configId = configId;
    this.blockId = blockId;
    this.parameterPath = parameterPath; // e.g., "parameters.frontRadius"
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute() {
    console.log('[Undo] execute() called');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      const sysConfig = window.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find(c => c.id === this.configId);
      const block = this.findBlock(cfg);
      this.setNestedValue(block, this.parameterPath, this.newValue);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
      console.log('[Undo] execute() completed');
    }
  }
  
  undo() {
    console.log('[Undo] SetBlockParameterCommand.undo() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      const sysConfig = window.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find(c => c.id === this.configId);
      console.log('[Undo] Config found:', cfg ? cfg.id : 'null');
      const block = this.findBlock(cfg);
      console.log('[Undo] Block found:', block ? block.blockId : 'null');
      console.log('[Undo] Setting', this.parameterPath, 'to', this.oldValue);
      this.setNestedValue(block, this.parameterPath, this.oldValue);
      console.log('[Undo] After setNestedValue, block value is:', this.getNestedValue(block, this.parameterPath));
      console.log('[Undo] Value set, calling refreshSystem');
      this.refreshSystem(sysConfig, cfg);
      console.log('[Undo] SetBlockParameterCommand.undo() completed');
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  getNestedValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
      if (!current) return undefined;
      current = current[parts[i]];
    }
    return current;
  }
  
  getConfig() {
    const sysConfig = window.loadSystemConfigurations();
    return sysConfig.configurations.find(c => c.id === this.configId);
  }
  
  findBlock(cfg) {
    return cfg.blocks.find(b => b.blockId === this.blockId);
  }
  
  setNestedValue(obj, path, value) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    if (value === undefined) {
      delete current[lastKey];
    } else {
      current[lastKey] = value;
    }
  }
  
  refreshSystem(sysConfig, cfg) {
    console.log('[Undo] refreshSystem() starting');
    
    // Re-expand blocks to optical system
    if (window.expandBlocksToOpticalSystemRows) {
      console.log('[Undo] Expanding blocks to optical system');
      const expanded = window.expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) {
        cfg.opticalSystem = expanded.rows;
        console.log('[Undo] Optical system updated');
      }
    }
    
    // Debug: Check value before save
    const cfgInSysConfig = sysConfig.configurations.find(c => c.id === cfg.id);
    const blockInSysConfig = cfgInSysConfig?.blocks.find(b => b.blockId === this.blockId);
    console.log('[Undo] Before save, value in sysConfig:', this.getNestedValue(blockInSysConfig, this.parameterPath));
    
    // Save to localStorage (sysConfig already contains the changes made toue(cfg.blocks.find(b => b.blockId === this.blockId), this.parameterPath));
    
    // Save to localStorage (must pass the full systemConfig, not just cfg)
    if (window.saveSystemConfigurations) {
      console.log('[Undo] Saving system configurations');
      window.saveSystemConfigurations(sysConfig);
      
      // Verify save
      const reloaded = window.loadSystemConfigurations();
      const reloadedCfg = reloaded.configurations.find(c => c.id === cfg.id);
      const reloadedBlock = reloadedCfg?.blocks.find(b => b.blockId === this.blockId);
      console.log('[Undo] After save, reloaded value:', this.getNestedValue(reloadedBlock, this.parameterPath));
    }
    
    // Refresh UI
    if (window.refreshBlockInspector) {
      console.log('[Undo] Calling refreshBlockInspector');
      window.refreshBlockInspector();
    }
    if (window.loadActiveConfigurationToTables) {
      console.log('[Undo] Calling loadActiveConfigurationToTables');
      window.loadActiveConfigurationToTables();
    }
    if (window.refreshAllUI) {
      console.log('[Undo] Calling refreshAllUI');
      window.refreshAllUI();
    }
    console.log('[Undo] refreshSystem() completed');
  }
}

/**
 * Command for setting a surface field in the Surface Table
 */
class SetSurfaceFieldCommand extends Command {
  constructor(configId, surfaceId, field, oldValue, newValue) {
    super(`Set surface ${surfaceId} ${field} from ${oldValue} to ${newValue}`);
    this.configId = configId;
    this.surfaceId = surfaceId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute() {
    const cfg = this.getConfig();
    const surface = cfg.opticalSystem.find(s => s.id === this.surfaceId);
    if (surface) {
      surface[this.field] = this.newValue;
      this.saveAndRefresh();
    }
  }
  
  undo() {
    const cfg = this.getConfig();
    const surface = cfg.opticalSystem.find(s => s.id === this.surfaceId);
    if (surface) {
      surface[this.field] = this.oldValue;
      this.saveAndRefresh();
    }
  }
  
  getConfig() {
    const sysConfig = window.loadSystemConfigurations();
    return sysConfig.configurations.find(c => c.id === this.configId);
  }
  
  saveAndRefresh() {
    if (window.saveSystemConfigurations) {
      window.saveSystemConfigurations();
    }
    
    // Reload table to reflect changes
    if (window.loadActiveConfigurationToTables) {
      window.loadActiveConfigurationToTables();
    }
    
    if (window.refreshAllUI) {
      window.refreshAllUI();
    }
  }
}

/**
 * Command for setting a System Requirement field
 */
class SetRequirementCommand extends Command {
  constructor(requirementId, field, oldValue, newValue) {
    super(`Set requirement ${requirementId} ${field}`);
    this.requirementId = requirementId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute() {
    console.log('[Undo] SetRequirementCommand.execute() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      // Load from systemRequirementsData localStorage key
      const json = localStorage.getItem('systemRequirementsData');
      const data = json ? JSON.parse(json) : [];
      const req = data.find(r => r.id === this.requirementId);
      if (req) {
        console.log(`[Undo] Setting ${this.field} from ${req[this.field]} to ${this.newValue}`);
        req[this.field] = this.newValue;
        localStorage.setItem('systemRequirementsData', JSON.stringify(data));
        console.log('[Undo] Saved to systemRequirementsData');
        this.refreshUI();
      }
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo() {
    console.log('[Undo] SetRequirementCommand.undo() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      // Load from systemRequirementsData localStorage key
      const json = localStorage.getItem('systemRequirementsData');
      const data = json ? JSON.parse(json) : [];
      const req = data.find(r => r.id === this.requirementId);
      if (req) {
        console.log(`[Undo] Setting ${this.field} from ${req[this.field]} to ${this.oldValue}`);
        req[this.field] = this.oldValue;
        localStorage.setItem('systemRequirementsData', JSON.stringify(data));
        console.log('[Undo] Saved to systemRequirementsData');
        
        // Verify save
        const reloaded = JSON.parse(localStorage.getItem('systemRequirementsData'));
        const reloadedReq = reloaded.find(r => r.id === this.requirementId);
        console.log(`[Undo] After save, reloaded value for ${this.field}:`, reloadedReq?.[this.field]);
        
        console.log('[Undo] Calling refreshUI()...');
        this.refreshUI();
      }
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  refreshUI() {
    console.log('[Undo] SetRequirementCommand.refreshUI() called');
    if (window.systemRequirementsEditor) {
      console.log('[Undo] Calling systemRequirementsEditor.loadFromStorage()...');
      window.systemRequirementsEditor.loadFromStorage();
      console.log('[Undo] loadFromStorage() completed, requirements:', window.systemRequirementsEditor.requirements);
      
      // Check if requirement data is correct
      const req = window.systemRequirementsEditor.requirements.find(r => r.id === this.requirementId);
      console.log(`[Undo] Requirement ${this.requirementId} data after loadFromStorage:`, req);
      console.log(`[Undo] Field ${this.field} value:`, req?.[this.field]);
      
      console.log('[Undo] Calling systemRequirementsEditor.renderTable()...');
      window.systemRequirementsEditor.renderTable();
      console.log('[Undo] renderTable() completed');
      
      // Verify UI after render
      setTimeout(() => {
        const reloadedReq = window.systemRequirementsEditor.requirements.find(r => r.id === this.requirementId);
        console.log(`[Undo] After renderTable, requirement ${this.requirementId}.${this.field}:`, reloadedReq?.[this.field]);
      }, 100);
    } else {
      console.error('[Undo] systemRequirementsEditor not found');
    }
  }
}

/**
 * Command for setting a Source (wavelength) field
 */
class SetSourceFieldCommand extends Command {
  constructor(configId, sourceId, field, oldValue, newValue) {
    super(`Set source ${sourceId} ${field}`);
    this.configId = configId;
    this.sourceId = sourceId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute() {
    console.log('[Undo] SetSourceFieldCommand.execute() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      // Load from sourceTableData localStorage key
      const json = localStorage.getItem('sourceTableData');
      const data = json ? JSON.parse(json) : [];
      const source = data.find(s => s.id === this.sourceId);
      if (source) {
        console.log(`[Undo] Setting ${this.field} from ${source[this.field]} to ${this.newValue}`);
        source[this.field] = this.newValue;
        localStorage.setItem('sourceTableData', JSON.stringify(data));
        console.log('[Undo] Saved to sourceTableData');
        this.refreshUI();
      }
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo() {
    console.log('[Undo] SetSourceFieldCommand.undo() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      // Load from sourceTableData localStorage key
      const json = localStorage.getItem('sourceTableData');
      const data = json ? JSON.parse(json) : [];
      const source = data.find(s => s.id === this.sourceId);
      if (source) {
        console.log(`[Undo] Setting ${this.field} from ${source[this.field]} to ${this.oldValue}`);
        source[this.field] = this.oldValue;
        localStorage.setItem('sourceTableData', JSON.stringify(data));
        console.log('[Undo] Saved to sourceTableData');
        this.refreshUI();
      }
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  refreshUI() {
    console.log('[Undo] SetSourceFieldCommand.refreshUI() called');
    console.log('[Undo] window.tableSource exists:', !!window.tableSource);
    console.log('[Undo] window.loadSourceTableData exists:', !!window.loadSourceTableData);
    if (window.tableSource && window.loadSourceTableData) {
      console.log('[Undo] Calling loadSourceTableData()...');
      const data = window.loadSourceTableData();
      console.log('[Undo] Loaded data:', data);
      console.log('[Undo] Calling tableSource.replaceData()...');
      window.tableSource.replaceData(data);
      console.log('[Undo] tableSource.replaceData() completed');
    } else {
      console.error('[Undo] Cannot refresh UI - missing tableSource or loadSourceTableData');
    }
  }
}

/**
 * Command for setting an Object (field point) field
 */
class SetObjectFieldCommand extends Command {
  constructor(configId, objectId, field, oldValue, newValue) {
    super(`Set object ${objectId} ${field}`);
    this.configId = configId;
    this.objectId = objectId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute() {
    console.log('[Undo] SetObjectFieldCommand.execute() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      // Load from objectTableData localStorage key
      const json = localStorage.getItem('objectTableData');
      const data = json ? JSON.parse(json) : [];
      const obj = data.find(o => o.id === this.objectId);
      if (obj) {
        console.log(`[Undo] Setting ${this.field} from ${obj[this.field]} to ${this.newValue}`);
        obj[this.field] = this.newValue;
        localStorage.setItem('objectTableData', JSON.stringify(data));
        console.log('[Undo] Saved to objectTableData');
        this.refreshUI();
      }
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo() {
    console.log('[Undo] SetObjectFieldCommand.undo() starting');
    if (window.undoHistory) {
      window.undoHistory.isExecuting = true;
    }
    try {
      // Load from objectTableData localStorage key
      const json = localStorage.getItem('objectTableData');
      const data = json ? JSON.parse(json) : [];
      const obj = data.find(o => o.id === this.objectId);
      if (obj) {
        console.log(`[Undo] Setting ${this.field} from ${obj[this.field]} to ${this.oldValue}`);
        obj[this.field] = this.oldValue;
        localStorage.setItem('objectTableData', JSON.stringify(data));
        console.log('[Undo] Saved to objectTableData');
        
        // Verify save
        const reloaded = JSON.parse(localStorage.getItem('objectTableData'));
        const reloadedObj = reloaded.find(o => o.id === this.objectId);
        console.log(`[Undo] After save, reloaded value for ${this.field}:`, reloadedObj?.[this.field]);
        
        console.log('[Undo] Calling refreshUI()...');
        this.refreshUI();
        console.log('[Undo] refreshUI() completed');
      } else {
        console.error('[Undo] Object not found! objectId:', this.objectId);
      }
    } finally {
      if (window.undoHistory) {
        window.undoHistory.isExecuting = false;
      }
    }
  }
  
  getConfig() {
    const sysConfig = window.loadSystemConfigurations();
    return sysConfig.configurations.find(c => c.id === this.configId);
  }
  
  refreshUI() {
    console.log('[Undo] SetObjectFieldCommand.refreshUI() called');
    console.log('[Undo] window.tableObject exists:', !!window.tableObject);
    console.log('[Undo] window.loadObjectTableData exists:', !!window.loadObjectTableData);
    if (window.tableObject && window.loadObjectTableData) {
      console.log('[Undo] Calling loadObjectTableData()...');
      const data = window.loadObjectTableData();
      console.log('[Undo] Loaded data:', data);
      console.log('[Undo] Calling tableObject.replaceData()...');
      window.tableObject.replaceData(data);
      console.log('[Undo] tableObject.replaceData() completed');
    } else {
      console.error('[Undo] Cannot refresh UI - missing tableObject or loadObjectTableData');
    }
  }
}

/**
 * Compound Command - groups multiple commands into one undo/redo action
 * Useful for operations that trigger multiple changes (e.g., gap auto-update)
 */
class CompoundCommand extends Command {
  constructor(description, commands) {
    super(description);
    this.commands = commands || []; // Array of Command objects
  }
  
  execute() {
    for (const cmd of this.commands) {
      cmd.execute();
    }
  }
  
  undo() {
    // Undo in reverse order
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i].undo();
    }
  }
  
  addCommand(command) {
    this.commands.push(command);
  }
}

// ============================================================================
// Undo History Manager
// ============================================================================

class UndoHistory {
  constructor(maxSize = 100) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSize = maxSize;
    this.isExecuting = false; // Prevent recording during undo/redo
  }
  
  /**
   * Record a new command in the undo history
   */
  record(command) {
    if (this.isExecuting) return; // Don't record undo/redo operations
    
    this.undoStack.push(command);
    this.redoStack = []; // Clear redo stack on new command
    
    // Limit stack size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    
    this.notifyListeners();
    
    console.log(`[Undo] Recorded: ${command.description}`);
  }
  
  /**
   * Undo the last command
   */
  undo() {
    console.log('[Undo] undo() called, stack size:', this.undoStack.length);
    if (this.undoStack.length === 0) {
      console.log('[Undo] Nothing to undo');
      return false;
    }
    
    this.isExecuting = true;
    try {
      const command = this.undoStack.pop();
      console.log(`[Undo] Undoing: ${command.description}`, command);
      command.undo();
      this.redoStack.push(command);
      this.notifyListeners();
      console.log('[Undo] Undo completed successfully');
      return true;
    } catch (error) {
      console.error('[Undo] Error during undo:', error);
      return false;
    } finally {
      this.isExecuting = false;
    }
  }
  
  /**
   * Redo the last undone command
   */
  redo() {
    console.log('[Undo] redo() called, stack size:', this.redoStack.length);
    if (this.redoStack.length === 0) {
      console.log('[Undo] Nothing to redo');
      return false;
    }
    
    this.isExecuting = true;
    try {
      const command = this.redoStack.pop();
      console.log(`[Undo] Redoing: ${command.description}`, command);
      command.execute();
      this.undoStack.push(command);
      this.notifyListeners();
      console.log('[Undo] Redo completed successfully');
      return true;
    } catch (error) {
      console.error('[Undo] Error during redo:', error);
      return false;
    } finally {
      this.isExecuting = false;
    }
  }
  
  canUndo() {
    return this.undoStack.length > 0;
  }
  
  canRedo() {
    return this.redoStack.length > 0;
  }
  
  /**
   * Clear all history (called on config switch, import, load)
   */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.notifyListeners();
    console.log('[Undo] History cleared');
  }
  
  /**
   * Update UI button states
   */
  notifyListeners() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    
    if (undoBtn) {
      undoBtn.disabled = !this.canUndo();
      undoBtn.title = this.canUndo() 
        ? `Undo: ${this.undoStack[this.undoStack.length - 1].description}` 
        : 'Nothing to undo';
    }
    
    if (redoBtn) {
      redoBtn.disabled = !this.canRedo();
      redoBtn.title = this.canRedo() 
        ? `Redo: ${this.redoStack[this.redoStack.length - 1].description}` 
        : 'Nothing to redo';
    }
  }
  
  /**
   * Get history information for debugging
   */
  getInfo() {
    return {
      undoStackSize: this.undoStack.length,
      redoStackSize: this.redoStack.length,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      isExecuting: this.isExecuting
    };
  }
}

// ============================================================================
// Global Instance & Exports
// ============================================================================

// Create global instance
if (typeof window !== 'undefined') {
  window.undoHistory = new UndoHistory();
  
  // Export command classes for use in other modules
  window.Command = Command;
  window.SetBlockParameterCommand = SetBlockParameterCommand;
  window.SetSurfaceFieldCommand = SetSurfaceFieldCommand;
  window.SetRequirementCommand = SetRequirementCommand;
  window.SetSourceFieldCommand = SetSourceFieldCommand;
  window.SetObjectFieldCommand = SetObjectFieldCommand;
  window.CompoundCommand = CompoundCommand;
  window.UndoHistory = UndoHistory;
  
  console.log('[Undo] Undo/Redo system initialized');
}
