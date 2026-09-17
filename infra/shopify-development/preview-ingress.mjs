import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_LOYALTY_API_ORIGIN } from "../../packages/shopify-app/app/public-runtime-policy.mjs";
import { admitsLoyaltyRequest } from "../cloudflare-release/loyalty-routes.mjs";

const productionHost = new URL(PUBLIC_LOYALTY_API_ORIGIN).host;
const maximumBody = 10 * 1024 * 1024;

export function previewHost(origin) {
  // Only explicitly selected ephemeral development tunnels. No arbitrary URL,
  // credentials, port, path, query or production-domain fallback is accepted.
  if (!/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(origin))
    throw new Error("Invalid development tunnel origin");
  return new URL(origin).host;
}

export function admitsPreviewRequest(request, origin) {
  const host = previewHost(origin);
  if (
    request.headers?.host !== host ||
    (request.headers["x-forwarded-host"] !== undefined &&
      request.headers["x-forwarded-host"] !== host)
  )
    return false;
  // Reuse canonical raw-path/framework-RPC rejection without widening the
  // production host policy. Internal gateways and cron remain loopback-only.
  if (!request.url?.startsWith("/api/shopify/")) return false;
  return admitsLoyaltyRequest({
    ...request,
    method: request.method,
    url: request.url,
    rawHeaders: request.rawHeaders,
    headers: {
      ...request.headers,
      host: productionHost,
      ...(request.headers["x-forwarded-host"] === undefined
        ? {}
        : { "x-forwarded-host": productionHost }),
    },
  });
}

function reply(response, status) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ error: "preview_request_unavailable" }));
}

// Transport injection is for isolated tests; the executable always uses Node's
// HTTP transport and a fixed loopback destination. No URL is client-controlled.
export function createPreviewHandler(origin, transport = httpRequest) {
  previewHost(origin);
  let active = 0;
  return async (incoming, outgoing) => {
    outgoing.on("error", () => outgoing.destroy());
    incoming.on("error", () => reply(outgoing, 400));
    if (!admitsPreviewRequest(incoming, origin)) return reply(outgoing, 404);
    if (active >= 8) return reply(outgoing, 503);
    active += 1;
    outgoing.once("close", () => {
      active -= 1;
    });
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maximumBody) {
          // Drain without retaining excess bytes. The server's request deadline
          // bounds slow senders, and a completed upload avoids a reset racing
          // the client's remaining buffered writes and the rejection response.
          chunks.length = 0;
          continue;
        }
        chunks.push(chunk);
      }
    } catch {
      return reply(outgoing, 400);
    }
    if (size > maximumBody) return reply(outgoing, 413);
    const body = Buffer.concat(chunks);
    const headers = { ...incoming.headers };
    // Connection-nominated fields must never cross the proxy boundary.
    const nominated = String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase());
    for (const name of Object.keys(headers)) {
      if (
        nominated.includes(name) ||
        /^(connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|forwarded|x-forwarded-.*)$/.test(
          name,
        )
      )
        delete headers[name];
    }
    headers.host = "app.localhost:8890";
    headers["content-length"] = String(body.length);
    headers["accept-encoding"] = "identity";
    const upstream = transport(
      {
        hostname: "127.0.0.1",
        port: 8890,
        path: incoming.url,
        method: incoming.method,
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const type = response.headers["content-type"] ?? "";
        // Do not leak development stack pages, redirects or framework content.
        if (
          status >= 500 ||
          (status >= 300 && status < 400) ||
          (status !== 204 &&
            !/^(application\/json|text\/plain)(;|$)/.test(type))
        ) {
          response.resume();
          return reply(outgoing, 502);
        }
        const parts = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > maximumBody) {
            response.destroy();
            reply(outgoing, 502);
          } else parts.push(chunk);
        });
        response.on("error", () => reply(outgoing, 502));
        response.on("end", () => {
          if (outgoing.destroyed || outgoing.writableEnded) return;
          const forwarded = { "cache-control": "no-store" };
          for (const name of [
            "content-type",
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
            "access-control-allow-credentials",
            "vary",
            "retry-after",
          ]) {
            if (response.headers[name] !== undefined)
              forwarded[name] = response.headers[name];
          }
          outgoing.writeHead(status, forwarded);
          outgoing.end(Buffer.concat(parts));
        });
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy());
    // An inactivity timeout alone permits an indefinitely trickling backend.
    const deadline = setTimeout(() => {
      upstream.destroy();
      reply(outgoing, 504);
    }, 30_000);
    upstream.on("error", () => reply(outgoing, 502));
    outgoing.on("close", () => {
      clearTimeout(deadline);
      upstream.destroy();
    });
    upstream.end(body);
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    process.env.NODE_ENV !== "development" ||
    args.length !== 2 ||
    args[0] !== "--confirm-local-ingress" ||
    !args[1].startsWith("--origin=")
  )
    throw new Error("Explicit development ingress configuration required");
  const server = createServer(createPreviewHandler(args[1].slice(9)));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  server.listen(8891, "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
