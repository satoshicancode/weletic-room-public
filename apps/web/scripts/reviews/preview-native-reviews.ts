/** Local browser-rendering harness. Uses production HTML/JS and input validation;
 * HTTP data is synthetic. Never treat this as Shopify deployment evidence. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { reviewFormResponse } from "../../../../packages/shopify-app/app/reviews-form.server";
import { reviewSubmissionSchema } from "../../lib/weletic/reviews/contracts";

const token = "A".repeat(43);
let consumed = false;
let photoNumber = 0;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:8788");
    const json = (data: unknown, status = 200) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(data));
    };
    if (url.pathname.endsWith("/write")) {
      const page = reviewFormResponse();
      response.writeHead(page.status, Object.fromEntries(page.headers));
      response.end(await page.text());
      return;
    }
    if (
      ["/weletic-reviews.js", "/weletic-reviews.css"].includes(url.pathname)
    ) {
      const asset = new URL(
        `../../../../packages/shopify-app/extensions/weletic-analytics/assets${url.pathname}`,
        import.meta.url,
      );
      response.writeHead(200, {
        "Content-Type": url.pathname.endsWith(".js")
          ? "application/javascript"
          : "text/css",
      });
      response.end(await readFile(asset));
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review block browser fixture</title><link rel="stylesheet" href="/weletic-reviews.css"><h1>Review fixture product</h1><weletic-reviews data-mode="stars" data-product-id="1234" data-proxy="/apps/weletic/reviews"></weletic-reviews><weletic-reviews data-mode="full" data-product-id="1234" data-proxy="/apps/weletic/reviews"></weletic-reviews><script src="/weletic-reviews.js"></script></html>',
      );
      return;
    }
    if (url.pathname.endsWith("/list")) {
      const rows = [
        {
          id: "review-fixture",
          rating: 1,
          title: "Honest feedback",
          body: '<img src=x onerror="window.reviewXss=true">\nThis product did not meet my expectations.',
          displayName: "Verified buyer",
          merchantReply: "Thank you for your honest feedback.",
          verifiedPurchase: true,
          incentivized: true,
          createdAt: new Date().toISOString(),
          media: [],
        },
      ];
      json({
        summary: { count: 1, average: 1, distribution: { 1: 1 } },
        items:
          url.searchParams.has("cursor") ||
          (url.searchParams.get("rating") &&
            url.searchParams.get("rating") !== "1")
            ? []
            : rows,
        nextCursor: null,
      });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 3 * 1024 * 1024) throw new Error("Too large");
      chunks.push(bytes);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !data ||
      typeof data !== "object" ||
      !("token" in data) ||
      data.token !== token ||
      consumed
    ) {
      json({ error: { message: "Invitation unavailable" } }, 404);
      return;
    }
    if (url.pathname.endsWith("/request")) {
      json({
        productTitle: "Review fixture product",
        photoUploadsEnabled: true,
      });
      return;
    }
    if (url.pathname.endsWith("/upload")) {
      json({ id: `wrevmedia_fixture${++photoNumber}` });
      return;
    }
    if (url.pathname.endsWith("/submit")) {
      reviewSubmissionSchema.parse(data);
      consumed = true;
      json({ id: "wreview_fixture", status: "pending" });
      return;
    }
    json({ error: { message: "Not found" } }, 404);
  } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "Invalid fixture input" } }),
    );
  }
});
server.listen(8788, "127.0.0.1", () =>
  process.stdout.write(
    `Local browser fixture only: http://127.0.0.1:8788/apps/weletic/reviews/write#token=${token}\n`,
  ),
);
