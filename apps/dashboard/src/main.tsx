import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Dashboard root element is missing.");

createRoot(root).render(
  <StrictMode>
    <main>Orchestrat dashboard foundation</main>
  </StrictMode>
);
