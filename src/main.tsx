import React from "react";
import ReactDOM from "react-dom/client";
// Loads Geist (the @font-face the --font-sans stack in index.css names). Without
// this import fontsource never injects the font and the webview falls back to
// the system default sans.
import "@fontsource-variable/geist";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
