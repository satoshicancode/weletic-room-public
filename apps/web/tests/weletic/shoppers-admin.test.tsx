// @vitest-environment jsdom

import { ShoppersAdmin } from "@/ui/weletic/shoppers/shoppers-admin";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  slug: "workspace-a",
  fetcher: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: navigation.slug }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: navigation.push }),
}));
vi.mock("@dub/utils", () => ({
  fetcher: navigation.fetcher,
  PRO_PLAN: {},
  getNextPlan: () => ({}),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it("does not retain shopper PII while the real workspace hook changes scope", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const cache = new Map();
  let resolveWorkspace!: (value: { id: string; slug: string }) => void;
  navigation.fetcher.mockImplementation((url: string) =>
    url.endsWith("workspace-a")
      ? Promise.resolve({ id: "id-a", slug: "workspace-a" })
      : new Promise((resolve) => {
          resolveWorkspace = resolve;
        }),
  );
  const fetchMock = vi.fn(async (url: string) =>
    Response.json({
      items: [
        {
          id: "shopper",
          shopifyCustomerId: "1234",
          firstName: "Controlled",
          lastName: "Fixture",
          email: url.includes("id-a")
            ? "private-a@example.test"
            : "private-b@example.test",
          createdAt: "2026-09-06T00:00:00.000Z",
          loyalty: null,
        },
      ],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          SWRConfig,
          {
            value: {
              provider: () => cache,
              keepPreviousData: true,
              shouldRetryOnError: false,
              dedupingInterval: 0,
            },
          },
          createElement(ShoppersAdmin),
        ),
      ),
    );
  try {
    await render();
    expect(container.textContent).toContain("private-a@example.test");
    navigation.slug = "workspace-b";
    await render();
    expect(container.textContent).toContain("Loading workspace");
    expect(container.textContent).not.toContain("private-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolveWorkspace({ id: "id-b", slug: "workspace-b" }),
    );
    expect(container.textContent).toContain("private-b@example.test");
    expect(container.textContent).not.toContain("private-a");
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("workspaceId=id-b"),
      { cache: "no-store" },
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    navigation.slug = "workspace-a";
  }
});
