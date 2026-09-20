import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";
import { expect, it } from "vitest";

it("transforms the Thank you entry at ES2015 without unsupported syntax warnings", async () => {
  const file = fileURLToPath(
    new URL(
      "../extensions/loyalty-checkout-slider/src/ThankYou.tsx",
      import.meta.url,
    ),
  );
  const result = await transformWithEsbuild(
    await readFile(file, "utf8"),
    file,
    {
      loader: "tsx",
      target: "es2015",
      jsx: "automatic",
      jsxImportSource: "preact",
    },
  );
  expect(result.warnings).toEqual([]);
  // Preserve exact arithmetic; this syntax check is not Shopify runtime proof.
  expect(result.code).toContain('BigInt("-9223372036854775808")');
  expect(result.code).toContain('BigInt("9223372036854775807")');
});
