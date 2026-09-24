import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CoachClient } from "../../web/app/coach-client";
import "../../web/app/globals.css";
import "../../web/app/client.css";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";
window.__VALORANT_API_BASE__ = apiBase;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CoachClient />
  </StrictMode>
);
