import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";

const sourceUrl = new URL(
  "../extensions/weletic-analytics/src/weletic-reviews.js",
  import.meta.url,
);
const assetUrl = new URL(
  "../extensions/weletic-analytics/assets/weletic-reviews.js",
  import.meta.url,
);
const source = await readFile(sourceUrl, "utf8");
const result = await transformWithEsbuild(source, fileURLToPath(sourceUrl), {
  minify: true,
  target: "es2020",
});
const asset = result.code;
const bytes = Buffer.byteLength(asset);
if (bytes > 10_000) {
  throw new Error(`Theme app block JavaScript exceeds 10,000 bytes: ${bytes}`);
}

if (process.argv.includes("--check")) {
  if ((await readFile(assetUrl, "utf8")) !== asset) {
    throw new Error("Review theme asset is stale; run pnpm build:theme-assets");
  }
} else {
  await writeFile(assetUrl, asset);
}
console.log(`Review theme asset: ${bytes} bytes`);
