import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { admitsLoyaltyRequest } from "./loyalty-routes.mjs";
import { assertCloudflareRuntime } from "./runtime-policy.mjs";

const directory = fileURLToPath(new URL("../../apps/web/", import.meta.url));

export function loyaltyHttpServer(handle) {
  const server = createServer(async (request, response) => {
    if (!admitsLoyaltyRequest(request)) {
      response.writeHead(404, {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      });
      response.end("Not found");
      return;
    }
    try {
      // Same IncomingMessage: no body consumption, URL rewrite or auth fallback.
      await handle(request, response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "Cache-Control": "private, no-store" });
        response.end("Request failed");
      } else response.destroy();
    }
  });
  server.on("upgrade", (_, socket) => socket.destroy());
  server.on("connect", (_, socket) => socket.destroy());
  return server;
}

export async function startLoyaltyWeb() {
  assertCloudflareRuntime("web", process.env);
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    if (existsSync(`${directory}${name}`))
      throw new Error("Runtime dotenv rejected");
  }
  // Runtime-only selector; ordinary Next deployments retain their job scope.
  process.env.WELETIC_RELEASE_PROFILE = "loyalty-only";
  const require = createRequire(`${directory}package.json`);
  // Next attaches its upgrade listener here, never to the public listener.
  // This server is deliberately never bound to a port.
  const frameworkServer = createServer();
  const app = require("next")({
    dev: false,
    dir: directory,
    hostname: "0.0.0.0",
    port: 3000,
    httpServer: frameworkServer,
  });
  await app.prepare();
  const server = loyaltyHttpServer(app.getRequestHandler());
  const stop = () => {
    // Parent start.mjs owns the 25-second hard shutdown bound.
    server.close(async () => {
      await app.close();
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3000, "0.0.0.0", resolve);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error();
    await startLoyaltyWeb();
  } catch {
    console.error("Loyalty web startup failed");
    process.exitCode = 1;
  }
}
