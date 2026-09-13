// @vitest-environment jsdom
import type {
  LoyaltyAppearanceRequest,
  LoyaltyAppearanceResponse,
} from "@/lib/weletic/loyalty/appearance-contract";
import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import { LoyaltyAppearanceScreen } from "@/ui/weletic/loyalty/appearance-screen";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement;
let root: Root;
const response: LoyaltyAppearanceResponse = {
  storeId: "PRIVATE_STORE",
  installationGeneration: "PRIVATE_GENERATION",
  revision: "a".repeat(64),
  programConfigured: true,
  capabilities: { configure: true },
  branding: { ...DEFAULT_LOYALTY_BRANDING },
};
beforeEach(() => {
  node = document.createElement("div");
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
async function render(
  request = vi.fn(async (input: LoyaltyAppearanceRequest) =>
    input.operation === "read"
      ? response
      : { ...response, revision: "b".repeat(64), branding: input.branding },
  ),
) {
  await act(async () =>
    root.render(createElement(LoyaltyAppearanceScreen, { request })),
  );
  return request;
}
async function select(index: number, value: string) {
  await act(async () => {
    const element = node.querySelectorAll("select")[index];
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function editExclusions(value: string) {
  await act(async () => {
    const input = node.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
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
it.each(["en", "ja", "vi"])(
  "renders and saves controls in %s without private identifiers",
  async (locale) => {
    const request = await render();
    await select(0, locale);
    expect(node.innerHTML).not.toContain("PRIVATE_");
    expect(node.querySelectorAll("input[type=number]")).toHaveLength(4);
    // Language, global position/icon, desktop position/layout, mobile position/layout, shape, devices.
    await select(6, "text_only");
    await select(7, "rounded");
    await editExclusions("/checkout\n/account");
    await submit();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toMatchObject({
      operation: "save",
      expectedRevision: response.revision,
      expectedInstallationGeneration: response.installationGeneration,
      branding: {
        launcherPresentation: {
          mobile: { layout: "text_only" },
          shape: "rounded",
          excludedUrlContains: ["/checkout", "/account"],
        },
      },
    });
  },
);
it("does not send invalid duplicate exclusions", async () => {
  const request = await render();
  await editExclusions("/cart\n/cart");
  await submit();
  expect(request).toHaveBeenCalledTimes(1);
  expect(node.querySelector('[role="alert"]')).not.toBeNull();
});
it("disables new controls without configure permission", async () => {
  await render(
    vi.fn(async () => ({ ...response, capabilities: { configure: false } })),
  );
  expect(node.querySelector("form fieldset")?.hasAttribute("disabled")).toBe(
    true,
  );
});
