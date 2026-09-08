import { vitePlugin as remix } from "@remix-run/dev";
import { vercelPreset } from "@vercel/remix/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { shopifyExtensionDevCorsPlugin } from "./shopify-extension-dev-cors";

export default defineConfig({
  // Shared Weletic components resolve from a different workspace package.
  // All embedded components must use the renderer's single React instance.
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [
    shopifyExtensionDevCorsPlugin(),
    remix({
      presets: [vercelPreset()],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
      },
    }),
    tsconfigPaths(),
  ],
  server: {
    port: Number(process.env.PORT || 3000),
    hmr: {
      clientPort: Number(process.env.PORT || 3000),
    },
    cors: false,
    allowedHosts:
      process.env.WELETIC_ISOLATED_DEVELOPMENT === "1"
        ? ["localhost", "127.0.0.1"]
        : true,
  },
});
