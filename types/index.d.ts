/**
 * Global Type Definitions for co-opt
 * TypeScript移行の基盤となる型定義
 */

// ========================================
// Block Schema Types
// ========================================

export type BlockType =
  | 'ObjectSurface'
  | 'ObjectPlane'
  | 'Lens'
  | 'PositiveLens'
  | 'Doublet'
  | 'Triplet'
  | 'Gap'
  | 'AirGap'
  | 'Stop'
  | 'CoordTrans'
  | 'Mirror'
  | 'SingleSurface'
  | 'ImageSurface';

export type SurfaceType =
  | 'Spherical'
  | 'Aspheric even'
  | 'Aspheric odd'
  | 'Toric';

export type ObjectMode = 'Infinite' | 'Finite';

export interface BaseBlock {
  blockId: string;
  blockType: BlockType;
  label?: string;
  note?: string;
}

export interface ObjectSurfaceBlock extends BaseBlock {
  blockType: 'ObjectSurface' | 'ObjectPlane';
  mode: ObjectMode;
  objectDistance?: number;
}

export interface LensBlock extends BaseBlock {
  blockType: 'Lens' | 'PositiveLens';
  frontRadius: number;
  backRadius: number;
  centerThickness: number;
  material: string;
  frontSurfType?: SurfaceType;
  backSurfType?: SurfaceType;
  frontConic?: number;
  backConic?: number;
  frontAsphericCoeffs?: number[];
  backAsphericCoeffs?: number[];
}

export interface DoubletBlock extends BaseBlock {
  blockType: 'Doublet';
  surf1Radius: number;
  surf2Radius: number;
  surf3Radius: number;
  thickness1: number;
  thickness2: number;
  material1: string;
  material2: string;
  surf1SurfType?: SurfaceType;
  surf2SurfType?: SurfaceType;
  surf3SurfType?: SurfaceType;
}

export interface TripletBlock extends BaseBlock {
  blockType: 'Triplet';
  surf1Radius: number;
  surf2Radius: number;
  surf3Radius: number;
  surf4Radius: number;
  thickness1: number;
  thickness2: number;
  thickness3: number;
  material1: string;
  material2: string;
  material3: string;
}

export interface GapBlock extends BaseBlock {
  blockType: 'Gap' | 'AirGap';
  thickness: number;
}

export interface StopBlock extends BaseBlock {
  blockType: 'Stop';
  thickness?: number;
}

export interface MirrorBlock extends BaseBlock {
  blockType: 'Mirror';
  radius: number;
  thickness?: number;
  surfType?: SurfaceType;
  conic?: number;
  asphericCoeffs?: number[];
}

export interface SingleSurfaceBlock extends BaseBlock {
  blockType: 'SingleSurface';
  radius: number;
  thickness: number;
  material: string;
  surfType?: SurfaceType;
  conic?: number;
  asphericCoeffs?: number[];
}

export interface CoordTransBlock extends BaseBlock {
  blockType: 'CoordTrans';
  dx?: number;
  dy?: number;
  dz?: number;
  tiltX?: number;
  tiltY?: number;
  tiltZ?: number;
}

export interface ImageSurfaceBlock extends BaseBlock {
  blockType: 'ImageSurface';
  thickness?: number;
}

export type Block =
  | ObjectSurfaceBlock
  | LensBlock
  | DoubletBlock
  | TripletBlock
  | GapBlock
  | StopBlock
  | MirrorBlock
  | SingleSurfaceBlock
  | CoordTransBlock
  | ImageSurfaceBlock;

// ========================================
// Surface Table Types
// ========================================

export interface OpticalSystemRow {
  surfaceNumber: number;
  surfaceType: string;
  radius: number;
  thickness: number;
  material: string;
  semidia?: number;
  conic?: number;
  label?: string;
  note?: string;
  asphericCoeffs?: number[];
  isStop?: boolean;
}

// ========================================
// Source & Object Types
// ========================================

export interface SourceRow {
  index: number;
  wavelength: number;
  weight: number;
  label?: string;
}

export interface ObjectRow {
  index: number;
  angle: number;
  height: number;
  shape: 'Rectangle' | 'Circle';
}

// ========================================
// Configuration Types
// ========================================

export interface Configuration {
  id?: string;
  name: string;
  version?: string;
  blocks?: Block[];
  opticalSystemRows?: OpticalSystemRow[];
  opticalSystem?: OpticalSystemRow[];
  sourceRows?: SourceRow[];
  objectRows?: ObjectRow[];
  pupilMode?: 'EPD' | 'Fno' | 'NA';
  pupilValue?: number;
  stopSurfaceNumber?: number;
  semidiaOverrides?: { [key: number]: number };
  scenarios?: Array<{ id: string; name: string; weight: number; overrides: any }>;
  activeScenarioId?: string;
}

// ========================================
// Issue/Error Types
// ========================================

export type IssueSeverity = 'fatal' | 'error' | 'warning' | 'info';

export interface Issue {
  severity: IssueSeverity;
  phase: string;
  message: string;
  blockId?: string;
  surfaceNumber?: number;
}

// ========================================
// Ray Tracing Types
// ========================================

export interface Ray {
  x: number;
  y: number;
  z: number;
  l: number;
  m: number;
  n: number;
  wavelength: number;
  intensity?: number;
}

export interface RayTraceResult {
  success: boolean;
  rays: Ray[];
  surfaces: OpticalSystemRow[];
  error?: string;
}

// ========================================
// Glass Types
// ========================================

export interface GlassData {
  name: string;
  nd: number;
  vd: number;
  manufacturer?: string;
  catalog?: string;
}

// ========================================
// Evaluation Types
// ========================================

export interface SpotDiagramPoint {
  x: number;
  y: number;
  wavelength: number;
}

export interface SpotDiagramResult {
  points: SpotDiagramPoint[];
  rmsRadius: number;
  geoRadius: number;
}

export interface WavefrontData {
  opd: number[][];
  pupilX: number[];
  pupilY: number[];
  rms: number;
  pv: number;
}

// ========================================
// Global Window Extensions
// ========================================

declare global {
  interface Window {
    undoHistory?: any;
    tableConfiguration?: any;
    currentConfig?: Configuration;
    getWASMSystem?: () => any;
  }
}
