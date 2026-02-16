// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * Undo/Redo System for Co-Opt
 * Implements Command Pattern for system-wide undo functionality
 */

import type { Block, Configuration } from '../types/index.ts';
import { loadTableData as loadSourceTableData, saveTableData as saveSourceTableData } from '../data/table-source.ts';
import { loadTableData as loadObjectTableData, saveTableData as saveObjectTableData } from '../data/table-object.ts';
import { loadTableData as loadSystemRequirementsTableData, saveTableData as saveSystemRequirementsTableData } from '../data/table-system-requirements.ts';
import { requestRefreshBlockInspector } from './window-facade.ts';

interface SystemRequirement {
  id: string;
  [key: string]: any;
}

interface SourceData {
  id: string;
  [key: string]: any;
}

interface ObjectData {
  id: string;
  [key: string]: any;
}

interface SystemConfigurations {
  configurations: Configuration[];
  activeConfigId: string;
}

// ============================================================================
// Base Command Class
// ============================================================================

export class Command {
  id: string;
  description: string;
  timestamp: number;

  constructor(description: string, timestamp?: number) {
    this.id = this.generateUUID();
    this.description = description;
    this.timestamp = timestamp || Date.now();
  }
  
  generateUUID(): string {
    return 'cmd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  execute(): void {
    throw new Error('execute() must be implemented by subclass');
  }
  
  undo(): void {
    throw new Error('undo() must be implemented by subclass');
  }
  
  redo(): void {
    this.execute();
  }
}

// ============================================================================
// Specific Command Types
// ============================================================================

/**
 * Command for setting a block parameter in Design Intent
 */
export class SetBlockParameterCommand extends Command {
  configId: string;
  blockId: string;
  parameterPath: string;
  oldValue: any;
  newValue: any;

  constructor(configId: string, blockId: string, parameterPath: string, oldValue: any, newValue: any) {
    super(`Set ${blockId}.${parameterPath} from ${oldValue} to ${newValue}`);
    this.configId = configId;
    this.blockId = blockId;
    this.parameterPath = parameterPath;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      const sysConfig = w.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg) {
        return;
      }
      const block = this.findBlock(cfg);
      this.setNestedValue(block, this.parameterPath, this.newValue);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      const sysConfig = w.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg) {
        return;
      }
      const block = this.findBlock(cfg);
      this.setNestedValue(block, this.parameterPath, this.oldValue);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
      if (!current) return undefined;
      current = current[parts[i]];
    }
    return current;
  }
  
  getConfig(): Configuration {
    const sysConfig = w.loadSystemConfigurations();
    return sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
  }
  
  findBlock(cfg: Configuration): Block {
    return cfg.blocks?.find((b: Block) => b.blockId === this.blockId)!;
  }
  
  setNestedValue(obj: any, path: string, value: any): void {
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
  
  refreshSystem(sysConfig: SystemConfigurations, cfg: Configuration): void {
    // Re-expand blocks to optical system
    if (w.expandBlocksToOpticalSystemRows) {
      const expanded = w.expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) {
        cfg.opticalSystemRows = expanded.rows;
      }
    }
    
    // Debug: Check value before save
    const cfgInSysConfig = sysConfig.configurations.find((c: Configuration) => c.name === cfg.name);
    const blockInSysConfig = cfgInSysConfig?.blocks?.find((b: Block) => b.blockId === this.blockId);
    this.getNestedValue(blockInSysConfig, this.parameterPath);
    
    // Save to localStorage (sysConfig already contains the changes made to cfg)
    if (w.saveSystemConfigurations) {
      w.saveSystemConfigurations(sysConfig);
      
      // Verify save
      const reloaded = w.loadSystemConfigurations();
      const reloadedCfg = reloaded.configurations.find((c: Configuration) => c.name === cfg.name);
      const reloadedBlock = reloadedCfg?.blocks.find((b: Block) => b.blockId === this.blockId);
      this.getNestedValue(reloadedBlock, this.parameterPath);
    }
    
    // Refresh UI
    if (w.refreshBlockInspector) {
      requestRefreshBlockInspector(w);
    }
    if (w.loadActiveConfigurationToTables) {
      w.loadActiveConfigurationToTables();
    }
    if (w.refreshAllUI) {
      w.refreshAllUI();
    }
  }
}

/**
 * Command for setting a surface field in the Surface Table
 */
export class SetSurfaceFieldCommand extends Command {
  configId: string;
  surfaceId: string;
  field: string;
  oldValue: any;
  newValue: any;

  constructor(configId: string, surfaceId: string, field: string, oldValue: any, newValue: any) {
    super(`Set surface ${surfaceId} ${field} from ${oldValue} to ${newValue}`);
    this.configId = configId;
    this.surfaceId = surfaceId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute(): void {
    const cfg = this.getConfig();
    const surface = cfg.opticalSystemRows?.find((s: any) => s.id === this.surfaceId);
    if (surface) {
      (surface as any)[this.field] = this.newValue;
      this.saveAndRefresh();
    }
  }
  
  undo(): void {
    const cfg = this.getConfig();
    const surface = cfg.opticalSystemRows?.find((s: any) => s.id === this.surfaceId);
    if (surface) {
      (surface as any)[this.field] = this.oldValue;
      this.saveAndRefresh();
    }
  }
  
  getConfig(): Configuration {
    const sysConfig = w.loadSystemConfigurations();
    return sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
  }
  
  saveAndRefresh(): void {
    if (w.saveSystemConfigurations) {
      w.saveSystemConfigurations();
    }
    
    // Reload table to reflect changes
    if (w.loadActiveConfigurationToTables) {
      w.loadActiveConfigurationToTables();
    }
    
    if (w.refreshAllUI) {
      w.refreshAllUI();
    }
  }
}

/**
 * Command for setting a System Requirement field
 */
export class SetRequirementCommand extends Command {
  requirementId: string;
  field: string;
  oldValue: any;
  newValue: any;

  constructor(requirementId: string, field: string, oldValue: any, newValue: any) {
    super(`Set requirement ${requirementId} ${field}`);
    this.requirementId = requirementId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      // Load from systemRequirementsData localStorage key
      const data: any[] = loadSystemRequirementsTableData() as any;
      const req = data.find((r: SystemRequirement) => r.id === this.requirementId);
      if (req) {
        req[this.field] = this.newValue;
        saveSystemRequirementsTableData(data as any);
        this.refreshUI();
      }
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      // Load from systemRequirementsData localStorage key
      const data: any[] = loadSystemRequirementsTableData() as any;
      const req = data.find((r: SystemRequirement) => r.id === this.requirementId);
      if (req) {
        req[this.field] = this.oldValue;
        saveSystemRequirementsTableData(data as any);
        
        // Verify save
        const reloaded: any[] = loadSystemRequirementsTableData() as any;
        const reloadedReq = Array.isArray(reloaded)
          ? reloaded.find((r: any) => r && String(r.id) === String(this.requirementId))
          : null;
        reloadedReq?.[this.field];
        
        this.refreshUI();
      }
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  refreshUI(): void {
    if (w.systemRequirementsEditor) {
      w.systemRequirementsEditor.loadFromStorage();
      
      // Check if requirement data is correct
      const req = w.systemRequirementsEditor.requirements.find((r: SystemRequirement) => r.id === this.requirementId);
      req?.[this.field];
      
      w.systemRequirementsEditor.renderTable();
      
      // Verify UI after render
      setTimeout(() => {
        const reloadedReq = w.systemRequirementsEditor.requirements.find((r: SystemRequirement) => r.id === this.requirementId);
        reloadedReq?.[this.field];
      }, 100);
    }
  }
}

/**
 * Command for setting a Source (wavelength) field
 */
export class SetSourceFieldCommand extends Command {
  configId: string;
  sourceId: string;
  field: string;
  oldValue: any;
  newValue: any;

  constructor(configId: string, sourceId: string, field: string, oldValue: any, newValue: any) {
    super(`Set source ${sourceId} ${field}`);
    this.configId = configId;
    this.sourceId = sourceId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      const data: any[] = loadSourceTableData() as any;
      const source = Array.isArray(data)
        ? data.find((s: any) => s && String(s.id) === String(this.sourceId))
        : null;
      if (source) {
        source[this.field] = this.newValue;
        saveSourceTableData(data as any);
        this.refreshUI();
      }
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      const data: any[] = loadSourceTableData() as any;
      const source = Array.isArray(data)
        ? data.find((s: any) => s && String(s.id) === String(this.sourceId))
        : null;
      if (source) {
        source[this.field] = this.oldValue;
        saveSourceTableData(data as any);
        this.refreshUI();
      }
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  refreshUI(): void {
    if (w.tableSource && w.loadSourceTableData) {
      const data = w.loadSourceTableData();
      w.tableSource.replaceData(data);
    }
  }
}

/**
 * Command for setting an Object (field point) field
 */
export class SetObjectFieldCommand extends Command {
  configId: string;
  objectId: string;
  field: string;
  oldValue: any;
  newValue: any;

  constructor(configId: string, objectId: string, field: string, oldValue: any, newValue: any) {
    super(`Set object ${objectId} ${field}`);
    this.configId = configId;
    this.objectId = objectId;
    this.field = field;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
  
  execute(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      const data: any[] = loadObjectTableData() as any;
      const obj = Array.isArray(data)
        ? data.find((o: any) => o && String(o.id) === String(this.objectId))
        : null;
      if (obj) {
        obj[this.field] = this.newValue;
        saveObjectTableData(data as any);
        this.refreshUI();
      }
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    if (w.undoHistory) {
      w.undoHistory.isExecuting = true;
    }
    try {
      const data: any[] = loadObjectTableData() as any;
      const obj = Array.isArray(data)
        ? data.find((o: any) => o && String(o.id) === String(this.objectId))
        : null;
      if (obj) {
        obj[this.field] = this.oldValue;
        saveObjectTableData(data as any);
        
        // Verify save
        const reloaded: any[] = loadObjectTableData() as any;
        const reloadedObj = Array.isArray(reloaded)
          ? reloaded.find((o: any) => o && String(o.id) === String(this.objectId))
          : null;
        reloadedObj?.[this.field];
        
        this.refreshUI();
      }
    } finally {
      if (w.undoHistory) {
        w.undoHistory.isExecuting = false;
      }
    }
  }
  
  getConfig(): Configuration {
    const sysConfig = w.loadSystemConfigurations();
    return sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
  }
  
  refreshUI(): void {
    if (w.tableObject && w.loadObjectTableData) {
      const data = w.loadObjectTableData();
      w.tableObject.replaceData(data);
    }
  }
}

/**
 * Command for adding a block
 */
export class AddBlockCommand extends Command {
  configId: string;
  blockData: Block;
  insertIndex: number;

  constructor(configId: string, blockData: Block, insertIndex: number) {
    super(`Add block ${blockData.blockId}`);
    this.configId = configId;
    this.blockData = blockData;
    this.insertIndex = insertIndex;
  }
  
  execute(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const sysConfig = w.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.insertIndex, 0, this.blockData);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const sysConfig = w.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.insertIndex, 1);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  refreshSystem(sysConfig: SystemConfigurations, cfg: Configuration): void {
    if (w.expandBlocksToOpticalSystemRows) {
      const expanded = w.expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) cfg.opticalSystemRows = expanded.rows;
    }
    if (w.saveSystemConfigurations) w.saveSystemConfigurations(sysConfig);
    if (w.refreshBlockInspector) requestRefreshBlockInspector(w);
    if (w.loadActiveConfigurationToTables) w.loadActiveConfigurationToTables();
    if (w.refreshAllUI) w.refreshAllUI();
  }
}

/**
 * Command for deleting a block
 */
export class DeleteBlockCommand extends Command {
  configId: string;
  blockData: Block;
  blockIndex: number;

  constructor(configId: string, blockData: Block, blockIndex: number) {
    super(`Delete block ${blockData.blockId}`);
    this.configId = configId;
    this.blockData = blockData;
    this.blockIndex = blockIndex;
  }
  
  execute(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const sysConfig = w.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.blockIndex, 1);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const sysConfig = w.loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.blockIndex, 0, this.blockData);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  refreshSystem(sysConfig: SystemConfigurations, cfg: Configuration): void {
    if (w.expandBlocksToOpticalSystemRows) {
      const expanded = w.expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) cfg.opticalSystemRows = expanded.rows;
    }
    if (w.saveSystemConfigurations) w.saveSystemConfigurations(sysConfig);
    if (w.refreshBlockInspector) requestRefreshBlockInspector(w);
    if (w.loadActiveConfigurationToTables) w.loadActiveConfigurationToTables();
    if (w.refreshAllUI) w.refreshAllUI();
  }
}

/**
 * Command for adding a source/object/requirement
 */
export class AddRowCommand extends Command {
  tableName: string;
  rowData: any;
  rowIndex: number;

  constructor(tableName: string, rowData: any, rowIndex: number, autoExecute: boolean = false) {
    super(`Add ${tableName} row`);
    this.tableName = tableName;
    this.rowData = rowData;
    this.rowIndex = rowIndex;
    if (autoExecute) {
      this.execute();
    }
  }
  
  execute(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      data.splice(this.rowIndex, 0, this.rowData);
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if (w.undoHistory) w.undoHistory.isExecuting = false;
      this.refreshUI();
      if (w.undoHistory) w.undoHistory.isExecuting = true;
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      data.splice(this.rowIndex, 1);
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if (w.undoHistory) w.undoHistory.isExecuting = false;
      this.refreshUI();
      if (w.undoHistory) w.undoHistory.isExecuting = true;
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  getStorageKey(): string {
    const keyMap: Record<string, string> = {
      'source': 'sourceTableData',
      'object': 'objectTableData',
      'requirement': 'systemRequirementsData'
    };
    return keyMap[this.tableName] || 'sourceTableData';
  }
  
  refreshUI(): void {
    if (this.tableName === 'source' && w.tableSource && w.loadSourceTableData) {
      w.tableSource.replaceData(w.loadSourceTableData());
    } else if (this.tableName === 'object' && w.tableObject && w.loadObjectTableData) {
      w.tableObject.replaceData(w.loadObjectTableData());
    } else if (this.tableName === 'requirement' && w.systemRequirementsEditor) {
      w.systemRequirementsEditor.loadFromStorage();
      w.systemRequirementsEditor.renderTable();
    }
  }
}

/**
 * Command for deleting a source/object/requirement
 */
export class DeleteRowCommand extends Command {
  tableName: string;
  rowData: any;
  rowIndex: number;

  constructor(tableName: string, rowData: any, rowIndex: number, autoExecute: boolean = false) {
    super(`Delete ${tableName} row`);
    this.tableName = tableName;
    this.rowData = rowData;
    this.rowIndex = rowIndex;
    if (autoExecute) {
      this.execute();
    }
  }
  
  execute(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      data.splice(this.rowIndex, 1);
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if (w.undoHistory) w.undoHistory.isExecuting = false;
      this.refreshUI();
      if (w.undoHistory) w.undoHistory.isExecuting = true;
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      data.splice(this.rowIndex, 0, this.rowData);
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if (w.undoHistory) w.undoHistory.isExecuting = false;
      this.refreshUI();
      if (w.undoHistory) w.undoHistory.isExecuting = true;
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }
  
  getStorageKey(): string {
    const keyMap: Record<string, string> = {
      'source': 'sourceTableData',
      'object': 'objectTableData',
      'requirement': 'systemRequirementsData'
    };
    return keyMap[this.tableName] || 'sourceTableData';
  }
  
  refreshUI(): void {
    if (this.tableName === 'source' && w.tableSource && w.loadSourceTableData) {
      w.tableSource.replaceData(w.loadSourceTableData());
    } else if (this.tableName === 'object' && w.tableObject && w.loadObjectTableData) {
      w.tableObject.replaceData(w.loadObjectTableData());
    } else if (this.tableName === 'requirement' && w.systemRequirementsEditor) {
      w.systemRequirementsEditor.loadFromStorage();
      w.systemRequirementsEditor.renderTable();
    }
  }
}

/**
 * Compound Command - groups multiple commands into one undo/redo action
 * Useful for operations that trigger multiple changes (e.g., gap auto-update)
 */
export class CompoundCommand extends Command {
  commands: Command[];

  constructor(description: string, commands?: Command[]) {
    super(description);
    this.commands = commands || [];
  }
  
  execute(): void {
    for (const cmd of this.commands) {
      cmd.execute();
    }
  }
  
  undo(): void {
    // Undo in reverse order
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i].undo();
    }
  }
  
  addCommand(command: Command): void {
    this.commands.push(command);
  }
}

// ============================================================================
// Undo History Manager
// ============================================================================

export class UndoHistory {
  undoStack: Command[];
  redoStack: Command[];
  maxSize: number;
  isExecuting: boolean;

  constructor(maxSize: number = 100) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSize = maxSize;
    this.isExecuting = false;
  }
  
  /**
   * Record a new command in the undo history
   */
  record(command: Command): void {
    if (this.isExecuting) {
      return; // Don't record undo/redo operations
    }
    
    this.undoStack.push(command);
    this.redoStack = []; // Clear redo stack on new command
    
    // Limit stack size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    
    this.notifyListeners();
  }
  
  /**
   * Undo the last command
   */
  undo(): boolean {
    if (this.undoStack.length === 0) {
      return false;
    }
    
    this.isExecuting = true;
    try {
      const command = this.undoStack.pop()!;
      command.undo();
      this.redoStack.push(command);
      this.notifyListeners();
      return true;
    } catch (_error) {
      return false;
    } finally {
      this.isExecuting = false;
    }
  }
  
  /**
   * Redo the last undone command
   */
  redo(): boolean {
    if (this.redoStack.length === 0) {
      return false;
    }
    
    this.isExecuting = true;
    try {
      const command = this.redoStack.pop()!;
      command.execute();
      this.undoStack.push(command);
      this.notifyListeners();
      return true;
    } catch (_error) {
      return false;
    } finally {
      this.isExecuting = false;
    }
  }
  
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  
  /**
   * Clear all history (called on config switch, import, load)
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.notifyListeners();
  }
  
  /**
   * Update UI button states
   */
  notifyListeners(): void {
    const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement | null;
    const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement | null;
    
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
  getInfo(): {
    undoStackSize: number;
    redoStackSize: number;
    canUndo: boolean;
    canRedo: boolean;
    isExecuting: boolean;
  } {
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
  w.undoHistory = new UndoHistory();
  
  // Export command classes for use in other modules
  w.Command = Command;
  w.SetBlockParameterCommand = SetBlockParameterCommand;
  w.SetSurfaceFieldCommand = SetSurfaceFieldCommand;
  w.SetRequirementCommand = SetRequirementCommand;
  w.SetSourceFieldCommand = SetSourceFieldCommand;
  w.SetObjectFieldCommand = SetObjectFieldCommand;
  w['AddBlockCommand'] = AddBlockCommand;
  w.DeleteBlockCommand = DeleteBlockCommand;
  w['AddRowCommand'] = AddRowCommand;
  w.DeleteRowCommand = DeleteRowCommand;
  w.CompoundCommand = CompoundCommand;
  w.UndoHistory = UndoHistory;
}
