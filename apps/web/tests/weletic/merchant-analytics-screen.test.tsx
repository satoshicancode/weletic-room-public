// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MerchantAnalyticsResponse } from "../../lib/weletic/loyalty/merchant-analytics-contract";
import { MerchantAnalyticsScreen } from "../../ui/weletic/loyalty/merchant-analytics-screen";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const response: MerchantAnalyticsResponse = {
  download: null,
  snapshot: {
    storeId: "private-store-id",
    installationGeneration: "private-generation",
    generatedAt: "2026-09-09T00:00:00Z",
    filter: { startAt: null, endAt: null },
    currency: "JPY",
    canExport: false,
    financialStatus: "temporarily_unavailable",
    financialReason: "Internal valuation reason",
    liability: {
      circulatingPoints: "9007199254740993",
      pendingPoints: "0",
      debtPoints: "0",
      currentMinorUnits: null,
      pendingMinorUnits: null,
      potentialMinorUnits: null,
      totalMembers: "1",
      activeMembers: "1",
    },
    activity: {
      earned: "1",
      redeemed: "0",
      refundReversed: "0",
      expired: "0",
      backfilled: "0",
      backfillCorrected: "0",
      manualCredits: "0",
      manualDebits: "0",
    },
    referralEconomics: {
      total: "0",
      successful: "0",
      revenueMinorUnits: null,
      costMinorUnits: null,
    },
    referrals: [],
    rewards: [],
    tiers: [],
  },
};
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  node = document.createElement("div");
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

it.each([
  ["en", "Loyalty analytics", "Unavailable"],
  ["ja", "ロイヤルティ分析", "利用不可"],
  ["vi", "Phân tích khách hàng thân thiết", "Không khả dụng"],
])(
  "renders %s aggregates without private identifiers and disables unauthorized exports",
  async (locale, title, unavailable) => {
    const request = vi.fn().mockResolvedValue(response);
    await act(async () =>
      root.render(createElement(MerchantAnalyticsScreen, { request })),
    );
    await act(async () => {
      const select = node.querySelector("select")!;
      select.value = locale;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(node.querySelector("article")?.lang).toBe(locale);
    expect(node.textContent).toContain(title);
    expect(node.textContent).toContain(unavailable);
    expect(node.textContent).toContain("9007199254740993");
    expect(node.innerHTML).not.toMatch(
      /private-store-id|private-generation|Internal valuation reason/,
    );
    const exports = Array.from(node.querySelectorAll("button")).filter(
      (button) =>
        button.textContent?.includes("CSV") ||
        button.textContent?.includes("JSON"),
    );
    expect(exports).toHaveLength(2);
    expect(exports.every((button) => button.disabled)).toBe(true);
  },
);

it("ignores a late old-scope response after changing the authenticated transport", async () => {
  let finish!: (value: MerchantAnalyticsResponse) => void;
  const oldRequest = vi.fn(
    () =>
      new Promise<MerchantAnalyticsResponse>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      createElement(MerchantAnalyticsScreen, { request: oldRequest }),
    ),
  );
  expect(node.querySelector('[role="status"]')?.textContent).toContain(
    "Loading",
  );
  const newRequest = vi.fn().mockResolvedValue({
    ...response,
    snapshot: { ...response.snapshot, currency: "VND" },
  });
  await act(async () =>
    root.render(
      createElement(MerchantAnalyticsScreen, { request: newRequest }),
    ),
  );
  await act(async () => finish(response));
  expect(node.textContent).toContain("VND");
  expect(node.textContent).not.toContain("Accounting currency: JPY");
});

it("clears prior data on permission failure and permits an explicit retry", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockRejectedValueOnce(new Error("secret failure"))
    .mockResolvedValue(response);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(
    "Check your access",
  );
  expect(node.textContent).not.toContain("secret failure");
  expect(node.textContent).not.toContain("9007199254740993");
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(node.textContent).toContain("9007199254740993");
});

it("invalidates the displayed report and export when draft dates change", async () => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: { ...response.snapshot, canExport: true },
  });
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const input = node.querySelector('input[type="date"]')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "2026-09-01");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(node.textContent).not.toContain("9007199254740993");
  expect(node.textContent).not.toContain("Export CSV");
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(request).toHaveBeenLastCalledWith({
    operation: "read",
    filter: { startAt: "2026-09-01T00:00:00.000Z", endAt: null },
  });
  const replacement = vi.fn().mockResolvedValue(response);
  await act(async () =>
    root.render(
      createElement(MerchantAnalyticsScreen, { request: replacement }),
    ),
  );
  expect(
    Array.from(node.querySelectorAll("input")).map((input) => input.value),
  ).toEqual(["", ""]);
  expect(replacement).toHaveBeenCalledWith({
    operation: "read",
    filter: { startAt: null, endAt: null },
  });
});

it("preserves merchant tier names and translates only status enums", async () => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      tiers: [
        {
          name: "active",
          assignment: "configured",
          members: "1",
          pointsBalance: "5",
          rollingSpendMinorUnits: "10",
        },
      ],
      rewards: [
        {
          status: "expired",
          artifact: "discount_code",
          count: "1",
          pointsSpent: "5",
        },
      ],
    },
  });
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  const cells = Array.from(node.querySelectorAll("td")).map(
    (cell) => cell.textContent,
  );
  expect(cells).toContain("active");
  expect(cells).toContain("Expired");
  expect(cells).not.toContain("Expired points");
});
