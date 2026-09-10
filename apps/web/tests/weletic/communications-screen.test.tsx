// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoyaltyCommunicationsResponse } from "../../lib/weletic/loyalty/communications-contract";
import { communicationsCopy } from "../../ui/weletic/loyalty/communications-copy";
import { CommunicationsScreen } from "../../ui/weletic/loyalty/communications-screen";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const response: LoyaltyCommunicationsResponse = {
  storeId: "private-store",
  installationGeneration: "private-generation",
  revision: "a".repeat(64),
  capabilities: { configure: true },
  deliveryIntegration: "not_connected",
  policies: [],
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
async function select(index: number, value: string) {
  const input = node.querySelectorAll("select")[index];
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function editSubject(value: string) {
  const input = node.querySelector(
    'fieldset input:not([type="checkbox"])',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it.each(["en", "ja", "vi"] as const)(
  "separates birthday readiness from points-earned and unconnected journeys in %s",
  async (locale) => {
    const connectedResponse = {
      ...response,
      deliveryIntegration: "purchase_signup_birthday_and_expiry_policies",
    };
    const request = vi.fn().mockImplementation(async (input) =>
      input.operation === "read"
        ? connectedResponse
        : {
            ...connectedResponse,
            revision: "b".repeat(64),
            policies: [input.policy],
          },
    );
    await act(async () =>
      root.render(createElement(CommunicationsScreen, { request })),
    );
    await select(0, locale);
    expect(node.textContent).toContain(
      communicationsCopy[locale].signupWithBirthdayConnected,
    );
    await select(1, "birthday");
    expect(node.textContent).toContain(
      communicationsCopy[locale].birthdayConnected,
    );
    expect(node.textContent).toContain(
      communicationsCopy[locale].birthdayEnabled,
    );
    await editSubject("Birthday award");
    await submit();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].policy.journey).toBe("birthday");
    expect(node.textContent).toContain(
      communicationsCopy[locale].birthdaySaved,
    );
    await select(1, "points_warning");
    expect(node.textContent).toContain(
      communicationsCopy[locale].expiryConnected,
    );
    await select(1, "vip_achieved");
    expect(node.textContent).toContain(communicationsCopy[locale].disconnected);
    expect(node.textContent).not.toContain(
      communicationsCopy[locale].birthdayConnected,
    );
    expect(node.textContent).not.toContain("private-store");
  },
);

it.each(["en", "ja", "vi"])(
  "reports signup readiness only for the new capability in %s",
  async (locale) => {
    const request = vi.fn().mockResolvedValue({
      ...response,
      deliveryIntegration: "purchase_signup_and_expiry_policies",
    });
    await act(async () =>
      root.render(createElement(CommunicationsScreen, { request })),
    );
    await select(0, locale);
    expect(node.querySelector("article > p")?.textContent).toContain(
      {
        en: "and new signup awards",
        ja: "新規会員登録のポイント付与",
        vi: "điểm thưởng đăng ký mới",
      }[locale],
    );
    expect(node.textContent).toContain(
      {
        en: "Manual, birthday",
        ja: "手動付与、誕生日",
        vi: "Điểm thủ công, sinh nhật",
      }[locale],
    );
    await select(1, "birthday");
    expect(node.textContent).toContain(
      {
        en: "Delivery is not connected",
        ja: "まだ配信に接続されていません",
        vi: "chưa được kết nối",
      }[locale],
    );
    await select(1, "points_warning");
    expect(node.textContent).toContain(
      {
        en: "Expiry templates",
        ja: "失効通知のテンプレート",
        vi: "Mẫu hết hạn",
      }[locale],
    );
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each(["en", "ja", "vi"])(
  "reports purchase-only readiness without enabling other journeys in %s",
  async (locale) => {
    const request = vi.fn().mockResolvedValue({
      ...response,
      deliveryIntegration: "purchase_and_expiry_policies",
    });
    await act(async () =>
      root.render(createElement(CommunicationsScreen, { request })),
    );
    await select(0, locale);
    const purchaseCopy = node.querySelector("article > p")?.textContent;
    expect(purchaseCopy).toContain(
      {
        en: "Signup, manual, birthday",
        ja: "会員登録、手動付与、誕生日",
        vi: "Điểm đăng ký, thủ công, sinh nhật",
      }[locale],
    );
    await select(1, "reward_redeemed");
    expect(node.querySelector("article > p")?.textContent).not.toBe(
      purchaseCopy,
    );
    expect(node.textContent).toContain(
      {
        en: "Delivery is not connected",
        ja: "まだ配信に接続されていません",
        vi: "chưa được kết nối",
      }[locale],
    );
    await select(1, "points_warning");
    expect(node.textContent).toContain(
      {
        en: "Expiry templates",
        ja: "失効通知のテンプレート",
        vi: "Mẫu hết hạn",
      }[locale],
    );
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("does not infer purchase readiness from an older expiry-only response", async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ ...response, deliveryIntegration: "expiry_policies" });
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request })),
  );
  expect(node.textContent).toContain("Delivery is not connected");
});

it.each([
  ["en", "Loyalty communications"],
  ["ja", "ロイヤルティ通知"],
  ["vi", "Thông báo khách hàng thân thiết"],
])("renders %s editor without private identifiers", async (locale, title) => {
  const request = vi.fn().mockResolvedValue(response);
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request })),
  );
  await select(0, locale);
  expect(node.querySelector("h1")?.textContent).toBe(title);
  expect(node.innerHTML).not.toContain("private-store");
  expect(node.innerHTML).not.toContain("private-generation");
  expect(node.querySelectorAll("select")[1].options).toHaveLength(9);
});
it("saves all languages with current fences and locks journey selection while dirty", async () => {
  const onNavigationStateChange = vi.fn();
  const request = vi
    .fn()
    .mockImplementation(async (input) =>
      input.operation === "read"
        ? response
        : { ...response, revision: "b".repeat(64), policies: [input.policy] },
    );
  await act(async () =>
    root.render(
      createElement(CommunicationsScreen, { request, onNavigationStateChange }),
    ),
  );
  await editSubject("Edited subject");
  expect(onNavigationStateChange).toHaveBeenLastCalledWith({
    dirty: true,
    locale: "en",
  });
  expect(node.querySelectorAll("select")[1].disabled).toBe(true);
  await submit();
  const input = request.mock.calls[1][0];
  expect(input.expectedRevision).toBe(response.revision);
  expect(input.expectedInstallationGeneration).toBe(
    response.installationGeneration,
  );
  expect(input.policy.templates.en.subject).toBe("Edited subject");
  expect(Object.keys(input.policy.templates)).toEqual(["en", "ja", "vi"]);
  expect(node.textContent).toContain("Saved. Delivery remains disconnected.");
  expect(node.querySelectorAll("select")[1].disabled).toBe(false);
  expect(onNavigationStateChange).toHaveBeenLastCalledWith({
    dirty: false,
    locale: "en",
  });
});
it("blocks invalid content and never interprets markup in previews", async () => {
  const request = vi.fn().mockResolvedValue(response);
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request })),
  );
  await editSubject('<img src="x" onerror="alert(1)">');
  await submit();
  expect(request).toHaveBeenCalledTimes(1);
  expect(node.querySelector("img")).toBeNull();
  expect(node.querySelector('[role="alert"]')).not.toBeNull();
});
it("requires reload after an ambiguous save instead of retrying", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockRejectedValue(new Error("private detail"));
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request })),
  );
  await editSubject("Changed");
  await submit();
  expect(node.querySelector("fieldset")?.disabled).toBe(true);
  await submit();
  expect(request).toHaveBeenCalledTimes(2);
  expect(node.textContent).not.toContain("private detail");
});
it("keeps unauthorized forms disabled", async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ ...response, capabilities: { configure: false } });
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request })),
  );
  expect(node.querySelector("fieldset")?.disabled).toBe(true);
  await submit();
  expect(request).toHaveBeenCalledTimes(1);
});
it("ignores late responses from a replaced transport", async () => {
  let complete!: (value: LoyaltyCommunicationsResponse) => void;
  const old = vi.fn().mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request: old })),
  );
  const current = vi
    .fn()
    .mockResolvedValue({ ...response, capabilities: { configure: false } });
  await act(async () =>
    root.render(createElement(CommunicationsScreen, { request: current })),
  );
  await act(async () => complete(response));
  expect(node.querySelector("fieldset")?.disabled).toBe(true);
});
