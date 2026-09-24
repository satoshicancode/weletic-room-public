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
    activitySeries: { status: "range_required", bucket: "utc_day", rows: [] },
    ledgerNetSeries: {
      status: "range_required",
      bucket: "utc_day",
      coverage: "recorded_ledger_net_only",
      openingNetPoints: null,
      rows: [],
    },
    firstRecordedEarnersSeries: {
      status: "range_required",
      bucket: "utc_month",
      coverage: "retained_qualifying_ledger_accounts_only",
      rows: [],
    },
    firstRecordedRedemptionDebitsSeries: {
      status: "range_required",
      bucket: "utc_month",
      coverage: "retained_reward_debit_accounts_only",
      rows: [],
    },
    retainedEnrollmentSeries: {
      status: "range_required",
      bucket: "utc_month",
      coverage: "retained_account_enrollments_only",
      openingRetainedAccounts: null,
      rows: [],
    },
    recordedTierChangesSeries: {
      status: "range_required",
      bucket: "utc_month",
      coverage: "retained_tier_change_reasons_only",
      rows: [],
    },
    earningSources: {
      coverage: "retained_positive_earning_ledger_only",
      rows: [],
    },
    redemptionSources: {
      coverage: "retained_redemption_debits_only",
      rows: [],
      other: { eventCount: "0", pointsSpent: "0" },
      unknown: { eventCount: "0", pointsSpent: "0" },
      total: { eventCount: "0", pointsSpent: "0" },
    },
    redemptionRateSeries: {
      status: "range_required",
      bucket: "utc_month",
      coverage: "recorded_ledger_only",
      rows: [],
    },
    orderEarningSeries: {
      status: "range_required",
      bucket: "utc_day",
      coverage: "recorded_orders_only",
      rows: [],
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

it("downloads one owner-authorized tier snapshot only after an explicit date refresh", async () => {
  const ownerResponse = {
    ...response,
    snapshot: { ...response.snapshot, canExport: true },
  } satisfies MerchantAnalyticsResponse;
  const request = vi.fn().mockResolvedValue(ownerResponse);
  const requestTierHistory = vi.fn().mockResolvedValue({
    status: "available",
    coverage: "retained_nonredacted_tier_events_only",
    installationGeneration: "private-generation",
    filter: {
      startAt: "2026-09-01T00:00:00.000Z",
      endAt: "2026-09-30T23:59:59.999Z",
    },
    rows: [
      {
        accountPseudonym: `account_${"a".repeat(32)}`,
        effectiveAt: "2026-09-02T00:00:00.000Z",
        fromTierCurrentName: "Silver",
        toTierCurrentName: "Gold",
        changeReason: "threshold_reached",
      },
    ],
  });
  const createObjectURL = vi.fn().mockReturnValue("blob:fixture");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    await act(async () =>
      root.render(
        createElement(MerchantAnalyticsScreen, {
          request,
          requestTierHistory,
        }),
      ),
    );
    const dates = node.querySelectorAll<HTMLInputElement>('input[type="date"]');
    const exportButton = () =>
      Array.from(node.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Export tier events CSV"),
      );
    expect(exportButton()!.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(dates[0], "2026-09-01");
      dates[0].dispatchEvent(new Event("input", { bubbles: true }));
      dates[0].dispatchEvent(new Event("change", { bubbles: true }));
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(dates[1], "2026-09-30");
      dates[1].dispatchEvent(new Event("input", { bubbles: true }));
      dates[1].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(exportButton()).toBeUndefined();
    await act(async () => {
      node
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(exportButton()!.disabled).toBe(false);
    await act(async () => exportButton()!.click());
    expect(requestTierHistory).toHaveBeenCalledTimes(1);
    expect(requestTierHistory.mock.calls[0][0]).toEqual({
      filter: {
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-30T23:59:59.999Z",
      },
      expectedInstallationGeneration: "private-generation",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    requestTierHistory.mockResolvedValueOnce({
      status: "too_large",
      coverage: "retained_nonredacted_tier_events_only",
      installationGeneration: "private-generation",
      filter: {
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-30T23:59:59.999Z",
      },
      rows: [],
    });
    await act(async () => exportButton()!.click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "More than 2,000",
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  } finally {
    click.mockRestore();
  }
});

it("downloads recorded ledger rows only for an owner with applied dates", async () => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: { ...response.snapshot, canExport: true },
  });
  const requestLedgerRows = vi.fn().mockResolvedValue({
    status: "available",
    coverage: "retained_nonredacted_ledger_entries_only",
    installationGeneration: "private-generation",
    filter: {
      startAt: "2026-09-01T00:00:00.000Z",
      endAt: "2026-09-30T23:59:59.999Z",
    },
    rows: [
      {
        accountPseudonym: `account_${"a".repeat(32)}`,
        sequenceNumber: 1,
        createdAt: "2026-09-02T00:00:00.000Z",
        entryType: "BACKFILL_CORRECTION",
        pointsDelta: "-5",
        pendingDelta: "0",
        balanceAfter: "9007199254740997",
      },
    ],
  });
  const createObjectURL = vi.fn().mockReturnValue("blob:ledger-fixture");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    await act(async () =>
      root.render(
        createElement(MerchantAnalyticsScreen, {
          request,
          requestLedgerRows,
        }),
      ),
    );
    const exportButton = () =>
      Array.from(node.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Export points transactions CSV"),
      );
    expect(exportButton()!.disabled).toBe(true);
    const dates = node.querySelectorAll<HTMLInputElement>('input[type="date"]');
    await act(async () => {
      for (const [index, value] of ["2026-09-01", "2026-09-30"].entries()) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(dates[index], value);
        dates[index].dispatchEvent(new Event("input", { bubbles: true }));
        dates[index].dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(exportButton()).toBeUndefined();
    await act(async () =>
      node
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(exportButton()!.disabled).toBe(false);
    await act(async () => exportButton()!.click());
    expect(requestLedgerRows).toHaveBeenCalledWith({
      filter: {
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-30T23:59:59.999Z",
      },
      expectedInstallationGeneration: "private-generation",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    requestLedgerRows.mockResolvedValueOnce({
      status: "too_large",
      coverage: "retained_nonredacted_ledger_entries_only",
      installationGeneration: "private-generation",
      filter: {
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-30T23:59:59.999Z",
      },
      rows: [],
    });
    await act(async () => exportButton()!.click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "More than 2,000",
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  } finally {
    click.mockRestore();
  }
});

it.each([
  ["en", "Recorded points transactions"],
  ["ja", "記録されたポイント取引"],
  ["vi", "Giao dịch điểm đã ghi nhận"],
])("labels the ledger export in %s", async (locale, title) => {
  const request = vi.fn().mockResolvedValue(response);
  await act(async () =>
    root.render(
      createElement(MerchantAnalyticsScreen, {
        request,
        requestLedgerRows: vi.fn(),
      }),
    ),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(node.textContent).toContain(title);
});

it.each([
  ["en", "Daily point activity (UTC)", "UTC date"],
  ["ja", "日別ポイント履歴（UTC）", "UTCの日付"],
  ["vi", "Hoạt động điểm theo ngày (UTC)", "Ngày UTC"],
])("renders exact daily activity in %s", async (locale, title, dateLabel) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      activitySeries: {
        status: "available",
        bucket: "utc_day",
        rows: [
          {
            date: "2026-09-01",
            earned: "9007199254740993",
            redeemed: "2",
            refundReversed: "0",
            expired: "0",
            backfilled: "9007199254740993",
            backfillCorrected: "0",
            manualCredits: "0",
            manualDebits: "0",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  expect(heading).toBeDefined();
  const section = heading!.closest("section")!;
  expect(section.querySelector("th")?.textContent).toBe(dateLabel);
  expect(section.textContent).toContain("2026-09-01");
  expect(section.textContent).toContain("9007199254740993");
});

it.each([
  ["en", "Recorded ledger net over time (UTC)", "Daily net change"],
  ["ja", "記録済み台帳の累積純増減（UTC）", "日別の純増減"],
  [
    "vi",
    "Biến động ròng tích lũy theo sổ điểm (UTC)",
    "Thay đổi ròng theo ngày",
  ],
])(
  "renders exact recorded-ledger net in %s",
  async (locale, title, changeLabel) => {
    const request = vi.fn().mockResolvedValue({
      ...response,
      snapshot: {
        ...response.snapshot,
        ledgerNetSeries: {
          status: "available",
          bucket: "utc_day",
          coverage: "recorded_ledger_net_only",
          openingNetPoints: "9007199254740993",
          rows: [
            {
              date: "2026-09-01",
              netChangePoints: "-4",
              cumulativeNetPoints: "9007199254740989",
            },
          ],
        },
      },
    } satisfies MerchantAnalyticsResponse);
    await act(async () =>
      root.render(createElement(MerchantAnalyticsScreen, { request })),
    );
    await act(async () => {
      const select = node.querySelector("select")!;
      select.value = locale;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const heading = Array.from(node.querySelectorAll("h2")).find(
      (element) => element.textContent === title,
    );
    expect(heading).toBeDefined();
    const section = heading!.closest("section")!;
    expect(section.textContent).toContain(changeLabel);
    expect(section.textContent).toContain("9007199254740989");
    expect(node.textContent).toContain("9007199254740993");
  },
);

it.each([
  [
    "en",
    "First recorded and returning earn accounts (UTC)",
    "First recorded earn accounts",
  ],
  ["ja", "初回記録と再獲得のアカウント（UTC）", "記録上の初回獲得アカウント"],
  [
    "vi",
    "Tài khoản tích điểm lần đầu và quay lại (UTC)",
    "Tài khoản tích điểm lần đầu ghi nhận",
  ],
])("renders retained earn cohorts in %s", async (locale, title, firstLabel) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      firstRecordedEarnersSeries: {
        status: "available",
        bucket: "utc_month",
        coverage: "retained_qualifying_ledger_accounts_only",
        rows: [
          {
            month: "2026-09",
            activeAccounts: "9007199254740993",
            firstRecordedAccounts: "9007199254740990",
            returningAccounts: "3",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  expect(heading).toBeDefined();
  const section = heading!.closest("section")!;
  expect(section.textContent).toContain(firstLabel);
  expect(section.textContent).toContain("9007199254740990");
  expect(node.innerHTML).not.toContain("account_123");
});

it.each([
  [
    "en",
    "First recorded and repeat reward-debit accounts (UTC)",
    "First recorded debit accounts",
  ],
  [
    "ja",
    "初回記録と再記録の報酬ポイント引落アカウント（UTC）",
    "初回引落記録のアカウント",
  ],
  [
    "vi",
    "Tài khoản ghi nhận lần đầu và lặp lại khoản trừ điểm đổi thưởng (UTC)",
    "Tài khoản ghi nhận trừ điểm lần đầu",
  ],
])("renders recorded debit cohorts in %s", async (locale, title, label) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      firstRecordedRedemptionDebitsSeries: {
        status: "available",
        bucket: "utc_month",
        coverage: "retained_reward_debit_accounts_only",
        rows: [
          {
            month: "2026-09",
            debitAccounts: "9007199254740993",
            firstRecordedDebitAccounts: "9007199254740990",
            returningDebitAccounts: "3",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  expect(heading).toBeDefined();
  expect(heading!.closest("section")!.textContent).toContain(label);
  expect(heading!.closest("section")!.textContent).toContain(
    "9007199254740990",
  );
  expect(node.innerHTML).not.toContain("account_123");
});

it.each([
  [
    "en",
    "Retained account enrollments over time (UTC)",
    "Cumulative retained accounts",
  ],
  ["ja", "保持中アカウントの登録推移（UTC）", "保持中アカウントの累計"],
  [
    "vi",
    "Tài khoản còn lưu theo thời điểm đăng ký (UTC)",
    "Lũy kế tài khoản còn lưu",
  ],
])("renders retained enrollment counts in %s", async (locale, title, label) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      retainedEnrollmentSeries: {
        status: "available",
        bucket: "utc_month",
        coverage: "retained_account_enrollments_only",
        openingRetainedAccounts: "9007199254740993",
        rows: [
          {
            month: "2026-09",
            newRetainedAccounts: "2",
            cumulativeRetainedAccounts: "9007199254740995",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  expect(heading).toBeDefined();
  expect(heading!.closest("section")!.textContent).toContain(label);
  expect(heading!.closest("section")!.textContent).toContain(
    "9007199254740995",
  );
  expect(node.innerHTML).not.toContain("shopper_123");
});

it.each([
  ["en", "Recorded VIP tier events by reason (UTC)", "Manual override"],
  ["ja", "記録されたVIPランク変更理由（UTC）", "手動変更"],
  ["vi", "Sự kiện hạng VIP đã ghi theo lý do (UTC)", "Điều chỉnh thủ công"],
])("renders recorded VIP reasons in %s", async (locale, title, manualLabel) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      recordedTierChangesSeries: {
        status: "available",
        bucket: "utc_month",
        coverage: "retained_tier_change_reasons_only",
        rows: [
          {
            month: "2026-09",
            totalChanges: "9007199254740993",
            thresholdReached: "9007199254740990",
            bonusPromotion: "0",
            annualDowngrade: "0",
            gracePeriodExpired: "0",
            programActivation: "0",
            manualOverride: "3",
            otherReasons: "0",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  expect(heading).toBeDefined();
  const section = heading!.closest("section")!;
  expect(section.textContent).toContain(manualLabel);
  expect(section.textContent).toContain("9007199254740990");
  expect(node.innerHTML).not.toContain("account_123");
});

it.each([
  ["en", "Top recorded earning sources", "Order"],
  ["ja", "記録済みポイント獲得源の順位", "注文"],
  ["vi", "Nguồn tích điểm đã ghi nhận", "Đơn hàng"],
])(
  "renders exact recorded earning-source counts in %s",
  async (locale, title, source) => {
    const request = vi.fn().mockResolvedValue({
      ...response,
      snapshot: {
        ...response.snapshot,
        earningSources: {
          coverage: "retained_positive_earning_ledger_only",
          rows: [
            {
              entryType: "EARN_ORDER",
              eventCount: "2",
              pointsEarned: "9007199254740993",
            },
          ],
        },
      },
    } satisfies MerchantAnalyticsResponse);
    await act(async () =>
      root.render(createElement(MerchantAnalyticsScreen, { request })),
    );
    await act(async () => {
      const select = node.querySelector("select")!;
      select.value = locale;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const heading = Array.from(node.querySelectorAll("h2")).find(
      (element) => element.textContent === title,
    );
    expect(heading).toBeDefined();
    const section = heading!.closest("section")!;
    expect(section.textContent).toContain(source);
    expect(section.textContent).toContain("9007199254740993");
  },
);

it.each([
  ["en", "Top recorded redemption debits", "Unknown provenance"],
  ["ja", "記録された特典交換のポイント引落上位", "情報不明"],
  ["vi", "Nguồn đổi thưởng đã ghi theo điểm trừ", "Không rõ nguồn gốc"],
])(
  "renders bounded redemption sources and unknown provenance in %s",
  async (locale, title, unknown) => {
    const request = vi.fn().mockResolvedValue({
      ...response,
      snapshot: {
        ...response.snapshot,
        redemptionSources: {
          coverage: "retained_redemption_debits_only",
          rows: [
            {
              rewardDefinitionId: "reward-one",
              capturedName: "=Voucher",
              rewardType: "amount_off",
              eventCount: "1",
              pointsSpent: "9007199254740993",
            },
          ],
          other: { eventCount: "0", pointsSpent: "0" },
          unknown: { eventCount: "1", pointsSpent: "50" },
          total: { eventCount: "2", pointsSpent: "9007199254741043" },
        },
      },
    } satisfies MerchantAnalyticsResponse);
    await act(async () =>
      root.render(createElement(MerchantAnalyticsScreen, { request })),
    );
    await act(async () => {
      const select = node.querySelector("select")!;
      select.value = locale;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const heading = Array.from(node.querySelectorAll("h2")).find(
      (element) => element.textContent === title,
    );
    expect(heading).toBeDefined();
    const section = heading!.closest("section")!;
    expect(section.textContent).toContain("=Voucher");
    expect(section.textContent).toContain(unknown);
    expect(section.textContent).toContain("9007199254740993");
    expect(section.textContent).not.toContain("shopper_");
  },
);

it.each([
  ["en", "Recorded order earning rate (UTC)"],
  ["ja", "記録済み注文のポイント獲得率（UTC）"],
  ["vi", "Tỷ lệ tích điểm của đơn đã ghi nhận (UTC)"],
])("renders bounded recorded-order rates in %s", async (locale, title) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      orderEarningSeries: {
        status: "available",
        bucket: "utc_day",
        coverage: "recorded_orders_only",
        rows: [
          {
            date: "2026-09-01",
            recordedOrders: "3",
            earningOrders: "2",
            rateBasisPoints: "6667",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  const section = heading!.closest("section")!;
  expect(section.textContent).toContain("2026-09-01");
  expect(section.textContent).toContain("3");
  expect(section.textContent).toContain("2");
  expect(section.textContent).toMatch(/66[,.]67\s?%/);
  expect(node.innerHTML).not.toContain("private-store-id");
});

it.each([
  ["en", "Monthly redemption-to-earn rate (UTC)"],
  ["ja", "月別ポイント利用・獲得比率（UTC）"],
  ["vi", "Tỷ lệ dùng điểm trên điểm tích lũy theo tháng (UTC)"],
])("renders an exact monthly redemption rate in %s", async (locale, title) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      redemptionRateSeries: {
        status: "available",
        bucket: "utc_month",
        coverage: "recorded_ledger_only",
        rows: [
          {
            month: "2026-09",
            earnedPoints: "100",
            redeemedPoints: "150",
            redemptionRateBasisPoints: "15000",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const heading = Array.from(node.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  const section = heading!.closest("section")!;
  expect(section.textContent).toContain("2026-09");
  expect(section.textContent).toMatch(/150[,.]00\s?%/);
  expect(node.innerHTML).not.toContain("private-store-id");
});

it("renders a rate above Number precision without losing digits", async () => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    snapshot: {
      ...response.snapshot,
      redemptionRateSeries: {
        status: "available",
        bucket: "utc_month",
        coverage: "recorded_ledger_only",
        rows: [
          {
            month: "2026-09",
            earnedPoints: "1",
            redeemedPoints: "9007199254740993",
            redemptionRateBasisPoints: "90071992547409930000",
          },
        ],
      },
    },
  } satisfies MerchantAnalyticsResponse);
  await act(async () =>
    root.render(createElement(MerchantAnalyticsScreen, { request })),
  );
  expect(node.textContent).toContain("900,719,925,474,099,300.00%");
});

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
