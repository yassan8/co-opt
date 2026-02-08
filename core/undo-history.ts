/**
 * Undo/Redo System for Co-Opt
 * Implements Command Pattern for system-wide undo functionality
 */

import type { Block, Configuration } from '../types/index.js';

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
    console.log('[Undo] execute() called');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      const sysConfig = (window as any).loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      const block = this.findBlock(cfg);
      this.setNestedValue(block, this.parameterPath, this.newValue);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
      console.log('[Undo] execute() completed');
    }
  }
  
  undo(): void {
    console.log('[Undo] SetBlockParameterCommand.undo() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      const sysConfig = (window as any).loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      console.log('[Undo] Config found:', cfg ? cfg.name : 'null');
      const block = this.findBlock(cfg);
      console.log('[Undo] Block found:', block ? block.blockId : 'null');
      console.log('[Undo] Setting', this.parameterPath, 'to', this.oldValue);
      this.setNestedValue(block, this.parameterPath, this.oldValue);
      console.log('[Undo] After setNestedValue, block value is:', this.getNestedValue(block, this.parameterPath));
      console.log('[Undo] Value set, calling refreshSystem');
      this.refreshSystem(sysConfig, cfg);
      console.log('[Undo] SetBlockParameterCommand.undo() completed');
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
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
    const sysConfig = (window as any).loadSystemConfigurations();
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
    console.log('[Undo] refreshSystem() starting');
    
    // Re-expand blocks to optical system
    if ((window as any).expandBlocksToOpticalSystemRows) {
      console.log('[Undo] Expanding blocks to optical system');
      const expanded = (window as any).expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) {
        cfg.opticalSystemRows = expanded.rows;
        console.log('[Undo] Optical system updated');
      }
    }
    
    // Debug: Check value before save
    const cfgInSysConfig = sysConfig.configurations.find((c: Configuration) => c.name === cfg.name);
    const blockInSysConfig = cfgInSysConfig?.blocks?.find((b: Block) => b.blockId === this.blockId);
    console.log('[Undo] Before save, value in sysConfig:', this.getNestedValue(blockInSysConfig, this.parameterPath));
    
    // Save to localStorage (sysConfig already contains the changes made to cfg)
    if ((window as any).saveSystemConfigurations) {
      console.log('[Undo] Saving system configurations');
      (window as any).saveSystemConfigurations(sysConfig);
      
      // Verify save
      const reloaded = (window as any).loadSystemConfigurations();
      const reloadedCfg = reloaded.configurations.find((c: Configuration) => c.name === cfg.name);
      const reloadedBlock = reloadedCfg?.blocks.find((b: Block) => b.blockId === this.blockId);
      console.log('[Undo] After save, reloaded value:', this.getNestedValue(reloadedBlock, this.parameterPath));
    }
    
    // Refresh UI
    if ((window as any).refreshBlockInspector) {
      console.log('[Undo] Calling refreshBlockInspector');
      (window as any).refreshBlockInspector();
    }
    if ((window as any).loadActiveConfigurationToTables) {
      console.log('[Undo] Calling loadActiveConfigurationToTables');
      (window as any).loadActiveConfigurationToTables();
    }
    if ((window as any).refreshAllUI) {
      console.log('[Undo] Calling refreshAllUI');
      (window as any).refreshAllUI();
    }
    console.log('[Undo] refreshSystem() completed');
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
    const sysConfig = (window as any).loadSystemConfigurations();
    return sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
  }
  
  saveAndRefresh(): void {
    if ((window as any).saveSystemConfigurations) {
      (window as any).saveSystemConfigurations();
    }
    
    // Reload table to reflect changes
    if ((window as any).loadActiveConfigurationToTables) {
      (window as any).loadActiveConfigurationToTables();
    }
    
    if ((window as any).refreshAllUI) {
      (window as any).refreshAllUI();
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
    console.log('[Undo] SetRequirementCommand.execute() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      // Load from systemRequirementsData localStorage key
      const json = localStorage.getItem('systemRequirementsData');
      const data: SystemRequirement[] = json ? JSON.parse(json) : [];
      const req = data.find((r: SystemRequirement) => r.id === this.requirementId);
      if (req) {
        console.log(`[Undo] Setting ${this.field} from ${req[this.field]} to ${this.newValue}`);
        req[this.field] = this.newValue;
        localStorage.setItem('systemRequirementsData', JSON.stringify(data));
        console.log('[Undo] Saved to systemRequirementsData');
        this.refreshUI();
      }
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    console.log('[Undo] SetRequirementCommand.undo() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      // Load from systemRequirementsData localStorage key
      const json = localStorage.getItem('systemRequirementsData');
      const data: SystemRequirement[] = json ? JSON.parse(json) : [];
      const req = data.find((r: SystemRequirement) => r.id === this.requirementId);
      if (req) {
        console.log(`[Undo] Setting ${this.field} from ${req[this.field]} to ${this.oldValue}`);
        req[this.field] = this.oldValue;
        localStorage.setItem('systemRequirementsData', JSON.stringify(data));
        console.log('[Undo] Saved to systemRequirementsData');
        
        // Verify save
        const reloaded: SystemRequirement[] = JSON.parse(localStorage.getItem('systemRequirementsData') || '[]');
        const reloadedReq = reloaded.find((r: SystemRequirement) => r.id === this.requirementId);
        console.log(`[Undo] After save, reloaded value for ${this.field}:`, reloadedReq?.[this.field]);
        
        console.log('[Undo] Calling refreshUI()...');
        this.refreshUI();
      }
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
    }
  }
  
  refreshUI(): void {
    console.log('[Undo] SetRequirementCommand.refreshUI() called');
    if ((window as any).systemRequirementsEditor) {
      console.log('[Undo] Calling systemRequirementsEditor.loadFromStorage()...');
      (window as any).systemRequirementsEditor.loadFromStorage();
      console.log('[Undo] loadFromStorage() completed, requirements:', (window as any).systemRequirementsEditor.requirements);
      
      // Check if requirement data is correct
      const req = (window as any).systemRequirementsEditor.requirements.find((r: SystemRequirement) => r.id === this.requirementId);
      console.log(`[Undo] Requirement ${this.requirementId} data after loadFromStorage:`, req);
      console.log(`[Undo] Field ${this.field} value:`, req?.[this.field]);
      
      console.log('[Undo] Calling systemRequirementsEditor.renderTable()...');
      (window as any).systemRequirementsEditor.renderTable();
      console.log('[Undo] renderTable() completed');
      
      // Verify UI after render
      setTimeout(() => {
        const reloadedReq = (window as any).systemRequirementsEditor.requirements.find((r: SystemRequirement) => r.id === this.requirementId);
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
    console.log('[Undo] SetSourceFieldCommand.execute() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      // Load from sourceTableData localStorage key
      const json = localStorage.getItem('sourceTableData');
      const data: SourceData[] = json ? JSON.parse(json) : [];
      const source = data.find((s: SourceData) => s.id === this.sourceId);
      if (source) {
        console.log(`[Undo] Setting ${this.field} from ${source[this.field]} to ${this.newValue}`);
        source[this.field] = this.newValue;
        localStorage.setItem('sourceTableData', JSON.stringify(data));
        console.log('[Undo] Saved to sourceTableData');
        this.refreshUI();
      }
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    console.log('[Undo] SetSourceFieldCommand.undo() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      // Load from sourceTableData localStorage key
      const json = localStorage.getItem('sourceTableData');
      const data: SourceData[] = json ? JSON.parse(json) : [];
      const source = data.find((s: SourceData) => s.id === this.sourceId);
      if (source) {
        console.log(`[Undo] Setting ${this.field} from ${source[this.field]} to ${this.oldValue}`);
        source[this.field] = this.oldValue;
        localStorage.setItem('sourceTableData', JSON.stringify(data));
        console.log('[Undo] Saved to sourceTableData');
        this.refreshUI();
      }
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
    }
  }
  
  refreshUI(): void {
    console.log('[Undo] SetSourceFieldCommand.refreshUI() called');
    console.log('[Undo] window.tableSource exists:', !!(window as any).tableSource);
    console.log('[Undo] window.loadSourceTableData exists:', !!(window as any).loadSourceTableData);
    if ((window as any).tableSource && (window as any).loadSourceTableData) {
      console.log('[Undo] Calling loadSourceTableData()...');
      const data = (window as any).loadSourceTableData();
      console.log('[Undo] Loaded data:', data);
      console.log('[Undo] Calling tableSource.replaceData()...');
      (window as any).tableSource.replaceData(data);
      console.log('[Undo] tableSource.replaceData() completed');
    } else {
      console.error('[Undo] Cannot refresh UI - missing tableSource or loadSourceTableData');
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
    console.log('[Undo] SetObjectFieldCommand.execute() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      // Load from objectTableData localStorage key
      const json = localStorage.getItem('objectTableData');
      const data: ObjectData[] = json ? JSON.parse(json) : [];
      const obj = data.find((o: ObjectData) => o.id === this.objectId);
      if (obj) {
        console.log(`[Undo] Setting ${this.field} from ${obj[this.field]} to ${this.newValue}`);
        obj[this.field] = this.newValue;
        localStorage.setItem('objectTableData', JSON.stringify(data));
        console.log('[Undo] Saved to objectTableData');
        this.refreshUI();
      }
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
    }
  }
  
  undo(): void {
    console.log('[Undo] SetObjectFieldCommand.undo() starting');
    if ((window as any).undoHistory) {
      (window as any).undoHistory.isExecuting = true;
    }
    try {
      // Load from objectTableData localStorage key
      const json = localStorage.getItem('objectTableData');
      const data: ObjectData[] = json ? JSON.parse(json) : [];
      const obj = data.find((o: ObjectData) => o.id === this.objectId);
      if (obj) {
        console.log(`[Undo] Setting ${this.field} from ${obj[this.field]} to ${this.oldValue}`);
        obj[this.field] = this.oldValue;
        localStorage.setItem('objectTableData', JSON.stringify(data));
        console.log('[Undo] Saved to objectTableData');
        
        // Verify save
        const reloaded: ObjectData[] = JSON.parse(localStorage.getItem('objectTableData') || '[]');
        const reloadedObj = reloaded.find((o: ObjectData) => o.id === this.objectId);
        console.log(`[Undo] After save, reloaded value for ${this.field}:`, reloadedObj?.[this.field]);
        
        console.log('[Undo] Calling refreshUI()...');
        this.refreshUI();
        console.log('[Undo] refreshUI() completed');
      } else {
        console.error('[Undo] Object not found! objectId:', this.objectId);
      }
    } finally {
      if ((window as any).undoHistory) {
        (window as any).undoHistory.isExecuting = false;
      }
    }
  }
  
  getConfig(): Configuration {
    const sysConfig = (window as any).loadSystemConfigurations();
    return sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
  }
  
  refreshUI(): void {
    console.log('[Undo] SetObjectFieldCommand.refreshUI() called');
    console.log('[Undo] window.tableObject exists:', !!(window as any).tableObject);
    console.log('[Undo] window.loadObjectTableData exists:', !!(window as any).loadObjectTableData);
    if ((window as any).tableObject && (window as any).loadObjectTableData) {
      console.log('[Undo] Calling loadObjectTableData()...');
      const data = (window as any).loadObjectTableData();
      console.log('[Undo] Loaded data:', data);
      console.log('[Undo] Calling tableObject.replaceData()...');
      (window as any).tableObject.replaceData(data);
      console.log('[Undo] tableObject.replaceData() completed');
    } else {
      console.error('[Undo] Cannot refresh UI - missing tableObject or loadObjectTableData');
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
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const sysConfig = (window as any).loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.insertIndex, 0, this.blockData);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const sysConfig = (window as any).loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.insertIndex, 1);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
  }
  
  refreshSystem(sysConfig: SystemConfigurations, cfg: Configuration): void {
    if ((window as any).expandBlocksToOpticalSystemRows) {
      const expanded = (window as any).expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) cfg.opticalSystemRows = expanded.rows;
    }
    if ((window as any).saveSystemConfigurations) (window as any).saveSystemConfigurations(sysConfig);
    if ((window as any).refreshBlockInspector) (window as any).refreshBlockInspector();
    if ((window as any).loadActiveConfigurationToTables) (window as any).loadActiveConfigurationToTables();
    if ((window as any).refreshAllUI) (window as any).refreshAllUI();
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
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const sysConfig = (window as any).loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.blockIndex, 1);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const sysConfig = (window as any).loadSystemConfigurations();
      const cfg = sysConfig.configurations.find((c: Configuration) => c.name === this.configId);
      if (!cfg || !Array.isArray(cfg.blocks)) return;
      
      cfg.blocks.splice(this.blockIndex, 0, this.blockData);
      this.refreshSystem(sysConfig, cfg);
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
  }
  
  refreshSystem(sysConfig: SystemConfigurations, cfg: Configuration): void {
    if ((window as any).expandBlocksToOpticalSystemRows) {
      const expanded = (window as any).expandBlocksToOpticalSystemRows(cfg.blocks);
      if (expanded && expanded.rows) cfg.opticalSystemRows = expanded.rows;
    }
    if ((window as any).saveSystemConfigurations) (window as any).saveSystemConfigurations(sysConfig);
    if ((window as any).refreshBlockInspector) (window as any).refreshBlockInspector();
    if ((window as any).loadActiveConfigurationToTables) (window as any).loadActiveConfigurationToTables();
    if ((window as any).refreshAllUI) (window as any).refreshAllUI();
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
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      data.splice(this.rowIndex, 0, this.rowData);
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
      this.refreshUI();
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    console.log('[DEBUG AddRowCommand.undo] Called:', {
      tableName: this.tableName,
      rowIndex: this.rowIndex,
      rowDataId: this.rowData?.id
    });
    
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      console.log('[DEBUG AddRowCommand.undo] Before splice:', { dataLength: data.length });
      data.splice(this.rowIndex, 1);
      console.log('[DEBUG AddRowCommand.undo] After splice:', { dataLength: data.length });
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
      this.refreshUI();
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
    console.log('[DEBUG AddRowCommand.undo] Completed');
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
    if (this.tableName === 'source' && (window as any).tableSource && (window as any).loadSourceTableData) {
      (window as any).tableSource.replaceData((window as any).loadSourceTableData());
    } else if (this.tableName === 'object' && (window as any).tableObject && (window as any).loadObjectTableData) {
      (window as any).tableObject.replaceData((window as any).loadObjectTableData());
    } else if (this.tableName === 'requirement' && (window as any).systemRequirementsEditor) {
      (window as any).systemRequirementsEditor.loadFromStorage();
      (window as any).systemRequirementsEditor.renderTable();
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
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      data.splice(this.rowIndex, 1);
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
      this.refreshUI();
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
  }
  
  undo(): void {
    console.log('[DEBUG DeleteRowCommand.undo] Called:', {
      tableName: this.tableName,
      rowIndex: this.rowIndex,
      rowDataId: this.rowData?.id
    });
    
    if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    try {
      const storageKey = this.getStorageKey();
      const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
      console.log('[DEBUG DeleteRowCommand.undo] Before splice:', { dataLength: data.length });
      data.splice(this.rowIndex, 0, this.rowData);
      console.log('[DEBUG DeleteRowCommand.undo] After splice:', { dataLength: data.length });
      localStorage.setItem(storageKey, JSON.stringify(data));
      
      // Temporarily set isExecuting to false for refreshUI to work properly
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
      this.refreshUI();
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = true;
    } finally {
      if ((window as any).undoHistory) (window as any).undoHistory.isExecuting = false;
    }
    console.log('[DEBUG DeleteRowCommand.undo] Completed');
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
    if (this.tableName === 'source' && (window as any).tableSource && (window as any).loadSourceTableData) {
      (window as any).tableSource.replaceData((window as any).loadSourceTableData());
    } else if (this.tableName === 'object' && (window as any).tableObject && (window as any).loadObjectTableData) {
      (window as any).tableObject.replaceData((window as any).loadObjectTableData());
    } else if (this.tableName === 'requirement' && (window as any).systemRequirementsEditor) {
      (window as any).systemRequirementsEditor.loadFromStorage();
      (window as any).systemRequirementsEditor.renderTable();
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
  undo(): boolean {
    console.log('[Undo] undo() called, stack size:', this.undoStack.length);
    if (this.undoStack.length === 0) {
      console.log('[Undo] Nothing to undo');
      return false;
    }
    
    this.isExecuting = true;
    try {
      const command = this.undoStack.pop()!;
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
  redo(): boolean {
    console.log('[Undo] redo() called, stack size:', this.redoStack.length);
    if (this.redoStack.length === 0) {
      console.log('[Undo] Nothing to redo');
      return false;
    }
    
    this.isExecuting = true;
    try {
      const command = this.redoStack.pop()!;
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
    console.log('[Undo] History cleared');
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
  (window as any).undoHistory = new UndoHistory();
  
  // Export command classes for use in other modules
  (window as any).Command = Command;
  (window as any).SetBlockParameterCommand = SetBlockParameterCommand;
  (window as any).SetSurfaceFieldCommand = SetSurfaceFieldCommand;
  (window as any).SetRequirementCommand = SetRequirementCommand;
  (window as any).SetSourceFieldCommand = SetSourceFieldCommand;
  (window as any).SetObjectFieldCommand = SetObjectFieldCommand;
  (window as any).AddBlockCommand = AddBlockCommand;
  (window as any).DeleteBlockCommand = DeleteBlockCommand;
  (window as any).AddRowCommand = AddRowCommand;
  (window as any).DeleteRowCommand = DeleteRowCommand;
  (window as any).CompoundCommand = CompoundCommand;
  (window as any).UndoHistory = UndoHistory;
}
