import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  extensionCorsPreflight,
  privateCustomerJson,
} from "../../../../packages/shopify-app/app/weletic-api.server";
import { shopifyExtensionDevCorsMiddleware } from "../../../../packages/shopify-app/shopify-extension-dev-cors";

const repositoryRoot = path.resolve(__dirname, "../../../..");

describe("Shopify extension gateway CORS", () => {
  test("allows null-origin workers only on extension gateways in Vite development", async () => {
    const source = fs.readFileSync(
      path.join(repositoryRoot, "packages/shopify-app/vite.config.ts"),
      "utf8",
    );
    expect(source).toContain("shopifyExtensionDevCorsPlugin()");
    expect(source).toContain("cors: false");

    const server = createServer((request, response) => {
      shopifyExtensionDevCorsMiddleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const headers = {
        Origin: "null",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      };
      const gateway = await fetch(
        `http://127.0.0.1:${port}/api/customer-account/loyalty/customer`,
        { method: "OPTIONS", headers },
      );
      const viteModule = await fetch(
        `http://127.0.0.1:${port}/@fs/private-source.ts`,
        { method: "OPTIONS", headers },
      );

      expect(gateway.status).toBe(204);
      expect(gateway.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(gateway.headers.get("Access-Control-Allow-Headers")).toBe(
        "Authorization, Content-Type",
      );
      expect(viteModule.status).toBe(404);
      expect(viteModule.headers.has("Access-Control-Allow-Origin")).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("answers unauthenticated preflight before session-token verification", async () => {
    const response = extensionCorsPreflight(
      new Request(
        "https://shopify.weletic.com/api/customer-account/loyalty/customer",
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://shopify.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
          },
        },
      ),
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(204);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response?.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(response?.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type",
    );
    expect(await response?.text()).toBe("");
  });

  test("does not intercept authenticated gateway methods", () => {
    expect(
      extensionCorsPreflight(
        new Request(
          "https://shopify.weletic.com/api/customer-account/loyalty/customer",
        ),
      ),
    ).toBeNull();
    expect(
      extensionCorsPreflight(
        new Request(
          "https://shopify.weletic.com/api/customer-account/loyalty/customer/redeem",
          { method: "POST" },
        ),
      ),
    ).toBeNull();
  });

  test("marks customer data and errors private and non-cacheable", async () => {
    const success = privateCustomerJson({ rewardWallet: [] });
    const failure = privateCustomerJson(
      { error: { code: "unauthorized" } },
      { status: 401 },
    );
    const storefront = privateCustomerJson({ rewardWallet: [] }, {}, "Cookie");

    expect(success.headers.get("Cache-Control")).toBe("private, no-store");
    expect(success.headers.get("Vary")).toBe("Authorization");
    expect(success.headers.get("Access-Control-Expose-Headers")).toBe(
      "Server-Timing, X-Weletic-Request-Id",
    );
    expect(success.headers.get("Timing-Allow-Origin")).toBe("*");
    expect(await success.json()).toEqual({ rewardWallet: [] });
    expect(failure.status).toBe(401);
    expect(failure.headers.get("Cache-Control")).toBe("private, no-store");
    expect(failure.headers.get("Vary")).toBe("Authorization");
    expect(storefront.headers.get("Cache-Control")).toBe("private, no-store");
    expect(storefront.headers.get("Vary")).toBe("Cookie");
  });

  test.each(["api.customer-account.$.ts", "api.checkout.$.ts"])(
    "%s handles preflight before Shopify authentication",
    (routeFile) => {
      const source = fs.readFileSync(
        path.join(repositoryRoot, "packages/shopify-app/app/routes", routeFile),
        "utf8",
      );
      const actionStart = source.indexOf("export async function action");
      const functionSources = [
        source.slice(
          source.indexOf("export async function loader"),
          actionStart,
        ),
        source.slice(actionStart),
      ];

      for (const functionSource of functionSources) {
        const preflightIndex = functionSource.indexOf(
          "extensionCorsPreflight(request)",
        );
        const authenticateIndex = functionSource.indexOf(
          "authenticate.public.",
        );

        expect(preflightIndex).toBeGreaterThan(-1);
        expect(authenticateIndex).toBeGreaterThan(preflightIndex);
      }
    },
  );
});
