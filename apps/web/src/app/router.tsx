import { createBrowserRouter } from "react-router-dom";

import { AppShell } from "../components/app-shell.js";
import { RouteErrorState } from "../components/page-state.js";
import { HomePage } from "../pages/home-page.js";
import { NotFoundPage } from "../pages/not-found-page.js";
import { WorkspacePage } from "../pages/workspace-page.js";

export const appRouter = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteErrorState />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: "app",
        element: <WorkspacePage />,
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);
