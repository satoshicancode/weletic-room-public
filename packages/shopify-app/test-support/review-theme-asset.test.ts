import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformWithEsbuild } from "vite";
import { expect, it } from "vitest";

it("ships a current review asset within Shopify's app block limit", async () => {
  const root = resolve(process.cwd(), "extensions/weletic-analytics");
  const readableSource = readFileSync(
    resolve(root, "src/weletic-reviews.js"),
    "utf8",
  );
  const asset = readFileSync(
    resolve(root, "assets/weletic-reviews.js"),
    "utf8",
  );
  const generated = await transformWithEsbuild(
    readableSource,
    "weletic-reviews.js",
    {
      minify: true,
      target: "es2020",
    },
  );
  expect(asset).toBe(generated.code);
  expect(Buffer.byteLength(asset)).toBeLessThanOrEqual(10_000);
});
