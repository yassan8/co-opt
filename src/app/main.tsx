import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./app.css";

// Extend Window interface
declare global {
  interface Window {
    __cooptReactMounted?: boolean;
    initializeAllTables?: () => void;
  }
}

const container = document.getElementById("react-root");

if (!container) {
  throw new Error("Missing #react-root container in index.html");
}

console.log("[React] Mounting React app to #react-root");
ReactDOM.createRoot(container).render(<App />);
console.log("[React] React app mounted successfully");

// Notify main.js that React has been mounted
window.__cooptReactMounted = true;
window.dispatchEvent(new CustomEvent('coopt:react-mounted'));
console.log("[React] Dispatched coopt:react-mounted event");

// Initialize tables after React DOM is ready
setTimeout(() => {
  console.log("[React] Initializing tables...");
  if (typeof (window as any).initializeAllTables === 'function') {
    (window as any).initializeAllTables();
  }
}, 50);
