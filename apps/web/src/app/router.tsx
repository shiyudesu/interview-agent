import { createBrowserRouter } from "react-router-dom";

import { AppShell } from "../components/app-shell.js";
import { RouteErrorState } from "../components/page-state.js";
import { AccountSettingsPage } from "../pages/account-settings-page.js";
import { AuthErrorPage } from "../pages/auth-error-page.js";
import { HomePage } from "../pages/home-page.js";
import { InterviewCreationPage } from "../pages/interview-creation-page.js";
import { InterviewPlaceholderPage } from "../pages/interview-placeholder-page.js";
import { NotFoundPage } from "../pages/not-found-page.js";
import { SignInPage } from "../pages/sign-in-page.js";

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
        element: <InterviewCreationPage />,
      },
      {
        path: "interviews/:interviewId",
        element: <InterviewPlaceholderPage />,
      },
      {
        path: "sign-in",
        element: <SignInPage />,
      },
      {
        path: "auth/error",
        element: <AuthErrorPage />,
      },
      {
        path: "settings",
        element: <AccountSettingsPage />,
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);
