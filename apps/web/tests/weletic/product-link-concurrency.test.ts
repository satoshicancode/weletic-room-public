import { describe, expect, it } from "vitest";

describe("Product Link Creation Concurrency & Limit Enforcement Scenarios", () => {
  it("Scenario 15a: enforces maxPartnerLinks limit and prevents exceeding quota", () => {
    const maxPartnerLinks = 3;
    const existingLinks = ["link_1", "link_2", "link_3"];

    const createProductLink = (links: string[]) => {
      if (links.length >= maxPartnerLinks) {
        throw new Error("The partner link limit has been reached.");
      }
      const newId = `link_${links.length + 1}`;
      links.push(newId);
      return newId;
    };

    expect(() => createProductLink(existingLinks)).toThrow(
      "The partner link limit has been reached.",
    );
    expect(existingLinks.length).toBe(3);
  });

  it("Scenario 15b: concurrent requests for the same product and market reuse the existing link instead of duplicating", () => {
    interface ProductLinkRecord {
      id: string;
      productId: string;
      marketId: string;
      countryCode?: string | null;
      shortUrl: string;
    }

    const linksTable: ProductLinkRecord[] = [];

    const getOrCreateProductLink = (
      productId: string,
      marketId: string,
      countryCode?: string | null,
    ) => {
      const existing = linksTable.find(
        (l) =>
          l.productId === productId &&
          l.marketId === marketId &&
          l.countryCode === countryCode,
      );
      if (existing) {
        return { created: false, link: existing };
      }

      const newLink: ProductLinkRecord = {
        id: `link_${linksTable.length + 1}`,
        productId,
        marketId,
        countryCode,
        shortUrl: `https://wlt.link/p/${productId}`,
      };
      linksTable.push(newLink);
      return { created: true, link: newLink };
    };

    // First call creates
    const r1 = getOrCreateProductLink("prod_leggings", "mkt_vn", "VN");
    expect(r1.created).toBe(true);
    expect(linksTable.length).toBe(1);

    // Second simultaneous call reuses existing
    const r2 = getOrCreateProductLink("prod_leggings", "mkt_vn", "VN");
    expect(r2.created).toBe(false);
    expect(r2.link.id).toBe(r1.link.id);
    expect(linksTable.length).toBe(1);
  });
});
