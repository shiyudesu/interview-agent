import { createBrowserRouter } from "react-router-dom";

import { AppShell } from "../components/app-shell.js";
import { RouteErrorState } from "../components/page-state.js";
import { AccountSettingsPage } from "../pages/account-settings-page.js";
import { ActiveInterviewPage } from "../pages/active-interview-page.js";
import { AuthErrorPage } from "../pages/auth-error-page.js";
import { HistoryPage } from "../pages/history-page.js";
import { HomePage } from "../pages/home-page.js";
import { InterviewCreationPage } from "../pages/interview-creation-page.js";
import { NotFoundPage } from "../pages/not-found-page.js";
import { ReportPage } from "../pages/report-page.js";
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
        element: <ActiveInterviewPage />,
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
        path: "history",
        element: <HistoryPage />,
      },
      {
        path: "reports/:interviewId",
        element: <ReportPage />,
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);
