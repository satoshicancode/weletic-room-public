import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { previewOrigin } from "../../packages/shopify-app/app/preview-origins.mjs";
import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";

export function stagePreview(root, config, retainedWeb, retainedShopify) {
  const app = previewOrigin(config.appOrigin);
  const api = previewOrigin(config.apiOrigin);
  if (
    app === api ||
    Object.keys(config).sort().join(",") !== "apiOrigin,appOrigin"
  )
    throw new Error("Invalid preview pair");
  // Paths become a local CLI command, never accept shell syntax.
  for (const path of [root, retainedWeb, retainedShopify]) {
    if (!isAbsolute(path) || !/^[A-Za-z0-9_./-]+$/.test(path))
      throw new Error("Unsafe staging path");
  }
  const appRoot = join(root, "packages/shopify-app");
  const directory = join(appRoot, ".loyalty-preview");
  const manifest = join(appRoot, "shopify.app.loyalty-preview.toml");
  if (existsSync(directory) || existsSync(manifest))
    throw new Error("Existing preview configuration must not be overwritten");
  let source = readFileSync(
    join(appRoot, "shopify.app.loyalty-public.toml"),
    "utf8",
  );
  if (
    !source.includes(`client_id = "${PUBLIC_LOYALTY_CLIENT_ID}"`) ||
    !source.includes(
      'extension_directories = ["public-extensions-disabled/*"]',
    ) ||
    source.includes("web_directories")
  )
    throw new Error("Unexpected public manifest");
  source = source
    .replaceAll(PUBLIC_LOYALTY_APP_ORIGIN, app)
    .replaceAll(PUBLIC_LOYALTY_API_ORIGIN, api)
    .replace(
      "[build]",
      'web_directories = [".loyalty-preview/web"]\n\n[build]',
    );
  mkdirSync(join(directory, "web"), { recursive: true, mode: 0o700 });
  const configPath = join(directory, "origins.json");
  writeFileSync(configPath, JSON.stringify(config), {
    mode: 0o600,
    flag: "wx",
  });
  const command = `node ${join(root, "infra/shopify-development/run.mjs")} --confirm-local-runtime --app=shopify --retained-web=${retainedWeb} --retained-shopify=${retainedShopify} --preview-config=${configPath}`;
  writeFileSync(
    join(directory, "web/shopify.web.toml"),
    `roles = ["frontend", "backend"]\nport = 3002\n[commands]\ndev = ${JSON.stringify(command)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(manifest, source, { mode: 0o600, flag: "wx" });
  return { configPath, manifest, extensionsEnabled: false };
}
