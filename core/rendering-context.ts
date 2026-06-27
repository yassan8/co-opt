declare global {
  interface Window {
    scene?: any;
    camera?: any;
    renderer?: any;
    controls?: any;
    __cooptRenderingContext?: {
      scene?: any;
      camera?: any;
      renderer?: any;
      controls?: any;
    };
    __cooptSetRenderingContext?: (partial: { scene?: any; camera?: any; renderer?: any; controls?: any }) => void;
  }
}

type RenderingContext = {
  scene?: any;
  camera?: any;
  renderer?: any;
  controls?: any;
};

const ctx: RenderingContext = {};

function syncToWindow(partial: RenderingContext): void {
  try {
    if (typeof window === 'undefined') return;
    if (partial.scene !== undefined) window['scene'] = ctx.scene;
    if (partial.camera !== undefined) window['camera'] = ctx.camera;
    if (partial.renderer !== undefined) window['renderer'] = ctx.renderer;
    if (partial.controls !== undefined) window['controls'] = ctx.controls;

    window['__cooptRenderingContext'] = {
      scene: window['scene'],
      camera: window['camera'],
      renderer: window['renderer'],
      controls: window['controls']
    };
  } catch (_) {
    // ignore
  }
}

export function setRenderingContext(partial: RenderingContext): RenderingContext {
  if (partial && typeof partial === 'object') {
    if (partial.scene !== undefined) ctx.scene = partial.scene;
    if (partial.camera !== undefined) ctx.camera = partial.camera;
    if (partial.renderer !== undefined) ctx.renderer = partial.renderer;
    if (partial.controls !== undefined) ctx.controls = partial.controls;
    syncToWindow(partial);
  }
  return getRenderingContext();
}

// Legacy callers can use this without importing modules.
try {
  if (typeof window !== 'undefined' && typeof window['__cooptSetRenderingContext'] !== 'function') {
    window['__cooptSetRenderingContext'] = (p) => {
      try { setRenderingContext(p || {}); } catch (_) {}
    };
  }
} catch (_) {
  // ignore
}

export function getRenderingContext(): RenderingContext {
  try {
    if (typeof window !== 'undefined') {
      if (ctx.scene === undefined && (window as any).scene !== undefined) ctx.scene = (window as any).scene;
      if (ctx.camera === undefined && (window as any).camera !== undefined) ctx.camera = (window as any).camera;
      if (ctx.renderer === undefined && (window as any).renderer !== undefined) ctx.renderer = (window as any).renderer;
      if (ctx.controls === undefined && (window as any).controls !== undefined) ctx.controls = (window as any).controls;
    }
  } catch (_) {
    // ignore
  }
  return {
    scene: ctx.scene,
    camera: ctx.camera,
    renderer: ctx.renderer,
    controls: ctx.controls
  };
}
