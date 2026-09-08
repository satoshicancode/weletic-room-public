// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReferralConfigurationResponse } from "../../lib/weletic/loyalty/referral-configuration-contract";
import { DEFAULT_REFERRAL_RULE_CONFIG } from "../../lib/weletic/loyalty/referral-rule-config";
import {
  ReferralConfigurationSession,
  type ReferralConfigurationTransport,
} from "../../ui/weletic/loyalty/referral-configuration-screen";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const view: ReferralConfigurationResponse = {
  storeId: "a",
  programId: "program-a",
  installationGeneration: "g1",
  shopCurrency: "JPY",
  thresholdDecimalPlaces: 0,
  revision: "a".repeat(64),
  capabilities: { configure: true },
  ruleId: "rule-a",
  fields: {
    ...DEFAULT_REFERRAL_RULE_CONFIG,
    advocatePointsReward: "9007199254740993",
  },
  active: true,
  legacyConfiguration: false,
  couponOptions: [],
  acknowledgedOperation: "read",
};
let root: Root;
let container: HTMLDivElement;
let transport: ReferralConfigurationTransport;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  transport = {
    scopeKey: "a",
    read: vi.fn().mockResolvedValue(view),
    save: vi.fn().mockResolvedValue({
      ...view,
      acknowledgedOperation: "save",
      revision: "b".repeat(64),
    }),
    pause: vi.fn().mockResolvedValue({
      ...view,
      active: false,
      acknowledgedOperation: "pause",
      revision: "b".repeat(64),
      fields: { ...view.fields!, isActive: false },
    }),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () =>
  act(async () =>
    root.render(createElement(ReferralConfigurationSession, { transport })),
  );
const submit = () =>
  act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
async function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
  if (!button) throw new Error(text);
  await act(async () => button.click());
}
it("saves exact point strings with revision and installation fences", async () => {
  await render();
  await submit();
  expect(transport.save).toHaveBeenCalledExactlyOnceWith({
    expectedRevision: view.revision,
    expectedInstallationGeneration: "g1",
    ruleId: "rule-a",
    fields: view.fields,
  });
  expect(container.textContent).toContain("Configuration saved.");
});
it("blocks writes for read-only staff", async () => {
  vi.mocked(transport.read).mockResolvedValue({
    ...view,
    capabilities: { configure: false },
  });
  await render();
  await submit();
  expect(transport.save).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Read-only access");
  expect(container.textContent).not.toContain("Pause referrals");
});
it("requires explicit pause confirmation even without editable terms/currency", async () => {
  vi.mocked(transport.read).mockResolvedValue({
    ...view,
    fields: null,
    legacyConfiguration: true,
    shopCurrency: null,
    thresholdDecimalPlaces: null,
  });
  vi.mocked(transport.pause).mockResolvedValue({
    ...view,
    fields: null,
    legacyConfiguration: true,
    shopCurrency: null,
    thresholdDecimalPlaces: null,
    active: false,
    acknowledgedOperation: "pause",
  });
  await render();
  expect(container.querySelector("form")).toBeNull();
  await click("Pause referrals");
  expect(transport.pause).not.toHaveBeenCalled();
  await click("Confirm pause");
  expect(transport.pause).toHaveBeenCalledExactlyOnceWith({
    expectedRevision: view.revision,
    expectedInstallationGeneration: "g1",
  });
  expect(transport.save).not.toHaveBeenCalled();
});
it("does not silently round a JPY threshold", async () => {
  vi.mocked(transport.read).mockResolvedValue({
    ...view,
    fields: { ...view.fields!, minQualifyingOrderSubtotal: "1.01" },
  });
  await render();
  await submit();
  expect(transport.save).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull();
});
it("drops the form after an uncertain save until explicit reload", async () => {
  vi.mocked(transport.save).mockRejectedValue(new Error("timeout"));
  await render();
  await submit();
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain("uncertain");
  expect(transport.save).toHaveBeenCalledOnce();
  await click("Reload");
  expect(container.querySelector("form")).not.toBeNull();
});
it.each(["scope", "transport"] as const)(
  "keeps a held write locked across %s changes",
  async (change) => {
    let resolve!: (value: ReferralConfigurationResponse) => void;
    const held = vi.fn(
      () =>
        new Promise<ReferralConfigurationResponse>((done) => {
          resolve = done;
        }),
    );
    transport.save = held;
    await render();
    await submit();
    const original = transport;
    if (change === "scope") {
      transport = {
        ...original,
        scopeKey: "b",
        read: vi
          .fn()
          .mockResolvedValue({ ...view, storeId: "b", programId: "program-b" }),
      };
      await render();
    }
    transport = { ...original };
    await render();
    await submit();
    expect(held).toHaveBeenCalledOnce();
    await act(async () =>
      resolve({
        ...view,
        fields: { ...view.fields!, advocatePointsReward: "11" },
        acknowledgedOperation: "save",
      }),
    );
    expect(container.textContent).not.toContain("Configuration saved.");
  },
);
it("ignores old reads after switching stores", async () => {
  let resolve!: (value: ReferralConfigurationResponse) => void;
  transport.read = vi.fn(
    () =>
      new Promise<ReferralConfigurationResponse>((done) => {
        resolve = done;
      }),
  );
  await render();
  transport = {
    ...transport,
    scopeKey: "b",
    read: vi.fn().mockResolvedValue({
      ...view,
      storeId: "b",
      shopCurrency: "USD",
      thresholdDecimalPlaces: 2,
    }),
  };
  await render();
  await act(async () => resolve(view));
  expect(container.textContent).toContain("USD");
  expect(container.textContent).not.toContain("JPY");
});
it.each([
  ["ja", "紹介プログラム設定"],
  ["vi", "Cấu hình giới thiệu"],
])("renders %s without saving", async (locale, title) => {
  await render();
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain(title);
  expect(transport.save).not.toHaveBeenCalled();
});
