import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./app.css";

const container = document.getElementById("react-root");

if (!container) {
  throw new Error("Missing #react-root container in index.html");
}

console.log("[React] Mounting React app to #react-root");
ReactDOM.createRoot(container).render(<App />);
console.log("[React] React app mounted successfully");
