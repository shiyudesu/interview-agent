import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, "../..", "");
  const apiProxyTarget =
    environment.VITE_API_PROXY_TARGET?.trim() ||
    environment.BETTER_AUTH_URL?.trim() ||
    "http://127.0.0.1:3000";
  const apiProxyOrigin = new URL(apiProxyTarget).origin;

  return {
    envDir: "../..",
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              proxyRequest.setHeader("origin", apiProxyOrigin);
            });
          },
          target: apiProxyTarget,
        },
      },
    },
  };
});
