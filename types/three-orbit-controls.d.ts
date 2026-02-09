declare module 'OrbitControls' {
  import { Camera, MOUSE, Vector3 } from 'three';

  export class OrbitControls {
    constructor(object: Camera, domElement: HTMLElement);
    
    object: Camera;
    domElement: HTMLElement | Document;
    
    enabled: boolean;
    target: Vector3;
    
    minDistance: number;
    maxDistance: number;
    minZoom: number;
    maxZoom: number;
    
    minPolarAngle: number;
    maxPolarAngle: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;
    
    enableDamping: boolean;
    dampingFactor: number;
    
    enableZoom: boolean;
    zoomSpeed: number;
    enableRotate: boolean;
    rotateSpeed: number;
    enablePan: boolean;
    panSpeed: number;
    screenSpacePanning: boolean;
    keyPanSpeed: number;
    
    autoRotate: boolean;
    autoRotateSpeed: number;
    
    enableKeys: boolean;
    keys: { LEFT: string; UP: string; RIGHT: string; BOTTOM: string };
    mouseButtons: { LEFT?: MOUSE; MIDDLE?: MOUSE; RIGHT?: MOUSE };
    
    update(): boolean;
    saveState(): void;
    reset(): void;
    dispose(): void;
    
    getPolarAngle(): number;
    getAzimuthalAngle(): number;
    getDistance(): number;
  }
}
