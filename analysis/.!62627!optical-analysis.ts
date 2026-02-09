// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * Optical Analysis Module
 * Handles PSF, spot diagram, and aberration analysis functions
 */

import * as THREE from 'three';
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.ts';
import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { getScene, getCamera, getRenderer, getControls, getTableOpticalSystem, getTableObject, getTableSource,
         getIsGeneratingSpotDiagram, getIsGeneratingTransverseAberration,
         setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration } from '../core/app-config.ts';

/**
 * Create field setting from object data for PSF calculation
 */
export function createFieldSettingFromObject(objectData: any): any {
    if (!objectData) {
        console.error('❌ Object data is null or undefined');
        return null;
    }

