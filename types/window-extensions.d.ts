import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';

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
    getOpticalSystemRows?: () => any[];
    getObjectRows?: () => any[];
    getSourceRows?: () => any[];
    
    // Utility functions
    adjustCameraView?: () => void;
    clearAllOpticalElements?: () => void;
    drawOpticalSystemSurfaces?: (options: any) => void;
    drawRayWithSegmentColors?: (rayPath: any, objectId: any, rayNumber: any) => void;
  }

  interface Document {
    scene?: THREE.Scene;
  }

  interface HTMLElement {
    value?: string;
    disabled?: boolean;
  }
}

export {};
