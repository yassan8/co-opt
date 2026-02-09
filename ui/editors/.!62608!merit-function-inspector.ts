// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * System Evaluation Inspector Configuration
 * Manages operand definitions and inspector display logic
 */

// Operand definitions in JSON format
// Order: 1. Paraxial (近軸) → 2. 3rd Order Aberrations → 3. Analysis
export const OPERAND_DEFINITIONS: Record<string, any> = {
  // ===== Paraxial (近軸関連) =====
  "FL": {
    name: "Focal Length (FL)",
    description: "Paraxial focal length (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
