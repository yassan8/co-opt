// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * (Removed) Draw/Clear OPD Rays feature.
 * Kept as a no-op stub to avoid stale imports crashing.
 */

export function setupWavefrontRayButtons(): void {
    // no-op
}

/**
 * Handle clearing wavefront rays
 */
function handleClearWavefrontRays(): void {
    try {
        console.log('🧹 波面収差光線クリア処理開始');

        let clearedAny = false;
        try {
            const popup = w.popup3DWindow;
            if (popup && !popup.closed && popup.scene) {
                clearWavefrontRays(popup.scene);
                clearedAny = true;
            }
        } catch (_) {}

        if (w.scene) {
            clearWavefrontRays(w.scene);
            clearedAny = true;
        }

        if (clearedAny) {
            console.log('✅ 波面収差光線クリア完了');
        } else {
            console.warn('⚠️ 3Dシーンが見つかりません');
        }
        
    } catch (error) {
        console.error('❌ 波面収差光線クリアエラー:', error);
    }
}

/**
 * Get current field setting for wavefront analysis
 * @returns Current field setting
 */
function getCurrentFieldSetting(): any {
    try {
