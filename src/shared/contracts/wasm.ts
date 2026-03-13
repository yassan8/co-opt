export const REQUIRED_RUST_RAYTRACING_WASM_FUNCTIONS = [
  'intersect_aspheric_rt10',
  'intersect_aspheric_rt10_batch',
  'surface_normal_aspheric_rt10',
  'batch_mat3_mul_vec3'
] as const;

export type RequiredRustRayTracingWasmFunction =
  typeof REQUIRED_RUST_RAYTRACING_WASM_FUNCTIONS[number];

export type RayTracingWasmReadiness = {
  ready: boolean;
  hasSystem: boolean;
  hasModule: boolean;
  isWASMReady: boolean;
  missingFunctions: RequiredRustRayTracingWasmFunction[];
};
