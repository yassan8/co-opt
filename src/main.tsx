import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./app.css";
import "../core/undo-history.ts";

console.log("[src/main.tsx] Starting React initialization");

function installVersionUpdatePrompt(): void {
  if (!import.meta.env.PROD) return;
  const w = window as any;
  if (w.__cooptVersionWatcherInstalled) return;
  w.__cooptVersionWatcherInstalled = true;

  const collectVersionedModuleScripts = (doc: Document): string[] => {
    try {
      const scripts = Array.from(doc.querySelectorAll('script[type="module"][src]'))
        .map((el) => String((el as HTMLScriptElement).getAttribute('src') || '').trim())
        .filter((src) => src !== '')
        .map((src) => {
          try {
            return new URL(src, window.location.href).pathname;
          } catch (_) {
            return src;
          }
        })
        .filter((path) => path.includes('/assets/') && /-[A-Za-z0-9_-]+\.js$/i.test(path))
        .sort();
      return scripts;
    } catch (_) {
      return [];
    }
  };

  const currentKey = collectVersionedModuleScripts(document).join('|');
  if (!currentKey) return;

  const checkForUpdate = async () => {
    if ((window as any).__cooptVersionPromptDone) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('__coopt_vcheck', String(Date.now()));
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      if (!html) return;

      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const latestKey = collectVersionedModuleScripts(parsed).join('|');
      if (!latestKey || latestKey === currentKey) return;

      (window as any).__cooptVersionPromptDone = true;
      const reloadNow = window.confirm('新しいバージョンがあります。再読み込みしますか？\nA new version is available. Reload now?');
      if (reloadNow) {
        window.location.reload();
      }
    } catch (_) {
      // ignore update check failures
    }
  };

  setTimeout(() => {
    void checkForUpdate();
  }, 30_000);
  setInterval(() => {
    void checkForUpdate();
  }, 5 * 60 * 1000);
}

const notifyMainModuleLoaded = () => {
  try {
    (window as any).__cooptMainModuleLoaded = true;
    window.dispatchEvent(new CustomEvent("coopt:main-module-loaded"));
    console.log("[src/main.tsx] Dispatched coopt:main-module-loaded");
  } catch (e) {
    console.warn("[src/main.tsx] Failed to dispatch coopt:main-module-loaded", e);
  }
};

const notifyMainModuleFailed = (error: unknown) => {
  try {
    (window as any).__cooptMainLoadError = String((error as any)?.message || error || "unknown");
    window.dispatchEvent(new CustomEvent("coopt:main-load-failed", {
      detail: { message: (window as any).__cooptMainLoadError }
    }));
    console.warn("[src/main.tsx] Dispatched coopt:main-load-failed");
  } catch (_) {
    // ignore
  }
};

// Dynamically import main.ts to ensure it loads before React
import("../main.ts").then(() => {
  console.log("[src/main.tsx] main.ts loaded successfully");
  notifyMainModuleLoaded();
  
  const container = document.getElementById("react-root");

  if (!container) {
    throw new Error("Missing #react-root container in index.html");
  }

  console.log("[React] Mounting React app to #react-root");
  ReactDOM.createRoot(container).render(<App />);
  console.log("[React] React app mounted successfully");
  installVersionUpdatePrompt();

  // Notify main.ts that React has been mounted
  (window as any).__cooptReactMounted = true;
  window.dispatchEvent(new CustomEvent('coopt:react-mounted'));
  console.log("[React] Dispatched coopt:react-mounted event");
}).catch(error => {
  console.error("[src/main.tsx] Failed to load main.ts:", error);
  notifyMainModuleFailed(error);
  
  // Still try to mount React even if main.ts fails
  const container = document.getElementById("react-root");
  if (container) {
    ReactDOM.createRoot(container).render(<App />);
    installVersionUpdatePrompt();
    // Notify main.ts that React has been mounted (fallback path)
    (window as any).__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent('coopt:react-mounted'));
    console.log("[React] Dispatched coopt:react-mounted event (fallback)");
  }
});
