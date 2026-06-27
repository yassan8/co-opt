import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';

// Plotly.js type declaration
declare const Plotly: any;

// Extend Window interface with custom properties
declare global {
  interface Window {
    scene?: THREE.Scene;
    camera?: THREE.Camera;
    renderer?: THREE.WebGLRenderer;
    controls?: OrbitControls;
    
    // Optical system functions
    createOPDCalculator?: (options?: any) => any;
    PSFCalculator?: any;
    WavefrontAberrationAnalyzer?: any;
    
    // Ray tracing functions
    traceRayThroughSystem?: (ray: any, opticalSystemRows: any[], objectRows?: any[]) => any;
    
    // Data access functions
    getOpticalSystemRows?: (tableOpticalSystem?: any) => any[];
    getObjectRows?: (tableObject?: any) => any[];
    getSourceRows?: (tableSource?: any) => any[];
    
    // Utility functions
    adjustCameraView?: (scene?: any, camera?: any, controls?: any, renderer?: any) => void;
    clearAllOpticalElements?: () => void;
    drawOpticalSystemSurfaces?: (options: any) => void;
    drawRayWithSegmentColors?: (rayPath: any, objectId: any, rayNumber: any, scene?: any) => void;
  }

  interface Document {
    scene?: THREE.Scene;
  }

  interface HTMLElement {
    value?: string;
    disabled?: boolean;
    tabulator?: any;
  }
}

export {};
