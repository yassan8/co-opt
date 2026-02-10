import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./app.css";

console.log("[src/main.tsx] Starting React initialization");

// Dynamically import main.ts to ensure it loads before React
import("../main.ts").then(() => {
  console.log("[src/main.tsx] main.ts loaded successfully");
  
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
