// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabSettings } from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/modules/tab-settings";
import { TabVip } from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/modules/tab-vip";
const mocks = vi.hoisted(() => ({
  jobs: vi.fn(),
  preview: vi.fn(),
  legacySave: vi.fn(),
}));
vi.mock(
  "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/modals/modal-vip-tier",
  () => ({
    ModalVipTier: () =>
      createElement("div", { role: "dialog" }, "Controlled tier editor"),
  }),
);
vi.mock(
  "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/api-client",
  () => ({
    LoyaltyAdminApi: {
      getBackfillJobs: mocks.jobs,
      createBackfillPreview: mocks.preview,
      updateSettings: mocks.legacySave,
    },
  }),
);
vi.mock(
  "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/modals/modal-backfill-preview",
  () => ({
    ModalBackfillPreview: () =>
      createElement("div", { role: "dialog" }, "Controlled preview"),
  }),
);
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const view = {
  storeId: "store-a",
  installationGeneration: "g1",
  accountingCurrency: "JPY",
  configurationRevision: "a".repeat(64),
  capabilities: { configure: true, owner: true },
  program: {
    id: "program-a",
    settings: {
      name: "Loyalty",
      status: "draft",
      pointNameSingular: "Point",
      pointNamePlural: "Points",
      pointsPerCurrencyUnit: "1.25",
      holdingPeriodDays: 14,
      pointsExpiryMonths: 12,
      pointsExpiryDays: 0,
      pointsExpiryWarningDays: 30,
      pointsExpiryLastChanceDays: 3,
      pointsExpiryWarningEnabled: true,
      pointsExpiryLastChanceEnabled: true,
      killSwitchActive: false,
      vipMilestoneMode: "amount_spent",
      vipTimeframe: "rolling_12m",
      vipDowngradeGraceDays: 30,
      vipAutoDowngradeEnabled: true,
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: "1",
      liabilityPointsDenominator: "100",
    },
  },
};
const update = {
  expectedRevision: "a".repeat(64),
  expectedInstallationGeneration: "g1",
  settings: { pointsPerCurrencyUnit: "1.2500" },
};

describe("workspace settings consolidation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let refreshed: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.resetAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    refreshed = vi.fn();
    mocks.jobs.mockResolvedValue([]);
    mocks.preview.mockResolvedValue({ jobId: "preview-a" });
    fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(view));
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async (id = "workspace-a") =>
    act(async () => {
      root.render(
        createElement(TabSettings, {
          workspaceId: id,
          settings: { pointsPerCurrencyUnit: "1.25" },
          currency: "JPY",
          isOwner: true,
          onRefresh: refreshed,
        }),
      );
    });
  it("keeps tier creation and links policy editing to shared settings", async () => {
    const configure = vi.fn();
    await act(async () =>
      root.render(
        createElement(TabVip, {
          tiers: [],
          onConfigure: configure,
          onRefresh: refreshed,
        }),
      ),
    );
    expect(container.querySelector("form")).toBeNull();
    const policy = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Configure VIP policy"),
    )!;
    await act(async () => policy.click());
    expect(configure).toHaveBeenCalledTimes(1);
    const add = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add VIP Tier"),
    )!;
    await act(async () => add.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe(
      "Controlled tier editor",
    );
    expect(mocks.legacySave).not.toHaveBeenCalled();
  });
  it("renders one shared configuration editor alongside retained backfill controls", async () => {
    await render();
    expect(container.querySelectorAll('input[name="name"]')).toHaveLength(1);
    expect(container.textContent).toContain("Historical Order Backfill Engine");
    expect(container.textContent).toContain("1.25 pts per JPY");
    expect(mocks.legacySave).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/weletic/loyalty-configuration?workspaceId=workspace-a",
    );
  });
  it("saves changed fields through the new API and refreshes the parent only after acknowledgement", async () => {
    await render();
    fetcher.mockImplementation(async (_url, init) => {
      if (init?.method === "PATCH")
        return Response.json({
          ...view,
          program: {
            ...view.program,
            settings: { ...view.program.settings, name: "Changed" },
          },
        });
      return Response.json(view);
    });
    const input =
      container.querySelector<HTMLInputElement>('input[name="name"]')!;
    input.value = "Changed";
    await act(async () =>
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    const patch = fetcher.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(JSON.parse(String(patch?.[1]?.body)).settings).toEqual({
      name: "Changed",
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(mocks.legacySave).not.toHaveBeenCalled();
  });
  it("retains preview generation without calling the old settings writer", async () => {
    await render();
    const button = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Generate Backfill Preview"),
    )!;
    await act(async () =>
      button.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.preview).toHaveBeenCalledWith({
      lookbackDays: undefined,
      minOrderAmount: undefined,
      pointsPerCurrencyUnit: 1.25,
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe(
      "Controlled preview",
    );
    expect(mocks.legacySave).not.toHaveBeenCalled();
  });
  it("does not show projected credits as committed history", async () => {
    mocks.jobs.mockResolvedValue([
      {
        id: "job-a",
        status: "preview",
        totalShoppersCount: 1,
        totalCommittedPoints: "0",
        totalProjectedPoints: "999",
        createdAt: "2026-09-07T00:00:00Z",
      },
    ]);
    await render();
    const cells = container.querySelectorAll("tbody tr td");
    expect(cells[3]?.textContent).toContain("0");
    expect(cells[3]?.textContent).not.toContain("999");
  });
  it("blocks uncertain configuration writes without refreshing the parent", async () => {
    await render();
    fetcher.mockResolvedValue(
      Response.json({ error: "denied" }, { status: 403 }),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[name="name"]')!;
    input.value = "Rejected";
    await act(async () =>
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelector('input[name="name"]')).toBeNull();
    expect(refreshed).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Historical Order Backfill Engine");
  });
  it("does not refresh workspace B when a save from workspace A completes", async () => {
    await render("workspace-a");
    let complete!: (response: Response) => void;
    fetcher.mockImplementation(async (_url, init) =>
      init?.method === "PATCH"
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : Response.json(view),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[name="name"]')!;
    input.value = "Late A";
    await act(async () =>
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await render("workspace-b");
    await act(async () =>
      complete(
        Response.json({
          ...view,
          program: {
            ...view.program,
            settings: { ...view.program.settings, name: "Late A" },
          },
        }),
      ),
    );
    expect(refreshed).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>('input[name="name"]')?.value,
    ).toBe("Loyalty");
  });
});
