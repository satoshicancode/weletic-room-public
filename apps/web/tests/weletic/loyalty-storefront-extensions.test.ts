import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import profileEnglish from "../../../../packages/shopify-app/extensions/weletic-customer-account-blocks/locales/en.default.json";
import {
  availableRewardCount,
  ProfileLoyaltySummaryView,
} from "../../../../packages/shopify-app/extensions/weletic-customer-account-blocks/src/CustomerAccountLoyaltyBlocks";
import {
  calculateBirthdayLockout,
  calculateExactCustomerProgress,
  calculateVipProgress,
  customerCanParticipate,
  customerReferralActivityRewardLabel,
  customerReferralOfferCopy,
  CustomerRewardCard,
  customerRewardStatusDetail,
  customerRewardStatusLabel,
  customerRewardTerms,
  formatCustomerPoints,
  formatCustomerRewardDate,
  formatCustomerTierDestination,
  formatStoreMinorCurrency,
  getOrCreateRedemptionIntentKey,
  isOnlineStoreReward,
  normalizeIssuedRewardArtifact,
  RedeemRewardCard,
  shouldClearRedemptionIntentKey,
  validateCustomerSessionClaims,
  validateIncrementalPointsSelection,
} from "../../../../packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountLoyalty";

describe("Milestone 5: Storefront Theme & Customer Account Extensions Test Suite", () => {
  it.each([
    ["en", "No tier"],
    ["ja-JP", "ランクなし"],
    ["vi-VN", "Chưa có hạng"],
  ])("renders a real no-tier destination in %s", (locale, expected) => {
    expect(formatCustomerTierDestination(null, locale)).toBe(expected);
    expect(formatCustomerTierDestination({ name: "Gold" }, locale)).toBe(
      "Gold",
    );
  });
  const extensionsDir = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions",
  );

  describe("Zero Cleartext DOM PII Architecture Compliance", () => {
    const liquidBlockPaths = [
      path.join(extensionsDir, "weletic-analytics/blocks/app-embed.liquid"),
      path.join(
        extensionsDir,
        "weletic-analytics/blocks/loyalty-landing.liquid",
      ),
      path.join(
        extensionsDir,
        "weletic-analytics/blocks/product-points-preview.liquid",
      ),
    ];

    it("verifies all Liquid blocks exist and contain zero cleartext DOM PII attributes", () => {
      liquidBlockPaths.forEach((blockPath) => {
        expect(fs.existsSync(blockPath)).toBe(true);
        const content = fs.readFileSync(blockPath, "utf-8");

        // Forbidden DOM PII attributes
        expect(content).not.toContain("data-customer-email");
        expect(content).not.toContain("data-customer-first-name");
        expect(content).not.toContain("data-customer-last-name");
        expect(content).not.toContain("data-customer-name");
        expect(content).not.toContain("data-customer-phone");
        expect(content).not.toContain("data-customer-birthday");
        expect(content).not.toContain("customer.email");
        expect(content).not.toContain("customer.phone");

        // Customer state must be safely represented only as boolean or permanent domain
        if (content.includes("data-logged-in")) {
          expect(content).toContain(
            'data-logged-in="{% if customer %}true{% else %}false{% endif %}"',
          );
        }
      });
    });

    it("verifies theme extension manifest declares all entry points", () => {
      const tomlPath = path.join(
        extensionsDir,
        "weletic-analytics/shopify.extension.toml",
      );
      expect(fs.existsSync(tomlPath)).toBe(true);
      const tomlContent = fs.readFileSync(tomlPath, "utf-8");

      expect(tomlContent).toContain("blocks/app-embed.liquid");
      expect(tomlContent).toContain("blocks/loyalty-landing.liquid");
      expect(tomlContent).toContain("blocks/product-points-preview.liquid");
    });

    it("keeps the customer account page target isolated from block targets", () => {
      const hubManifest = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-customer-account/shopify.extension.toml",
        ),
        "utf-8",
      );
      const blocksManifest = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-customer-account-blocks/shopify.extension.toml",
        ),
        "utf-8",
      );

      expect(hubManifest).toContain('target = "customer-account.page.render"');
      expect(hubManifest).not.toContain(
        "customer-account.profile.block.render",
      );
      expect(hubManifest).not.toContain(
        "customer-account.order-status.block.render",
      );

      expect(blocksManifest).not.toContain("customer-account.page.render");
      expect(blocksManifest).toContain(
        'target = "customer-account.profile.block.render"',
      );
      expect(blocksManifest).not.toContain(
        "customer-account.order-status.block.render",
      );
    });
  });

  describe("Shopify app distribution", () => {
    it("keeps App Store distribution by default with a staging custom-app override", () => {
      const shopifyServer = fs.readFileSync(
        path.join(extensionsDir, "../app/shopify.server.ts"),
        "utf-8",
      );

      expect(shopifyServer).toContain("SHOPIFY_APP_DISTRIBUTION");
      expect(shopifyServer).toContain("AppDistribution.SingleMerchant");
      expect(shopifyServer).toContain("AppDistribution.AppStore");
      expect(shopifyServer).toContain("distribution: appDistribution");
    });

    it("keeps external API endpoints as Remix resource routes", () => {
      const routeNames = [
        "apps.proxy.$.ts",
        "api.checkout.$.ts",
        "api.customer-account.$.ts",
      ];

      routeNames.forEach((routeName) => {
        const routeSource = fs.readFileSync(
          path.join(extensionsDir, `../app/routes/${routeName}`),
          "utf-8",
        );

        expect(routeSource).toContain("export async function loader");
        expect(routeSource).not.toContain("export default");
        expect(routeSource).not.toContain("export function ErrorBoundary");
      });
    });
  });

  describe("Paid-order retry contract", () => {
    it("replays idempotent loyalty effects for duplicate Shopify webhooks", () => {
      const recordOrderSource = fs.readFileSync(
        path.resolve(__dirname, "../../lib/weletic/commerce/record-order.ts"),
        "utf-8",
      );

      expect(recordOrderSource).toContain(
        "const loyalty = await finalizeOrderLoyalty({",
      );
      expect(recordOrderSource).toContain("expectedInstallationGeneration,");
      expect(recordOrderSource).not.toContain("shopperId && !existing");
      expect(recordOrderSource).not.toContain(
        "Failed to process loyalty lifecycle for order",
      );
    });
  });

  describe("Theme loyalty tier contract", () => {
    const tierAssetNames = [
      "weletic-loyalty-widget.js",
      "weletic-loyalty-landing.js",
    ];

    it("renders canonical milestone thresholds and multiplier fields", () => {
      tierAssetNames.forEach((assetName) => {
        const source = fs.readFileSync(
          path.join(extensionsDir, "weletic-analytics/assets", assetName),
          "utf-8",
        );

        expect(source).toContain("vipMilestoneMode");
        expect(source).toContain("minPointsThreshold");
        expect(source).toContain("minSpendThreshold");
        expect(source).toContain("pointsMultiplier");
        expect(source).not.toContain('.spend || "$0"');
      });
    });

    it("formats base-currency tier thresholds from the program contract", () => {
      tierAssetNames.forEach((assetName) => {
        const source = fs.readFileSync(
          path.join(extensionsDir, "weletic-analytics/assets", assetName),
          "utf-8",
        );

        expect(source).toContain("currencyCode");
        expect(source).toMatch(/(?:state\.)?program\?\.currency/);
      });

      const programRoute = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../app/api/internal/shopify/loyalty/program/route.ts",
        ),
        "utf-8",
      );
      expect(programRoute).toContain("currency: store.shopCurrency");
      expect(programRoute).toContain("provisionableOnly: true");

      const rewardEditor = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../ui/weletic/loyalty/reward-catalog-screen.tsx",
        ),
        "utf-8",
      );
      expect(rewardEditor).toContain('"free_product"');
      expect(rewardEditor).toContain("entitledVariantIds");
    });
  });

  describe("Shopify OAuth credential binding", () => {
    it("verifies and persists one canonical shop identity beside every offline token", () => {
      const callbackRoute = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../app/(ee)/api/shopify/integration/callback/route.ts",
        ),
        "utf-8",
      );

      expect(callbackRoute).toContain("canonicalizeShopifyDomain(");
      expect(callbackRoute).toContain("fetchVerifiedShopifyShopDetails({");
      expect(callbackRoute).toContain("shopifyStoreId: verifiedShopDomain");
      expect(callbackRoute).toContain("shop: verifiedShopDomain");
      expect(callbackRoute).toContain("installationGeneration:");
      expect(callbackRoute).toContain("shopVerificationTokenHash:");
    });
  });

  describe("Customer Account Extension: Session Token Claims Validation", () => {
    it("validates valid Shopify Customer Account JWT claims", () => {
      const claims = {
        dest: "https://n0pvef-cs.myshopify.com",
        sub: "gid://shopify/Customer/847291048",
      };

      const result = validateCustomerSessionClaims(claims);
      expect(result.valid).toBe(true);
      expect(result.shopDomain).toBe("n0pvef-cs.myshopify.com");
      expect(result.customerId).toBe("847291048");
      expect(result.error).toBeUndefined();
    });

    it("handles plain numeric sub customer IDs seamlessly", () => {
      const claims = {
        dest: "store.myshopify.com",
        sub: "12345678",
      };

      const result = validateCustomerSessionClaims(claims);
      expect(result.valid).toBe(true);
      expect(result.customerId).toBe("12345678");
    });

    it("rejects missing or malformed dest claim", () => {
      expect(
        validateCustomerSessionClaims({ sub: "gid://shopify/Customer/1" })
          .valid,
      ).toBe(false);
      expect(
        validateCustomerSessionClaims({
          dest: "not-a-valid-domain",
          sub: "123",
        }).valid,
      ).toBe(false);
    });

    it("rejects missing or empty sub claim", () => {
      expect(
        validateCustomerSessionClaims({
          dest: "https://store.myshopify.com",
          sub: "",
        }).valid,
      ).toBe(false);
      expect(
        validateCustomerSessionClaims({ dest: "https://store.myshopify.com" })
          .valid,
      ).toBe(false);
    });
  });

  describe("Persistent customer coupon wallet", () => {
    it("withholds shopper actions when the program or account is restricted", () => {
      expect(
        customerCanParticipate(true, {
          status: "active",
          canParticipate: true,
        }),
      ).toBe(true);
      expect(
        customerCanParticipate(true, {
          status: "suspended",
          canParticipate: false,
        }),
      ).toBe(false);
      expect(
        customerCanParticipate(true, {
          status: "closed",
          canParticipate: false,
        }),
      ).toBe(false);
      expect(
        customerCanParticipate(true, {
          status: "suspended",
          canParticipate: true,
        }),
      ).toBe(false);
      expect(
        customerCanParticipate(true, {
          status: "active",
          canParticipate: false,
        }),
      ).toBe(false);
      expect(customerCanParticipate(true, { status: "active" })).toBe(false);
      expect(customerCanParticipate(true)).toBe(false);
      expect(
        customerCanParticipate(false, {
          status: "active",
          canParticipate: true,
        }),
      ).toBe(false);
    });

    it("renders customer-safe reward terms and branded point names", () => {
      expect(
        customerRewardTerms(
          {
            id: "reward-terms",
            name: "Free Yamax Flow",
            rewardType: "free_product",
            pointsCost: "100",
            canRedeem: true,
            minOrderAmount: 5_000,
            expiresInDays: 30,
            usageLimitPerCustomer: 1,
            entitledProductIds: ["gid://shopify/Product/1"],
          },
          "JPY",
        ),
      ).toEqual([
        "Minimum purchase ¥5,000",
        "Expires 30 days after redemption",
        "1 use per customer",
        "Applies to selected products or collections",
      ]);
      expect(formatCustomerPoints(1, "Coin", "Coins")).toBe("1 Coin");
      expect(formatCustomerPoints(2500, "Coin", "Coins")).toBe("2,500 Coins");
      expect(formatCustomerPoints("-9007199254740993", "Coin", "Coins")).toBe(
        "-9,007,199,254,740,993 Coins",
      );
    });

    it("formats stored minor-unit minimums for 2- and 3-decimal currencies", () => {
      const minimumTerms = (currency: string) =>
        customerRewardTerms(
          {
            minOrderAmount: "5000",
          },
          currency,
          "en-US",
        )[0];

      expect(minimumTerms("USD")).toBe("Minimum purchase $50.00");
      expect(minimumTerms("EUR")).toBe("Minimum purchase €50.00");
      expect(minimumTerms("BHD")).toContain("BHD");
      expect(minimumTerms("BHD")).toContain("5.000");
      expect(
        formatStoreMinorCurrency("900719925474099312", "USD", "en-US"),
      ).toBe("$9,007,199,254,740,993.12");
      expect(
        formatStoreMinorCurrency("-900719925474099312", "USD", "en-US"),
      ).toBe("-$9,007,199,254,740,993.12");
    });

    it("renders immutable issuance-time terms before an edited catalog definition", () => {
      const collectText = (node: any): string => {
        if (Array.isArray(node)) return node.map(collectText).join("");
        if (typeof node === "string" || typeof node === "number") {
          return String(node);
        }
        if (!node || typeof node !== "object") return "";
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return children.map(collectText).join("");
      };
      const baseReward = {
        id: "snapshot-reward",
        rewardName: "$10 Voucher at issuance",
        rewardType: "amount_off",
        pointsSpent: "500",
        discountCode: "WL-SNAPSHOT",
        status: "available" as const,
        issuedAt: "2026-09-01T00:00:00.000Z",
      };
      const currentDefinition = {
        id: "reward-edited",
        name: "$25 Voucher after edit",
        rewardType: "amount_off" as const,
        pointsCost: "500",
        canRedeem: true,
        minOrderAmount: "25000",
        expiresInDays: 90,
        usageLimitPerCustomer: 1,
        appliesToResource: "entire_order",
      };

      const snapshotView = CustomerRewardCard({
        reward: {
          ...baseReward,
          termsSource: "issuance_snapshot",
          termsSnapshot: {
            version: 1,
            rewardType: "amount_off",
            salesChannel: "online_store",
            currency: "USD",
            minOrderAmount: "5000",
            expiresInDays: 30,
            usageLimitPerCustomer: 1,
            appliesToResource: "selected_products",
            entitlementCount: 1,
            combinesWithProductDiscounts: false,
            combinesWithOrderDiscounts: true,
            combinesWithShippingDiscounts: false,
          },
        },
        rewardDefinition: currentDefinition,
        currency: "USD",
      });
      const snapshotText = collectText(snapshotView);
      expect(snapshotText).toContain("Minimum purchase $50.00");
      expect(snapshotText).toContain("Expires 30 days after redemption");
      expect(snapshotText).toContain(
        "Applies to selected products or collections",
      );
      expect(snapshotText).not.toContain("$250.00");
      expect(snapshotText).not.toContain("90 days");
      expect(snapshotText).not.toContain("legacy reward");

      const legacyText = collectText(
        CustomerRewardCard({
          reward: {
            ...baseReward,
            termsSource: "legacy",
            termsSnapshot: null,
          },
          rewardDefinition: currentDefinition,
          currency: "USD",
        }),
      );
      expect(legacyText).toContain("Minimum purchase $250.00");
      expect(legacyText).toContain(
        "Original terms are unavailable for this legacy reward; current reward terms are shown.",
      );
    });

    it("renders verified referral terms and withholds corrupted modern snapshots", () => {
      const collectText = (node: any): string => {
        if (Array.isArray(node)) return node.map(collectText).join("");
        if (typeof node === "string" || typeof node === "number") {
          return String(node);
        }
        if (!node || typeof node !== "object") return "";
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return children.map(collectText).join("");
      };
      const rewardDefinition = {
        id: "referral-reward-current",
        name: "Referral voucher after edit",
        rewardType: "amount_off" as const,
        pointsCost: "0",
        canRedeem: false,
        minOrderAmount: "25000",
        expiresInDays: 90,
        appliesToResource: "entire_order",
      };
      const referralReward = {
        id: "referral-wallet-reward",
        rewardName: "Referral voucher at qualification",
        rewardType: "amount_off",
        pointsSpent: "0",
        discountCode: "WLR-VERIFIED",
        status: "available" as const,
        issuedAt: "2029-01-01T00:00:00.000Z",
      };

      const verifiedText = collectText(
        CustomerRewardCard({
          reward: {
            ...referralReward,
            termsSource: "issuance_snapshot",
            termsSnapshot: {
              version: 1,
              rewardType: "amount_off",
              salesChannel: "online_store",
              currency: "EUR",
              minOrderAmount: "7500",
              expiresInDays: 30,
              usageLimitPerCustomer: 1,
              appliesToResource: "selected_products",
              entitlementCount: 1,
              combinesWithProductDiscounts: false,
              combinesWithOrderDiscounts: true,
              combinesWithShippingDiscounts: false,
            },
          },
          rewardDefinition,
          currency: "USD",
        }),
      );
      expect(verifiedText).toContain("Minimum purchase €75.00");
      expect(verifiedText).toContain("Expires 30 days after redemption");
      expect(verifiedText).not.toContain("$250.00");
      expect(verifiedText).not.toContain("90 days");

      const corruptedText = collectText(
        CustomerRewardCard({
          reward: {
            ...referralReward,
            id: "corrupted-referral-wallet-reward",
            termsSource: "unavailable",
            termsSnapshot: null,
          },
          rewardDefinition,
          currency: "USD",
        }),
      );
      expect(corruptedText).toContain(
        "Original reward terms could not be verified and are unavailable.",
      );
      expect(corruptedText).not.toContain("$250.00");
      expect(corruptedText).not.toContain("90 days");
    });

    it("supports incremental amount-off redemption in the Shopify Basic theme widget", () => {
      const widgetSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-loyalty-widget.js",
        ),
        "utf-8",
      );

      expect(widgetSource).toContain("data-reward-points");
      expect(widgetSource).toContain("pointsRequested");
      expect(widgetSource).toContain("minPointsCost");
      expect(widgetSource).toContain("pointsStep");
      expect(widgetSource).toContain("redemptionIntentKeys");
      expect(widgetSource).toContain("delete redemptionIntentKeys[intentId]");
    });

    it("persists a bounded storefront referral code across navigation", () => {
      const widgetSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-loyalty-widget.js",
        ),
        "utf-8",
      );

      expect(widgetSource).toContain(
        "new URLSearchParams(window.location.search)",
      );
      expect(widgetSource).toContain('referralParams.get("ref")');
      expect(widgetSource).toContain("referralCodeCandidate.length <= 64");
      expect(widgetSource).toContain(
        'var referralStorageKey = "weletic_referral_code"',
      );
      expect(widgetSource).toContain("window.sessionStorage.setItem(");
      expect(widgetSource).toContain("window.sessionStorage.getItem(");
      expect(widgetSource).toContain("_storageWriteError");
    });

    it("formats customer-facing coupon statuses and dates", () => {
      expect(customerRewardStatusLabel("available")).toBe("Available");
      expect(customerRewardStatusLabel("used")).toBe("Used");
      expect(customerRewardStatusLabel("expired")).toBe("Expired");
      expect(customerRewardStatusLabel("cancelled")).toBe("Cancelled");
      expect(
        formatCustomerRewardDate("2026-08-28T00:00:00.000Z", "en-US"),
      ).toBe("Aug 28, 2026");
      expect(formatCustomerRewardDate("invalid", "en-US")).toBeNull();

      const baseReward = {
        id: "reward-1",
        rewardName: "$10 Voucher",
        pointsSpent: "500",
        discountCode: "WL-TEST",
        issuedAt: "2026-08-01T00:00:00.000Z",
        statusDate: "2026-08-28T00:00:00.000Z",
      } as const;
      expect(
        customerRewardStatusDetail(
          { ...baseReward, status: "used", orderName: "#1001" },
          "en-US",
        ),
      ).toBe("Used on Aug 28, 2026 · Order #1001");
      expect(
        customerRewardStatusDetail(
          { ...baseReward, status: "expired" },
          "en-US",
        ),
      ).toBe("Expired on Aug 28, 2026");
      expect(
        customerRewardStatusDetail(
          { ...baseReward, status: "cancelled" },
          "en-US",
        ),
      ).toBe("Cancelled on Aug 28, 2026");
    });

    it("renders copy/apply controls only for available customer rewards", () => {
      const baseReward = {
        id: "reward-1",
        rewardName: "$10 Voucher",
        pointsSpent: "500",
        discountCode: "WL-COPY-ME",
        issuedAt: "2026-08-01T00:00:00.000Z",
        statusDate: "2026-08-28T00:00:00.000Z",
      } as const;
      const collectVNodes = (node: any): any[] => {
        if (!node || typeof node !== "object") return [];
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return [node, ...children.flatMap(collectVNodes)];
      };

      const availableNodes = collectVNodes(
        CustomerRewardCard({
          reward: {
            ...baseReward,
            status: "available",
            applyUrl:
              "https://n0pvef-cs.myshopify.com/discount/WL-COPY-ME?redirect=/cart",
          },
        }),
      );
      const clipboard = availableNodes.find(
        (node) => node.type === "s-clipboard-item",
      );
      const copyButton = availableNodes.find(
        (node) => node.props?.command === "--copy",
      );
      const applyButton = availableNodes.find((node) =>
        node.props?.href?.includes("/discount/WL-COPY-ME"),
      );

      expect(clipboard?.props).toMatchObject({
        id: "weletic-reward-reward-1",
        text: "WL-COPY-ME",
      });
      expect(copyButton?.props.commandFor).toBe("weletic-reward-reward-1");
      expect(applyButton?.props.href).toContain("redirect=/cart");

      const restrictedView = CustomerRewardCard({
        reward: {
          ...baseReward,
          status: "available",
          applyUrl:
            "https://n0pvef-cs.myshopify.com/discount/WL-COPY-ME?redirect=/cart",
        },
        actionsEnabled: false,
      });
      const restrictedNodes = collectVNodes(restrictedView);
      expect(
        restrictedNodes.some((node) => node.type === "s-clipboard-item"),
      ).toBe(false);
      expect(
        restrictedNodes.some((node) => node.props?.command === "--copy"),
      ).toBe(false);
      expect(
        restrictedNodes.some((node) =>
          node.props?.href?.includes("/discount/WL-COPY-ME"),
        ),
      ).toBe(false);
      expect(
        restrictedNodes.some((node) => node.props?.children === "WL-COPY-ME"),
      ).toBe(true);

      const usedNodes = collectVNodes(
        CustomerRewardCard({
          reward: {
            ...baseReward,
            status: "used",
            orderName: "#1001",
          },
        }),
      );
      expect(usedNodes.some((node) => node.type === "s-clipboard-item")).toBe(
        false,
      );
      expect(usedNodes.some((node) => node.props?.command === "--copy")).toBe(
        false,
      );
      expect(
        usedNodes.some((node) =>
          String(node.props?.children).includes("Order #1001"),
        ),
      ).toBe(true);
    });

    it("keeps financial reward artifacts safe and retrievable", () => {
      const collectVNodes = (node: any): any[] => {
        if (!node || typeof node !== "object") return [];
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return [node, ...children.flatMap(collectVNodes)];
      };
      const collectText = (node: any): string => {
        if (typeof node === "string" || typeof node === "number") {
          return String(node);
        }
        if (!node || typeof node !== "object") return "";
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return children.map(collectText).join("");
      };

      const giftNodes = collectVNodes(
        CustomerRewardCard({
          reward: {
            id: "gift-1",
            rewardName: "Gift Card",
            pointsSpent: "1000",
            artifactKind: "gift_card",
            artifactCode: "WLGC123456",
            status: "available",
            issuedAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      );
      expect(
        giftNodes.find((node) => node.type === "s-clipboard-item")?.props.text,
      ).toBe("WLGC123456");

      const creditView = CustomerRewardCard({
        reward: {
          id: "credit-1",
          rewardName: "Store Credit",
          pointsSpent: "1000",
          artifactKind: "store_credit",
          artifactCode: "internal-transaction-reference",
          discountCode: "legacy-internal-reference",
          status: "available",
          issuedAt: "2026-09-01T00:00:00.000Z",
        },
      });
      const creditNodes = collectVNodes(creditView);
      expect(collectText(creditView)).toContain(
        "Added to your customer balance",
      );
      expect(creditNodes.some((node) => node.type === "s-clipboard-item")).toBe(
        false,
      );
      expect(collectText(creditView)).not.toContain(
        "internal-transaction-reference",
      );
      expect(
        normalizeIssuedRewardArtifact({
          artifactKind: "store_credit",
          discountCode: "internal-transaction-reference",
        }),
      ).toEqual({ artifactKind: "store_credit", artifactCode: null });
    });

    it("keeps POS-only rewards out of online shopper surfaces", () => {
      expect(
        isOnlineStoreReward({
          id: "online-reward",
          name: "Online reward",
          rewardType: "amount_off",
          salesChannel: "online_store",
          pointsCost: "100",
          canRedeem: true,
        }),
      ).toBe(true);
      expect(
        isOnlineStoreReward({
          id: "pos-reward",
          name: "POS reward",
          rewardType: "amount_off",
          salesChannel: "pos",
          pointsCost: "100",
          canRedeem: true,
        }),
      ).toBe(false);
      expect(
        isOnlineStoreReward({
          id: "both-reward",
          name: "Omnichannel reward",
          rewardType: "amount_off",
          salesChannel: "both",
          pointsCost: "100",
          canRedeem: true,
        }),
      ).toBe(true);
      expect(
        isOnlineStoreReward({
          id: "missing-channel",
          name: "Unverified reward",
          rewardType: "amount_off",
          pointsCost: "100",
          canRedeem: true,
        }),
      ).toBe(false);
      expect(
        isOnlineStoreReward({
          id: "invalid-channel",
          name: "Malformed reward",
          rewardType: "amount_off",
          salesChannel: "marketplace" as any,
          pointsCost: "100",
          canRedeem: true,
        }),
      ).toBe(false);

      const themeSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-loyalty-widget.js",
        ),
        "utf-8",
      );
      expect(themeSource).toContain("function isOnlineStoreReward(reward)");
      expect(themeSource).toContain("filter(\n        isOnlineStoreReward,");
    });

    it("uses a native full-page hierarchy with grouped responsive reward cards", () => {
      const customerAccountSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-customer-account/src/CustomerAccountLoyalty.tsx",
        ),
        "utf-8",
      );

      expect(customerAccountSource).toContain('heading="Loyalty Hub"');
      expect(customerAccountSource).toContain('inlineSize="large"');
      expect(customerAccountSource).toContain("<s-query-container>");
      expect(customerAccountSource).toContain(
        'gridTemplateColumns="@container (inline-size > 760px) 2fr 1fr, 1fr"',
      );
      expect(customerAccountSource).toContain(
        'accessibilityRole="unordered-list"',
      );
      expect(customerAccountSource).toContain("<s-button-group");
      expect(customerAccountSource).not.toContain(
        '<s-section heading="Rewards">\n      <s-box',
      );
    });

    it("explains disabled redemptions instead of relying on button state alone", () => {
      const collectVNodes = (node: any): any[] => {
        if (!node || typeof node !== "object") return [];
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return [node, ...children.flatMap(collectVNodes)];
      };
      const collectText = (node: any): string => {
        if (typeof node === "string" || typeof node === "number") {
          return String(node);
        }
        if (!node || typeof node !== "object") return "";
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return children.map(collectText).join("");
      };
      const view = RedeemRewardCard({
        reward: {
          id: "reward-definition-1",
          name: "$10 Voucher",
          pointsCost: "500",
          canRedeem: false,
        },
        pointsBalance: 125,
        redeeming: null,
        onRedeem: () => undefined,
      });
      const nodes = collectVNodes(view);

      expect(collectText(view)).toContain("Earn 375 more points to redeem.");
      expect(
        nodes.find((node) => node.type === "s-button")?.props.disabled,
      ).toBe(true);
    });

    it("validates incremental point selections as exact integer strings", () => {
      const exactLargeSelection = validateIncrementalPointsSelection({
        pointsRequested: "9007199254740993",
        pointsBalance: "9007199254741003",
        pointsCost: "9007199254740993",
        minPointsCost: "9007199254740993",
        maxPointsCost: "9007199254741003",
        pointsStep: "1",
      });
      expect(exactLargeSelection).toEqual({
        valid: true,
        pointsRequested: "9007199254740993",
        error: null,
      });

      const common = {
        pointsBalance: "2000",
        pointsCost: "500",
        minPointsCost: "500",
        maxPointsCost: "1500",
        pointsStep: "100",
      };
      expect(
        validateIncrementalPointsSelection({
          ...common,
          pointsRequested: "0",
        }),
      ).toMatchObject({ valid: false, pointsRequested: null });
      expect(
        validateIncrementalPointsSelection({
          ...common,
          pointsRequested: "1600",
        }),
      ).toMatchObject({ valid: false, pointsRequested: null });
      expect(
        validateIncrementalPointsSelection({
          ...common,
          pointsRequested: "550",
        }),
      ).toMatchObject({ valid: false, pointsRequested: null });
    });

    it("normalizes huge exact point progress without unsafe Number operands", () => {
      expect(
        calculateExactCustomerProgress(
          "9007199254740993000000000000000000",
          "18014398509481986000000000000000000",
        ),
      ).toEqual({
        value: 5000,
        max: 10000,
        percent: 50,
        remaining: "9007199254740993000000000000000000",
      });
      expect(calculateExactCustomerProgress("0", "9007199254740993")).toEqual({
        value: 0,
        max: 10000,
        percent: 0,
        remaining: "9007199254740993",
      });
    });

    it("preserves a typed zero and never converts it into a default redemption", () => {
      let redeemCalls = 0;
      const selections: string[] = [];
      const collectVNodes = (node: any): any[] => {
        if (!node || typeof node !== "object") return [];
        const children = Array.isArray(node.props?.children)
          ? node.props.children
          : [node.props?.children];
        return [node, ...children.flatMap(collectVNodes)];
      };
      const view = RedeemRewardCard({
        reward: {
          id: "reward-incremental",
          name: "Choose your discount",
          rewardType: "amount_off",
          exchangeType: "incremental",
          pointsCost: "500",
          minPointsCost: "500",
          maxPointsCost: "1500",
          pointsStep: "100",
          canRedeem: true,
        },
        pointsBalance: "2000",
        selectedPoints: "0",
        redeeming: null,
        onPointsChange: (value) => selections.push(value),
        onRedeem: () => {
          redeemCalls += 1;
        },
      });
      const nodes = collectVNodes(view);
      const field = nodes.find((node) => node.type === "s-number-field");
      const button = nodes.find((node) => node.type === "s-button");

      expect(field?.props.value).toBe("0");
      expect(field?.props.error).toContain("at least 500");
      field?.props.onInput({ currentTarget: { value: "0" } });
      expect(selections).toEqual(["0"]);
      expect(button?.props.disabled).toBe(true);
      button?.props.onClick();
      expect(redeemCalls).toBe(0);
    });

    it("derives referral copy and point totals from the configured reward kinds", () => {
      expect(
        customerReferralOfferCopy(
          {
            refereeRewardKind: "points",
            refereePointsReward: "250",
            advocateRewardKind: "coupon",
            advocatePointsReward: "0",
            advocateRewardName: "$10 Voucher",
          },
          "Coin",
          "Coins",
        ),
      ).toMatchObject({
        heading: "Give 250 Coins, get $10 Voucher",
        qualification:
          "Your friend receives 250 Coins after completing their first eligible order. You receive $10 Voucher when they qualify.",
        showPointsEarned: false,
      });
      expect(
        customerReferralOfferCopy({
          refereeRewardKind: "coupon",
          refereePointsReward: "0",
          refereeRewardName: "Welcome voucher",
          advocateRewardKind: "points",
          advocatePointsReward: "500",
        }),
      ).toMatchObject({
        qualification:
          "Your friend can claim Welcome voucher before their first eligible order. You receive 500 Points when they qualify.",
        showPointsEarned: true,
      });
    });

    it("shows referral activity points only for point advocate rewards", () => {
      expect(
        customerReferralActivityRewardLabel("points", "250", "Coin", "Coins"),
      ).toBe("250 Coins");
      expect(
        customerReferralActivityRewardLabel("coupon", "0", "Coin", "Coins"),
      ).toBeNull();
    });

    it("keeps the Profile surface compact and linked to the Rewards hub", () => {
      const summary = {
        isEnrolled: true,
        account: { pointsBalance: "1250" },
        tier: { currentTier: { name: "Gold" } },
        rewardWallet: [
          { status: "available" },
          { status: "used" },
          { status: "available" },
        ],
      };
      const view = ProfileLoyaltySummaryView({
        summary,
        i18n: {
          formatNumber: (value) => new Intl.NumberFormat("en").format(value),
          translate: (key, values = {}) => {
            const text = (profileEnglish as Record<string, string>)[key];
            if (!text) throw new Error("Missing profile translation");
            return text.replace(/{{(\w+)}}/g, (_, name) =>
              String(values[name]),
            );
          },
        },
      });
      const children = Array.isArray(view.props.children)
        ? view.props.children
        : [view.props.children];
      const action = children.find((child: any) => child?.type === "s-button");

      expect(availableRewardCount(summary)).toBe(2);
      expect(view.type).toBe("s-section");
      expect(view.props.heading).toBe("Rewards");
      expect(action?.props).toMatchObject({
        slot: "primary-action",
        href: "extension:weletic-loyalty-customer-account-hub/",
      });
      expect(action?.props.children).toBe("View Loyalty Hub");

      const blockSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-customer-account-blocks/src/CustomerAccountLoyaltyBlocks.tsx",
        ),
        "utf-8",
      );
      expect(blockSource).not.toContain(
        'from "../../weletic-customer-account/src/CustomerAccountLoyalty"',
      );
    });

    it("renders persistent coupon retrieval in both customer surfaces", () => {
      const customerAccountSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-customer-account/src/CustomerAccountLoyalty.tsx",
        ),
        "utf-8",
      );
      const profileBlockSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-customer-account-blocks/src/CustomerAccountLoyaltyBlocks.tsx",
        ),
        "utf-8",
      );
      const storefrontWidgetSource = fs.readFileSync(
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-loyalty-widget.js",
        ),
        "utf-8",
      );

      expect(customerAccountSource).toContain("rewardWallet");
      expect(customerAccountSource).toContain("<s-clipboard-item");
      expect(customerAccountSource).toContain("Your rewards");
      expect(customerAccountSource).toContain("Reward history");
      expect(customerAccountSource).toContain("CUSTOMER_REQUEST_TIMEOUT_MS");
      expect(customerAccountSource).not.toContain(
        "CUSTOMER_MUTATION_TIMEOUT_MS",
      );
      expect(customerAccountSource).toContain("AbortController");
      expect(customerAccountSource).toContain("Try again");
      expect(profileBlockSource).toContain("CUSTOMER_REQUEST_TIMEOUT_MS");
      expect(profileBlockSource).toContain('shopify.i18n.translate("retry")');
      expect(profileEnglish.retry).toBe("Try again");
      expect(storefrontWidgetSource).toContain("rewardWallet");
      expect(storefrontWidgetSource).toContain("data-copy-code");
      expect(storefrontWidgetSource).toContain("rewardArtifactKind");
      expect(storefrontWidgetSource).toContain(
        "Store credit was added to your Shopify customer balance",
      );
      expect(storefrontWidgetSource).toContain("Your Rewards");
      expect(storefrontWidgetSource).toContain("Reward History");
      expect(storefrontWidgetSource).not.toContain(".slice(0, 5)");
      expect(storefrontWidgetSource).not.toContain(".slice(0, 3)");
      expect(customerAccountSource).toContain(
        "await loadSummary().catch(() => undefined)",
      );
      expect(storefrontWidgetSource).toContain("Summary refresh failed:");
      expect(storefrontWidgetSource).toContain(
        'throw new Error("Unable to refresh rewards summary")',
      );
    });

    it("reuses a redemption intent key until the outcome is definitive", () => {
      const keys = new Map<string, string>();
      let sequence = 0;
      const createKey = () => `intent-${++sequence}`;

      expect(getOrCreateRedemptionIntentKey(keys, "reward-a", createKey)).toBe(
        "intent-1",
      );
      expect(getOrCreateRedemptionIntentKey(keys, "reward-a", createKey)).toBe(
        "intent-1",
      );
      expect(getOrCreateRedemptionIntentKey(keys, "reward-b", createKey)).toBe(
        "intent-2",
      );

      keys.delete("reward-a");
      expect(getOrCreateRedemptionIntentKey(keys, "reward-a", createKey)).toBe(
        "intent-3",
      );
    });

    it("clears redemption intent keys only after successful responses", () => {
      expect(shouldClearRedemptionIntentKey(200)).toBe(true);
      expect(shouldClearRedemptionIntentKey(201)).toBe(true);
      expect(shouldClearRedemptionIntentKey(400)).toBe(false);
      expect(shouldClearRedemptionIntentKey(500)).toBe(false);
      expect(shouldClearRedemptionIntentKey(504)).toBe(false);
    });
  });

  describe("Customer Account Extension: 30-Day Anti-Gaming Birthday Lockout Guard", () => {
    it("allows birthday bonus in current year when submitted >= 30 days in advance", () => {
      // Submission on March 1, 2026 for birthday on June 15 (106 days away)
      const submissionDate = new Date(2026, 2, 1); // March 1
      const result = calculateBirthdayLockout(6, 15, submissionDate);

      expect(result.isLockedOut).toBe(false);
      expect(result.nextEligibleYear).toBe(2026);
      expect(result.daysUntilBirthday).toBeGreaterThanOrEqual(30);
    });

    it("enforces lockout until next year when submitted < 30 days before birthday", () => {
      // Submission on August 20, 2026 for birthday on August 28 (8 days away)
      const submissionDate = new Date(2026, 7, 20); // August 20
      const result = calculateBirthdayLockout(8, 28, submissionDate);

      expect(result.isLockedOut).toBe(true);
      expect(result.nextEligibleYear).toBe(2027);
      expect(result.daysUntilBirthday).toBe(8);
    });

    it("locks out same-day birthday registrations", () => {
      // Submission on October 10 for birthday on October 10 (0 days away)
      const submissionDate = new Date(2026, 9, 10); // October 10
      const result = calculateBirthdayLockout(10, 10, submissionDate);

      expect(result.isLockedOut).toBe(true);
      expect(result.nextEligibleYear).toBe(2027);
    });

    it("correctly rolls over to next year when birthday already passed in current year", () => {
      // Submission on November 1, 2026 for birthday on February 10 (which passed 9 months ago)
      const submissionDate = new Date(2026, 10, 1); // Nov 1
      const result = calculateBirthdayLockout(2, 10, submissionDate);

      // Next birthday is Feb 10, 2027 (101 days away >= 30 days)
      expect(result.isLockedOut).toBe(false);
      expect(result.nextEligibleYear).toBe(2027);
    });
  });

  describe("Customer Account Extension: VIP Progress & Math", () => {
    it("calculates accurate VIP tier progression and remaining spend", () => {
      // Current spend $150.00 (15000 minor units), Next tier threshold $200.00 (20000 minor units)
      const progress = calculateVipProgress(15000, 20000);
      expect(progress.percent).toBe(75);
      expect(progress.remainingMinor).toBe(5000);
    });

    it("handles maximum tier cap without overflow", () => {
      const progress = calculateVipProgress(25000, 20000);
      expect(progress.percent).toBe(100);
      expect(progress.remainingMinor).toBe(0);
    });
  });
});
