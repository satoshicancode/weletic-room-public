// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RewardCatalogResponse } from "../../lib/weletic/loyalty/reward-catalog-contract";
import {
  changeRewardCatalogType,
  newRewardCatalogFields,
  parseRewardCatalogForm,
  rewardCatalogFormFromFields,
} from "../../ui/weletic/loyalty/reward-catalog-form";
import {
  RewardCatalogSession,
  type RewardCatalogTransport,
} from "../../ui/weletic/loyalty/reward-catalog-screen";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const fields = {
  ...newRewardCatalogFields(),
  name: "Controlled reward",
  pointsCost: "9007199254740993",
};
const view: RewardCatalogResponse = {
  storeId: "store-a",
  installationGeneration: "g1",
  shopCurrency: "JPY",
  revision: "a".repeat(64),
  affectedRewardId: null,
  capabilities: { configure: true },
  rewards: [
    {
      id: "reward-a",
      name: fields.name,
      rewardType: fields.rewardType,
      status: fields.status,
      fields,
      editUnavailableReason: null,
    },
  ],
};
let root: Root;
let container: HTMLDivElement;
let transport: RewardCatalogTransport;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  transport = {
    scopeKey: "a",
    read: vi.fn().mockResolvedValue(view),
    save: vi.fn().mockResolvedValue({ ...view, affectedRewardId: "reward-a" }),
    contain: vi
      .fn()
      .mockResolvedValue({ ...view, affectedRewardId: "reward-a" }),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () =>
  act(async () =>
    root.render(createElement(RewardCatalogSession, { transport })),
  );
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
const submit = () =>
  act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
async function select(label: string, value: string) {
  const field = Array.from(container.querySelectorAll("label"))
    .find((node) => node.textContent?.startsWith(label))
    ?.querySelector("select");
  if (!field) throw new Error(`Missing ${label}`);
  await act(async () => {
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("saves exact values and revision without a numeric round trip", async () => {
  await render();
  await click("Edit");
  await submit();
  expect(transport.save).toHaveBeenCalledExactlyOnceWith({
    expectedInstallationGeneration: "g1",
    expectedRevision: view.revision,
    rewardId: "reward-a",
    reward: fields,
  });
  expect(container.textContent).toContain("Reward saved.");
});
it("renders read-only and unsupported legacy entries without write controls", async () => {
  vi.mocked(transport.read).mockResolvedValue({
    ...view,
    capabilities: { configure: false },
    rewards: [
      {
        ...view.rewards[0],
        fields: null,
        editUnavailableReason: "legacy_configuration_requires_review",
      },
    ],
  });
  await render();
  expect(container.textContent).toContain("Read-only access");
  expect(container.textContent).toContain(
    "Legacy configuration requires review",
  );
  expect(container.textContent).not.toContain("New reward");
  expect(container.querySelector("form")).toBeNull();
});
it("does not retry uncertain writes and requires reload before editing", async () => {
  vi.mocked(transport.save).mockRejectedValue(new Error("uncertain"));
  await render();
  await click("Edit");
  await submit();
  expect(transport.save).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Result unavailable or uncertain");
  expect(container.querySelector("form")).toBeNull();
  await click("Reload");
  expect(container.textContent).not.toContain(
    "Result unavailable or uncertain",
  );
  expect(container.textContent).toContain("Controlled reward");
});
it("requires a name and blocks invalid new rewards without sending", async () => {
  await render();
  await click("New reward");
  await submit();
  expect(transport.save).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull();
});
it("hides coupon-use fields for financial artifacts and explains their gate", async () => {
  await render();
  await click("Edit");
  await select("Reward type", "store_credit");
  const form = container.querySelector("form")!;
  expect(form.textContent).not.toContain("Code usage limit");
  expect(form.textContent).not.toContain("Combine order discounts");
  expect(container.textContent).toContain("checkout acceptance remains gated");
  await submit();
  expect(transport.save).toHaveBeenCalledWith(
    expect.objectContaining({
      reward: expect.objectContaining({
        rewardType: "store_credit",
        usageLimit: null,
        usageLimitPerCustomer: 0,
      }),
    }),
  );
});
it.each([
  ["ja", "特典カタログ"],
  ["vi", "Danh mục phần thưởng"],
])("supports %s labels", async (locale, title) => {
  await render();
  await select("Language", locale);
  expect(container.textContent).toContain(title);
});
it("ignores an old write after scope navigation returns to the original scope", async () => {
  let resolve!: (value: RewardCatalogResponse) => void;
  vi.mocked(transport.save).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Edit");
  await submit();
  transport = {
    ...transport,
    scopeKey: "b",
    read: vi
      .fn()
      .mockResolvedValue({ ...view, storeId: "store-b", rewards: [] }),
  };
  await render();
  transport = {
    ...transport,
    scopeKey: "a",
    read: vi.fn().mockResolvedValue({ ...view, rewards: [] }),
  };
  await render();
  await act(async () => resolve({ ...view, affectedRewardId: "reward-a" }));
  expect(container.textContent).not.toContain("Controlled reward");
  expect(container.textContent).not.toContain("Reward saved.");
});
it("ignores a stale write when the same scope receives a fresh transport", async () => {
  let resolve!: (value: RewardCatalogResponse) => void;
  vi.mocked(transport.save).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Edit");
  await submit();
  transport = {
    ...transport,
    read: vi.fn().mockResolvedValue({ ...view, rewards: [] }),
  };
  await render();
  await act(async () => resolve({ ...view, affectedRewardId: "reward-a" }));
  expect(container.textContent).not.toContain("Controlled reward");
});
it("blocks duplicate submissions while the first request is pending", async () => {
  vi.mocked(transport.save).mockImplementation(() => new Promise(() => {}));
  await render();
  await click("Edit");
  await act(async () => {
    const form = container.querySelector("form")!;
    for (let i = 0; i < 2; i++)
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
  });
  expect(transport.save).toHaveBeenCalledTimes(1);
});
it("preserves exact form values and refuses malformed numbers", () => {
  const form = rewardCatalogFormFromFields(fields);
  expect(parseRewardCatalogForm(form).data).toEqual(fields);
  expect(parseRewardCatalogForm({ ...form, usageLimit: "1e2" }).success).toBe(
    false,
  );
  expect(
    parseRewardCatalogForm({ ...form, combinesWithOrderDiscounts: "yes" })
      .success,
  ).toBe(false);
  expect(
    parseRewardCatalogForm(changeRewardCatalogType(form, "gift_card")).success,
  ).toBe(true);
  const product = parseRewardCatalogForm({
    ...changeRewardCatalogType(form, "free_product"),
    entitledProductIds: "123, gid://shopify/Product/123\n456",
  });
  expect(product.success).toBe(true);
  expect(product.data?.entitledProductIds).toEqual([
    "gid://shopify/Product/123",
    "gid://shopify/Product/456",
  ]);
});

it.each(["round-trip", "same-scope"])(
  "keeps a held create locked across %s navigation",
  async (mode) => {
    let resolve!: (value: RewardCatalogResponse) => void;
    const create = vi.fn().mockImplementation(
      () =>
        new Promise<RewardCatalogResponse>((done) => {
          resolve = done;
        }),
    );
    transport = {
      ...transport,
      save: create,
      read: vi.fn().mockResolvedValue({ ...view, rewards: [] }),
    };
    await render();
    await click("New reward");
    const name = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Name"))
      ?.querySelector("input");
    if (!name) throw new Error("Missing name");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(name, "Pending create");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    expect(create).toHaveBeenCalledTimes(1);
    if (mode === "round-trip") {
      transport = { ...transport, scopeKey: "b" };
      await render();
    }
    // The server may have committed already; only its response remains held.
    transport = {
      ...transport,
      scopeKey: "a",
      read: vi.fn().mockResolvedValue(view),
    };
    await render();
    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "New reward",
    );
    expect(createButton?.disabled).toBe(true);
    await click("New reward");
    expect(container.querySelector("form")).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ...view, affectedRewardId: "reward-a" }));
    expect(createButton?.disabled).toBe(false);
  },
);

it.each(["JPY", null])(
  "requires confirmation to pause a legacy reward with currency %s without rewriting terms",
  async (shopCurrency) => {
    vi.mocked(transport.read).mockResolvedValue({
      ...view,
      shopCurrency,
      rewards: [
        {
          ...view.rewards[0],
          status: "active",
          fields: null,
          editUnavailableReason: "legacy_configuration_requires_review",
        },
      ],
    });
    vi.mocked(transport.contain).mockResolvedValue({
      ...view,
      shopCurrency,
      affectedRewardId: "reward-a",
    });
    await render();
    if (shopCurrency === null) {
      expect(container.textContent).toContain("Currency unavailable");
      expect(container.textContent).not.toContain("New reward");
    }
    await click("Pause");
    expect(transport.contain).not.toHaveBeenCalled();
    await click("Confirm status change");
    expect(transport.contain).toHaveBeenCalledExactlyOnceWith({
      expectedInstallationGeneration: "g1",
      expectedRevision: view.revision,
      rewardId: "reward-a",
      status: "inactive",
    });
    expect(transport.save).not.toHaveBeenCalled();
  },
);
