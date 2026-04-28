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
 * Command for setting all requirement enabled flags in a single undo step
 */
export class SetRequirementEnabledBulkCommand extends Command {
  beforeRows: any[];
  afterRows: any[];
  enabled: boolean;

  constructor(beforeRows: any[], afterRows: any[], enabled: boolean) {
    super(`Set all requirements ${enabled ? 'ON' : 'OFF'}`);
    this.beforeRows = Array.isArray(beforeRows) ? JSON.parse(JSON.stringify(beforeRows)) : [];
    this.afterRows = Array.isArray(afterRows) ? JSON.parse(JSON.stringify(afterRows)) : [];
    this.enabled = !!enabled;
  }

  execute(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      saveSystemRequirementsTableData(JSON.parse(JSON.stringify(this.afterRows)) as any);
      this.refreshUI();
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }

  undo(): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      saveSystemRequirementsTableData(JSON.parse(JSON.stringify(this.beforeRows)) as any);
      this.refreshUI();
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
    }
  }

  refreshUI(): void {
    if (w.systemRequirementsEditor) {
      w.systemRequirementsEditor.loadFromStorage();
      w.systemRequirementsEditor.renderTable();
      if (typeof w.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
        w.systemRequirementsEditor.scheduleEvaluateAndUpdate();
      }
    }
  }
}

/**
 * Command for setting Design Intent parameter/aperture optimize mode in bulk
 */
export class SetDesignIntentOptimizeBulkCommand extends Command {
  configId: string;
  beforeBlocks: any[];
  afterBlocks: any[];

  constructor(configId: string, beforeBlocks: any[], afterBlocks: any[], enabled: boolean) {
    super(`Design Intent Parameter All ${enabled ? 'ON' : 'OFF'}`);
    this.configId = String(configId ?? '');
    this.beforeBlocks = Array.isArray(beforeBlocks) ? JSON.parse(JSON.stringify(beforeBlocks)) : [];
    this.afterBlocks = Array.isArray(afterBlocks) ? JSON.parse(JSON.stringify(afterBlocks)) : [];
  }

  execute(): void {
    this.applyBlocks(this.afterBlocks);
  }

  undo(): void {
    this.applyBlocks(this.beforeBlocks);
  }

  private applyBlocks(blocksSnapshot: any[]): void {
    if (w.undoHistory) w.undoHistory.isExecuting = true;
    try {
      const sysConfig = w.loadSystemConfigurations?.();
      if (!sysConfig || !Array.isArray(sysConfig.configurations)) return;

      const cfg = sysConfig.configurations.find((c: any) => c && (String(c.id) === this.configId || String(c.name) === this.configId));
      if (!cfg) return;

      cfg.blocks = Array.isArray(blocksSnapshot) ? JSON.parse(JSON.stringify(blocksSnapshot)) : [];

      if (w.expandBlocksToOpticalSystemRows) {
        const expanded = w.expandBlocksToOpticalSystemRows(cfg.blocks);
        if (expanded && expanded.rows) cfg.opticalSystemRows = expanded.rows;
      }

      if (w.saveSystemConfigurations) w.saveSystemConfigurations(sysConfig);
      if (w.refreshBlockInspector) requestRefreshBlockInspector(w);
      if (w.loadActiveConfigurationToTables) w.loadActiveConfigurationToTables();
      if (w.refreshAllUI) w.refreshAllUI();
    } finally {
      if (w.undoHistory) w.undoHistory.isExecuting = false;
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
      if (typeof w.systemRequirementsEditor.syncRequirementsToSystemConfigFromStorage === 'function') {
        w.systemRequirementsEditor.syncRequirementsToSystemConfigFromStorage();
      }
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
      if (typeof w.systemRequirementsEditor.syncRequirementsToSystemConfigFromStorage === 'function') {
        w.systemRequirementsEditor.syncRequirementsToSystemConfigFromStorage();
      }
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

  private isOptimizationLike(command: any): boolean {
    if (!command || typeof command !== 'object') return false;
    if (command.__cooptOptimizationCommand === true) return true;
    const name = String(command.name ?? '').trim();
    const description = String(command.description ?? '').trim();
    return name === 'Optimization'
      || description === 'Optimization'
      || name.startsWith('Optimization ')
      || description.startsWith('Optimization ');
  }

  private describeCommand(command: any): Record<string, any> {
    if (!command || typeof command !== 'object') {
      return { kind: 'unknown' };
    }
    return {
      description: String(command.description ?? command.name ?? ''),
      timestamp: Number(command.timestamp ?? 0),
      isOptimization: this.isOptimizationLike(command),
      isTrailing: command.__cooptPostOptimizationTrailing === true,
    };
  }

  private logOptimizationUndoDebug(reason: string): void {
    try {
      const recentUndo = this.undoStack.slice(-4).map((command, index) => ({
        index: this.undoStack.length - Math.min(4, this.undoStack.length) + index,
        ...this.describeCommand(command),
      }));
      const recentRedo = this.redoStack.slice(-2).map((command, index) => ({
        index: this.redoStack.length - Math.min(2, this.redoStack.length) + index,
        ...this.describeCommand(command),
      }));
      console.log('🧭 [UndoHistory][Optimize]', {
        reason,
        undoSize: this.undoStack.length,
        redoSize: this.redoStack.length,
        recentUndo,
        recentRedo,
      });
    } catch (_) {}
  }

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

    let isOptimizationCommand = false;

    try {
      const suppressUntil = Number((globalThis as any).__cooptUndoRecordSuppressedUntil || 0);
      if (Number.isFinite(suppressUntil) && Date.now() < suppressUntil) {
        return;
      }
    } catch (_) {}

    try {
      const lastOptimizationAt = Number((globalThis as any).__cooptLastOptimizationUndoRecordAt || 0);
      isOptimizationCommand = this.isOptimizationLike(command as any);
      if (!isOptimizationCommand && Number.isFinite(lastOptimizationAt) && lastOptimizationAt > 0) {
        const dt = Date.now() - lastOptimizationAt;
        if (dt >= 0 && dt < 10000) {
          (command as any).__cooptPostOptimizationTrailing = true;
        }
      }
    } catch (_) {}

    try {
      if (isOptimizationCommand && this.undoStack.length > 0) {
        const top = this.undoStack[this.undoStack.length - 1] as any;
        const topIsOptimization = this.isOptimizationLike(top);
        if (topIsOptimization) {
          const incomingIsMainOptimization = (command as any)?.__cooptOptimizationCommand === true;
          const topIsMainOptimization = top?.__cooptOptimizationCommand === true;
          const topTs = Number(top?.timestamp ?? 0);
          const nextTs = Number((command as any)?.timestamp ?? Date.now());
          const closeInTime = Number.isFinite(topTs) && Number.isFinite(nextTs)
            && Math.abs(nextTs - topTs) < 10000;
          if (closeInTime) {
            if (topIsMainOptimization && !incomingIsMainOptimization) {
              this.logOptimizationUndoDebug('skip-trailing-after-main');
              return;
            }
            if (!topIsMainOptimization && incomingIsMainOptimization) {
              this.undoStack[this.undoStack.length - 1] = command;
              this.redoStack = [];
              this.logOptimizationUndoDebug('replace-trailing-with-main');
              this.notifyListeners();
              return;
            }
            this.undoStack[this.undoStack.length - 1] = command;
            this.redoStack = [];
            this.logOptimizationUndoDebug('dedupe-optimization-record');
            this.notifyListeners();
            return;
          }
        }
      }
    } catch (_) {}
    
    this.undoStack.push(command);
    this.redoStack = []; // Clear redo stack on new command

    try {
      if (isOptimizationCommand || (command as any)?.__cooptPostOptimizationTrailing === true) {
        this.logOptimizationUndoDebug('record');
      }
    } catch (_) {}
    
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

    this.logOptimizationUndoDebug('undo-before');

    try {
      while (this.undoStack.length >= 2) {
        const top = this.undoStack[this.undoStack.length - 1] as any;
        const prev = this.undoStack[this.undoStack.length - 2] as any;
        const prevIsOptimization = this.isOptimizationLike(prev);
        if (!prevIsOptimization) break;

        const trailing = top?.__cooptPostOptimizationTrailing === true;
        if (!trailing) break;

        this.undoStack.pop();
        this.logOptimizationUndoDebug('undo-collapse-trailing');
      }
    } catch (_) {}
    
    this.isExecuting = true;
    const command = this.undoStack.pop()!;
    try {
      const described = this.describeCommand(command as any);
      if (described.isOptimization || described.isTrailing) {
        console.log('🧭 [UndoHistory][Optimize]', { reason: 'undo-pop', command: described });
      }
    } catch (_) {}
    try {
      const result = command.undo();
      this.redoStack.push(command);
      this.logOptimizationUndoDebug('undo-after-push-redo');
      this.notifyListeners();
      if (result && typeof (result as any).then === 'function') {
        // Async undo: keep isExecuting=true until the promise settles to prevent
        // table-change events triggered by loadActiveConfigurationToTables from
        // being recorded as new undo commands.
        (result as Promise<any>).catch(() => {}).finally(() => {
          this.isExecuting = false;
        });
      } else {
        this.isExecuting = false;
      }
      return true;
    } catch (_error) {
      this.isExecuting = false;
      return false;
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
    const command = this.redoStack.pop()!;
    try {
      const result = command.execute();
      this.undoStack.push(command);
      this.notifyListeners();
      if (result && typeof (result as any).then === 'function') {
        (result as Promise<any>).catch(() => {}).finally(() => {
          this.isExecuting = false;
        });
      } else {
        this.isExecuting = false;
      }
      return true;
    } catch (_error) {
      this.isExecuting = false;
      return false;
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
  w.SetRequirementEnabledBulkCommand = SetRequirementEnabledBulkCommand;
  w.SetDesignIntentOptimizeBulkCommand = SetDesignIntentOptimizeBulkCommand;
  w.SetSourceFieldCommand = SetSourceFieldCommand;
  w.SetObjectFieldCommand = SetObjectFieldCommand;
  w['AddBlockCommand'] = AddBlockCommand;
  w.DeleteBlockCommand = DeleteBlockCommand;
  w['AddRowCommand'] = AddRowCommand;
  w.DeleteRowCommand = DeleteRowCommand;
  w.CompoundCommand = CompoundCommand;
  w.UndoHistory = UndoHistory;
}
