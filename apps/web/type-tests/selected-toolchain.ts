import "@testing-library/jest-dom/vitest";

export type WebToolchainModules = {
  readonly query: typeof import("@tanstack/react-query");
  readonly radix: typeof import("radix-ui");
  readonly react: typeof import("react");
  readonly reactDom: typeof import("react-dom");
  readonly router: typeof import("react-router-dom");
  readonly tailwind: typeof import("tailwindcss");
  readonly tailwindVite: typeof import("@tailwindcss/vite");
  readonly testingLibrary: typeof import("@testing-library/react");
  readonly testingLibraryUserEvent: typeof import("@testing-library/user-event");
  readonly vite: typeof import("vite");
  readonly viteReact: typeof import("@vitejs/plugin-react");
};
