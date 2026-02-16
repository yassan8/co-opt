import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

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

ReactDOM.createRoot(container).render(<App />);

// Notify main.js that React has been mounted
window['__cooptReactMounted'] = true;
window.dispatchEvent(new CustomEvent('coopt:react-mounted'));

// Initialize tables after React DOM is ready
setTimeout(() => {
  if (typeof (window as any).initializeAllTables === 'function') {
    (window as any).initializeAllTables();
  }
}, 50);
