// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoyaltyImportsPage from "../../../../packages/shopify-app/app/imports-page";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  screen: vi.fn(),
  bridge: { idToken: vi.fn() },
}));
vi.mock(
  "../../../../packages/shopify-app/app/merchant-imports-client",
  async (original) => ({
    ...(await original<object>()),
    createMerchantImportContextClient: () => mocks.read,
  }),
);
vi.mock("../../../../packages/shopify-app/app/imports-screen", () => ({
  ImportsScreen: (props: unknown) => {
    mocks.screen(props);
    return null;
  },
}));
vi.mock("../../../../packages/shopify-app/app/loyalty-navigation", () => ({
  LoyaltyNavigation: () => null,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("shopify", mocks.bridge);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
it.each([true, false])(
  "uses loyalty context and preserves configure=%s",
  async (configure) => {
    mocks.read.mockResolvedValue({
      storeId: "store",
      installationGeneration: "generation",
      configure,
    });
    await act(async () =>
      root.render(createElement(LoyaltyImportsPage, { shopify: mocks.bridge })),
    );
    expect(mocks.read).toHaveBeenCalledWith();
    expect(mocks.screen).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: "generation", configure }),
    );
  },
);
it("does not mount upload controls when loyalty context fails", async () => {
  mocks.read.mockRejectedValue(new Error("private permission detail"));
  await act(async () =>
    root.render(createElement(LoyaltyImportsPage, { shopify: mocks.bridge })),
  );
  expect(mocks.screen).not.toHaveBeenCalled();
  expect(node.textContent).toContain("could not be loaded");
  expect(node.textContent).not.toContain("private permission");
  const select = node.querySelector("select")!;
  await act(async () => {
    select.value = "vi";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(node.textContent).toContain("Không tải được quyền");
});
