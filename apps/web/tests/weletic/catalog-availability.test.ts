import { describe, expect, it } from "vitest";

describe("Catalog Availability, Sync Retirement & Translation Scoping Scenarios", () => {
  it("Scenario 12: product is hidden or marked unavailable when contextual market price or publishing is false", () => {
    interface MarketPriceEntry {
      variantId: string;
      marketId: string;
      countryCode: string;
      available: boolean;
      amount: bigint;
    }

    const prices: MarketPriceEntry[] = [
      {
        variantId: "var_us",
        marketId: "mkt_us",
        countryCode: "US",
        available: true,
        amount: BigInt(5000),
      },
      {
        variantId: "var_jp",
        marketId: "mkt_jp",
        countryCode: "JP",
        available: false,
        amount: BigInt(700000),
      }, // Unpublished in JP
    ];

    const isAvailableInCountry = (variantId: string, countryCode: string) => {
      const price = prices.find(
        (p) => p.variantId === variantId && p.countryCode === countryCode,
      );
      return price ? price.available : false;
    };

    expect(isAvailableInCountry("var_us", "US")).toBe(true);
    expect(isAvailableInCountry("var_jp", "JP")).toBe(false);
    expect(isAvailableInCountry("var_unknown", "FR")).toBe(false);
  });

  it("Scenario 13: removed items are retired ONLY after full remote sync succeeds", () => {
    const databaseProducts = [
      { id: "p1", status: "active", updatedAt: new Date("2026-08-01") },
      { id: "p2", status: "active", updatedAt: new Date("2026-08-01") },
    ];

    const syncStartedAt = new Date("2026-08-14T10:00:00Z");

    // Simulating full sync where only p1 still exists in Shopify
    const runSync = (simulateNetworkCrash: boolean) => {
      if (simulateNetworkCrash) {
        // Crash midway -> retirement must NOT run
        throw new Error("Shopify GraphQL timeout during page 2");
      }

      // Sync updated p1
      databaseProducts.find((p) => p.id === "p1")!.updatedAt = new Date(
        "2026-08-14T10:05:00Z",
      );

      // Successful sync completes -> retire stale items (p2)
      for (const prod of databaseProducts) {
        if (prod.updatedAt < syncStartedAt) {
          prod.status = "archived";
        }
      }
    };

    // Test 1: Crash prevents premature deletion/archival
    expect(() => runSync(true)).toThrow();
    expect(databaseProducts.find((p) => p.id === "p2")?.status).toBe("active");

    // Test 2: Full success retires p2
    runSync(false);
    expect(databaseProducts.find((p) => p.id === "p1")?.status).toBe("active");
    expect(databaseProducts.find((p) => p.id === "p2")?.status).toBe(
      "archived",
    );
  });

  it("Scenario 14: market-specific translations do not leak into other markets or global scope", () => {
    interface TranslationRecord {
      productId: string;
      locale: string;
      marketKey: string; // '*' for global, or GID for specific market
      title: string;
    }

    const translations: TranslationRecord[] = [
      {
        productId: "p_leggings",
        locale: "vi",
        marketKey: "*",
        title: "Quần Legging Nâng Mông",
      },
      {
        productId: "p_leggings",
        locale: "vi",
        marketKey: "gid://shopify/Market/vn_special",
        title: "Quần Legging Phiên Bản Đặc Biệt VN",
      },
    ];

    const resolveTranslation = ({
      productId,
      locale,
      marketGid,
    }: {
      productId: string;
      locale: string;
      marketGid?: string;
    }) => {
      if (marketGid) {
        const specific = translations.find(
          (t) =>
            t.productId === productId &&
            t.locale === locale &&
            t.marketKey === marketGid,
        );
        if (specific) return specific.title;
      }
      const global = translations.find(
        (t) =>
          t.productId === productId &&
          t.locale === locale &&
          t.marketKey === "*",
      );
      return global?.title ?? null;
    };

    // Resolving for standard VN market gets special translation
    expect(
      resolveTranslation({
        productId: "p_leggings",
        locale: "vi",
        marketGid: "gid://shopify/Market/vn_special",
      }),
    ).toBe("Quần Legging Phiên Bản Đặc Biệt VN");

    // Resolving for global VN market gets default translation without leaking the special market variant
    expect(
      resolveTranslation({
        productId: "p_leggings",
        locale: "vi",
        marketGid: "gid://shopify/Market/other_market",
      }),
    ).toBe("Quần Legging Nâng Mông");
  });
});
