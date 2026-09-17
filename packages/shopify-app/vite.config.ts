import { vitePlugin as remix } from "@remix-run/dev";
import { vercelPreset } from "@vercel/remix/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { previewOrigins } from "./app/preview-origins.mjs";
import { useNodeShopifyBuild } from "./node-build-policy.mjs";
import { shopifyExtensionDevCorsPlugin } from "./shopify-extension-dev-cors";

const preview = previewOrigins(process.env);

export default defineConfig({
  // Shared Weletic components resolve from a different workspace package.
  // All embedded components must use the renderer's single React instance.
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [
    shopifyExtensionDevCorsPlugin(),
    remix({
      // Explicit Node release builds and legacy local probes share the adapter;
      // ordinary builds retain the Vercel preset.
      presets: useNodeShopifyBuild(process.env) ? [] : [vercelPreset()],
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
      ...(preview
        ? {
            protocol: "wss",
            host: new URL(preview.app).hostname,
            clientPort: 443,
          }
        : { clientPort: Number(process.env.PORT || 3000) }),
    },
    cors: false,
    allowedHosts:
      process.env.WELETIC_ISOLATED_DEVELOPMENT === "1"
        ? [
            "localhost",
            "127.0.0.1",
            ...(preview ? [new URL(preview.app).hostname] : []),
          ]
        : true,
  },
});
