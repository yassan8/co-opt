import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./app.css";

console.log("[src/main.tsx] Starting React initialization");

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
    // Notify main.ts that React has been mounted (fallback path)
    (window as any).__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent('coopt:react-mounted'));
    console.log("[React] Dispatched coopt:react-mounted event (fallback)");
  }
});
