import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./app.css";

const container = document.getElementById("react-root");

if (!container) {
  throw new Error("Missing #react-root container in index.html");
}

ReactDOM.createRoot(container).render(<App />);
