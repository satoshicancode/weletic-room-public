import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRetainedEnvironment } from "./init.mjs";
import { privateCredentialFiles } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clientId = "c7d49cebb06e445db345bb200f966a03";
function inputs(root) {
  const webPath = join(root, "apps/web/.env.loyalty.local");
  const shopifyPath = join(root, "packages/shopify-app/.env.loyalty.local");
  if (hasRetainedEnvironment(root) || !privateCredentialFiles(root))
    throw new Error("Unsafe environment");
  const web = readFileSync(webPath, "utf8");
  const shopify = readFileSync(shopifyPath, "utf8");
  if (
    shopify.match(/^SHOPIFY_API_KEY=.*$/gm)?.join("") !==
      `SHOPIFY_API_KEY=${clientId}` ||
    shopify.match(/^SHOPIFY_API_SECRET=.*$/gm)?.join("") !==
      "SHOPIFY_API_SECRET=" ||
    web.match(/^SHOPIFY_WEBHOOK_SECRET=.*$/gm)?.join("") !==
      "SHOPIFY_WEBHOOK_SECRET="
  )
    throw new Error("Refuse existing or wrong app credentials");
  return { web, shopify, webPath, shopifyPath };
}
export function configureAppSecret(root, secret) {
  if (!/^shpss_[a-zA-Z0-9]{32,128}$/.test(secret || ""))
    throw new Error("Invalid secret");
  const { web, shopify, webPath, shopifyPath } = inputs(root);
  // Synchronous local writes; no secret is echoed, logged or placed in arguments.
  // A partial write fails closed on the next invocation; do not rotate to retry.
  writeFileSync(
    shopifyPath,
    shopify.replace(/^SHOPIFY_API_SECRET=$/m, `SHOPIFY_API_SECRET=${secret}`),
    { mode: 0o600 },
  );
  writeFileSync(
    webPath,
    web.replace(
      /^SHOPIFY_WEBHOOK_SECRET=$/m,
      `SHOPIFY_WEBHOOK_SECRET=${secret}`,
    ),
    { mode: 0o600 },
  );
}
/** @returns {Promise<{url: string, server: import("node:http").Server, close: () => void}>} */
export function startCredentialSetup(root) {
  inputs(root);
  const path = `/configure/${randomBytes(32).toString("hex")}`;
  let origin;
  let consumed = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Preserve same-origin form Origin headers; never send referrers cross-origin.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (consumed || req.headers.host !== origin?.slice(7) || req.url !== path) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (req.method === "GET") {
      res.end(
        `<h1>Local Shopify credential setup</h1><p>Weletic Loyalty Reviews Dev — client ID ${clientId}</p><p>Writes only the two private env files in weletic-room-loyalty-dev. Does not install, rotate or deploy the app.</p><form method="post" autocomplete="off"><label>Existing Shopify client secret <input name="secret" type="password" autocomplete="off" required></label><button type="submit">Save to isolated local files</button></form>`,
      );
      return;
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== origin ||
      req.headers["content-type"]?.split(";")[0] !==
        "application/x-www-form-urlencoded"
    ) {
      console.error(
        JSON.stringify({
          event: "local_form_request_refused",
          methodValid: req.method === "POST",
          originValid: req.headers.origin === origin,
          contentTypeValid:
            req.headers["content-type"]?.split(";")[0] ===
            "application/x-www-form-urlencoded",
        }),
      );
      res.writeHead(403).end("Refused");
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (body.length > 2048) throw new Error("Oversize");
      }
      const fields = new URLSearchParams(body);
      const secret = fields.get("secret");
      if (
        consumed ||
        [...fields.keys()].join() !== "secret" ||
        !/^shpss_[a-zA-Z0-9]{32,128}$/.test(secret || "")
      )
        throw new Error("Invalid secret");
      consumed = true;
      configureAppSecret(root, secret);
      res.end(
        "<h1>Saved locally</h1><p>The existing app secret is configured. No installation, credential rotation or deployment occurred.</p>",
      );
      console.log(
        "Shopify credential saved to both isolated private env files. Listener closed.",
      );
      server.close();
      clearTimeout(expiry);
    } catch {
      res
        .writeHead(400)
        .end("Refused or incomplete; inspect local configuration privately.");
      if (consumed) {
        server.close();
        clearTimeout(expiry);
        process.exitCode = 1;
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const expiry = setTimeout(() => {
    server.closeAllConnections();
    server.close();
  }, 300_000);
  return new Promise((resolve, reject) => {
    server.on("error", () => {
      clearTimeout(expiry);
      reject(new Error("Local credential listener failed"));
    });
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${origin}${path}`,
        server,
        close: () => {
          clearTimeout(expiry);
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.slice(2).join(" ") !== "--confirm-local-credential-setup")
      throw new Error("Confirmation required");
    const { url } = await startCredentialSetup(root);
    console.log(
      `One-use local configuration form (expires in five minutes): ${url}`,
    );
  } catch {
    console.error(
      "Local credential setup refused. No secret values are printed; existing credentials are never rotated.",
    );
    process.exitCode = 1;
  }
}
