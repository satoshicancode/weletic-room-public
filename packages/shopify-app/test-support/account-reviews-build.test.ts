import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { writePublicExtensionStage } from "../../../infra/shopify-development/stage-public-extensions.mjs";

it("bundles the staged account entry and Reviews dependencies without legacy endpoints", async () => {
  const root = resolve(process.cwd(), "../..");
  const destination = join(
    realpathSync(tmpdir()),
    `weletic-account-bundle-${randomUUID()}`,
  );
  const require = createRequire(import.meta.url);
  writePublicExtensionStage(destination, root);
  try {
    const result = await build({
      configFile: false,
      envFile: false,
      logLevel: "error",
      resolve: {
        alias: [
          "preact/jsx-dev-runtime",
          "preact/jsx-runtime",
          "preact/hooks",
          "preact",
        ].map((name) => ({
          find: name,
          replacement: require.resolve(name),
        })),
      },
      esbuild: { jsx: "automatic", jsxImportSource: "preact", jsxDev: false },
      build: {
        write: false,
        minify: false,
        target: "es2015",
        lib: {
          entry: join(
            destination,
            "extensions/weletic-customer-account/src/CustomerAccountLoyalty.tsx",
          ),
          formats: ["es"],
        },
      },
    });
    if ("on" in result) throw new Error("Unexpected watch build");
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs
      .flatMap((output) => output.output)
      .filter((output) => output.type === "chunk")
      .map((output) => output.code)
      .join("\n");
    expect(code).toContain(
      "https://loyalty-shopify-dev.weletic.com/api/customer-account/loyalty",
    );
    expect(code).toContain("open-prepare");
    expect(code).toContain("open-submit");
    expect(code).toContain("open_unverified_unrewarded_v1");
    expect(code).toContain("This review is unverified");
    expect(code).not.toContain("https://shopify.weletic.com");
    expect(code).not.toMatch(/from ["']\.\/reviews-/);
  } finally {
    // This exact random directory was created by this test and contains no
    // credentials, provider state or user files.
    rmSync(destination, { recursive: true });
  }
});
