// @vitest-environment jsdom
import type { LoyaltyConfigurationResponse } from "@/lib/weletic/loyalty/configuration-contract";
import { loyaltyConfigurationCopy } from "@/ui/weletic/loyalty/configuration-copy";
import {
  LoyaltyConfigurationScreen,
  type LoyaltyConfigurationTransport,
} from "@/ui/weletic/loyalty/configuration-screen";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig, type State } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const initial: LoyaltyConfigurationResponse = {
  storeId: "store-a",
  installationGeneration: "g1",
  accountingCurrency: "JPY",
  configurationRevision: "a".repeat(64),
  capabilities: { configure: true, owner: true },
  program: {
    id: "program-a",
    settings: {
      name: "Loyalty",
      status: "disabled",
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

describe("shared Loyalty configuration editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let transport: LoyaltyConfigurationTransport;
  let data: LoyaltyConfigurationResponse;
  let cache: Map<string, State<unknown, unknown>>;
  let revalidate: () => Promise<unknown>;
  function Probe() {
    const { mutate } = useSWRConfig();
    revalidate = () => mutate(() => true);
    return null;
  }
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    cache = new Map();
    data = structuredClone(initial);
    transport = {
      scopeKey: "store-a",
      read: vi.fn(async () => data),
      save: vi.fn(async (input) => {
        data = {
          ...data,
          configurationRevision: "b".repeat(64),
          program: {
            id: "program-a",
            settings: { ...initial.program!.settings, ...input.settings },
          },
        };
        return data;
      }),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render() {
    await act(async () =>
      root.render(
        createElement(
          SWRConfig,
          {
            value: {
              provider: () => cache,
              dedupingInterval: 0,
              shouldRetryOnError: false,
            },
          },
          createElement(
            Fragment,
            null,
            createElement(Probe),
            createElement(LoyaltyConfigurationScreen, { transport }),
          ),
        ),
      ),
    );
  }
  function field(name: string) {
    const node = container.querySelector(`[name="${name}"]`);
    if (
      !(node instanceof HTMLInputElement || node instanceof HTMLSelectElement)
    )
      throw Error(`Missing ${name}`);
    return node;
  }
  async function submit() {
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  }
  async function click(text: string) {
    const node = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === text,
    );
    if (!node) throw Error(`Missing button ${text}`);
    await act(async () => node.click());
  }

  it("saves only changed fields with the current installation and state token", async () => {
    await render();
    field("name").value = "New name";
    await submit();
    expect(transport.save).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: "a".repeat(64),
      expectedInstallationGeneration: "g1",
      settings: { name: "New name" },
    });
    expect(container.textContent).toContain(loyaltyConfigurationCopy.en.saved);
  });
  it("saves valuation as exact strings in the configured accounting currency", async () => {
    await render();
    field("liabilityMinorUnitsNumerator").value = "9223372036854775807";
    await submit();
    expect(transport.save).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: {
          liabilityMinorUnitsNumerator: "9223372036854775807",
          liabilityPointsDenominator: "100",
          liabilityValuationCurrency: "JPY",
        },
      }),
    );
  });
  it("requires a complete valuation and supports explicit clearing", async () => {
    await render();
    field("liabilityMinorUnitsNumerator").value = "";
    await submit();
    expect(transport.save).not.toHaveBeenCalled();
    field("liabilityPointsDenominator").value = "";
    await submit();
    expect(transport.save).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: {
          liabilityMinorUnitsNumerator: null,
          liabilityPointsDenominator: null,
          liabilityValuationCurrency: null,
        },
      }),
    );
  });
  it("does not coerce a blank day count to zero or round excess precision", async () => {
    await render();
    field("holdingPeriodDays").value = "";
    await submit();
    expect(transport.save).not.toHaveBeenCalled();
    field("holdingPeriodDays").value = "14";
    field("pointsPerCurrencyUnit").value = "0.00001";
    await submit();
    expect(transport.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      loyaltyConfigurationCopy.en.invalid,
    );
  });
  it("keeps owner-only controls disabled and omits them from staff writes", async () => {
    data.capabilities.owner = false;
    await render();
    expect(field("status").matches(":disabled")).toBe(true);
    expect(field("liabilityMinorUnitsNumerator").matches(":disabled")).toBe(
      true,
    );
    field("name").value = "Staff name";
    await submit();
    expect(transport.save).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { name: "Staff name" } }),
    );
  });
  it("blocks all writes for read-only staff", async () => {
    data.capabilities.configure = false;
    await render();
    expect(field("name").matches(":disabled")).toBe(true);
    await submit();
    expect(transport.save).not.toHaveBeenCalled();
  });
  it("explicitly creates a draft without sending activation or emergency changes", async () => {
    data.program = null;
    data.configurationRevision = null;
    await render();
    expect(field("status").matches(":disabled")).toBe(true);
    expect(field("status").value).toBe("draft");
    await submit();
    expect(transport.save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: null,
        expectedInstallationGeneration: "g1",
        settings: expect.objectContaining({
          name: loyaltyConfigurationCopy.en.title,
          pointNameSingular: "Point",
          pointNamePlural: "Points",
          holdingPeriodDays: 0,
        }),
      }),
    );
    expect(
      vi.mocked(transport.save).mock.calls[0][0].settings,
    ).not.toHaveProperty("status");
    expect(
      vi.mocked(transport.save).mock.calls[0][0].settings,
    ).not.toHaveProperty("killSwitchActive");
  });
  it.each(["en", "ja", "vi"] as const)(
    "renders the complete %s configuration labels",
    async (locale) => {
      await render();
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = locale;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const copy = loyaltyConfigurationCopy[locale];
      expect(container.querySelector("section")?.lang).toBe(locale);
      for (const label of Object.values(copy.fields))
        expect(container.textContent).toContain(label);
      expect(container.textContent).toContain(copy.valuationHelp);
    },
  );
  it("requires explicit recovery after an uncertain write", async () => {
    vi.mocked(transport.save).mockRejectedValue(new Error("lost response"));
    await render();
    field("name").value = "Unconfirmed";
    await submit();
    expect(container.querySelector("form")).toBeNull();
    await act(async () => {
      await revalidate();
    });
    expect(container.querySelector("form")).toBeNull();
    await click(loyaltyConfigurationCopy.en.reload);
    expect(field("name").value).toBe("Loyalty");
    expect(container.textContent).not.toContain(
      loyaltyConfigurationCopy.en.error,
    );
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("retains a synchronous write lock across revalidation and editor remount", async () => {
    let finish!: (value: LoyaltyConfigurationResponse) => void;
    vi.mocked(transport.save).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    field("name").value = "Pending";
    await submit();
    await act(async () => {
      await revalidate();
    });
    expect(field("name").matches(":disabled")).toBe(true);
    await submit();
    expect(transport.save).toHaveBeenCalledTimes(1);
    await act(async () => finish(data));
  });
  it("does not display a previous store while a new scope is loading", async () => {
    await render();
    transport = {
      ...transport,
      scopeKey: "store-b",
      read: vi.fn(() => new Promise<LoyaltyConfigurationResponse>(() => {})),
    };
    await render();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Amount spent");
  });
  it("does not reuse cached data on an A-to-B-to-A navigation", async () => {
    await render();
    transport = {
      ...transport,
      scopeKey: "store-b",
      read: vi.fn(async () => ({ ...data, storeId: "store-b" })),
    };
    await render();
    let deny!: (reason: Error) => void;
    transport = {
      ...transport,
      scopeKey: "store-a",
      read: vi.fn(
        () =>
          new Promise<LoyaltyConfigurationResponse>((_, reject) => {
            deny = reject;
          }),
      ),
    };
    await render();
    expect(container.querySelector("form")).toBeNull();
    await act(async () => deny(new Error("access revoked")));
    expect(container.querySelector("form")).toBeNull();
  });
  it("sends displayed Japanese initialization values instead of relying on English defaults", async () => {
    data.program = null;
    data.configurationRevision = null;
    let finish!: (value: LoyaltyConfigurationResponse) => void;
    vi.mocked(transport.read).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "ja";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => finish(data));
    expect(field("pointNameSingular").value).toBe("ポイント");
    await submit();
    expect(transport.save).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          pointNameSingular: "ポイント",
          pointNamePlural: "ポイント",
        }),
      }),
    );
  });
});
