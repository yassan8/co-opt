// Runtime build stamp (for cache/stale-module diagnostics)
const RAY_TRACING_BUILD = '2025-12-30a';
if (typeof window !== 'undefined') {
  window.__RAY_TRACING_BUILD = RAY_TRACING_BUILD;
}

// Import functions from ray-paraxial.js without destructuring for compatibility
import * as rayParaxial from './ray-paraxial.ts';
import { asphericSagDerivative, toricSurfaceZ, toricSagDerivatives } from '../../optical/surface-math.ts';
const getSafeThickness = rayParaxial.getSafeThickness;
const getRefractiveIndex = rayParaxial.getRefractiveIndex;
const isCoordTransSurface = rayParaxial.isCoordTransSurface;
