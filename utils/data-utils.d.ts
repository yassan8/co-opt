// Type definitions for data-utils.js

export function getOpticalSystemRows(tableOpticalSystem?: any): any[];
export function getObjectRows(tableObject?: any, options?: { includeDisabled?: boolean }): any[];
export function getSourceRows(tableSource?: any): any[];
export function outputParaxialDataToDebug(...args: any[]): void;
export function outputSeidelCoefficientsToDebug(...args: any[]): void;
export function outputDebugSystemData(...args: any[]): void;
export function displayCoordinateTransformMatrix(...args: any[]): void;
export function debugTableStatus(...args: any[]): void;
export function initializeTablesWithDummyData(...args: any[]): void;
export function renderBlockContributionSummaryFromSeidel(...args: any[]): void;
export function renderSystemConstraintsFromSurfaceRows(...args: any[]): void;
