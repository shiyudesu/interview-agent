import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "./app/app-providers.js";
import { appRouter } from "./app/router.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Application root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={appRouter} />
    </AppProviders>
  </StrictMode>,
);
