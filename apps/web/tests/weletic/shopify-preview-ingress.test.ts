import {
  createServer,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitsPreviewRequest,
  createPreviewHandler,
  previewHost,
} from "../../../../infra/shopify-development/preview-ingress.mjs";

const origin = "https://synthetic-preview.trycloudflare.com";
const host = "synthetic-preview.trycloudflare.com";
const path = "/api/shopify/integration/webhook";
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
function candidate(url = path, headers = { host }) {
  return { url, method: "POST", headers, rawHeaders: ["Host", host] };
}
function send(port: number) {
  return new Promise<number | undefined>((done, reject) => {
    const client = request(
      { hostname: "127.0.0.1", port, path, headers: { host } },
      (response) => {
        response.resume();
        response.on("end", () => done(response.statusCode));
      },
    );
    client.on("error", reject);
    client.end();
  });
}
describe("development backend tunnel boundary", () => {
  it("limits concurrent requests and releases completed slots", async () => {
    const held: ServerResponse[] = [];
    let signalFull!: () => void;
    const full = new Promise<void>((done) => {
      signalFull = done;
    });
    const backend = await listen(
      createServer((incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        if (held.length < 8) {
          held.push(outgoing);
          if (held.length === 8) signalFull();
        } else outgoing.end("{}");
      }),
    );
    const ingress = await listen(
      createServer(
        createPreviewHandler(origin, (options, callback) =>
          request({ ...options, port: backend }, callback),
        ),
      ),
    );
    const initial = Array.from({ length: 8 }, () => send(ingress));
    await full;
    expect(await send(ingress)).toBe(503);
    for (const response of held) response.end("{}");
    expect(await Promise.all(initial)).toEqual(Array(8).fill(200));
    expect(await send(ingress)).toBe(200);
  });
  it("ends a continuously trickling backend at the absolute deadline", async () => {
    const backend = await listen(
      createServer((incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        const trickle = setInterval(() => outgoing.write(" "), 50);
        outgoing.once("close", () => clearInterval(trickle));
        outgoing.on("error", () => outgoing.destroy());
      }),
    );
    const ingress = await listen(
      createServer(
        createPreviewHandler(origin, (options, callback) =>
          request({ ...options, port: backend }, callback),
        ),
      ),
    );
    const status = await new Promise<number | undefined>((done, reject) => {
      const client = request(
        { hostname: "127.0.0.1", port: ingress, path, headers: { host } },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode));
        },
      );
      client.on("error", reject);
      client.end();
    });
    expect(status).toBe(504);
  }, 35_000);
  it.each([
    "http://synthetic-preview.trycloudflare.com",
    "https://foreign.invalid",
    "https://synthetic-preview.trycloudflare.com/",
    "https://synthetic-preview.trycloudflare.com:443",
    "https://user@synthetic-preview.trycloudflare.com",
    "https://synthetic-preview.trycloudflare.com?x=1",
    "https://loyalty-api-dev.weletic.com",
  ])("rejects an unreviewed origin: %s", (value) => {
    expect(() => previewHost(value)).toThrow();
  });
  it("admits only the selected host and the existing public API allowlist", () => {
    expect(admitsPreviewRequest(candidate(), origin)).toBe(true);
    expect(
      admitsPreviewRequest(
        candidate(path, { host: "foreign.invalid" }),
        origin,
      ),
    ).toBe(false);
    for (const url of [
      "/",
      "/_next/static/file.js",
      "/api/internal/shopify/sessions",
      "/api/cron/weletic/loyalty/outbox",
      "/api/shopify/unknown",
      "/api/shopify/../internal/shopify/sessions",
      "/api/shopify/%2e%2e/internal/shopify/sessions",
      `${path}?_rsc=1`,
      `${path}?__nextDefaultLocale=en`,
    ])
      expect(admitsPreviewRequest(candidate(url), origin)).toBe(false);
    for (const headers of [
      { host, "x-forwarded-host": "foreign.invalid" },
      { host, "x-forwarded-proto": "http" },
      { host, "x-middleware-subrequest": "middleware" },
      { host, "next-action": "synthetic" },
    ])
      expect(admitsPreviewRequest(candidate(path, headers), origin)).toBe(
        false,
      );
    expect(
      admitsPreviewRequest(
        { ...candidate(), rawHeaders: ["Host", host, "Host", host] },
        origin,
      ),
    ).toBe(false);
  });

  it("preserves signed bytes and query strings without forwarding routing headers", async () => {
    let observed: unknown;
    const backend = await listen(
      createServer(async (incoming, outgoing) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk);
        observed = {
          body: Buffer.concat(chunks).toString("hex"),
          url: incoming.url,
          host: incoming.headers.host,
          signature: incoming.headers["x-shopify-hmac-sha256"],
          forwarded: incoming.headers["x-forwarded-host"],
          nominated: incoming.headers["x-synthetic-hop"],
        };
        outgoing.writeHead(202, { "Content-Type": "application/json" });
        outgoing.end('{"accepted":true}');
      }),
    );
    const handler = createPreviewHandler(origin, (options, callback) =>
      request({ ...options, port: backend }, callback),
    );
    const ingress = await listen(createServer(handler));
    const body = Buffer.from([123, 32, 10, 34, 195, 169, 34, 58, 49, 125]);
    const result = await new Promise<number | undefined>((done, reject) => {
      const client = request(
        {
          hostname: "127.0.0.1",
          port: ingress,
          path: `${path}?signature=a%2Bb&x=1&x=2`,
          method: "POST",
          headers: {
            host,
            "x-shopify-hmac-sha256": "synthetic-signature",
            "x-forwarded-host": host,
            connection: "x-synthetic-hop",
            "x-synthetic-hop": "must-not-forward",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode));
        },
      );
      client.on("error", reject);
      client.end(body);
    });
    expect(result).toBe(202);
    expect(observed).toEqual({
      body: body.toString("hex"),
      url: `${path}?signature=a%2Bb&x=1&x=2`,
      host: "app.localhost:8890",
      signature: "synthetic-signature",
      forwarded: undefined,
      nominated: undefined,
    });
  });

  it.each(["request", "response"])("bounds %s buffering", async (direction) => {
    let calls = 0;
    const backend = await listen(
      createServer((incoming, outgoing) => {
        calls += 1;
        incoming.resume();
        // The ingress deliberately closes an oversized upstream response.
        outgoing.on("error", () => outgoing.destroy());
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(Buffer.alloc(11 * 1024 * 1024, 32));
      }),
    );
    const ingress = await listen(
      createServer(
        createPreviewHandler(origin, (options, callback) =>
          request({ ...options, port: backend }, callback),
        ),
      ),
    );
    const status = await new Promise<number | undefined>((done, reject) => {
      const client = request(
        {
          hostname: "127.0.0.1",
          port: ingress,
          path,
          method: "POST",
          headers: { host },
        },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode));
        },
      );
      client.on("error", reject);
      client.end(
        direction === "request"
          ? Buffer.alloc(11 * 1024 * 1024, 32)
          : undefined,
      );
    });
    expect(status).toBe(direction === "request" ? 413 : 502);
    expect(calls).toBe(direction === "request" ? 0 : 1);
  });

  it.each([500, 302, 200])(
    "suppresses upstream development pages/redirects (%s)",
    async (status) => {
      const backend = await listen(
        createServer((_, outgoing) => {
          outgoing.writeHead(status, {
            "Content-Type": "text/html",
            Location: "http://private.invalid",
          });
          outgoing.end("private development details");
        }),
      );
      const ingress = await listen(
        createServer(
          createPreviewHandler(origin, (options, callback) =>
            request({ ...options, port: backend }, callback),
          ),
        ),
      );
      const result = await new Promise<{
        status?: number;
        body: string;
        location?: string;
      }>((done, reject) => {
        const client = request(
          { hostname: "127.0.0.1", port: ingress, path, headers: { host } },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              done({
                status: response.statusCode,
                body,
                location: response.headers.location,
              }),
            );
          },
        );
        client.on("error", reject);
        client.end();
      });
      expect(result).toEqual({
        status: 502,
        body: '{"error":"preview_request_unavailable"}',
        location: undefined,
      });
    },
  );
});
