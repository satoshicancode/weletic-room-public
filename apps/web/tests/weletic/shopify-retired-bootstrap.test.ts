import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { connectShopifyStore } from "../../scripts/connect-shopify-store";

describe("retired Shopify direct-credential bootstrap", () => {
  it("rejects module callers without echoing supplied identities or credentials", async () => {
    const operation = connectShopifyStore({
      workspaceSlug: "private-fixture-workspace",
      shopDomain: "private-fixture-shop.myshopify.com",
      accessToken: "synthetic-secret-not-for-output",
    });
    await expect(operation).rejects.toThrow("bootstrap is retired");
    await expect(operation).rejects.not.toThrow("private-fixture");
    await expect(operation).rejects.not.toThrow("synthetic-secret");
  });

  it.each([
    { args: [] },
    { args: ["workspace", "shop.myshopify.com", "synthetic-cli-secret"] },
  ])("fails closed from the actual CLI with arguments $args", ({ args }) => {
    let result: unknown;
    try {
      execFileSync(
        process.execPath,
        ["--import=tsx", resolve("scripts/connect-shopify-store.ts"), ...args],
        {
          env: { PATH: process.env.PATH, NODE_ENV: "test" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        },
      );
    } catch (error) {
      result = error;
    }
    expect(result).toMatchObject({ status: 1, stdout: "" });
    const stderr = (result as { stderr: string }).stderr;
    expect(stderr).toContain("Open the app in Shopify Admin");
    expect(stderr).not.toContain("synthetic-cli-secret");
    expect(stderr).not.toContain("shop.myshopify.com");
  });
});
