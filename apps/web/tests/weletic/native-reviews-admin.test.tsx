// @vitest-environment jsdom

import { ReviewsAdmin } from "@/ui/weletic/reviews/reviews-admin";
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({ default: read }));
vi.mock("@/lib/swr/use-workspace", () => ({
  default: () => ({ id: "ws-controlled", slug: "controlled" }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("review participation merchant actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const mutate = vi.fn(async () => undefined);
  const transport = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  const review = {
    id: "review-controlled",
    version: 3,
    createdAt: "2026-09-07T00:00:00.000Z",
    status: "hidden",
    rating: 1,
    title: "Honest criticism",
    body: "The product did not meet my expectations.",
    displayName: "Controlled shopper",
    merchantReply: null,
    verifiedPurchase: true,
    incentivized: true,
    rewardStatus: "pending",
    rewardReason: "active_reviews_and_loyalty_account_required",
    product: { title: "Controlled product" },
    media: [],
  };
  beforeEach(() => {
    // The unit runner uses classic JSX; Next provides automatic JSX at runtime.
    vi.stubGlobal("React", React);
    mutate.mockClear();
    transport.mockClear();
    vi.stubGlobal("fetch", transport);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(
    rewardPolicy?: "participation" | "legacy",
    canRetryReward?: boolean,
  ) {
    read.mockReturnValue({
      data: {
        items: [{ ...review, rewardPolicy, canRetryReward }],
        settings: { enabled: true },
        canConfigure: true,
        shopDomain: "controlled.myshopify.com",
        nextCursor: null,
      },
      isLoading: false,
      mutate,
    });
    await act(async () => root.render(createElement(ReviewsAdmin)));
  }
  const retryButton = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry eligible reward",
    );

  it("retries hidden participation points without requesting publication", async () => {
    await render("participation", true);
    expect(container.textContent).toContain("Incentivized review");
    expect(container.textContent).toContain("shopper enrollment");
    expect(container.textContent).toContain("do not depend on publication");
    const button = retryButton();
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(transport).toHaveBeenCalledWith(
      "/api/shopify/reviews/admin?workspaceId=ws-controlled",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "moderate",
          reviewId: review.id,
          patch: { version: 3, retryReward: true },
        }),
      }),
    );
    expect(mutate).toHaveBeenCalledOnce();
  });
  it("does not offer unsupported coupon or nonwinner retries", async () => {
    await render("participation", false);
    expect(retryButton()).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps legacy policy wording separate", async () => {
    await render("legacy", false);
    expect(container.textContent).toContain(
      "original publication-based reward policy",
    );
    expect(container.textContent).not.toContain("do not depend on publication");
    expect(retryButton()).toBeUndefined();
  });
  it("fails closed when a compatibility response has no reward policy", async () => {
    await render();
    expect(retryButton()).toBeUndefined();
    expect(container.textContent).toContain(
      "Reload to view this review's reward policy",
    );
    expect(container.textContent).not.toContain(
      "original publication-based reward policy",
    );
  });
});
