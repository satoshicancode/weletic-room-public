// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { StoreReviewsPanel as StoreReviewsPanelType } from "../../../../packages/shopify-app/app/components/StoreReviewsPanel";
import { storeReviewsCopy } from "../../../../packages/shopify-app/app/store-reviews-copy";

vi.mock(
  "../../../../packages/shopify-app/app/components/ReviewModerationForm",
  () => ({
    ReviewModerationForm: () => null,
  }),
);

type Props = React.ComponentProps<typeof StoreReviewsPanelType>;
let StoreReviewsPanel: typeof StoreReviewsPanelType;
let AppProvider: React.ComponentType<{
  i18n: Record<string, unknown>;
  children: React.ReactNode;
}>;
beforeAll(async () => {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  ({ StoreReviewsPanel } = await import(
    "../../../../packages/shopify-app/app/components/StoreReviewsPanel"
  ));
  const requireShopify = createRequire(
    resolve(process.cwd(), "../../packages/shopify-app/package.json"),
  );
  ({ AppProvider } = requireShopify("@shopify/polaris"));
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const page = (title: string): Awaited<ReturnType<Props["client"]["list"]>> => ({
  enabled: true,
  nextCursor: null,
  items: [
    {
      id: title,
      version: 1,
      status: "pending",
      rating: 4,
      title,
      body: "Review body",
      displayName: "Buyer",
      merchantReply: null,
      verifiedPurchase: true,
      incentivized: false,
      createdAt: "2026-09-23T00:00:00.000Z",
      canModerate: false,
    },
  ],
});
async function render(client: Props["client"]) {
  await act(async () =>
    root.render(
      <AppProvider i18n={{}}>
        <StoreReviewsPanel client={client} locale="en" />
      </AppProvider>,
    ),
  );
}
async function reload() {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === storeReviewsCopy.en.reload,
  )!;
  await act(async () => button.click());
}
it("drops old identity data and late responses after authenticated client replacement", async () => {
  let resolveOld!: (value: ReturnType<typeof page>) => void;
  let resolveNew!: (value: ReturnType<typeof page>) => void;
  const oldClient = {
    list: vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    ),
    moderate: vi.fn(),
  } as unknown as Props["client"];
  const newClient = {
    list: vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveNew = resolve;
      }),
    ),
    moderate: vi.fn(),
  } as unknown as Props["client"];
  await render(oldClient);
  await reload();
  await render(newClient);
  await reload();
  await act(async () => resolveOld(page("Old identity")));
  expect(container.textContent).not.toContain("Old identity");
  expect(container.textContent).toContain(storeReviewsCopy.en.loading);
  await act(async () => resolveNew(page("New identity")));
  expect(container.textContent).toContain("New identity");
});
