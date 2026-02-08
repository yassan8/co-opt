/**
 * JSDoc Type Annotations Examples
 * 既存のJSファイルに段階的に型を追加するためのリファレンス
 */

// ========================================
// Import types from type definitions
// ========================================

/**
 * @typedef {import('./index').Block} Block
 * @typedef {import('./index').Configuration} Configuration
 * @typedef {import('./index').OpticalSystemRow} OpticalSystemRow
 * @typedef {import('./index').Issue} Issue
 */

// ========================================
// Function with type annotations
// ========================================

/**
 * Validate a block configuration
 * @param {Block} block - The block to validate
 * @returns {Issue[]} Array of validation issues
 */
function validateBlock(block) {
  const issues = [];
  
  if (!block.blockId) {
    issues.push({
      severity: 'error',
      phase: 'validate',
      message: 'blockId is required'
    });
  }
  
  return issues;
}

/**
 * Expand blocks to optical system rows
 * @param {Block[]} blocks - Array of blocks
 * @returns {{ rows: OpticalSystemRow[], issues: Issue[] }}
 */
function expandBlocks(blocks) {
  return {
    rows: [],
    issues: []
  };
}

// ========================================
// Class with type annotations
// ========================================

/**
 * Configuration manager class
 */
class ConfigurationManager {
  /**
   * @param {Configuration} config - Initial configuration
   */
  constructor(config) {
    /** @type {Configuration} */
    this.config = config;
    
    /** @type {Issue[]} */
    this.issues = [];
  }
  
  /**
   * Get current configuration
   * @returns {Configuration}
   */
  getConfig() {
    return this.config;
  }
  
  /**
   * Update configuration
   * @param {Partial<Configuration>} updates - Configuration updates
   * @returns {void}
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
  }
}

// ========================================
// Object literals with type annotations
// ========================================

/**
 * @type {Configuration}
 */
const defaultConfig = {
  name: 'Default',
  blocks: [],
  sourceRows: [],
  objectRows: [],
  pupilMode: 'EPD',
  pupilValue: 10
};

// ========================================
// Async functions
// ========================================

/**
 * Load configuration from server
 * @param {string} url - URL to load from
 * @returns {Promise<Configuration>}
 */
async function loadConfiguration(url) {
  const response = await fetch(url);
  return response.json();
}

export { validateBlock, expandBlocks, ConfigurationManager, defaultConfig, loadConfiguration };
