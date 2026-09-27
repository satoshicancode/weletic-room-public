import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { reviewProxyResponse } from "../../../../../packages/shopify-app/app/reviews-gateway.server";

/** Manual browser bridge for the opt-in isolated SQL suite. Shopify proxy
 * authentication is a fixed synthetic boundary; review HTTP handlers are real. */
export async function capturedReviewBrowser({
  shop,
  token,
  locale,
  backend,
}: {
  shop: string;
  token: string;
  locale: string;
  backend: (
    request: Request,
    context: { params: Promise<{ action: string }> },
  ) => Promise<Response>;
}) {
  if (
    process.env.CORE_REVIEW_BROWSER_DATABASE_TEST !== "1" ||
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" ||
    !new URL(process.env.DATABASE_URL!).pathname.startsWith(
      "/weletic_loyalty_it_",
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !["en", "ja", "vi"].includes(locale)
  )
    throw new Error("Explicit isolated browser fixture required");
  const baseDirectory = process.env.CORE_REVIEW_BROWSER_DIRECTORY;
  if (
    !baseDirectory ||
    !/^\/tmp\/weletic-review-http-[A-Za-z0-9-]+$/.test(baseDirectory)
  )
    throw new Error("Private browser evidence directory required");
  const directory = `${baseDirectory}-${locale}`;
  await mkdir(directory, { mode: 0o700 });
  const oldUrl = process.env.WELETIC_API_URL;
  const oldSecret = process.env.WELETIC_SHOPIFY_SERVICE_SECRET;
  const originalFetch = globalThis.fetch;
  const events: Array<{ action: string; status: number; code?: string }> = [];
  let origin = "";
  let submitted: { id: string } | undefined;
  let submissionBody: string | undefined;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (
        incoming.headers.host !== new URL(origin).host ||
        (incoming.headers.origin && incoming.headers.origin !== origin)
      ) {
        outgoing.writeHead(403).end();
        return;
      }
      const url = new URL(incoming.url!, origin);
      if (url.pathname === "/" && incoming.method === "GET") {
        outgoing.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        outgoing.end(
          `<p>Local captured invitation — ${locale}</p><a href="/apps/proxy/reviews/write?locale=${locale}#token=${token}">Open captured review invitation</a>`,
        );
        return;
      }
      const match =
        /^\/(apps\/proxy|api\/internal\/shopify)\/reviews\/(write|request|submit|upload)$/.exec(
          url.pathname,
        );
      if (!match || !["GET", "POST"].includes(incoming.method!)) {
        outgoing.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) throw new Error("Oversize fixture request");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const request = new Request(url, {
        method: incoming.method,
        headers: new Headers(
          Object.entries(incoming.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : [[key, String(value)] as [string, string]],
          ),
        ),
        ...(incoming.method === "POST" ? { body } : {}),
      });
      const response =
        match[1] === "apps/proxy"
          ? await reviewProxyResponse(request, shop, `reviews/${match[2]}`)
          : await backend(request, {
              params: Promise.resolve({ action: match[2] }),
            });
      const text = await response.text();
      events.push({
        action: `${match[1]}/${match[2]}`,
        status: response.status,
        ...(!response.ok && JSON.parse(text)?.error?.code === "not_found"
          ? { code: "not_found" }
          : {}),
      });
      if (match[1] === "apps/proxy" && match[2] === "submit" && response.ok) {
        submitted = JSON.parse(text);
        submissionBody = body;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(text);
    } catch {
      outgoing
        .writeHead(503, { "Content-Type": "application/json" })
        .end('{"error":"fixture_unavailable"}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No loopback address");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.WELETIC_API_URL = origin;
    process.env.WELETIC_SHOPIFY_SERVICE_SECRET =
      "synthetic-browser-service-secret-20260927";
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        ![
          origin,
          "http://127.0.0.1:8079",
          "http://127.0.0.1:9002",
          "http://127.0.0.1:13902",
          "http://127.0.0.1:65367",
        ].includes(url.origin)
      )
        throw new Error("Nonlocal browser-fixture request refused");
      return originalFetch(input, { ...init, redirect: "error" });
    };
    const unsigned = await fetch(
      `${origin}/api/internal/shopify/reviews/request?shop=${shop}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );
    if (unsigned.status !== 401)
      throw new Error("Unsigned service request was not rejected");
    await writeFile(
      join(directory, "ready.json"),
      JSON.stringify({ origin, locale }),
      { mode: 0o600 },
    );
    const deadline = Date.now() + 240_000;
    let verified = false;
    while (Date.now() < deadline) {
      if (
        submitted &&
        (await readFile(join(directory, "continue"), "utf8").catch(
          () => "",
        )) === "verified"
      ) {
        verified = true;
        break;
      }
      await delay(200);
    }
    if (!verified || !submitted?.id || !submissionBody)
      throw new Error("Browser submission not verified before timeout");
    if (
      process.env.CORE_REVIEW_BROWSER_PHOTO_TEST === "1" &&
      (!events.some(
        (event) =>
          event.action === "api/internal/shopify/upload" &&
          event.status === 201,
      ) ||
        JSON.parse(submissionBody).mediaIds?.length !== 1)
    )
      throw new Error("Browser must upload and submit exactly one real photo");
    const replay = await fetch(`${origin}/apps/proxy/reviews/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: submissionBody,
    });
    const replayBody = await replay.json();
    if (
      replay.status !== 404 ||
      replayBody?.error?.code !== "review_error" ||
      replayBody?.error?.message !== "Review request unavailable" ||
      !events.some(
        (event) =>
          event.action === "api/internal/shopify/submit" &&
          event.status === 404 &&
          event.code === "not_found",
      )
    )
      throw new Error("Replay did not reach the consumed-token rejection");
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        locale,
        reviewId: submitted.id,
        replayStatus: replay.status,
        events,
      }),
      { mode: 0o600 },
    );
    return submitted;
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.WELETIC_API_URL;
    else process.env.WELETIC_API_URL = oldUrl;
    if (oldSecret === undefined)
      delete process.env.WELETIC_SHOPIFY_SERVICE_SECRET;
    else process.env.WELETIC_SHOPIFY_SERVICE_SECRET = oldSecret;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
