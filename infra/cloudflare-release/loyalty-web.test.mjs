import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  admitsLoyaltyRequest,
  loyaltyRoutes,
  reviewRoutes,
} from "./loyalty-routes.mjs";
import { loyaltyHttpServer } from "./loyalty-web.mjs";
const host = "loyalty-api-dev.weletic.com";
const path = "/api/internal/shopify/merchant/reward-catalog";
const input = (url = path, headers = {}) => ({
  url,
  method: "POST",
  headers: { host, ...headers },
});

test("all explicit routes admit requests without granting authentication", () => {
  assert.equal(new Set(loyaltyRoutes).size, loyaltyRoutes.length);
  for (const url of loyaltyRoutes)
    assert.equal(admitsLoyaltyRequest(input(url)), true, url);
  assert.equal(
    admitsLoyaltyRequest(input("/api/shopify/compliance/exports/wcomp_123")),
    true,
  );
});

test("admits only exact Flow action and owner gateway paths, not sibling APIs", () => {
  for (const url of [
    "/api/shopify/flow/points-adjustment",
    "/api/internal/shopify/merchant/flow-grants",
    "/api/internal/shopify/merchant/analytics/account-rows",
    "/api/internal/shopify/merchant/analytics/ledger-rows",
    "/api/internal/shopify/merchant/analytics/redemption-rows",
  ]) {
    assert.equal(admitsLoyaltyRequest(input(url)), true);
    assert.equal(admitsLoyaltyRequest(input(url + "/extra")), false);
    assert.equal(
      admitsLoyaltyRequest(input(url, { host: "app.weletic.com" })),
      false,
    );
  }
  assert.equal(
    admitsLoyaltyRequest(input("/api/shopify/flow/new-action")),
    false,
  );
});

for (const url of [
  "/",
  "/login",
  "/register",
  "/admin",
  "/partners",
  "/app.dub.co",
  "/api/auth/signin",
  "/api/stripe/webhook",
  "/api/shopify/loyalty/admin/settings",
  "/api/internal/shopify/reviews/list",
  "/api/internal/shopify/merchant/reviews/list",
  "/api/internal/shopify/merchant/new-route",
  "/api/jobs/process/unrelated-job",
  "/_next/static/x.js",
  "/_next/data/build/login.json",
  "/_proxy/plausible/event",
  path + "/",
  path + "/../reviews",
  path.replace("/api/", "/api//"),
  path.replace("api", "%61pi"),
  path + "%3fignore",
  "https://" + host + path,
  "//" + host + path,
  path + "#fragment",
  path + "\\suffix",
]) {
  test(`denies excluded or ambiguous path ${url}`, () =>
    assert.equal(admitsLoyaltyRequest(input(url)), false));
}

test("denies alternate hosts, duplicate Host and framework routing controls", () => {
  for (const headers of [
    { host: "admin.dub.co" },
    { host: host + ":3000" },
    { "x-forwarded-host": "admin.dub.co" },
    { "x-forwarded-proto": "http" },
    { "x-middleware-subrequest": "middleware" },
    { "x-invoke-path": "/admin" },
    { "x-matched-path": "/login" },
    { "next-action": "action-id" },
    { rsc: "1" },
    { "x-now-route-matches": "path=/admin" },
  ])
    assert.equal(admitsLoyaltyRequest(input(path, headers)), false);
  assert.equal(
    admitsLoyaltyRequest({
      ...input(),
      rawHeaders: ["Host", host, "Host", host],
    }),
    false,
  );
  assert.equal(admitsLoyaltyRequest({ ...input(), method: "TRACE" }), false);
  for (const query of [
    "__nextDefaultLocale=en",
    "nxtPslug=login",
    "nxtIslug=login",
    "_rsc=token",
    "%5f%5fnextLocale=en",
  ])
    assert.equal(admitsLoyaltyRequest(input(path + "?" + query)), false);
});

test("review admission requires explicit opt-in and the exact supported method", () => {
  assert.ok(reviewRoutes.includes("/api/internal/shopify/reviews/open-submit"));
  assert.ok(reviewRoutes.includes("/api/internal/shopify/reviews/open-upload"));
  assert.ok(
    reviewRoutes.includes("/api/internal/shopify/reviews/open-prepare"),
  );
  for (const action of ["read", "write"]) {
    assert.ok(
      reviewRoutes.includes(
        `/api/internal/shopify/merchant/reviews/open-policy/${action}`,
      ),
    );
  }
  assert.equal(
    admitsLoyaltyRequest(
      {
        ...input("/api/internal/shopify/merchant/reviews/open-policy/delete"),
        method: "POST",
      },
      { reviewsEnabled: true },
    ),
    false,
  );
  for (const action of ["read", "write"]) {
    assert.ok(
      reviewRoutes.includes(
        `/api/internal/shopify/merchant/reviews/translations/${action}`,
      ),
    );
    assert.ok(
      reviewRoutes.includes(
        `/api/internal/shopify/merchant/reviews/collection/${action}`,
      ),
    );
    assert.ok(
      reviewRoutes.includes(
        `/api/internal/shopify/merchant/reviews/store/settings/${action}`,
      ),
    );
  }
  for (const path of [
    "/api/internal/shopify/reviews/store-list",
    "/api/internal/shopify/reviews/store-submit",
    "/api/internal/shopify/reviews/store-invitations",
    "/api/internal/shopify/merchant/reviews/store/list",
    "/api/internal/shopify/merchant/reviews/store/moderate",
  ])
    assert.ok(reviewRoutes.includes(path), path);
  assert.equal(
    admitsLoyaltyRequest(
      {
        ...input("/api/internal/shopify/merchant/reviews/translations/delete"),
        method: "POST",
      },
      { reviewsEnabled: true },
    ),
    false,
  );
  assert.equal(new Set(reviewRoutes).size, reviewRoutes.length);
  for (const url of reviewRoutes) {
    const method =
      /\/shopify\/reviews\/(list|store-list|store-invitations|photo|health)$/.test(
        url,
      )
        ? "GET"
        : "POST";
    const req = { ...input(url), method };
    assert.equal(admitsLoyaltyRequest(req), false);
    assert.equal(admitsLoyaltyRequest(req, { reviewsEnabled: "1" }), false);
    assert.equal(admitsLoyaltyRequest(req, { reviewsEnabled: true }), true);
    for (const other of [
      "GET",
      "POST",
      "HEAD",
      "PUT",
      "DELETE",
      "OPTIONS",
    ].filter((value) => value !== method))
      assert.equal(
        admitsLoyaltyRequest(
          { ...req, method: other },
          { reviewsEnabled: true },
        ),
        false,
      );
    for (const suffix of ["/", "/../list", "%2f", "#ignored"])
      assert.equal(
        admitsLoyaltyRequest(
          { ...req, url: url + suffix },
          { reviewsEnabled: true },
        ),
        false,
      );
    assert.equal(
      admitsLoyaltyRequest(
        { ...req, headers: { host, "x-invoke-path": "/admin" } },
        { reviewsEnabled: true },
      ),
      false,
    );
  }
  for (const url of [
    "/api/internal/shopify/reviews/new-action",
    "/api/internal/shopify/reviews/store-delete",
    "/api/internal/shopify/merchant/reviews/collection/delete",
    "/api/internal/shopify/merchant/reviews/store/settings/delete",
    "/api/auth/signin",
  ])
    assert.equal(
      admitsLoyaltyRequest(input(url), { reviewsEnabled: true }),
      false,
    );
});

test("inventory paths resolve to existing route files, including bounded dynamic routes", () => {
  const root = fileURLToPath(new URL("../../apps/web/app/", import.meta.url));
  const routes = readdirSync(root, { recursive: true })
    .filter((p) => p.endsWith("/route.ts"))
    .map(
      (p) =>
        "/" +
        p
          .split("/")
          .filter((s) => !s.startsWith("("))
          .slice(0, -1)
          .join("/"),
    );
  for (const path of [...loyaltyRoutes, ...reviewRoutes]) {
    assert.ok(
      routes.some((r) =>
        new RegExp("^" + r.replace(/\[[^\]]+\]/g, "[^/]+") + "$").test(path),
      ),
      path,
    );
  }
});

test("real HTTP denies before dispatch and preserves admitted raw body, query and signature", async () => {
  const seen = [];
  const server = loyaltyHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      body: Buffer.concat(chunks).toString("hex"),
      signature: req.headers["x-weletic-signature"],
    });
    // Synthetic handler: admission must NOT turn its auth denial into success.
    res.writeHead(401);
    res.end("Unauthorized");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: url,
          method: "POST",
          headers: { host, "x-weletic-signature": "synthetic", ...headers },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end(Buffer.from([0, 255, 10, 13]));
    });
  try {
    const denied = await send("/api/auth/signin");
    assert.equal(denied.status, 404);
    assert.equal(denied.headers["cache-control"], "private, no-store");
    assert.equal(seen.length, 0);
    assert.equal((await send(path, { "x-invoke-path": "/login" })).status, 404);
    const url = path + "?opaque=a%2Fb&opaque=second";
    assert.equal((await send(url)).status, 401);
    assert.deepEqual(seen, [{ url, body: "00ff0a0d", signature: "synthetic" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade and CONNECT sockets close without application dispatch", async () => {
  let dispatched = 0;
  const server = loyaltyHttpServer(() => {
    dispatched++;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const message of [
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
    ]) {
      await new Promise((resolve, reject) => {
        const socket = connect(server.address().port, "127.0.0.1", () =>
          socket.write(message),
        );
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error("Socket did not close"));
        });
        socket.on("error", reject);
        socket.on("close", resolve);
      });
    }
    assert.equal(dispatched, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("opted-in review HTTP preserves signature/body and never overrides application denial", async () => {
  let seen;
  const server = loyaltyHttpServer(
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen = {
        url: req.url,
        body: Buffer.concat(chunks).toString("hex"),
        signature: req.headers["x-weletic-signature"],
      };
      res.writeHead(401);
      res.end("Unauthorized");
    },
    { reviewsEnabled: true },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "/api/internal/shopify/reviews/submit?opaque=a%2Fb&opaque=second";
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: url,
          method: "POST",
          headers: { host, "x-weletic-signature": "synthetic" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(Buffer.from([0, 255, 10, 13]));
    });
    assert.equal(status, 401);
    assert.deepEqual(seen, { url, body: "00ff0a0d", signature: "synthetic" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("core launch retains checkout settlement and balance exports while denying new deferred work", () => {
  const options = { coreLaunch: true, reviewsEnabled: true };
  for (const path of [
    "/api/internal/shopify/loyalty/checkout/release",
    "/api/internal/shopify/merchant/analytics/account-rows",
    "/api/internal/shopify/merchant/analytics/ledger-rows",
  ])
    assert.equal(admitsLoyaltyRequest(input(path), options), true, path);
  for (const path of [
    "/api/internal/shopify/loyalty/checkout/reserve",
    "/api/internal/shopify/merchant/imports",
    "/api/internal/shopify/reviews/open-submit",
  ])
    assert.equal(admitsLoyaltyRequest(input(path), options), false, path);
});
