import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { startPreventDisplaySleep, stopPreventDisplaySleep } from '../src/desktop/ipc/client.ts';

type WakeLockSentinelLike = {
  released?: boolean;
  release?: () => Promise<void> | void;
  addEventListener?: (type: string, listener: () => void) => void;
};

function buildGuardToken(prefix = 'optimize'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createOptimizationActivityGuard(prefix = 'optimize') {
  let active = false;
  let wakeLockSentinel: WakeLockSentinelLike | null = null;
  let displaySleepToken: string | null = null;
  let visibilityHandler: (() => void) | null = null;

  const acquireWebWakeLock = async (): Promise<boolean> => {
    try {
      if (isTauriRuntime()) return false;
      const nav = navigator as any;
      const wakeLock = nav?.wakeLock;
      if (!wakeLock || typeof wakeLock.request !== 'function') return false;
      if (wakeLockSentinel && wakeLockSentinel.released !== true) return true;
      const sentinel = await wakeLock.request('screen');
      wakeLockSentinel = sentinel;
      try {
        if (sentinel && typeof sentinel.addEventListener === 'function') {
          sentinel.addEventListener('release', () => {
            if (wakeLockSentinel === sentinel) {
              wakeLockSentinel = null;
            }
          });
        }
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  };

  const releaseWebWakeLock = async (): Promise<void> => {
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    if (!sentinel || typeof sentinel.release !== 'function') return;
    try {
      await sentinel.release();
    } catch (_) {}
  };

  const installVisibilityHandlers = () => {
    if (visibilityHandler || typeof document === 'undefined') return;
    visibilityHandler = () => {
      if (!active || isTauriRuntime()) return;
      try {
        if (document.visibilityState === 'visible') {
          void acquireWebWakeLock();
        }
      } catch (_) {}
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    try { window.addEventListener('focus', visibilityHandler); } catch (_) {}
    try { window.addEventListener('pageshow', visibilityHandler); } catch (_) {}
  };

  const uninstallVisibilityHandlers = () => {
    if (!visibilityHandler || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', visibilityHandler);
    try { window.removeEventListener('focus', visibilityHandler); } catch (_) {}
    try { window.removeEventListener('pageshow', visibilityHandler); } catch (_) {}
    visibilityHandler = null;
  };

  return {
    async acquire(): Promise<void> {
      if (active) return;
      active = true;

      if (isTauriRuntime()) {
        displaySleepToken = buildGuardToken(prefix);
        try {
          await startPreventDisplaySleep(displaySleepToken);
        } catch (_) {}
        return;
      }

      installVisibilityHandlers();
      await acquireWebWakeLock();
    },

    async release(): Promise<void> {
      active = false;
      uninstallVisibilityHandlers();
      await releaseWebWakeLock();

      const token = displaySleepToken;
      displaySleepToken = null;
      if (!token) return;
      try {
        await stopPreventDisplaySleep(token);
      } catch (_) {}
    }
  };
}