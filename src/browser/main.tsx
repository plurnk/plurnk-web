import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@copilotkit/react-core/v2/styles.css";
import App from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("PLURNK browser root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
