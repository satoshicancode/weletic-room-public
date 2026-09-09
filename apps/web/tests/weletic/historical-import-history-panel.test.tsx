// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImportHistoryPanel } from "../../../../packages/shopify-app/app/import-history-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Props = ComponentProps<typeof ImportHistoryPanel>;
const source = {
  sourceId: "private-source",
  storeId: "private-store",
  installationGeneration: "private-generation",
  sourceInstallationGeneration: "private-old-generation",
  revision: "a".repeat(64),
  status: "preview" as const,
  rowCount: 2,
  totalOpeningBalance: "18446744073709551614",
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  verification: "source_record_only" as const,
};
const page = {
  storeId: "private-store",
  installationGeneration: "private-generation",
  sources: [source],
  nextCursor: null,
};
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
const render = async (
  readHistory: Props["readHistory"],
  readStatus: Props["readStatus"] = vi.fn(),
  locale: Props["locale"] = "en",
  generation = "private-generation",
) => {
  await act(async () =>
    root.render(
      createElement(ImportHistoryPanel, {
        key: generation,
        generation,
        locale,
        readHistory,
        readStatus,
        reconcile: vi.fn(),
        execute: vi.fn(),
      }),
    ),
  );
};
const button = (text: string) =>
  [...node.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
const click = (text: string) => act(async () => button(text).click());
it("recovers history without an upload and opens its signed status lookup", async () => {
  const readHistory = vi.fn().mockResolvedValue(page);
  const readStatus = vi.fn().mockResolvedValue(source);
  await render(readHistory, readStatus);
  expect(readHistory).not.toHaveBeenCalled();
  await click("Load latest imports");
  expect(readHistory).toHaveBeenCalledWith({
    operation: "history",
    expectedInstallationGeneration: "private-generation",
  });
  expect(node.textContent).toContain(source.totalOpeningBalance);
  const region = node.querySelector<HTMLElement>('[role="region"]')!;
  expect(region.getAttribute("aria-label")).toBe("Import history");
  expect(region.tabIndex).toBe(0);
  expect(region.style.overflowX).toBe("auto");
  expect(region.querySelector("table")!.style.whiteSpace).toBe("nowrap");
  await click("View status");
  await click("Refresh import status");
  expect(readStatus).toHaveBeenCalledWith({
    operation: "status",
    sourceId: "private-source",
    expectedInstallationGeneration: "private-generation",
  });
  expect(node.textContent).toContain("does not restart it");
  expect(node.innerHTML).not.toMatch(/private-|sourceId|revision/);
});
it("passes the continuation cursor and clears an older page on failure without retry", async () => {
  const sources = Array.from({ length: 20 }, (_, index) => ({
    ...source,
    sourceId: `private-source-${String(20 - index).padStart(2, "0")}`,
  }));
  const cursor = {
    sourceId: sources[19].sourceId,
    createdAt: source.createdAt,
  };
  const readHistory = vi
    .fn()
    .mockResolvedValueOnce({ ...page, sources, nextCursor: cursor })
    .mockRejectedValueOnce(new Error("private backend detail"));
  await render(readHistory);
  await click("Load latest imports");
  await click("View status");
  await click("Older imports");
  expect(readHistory.mock.calls[1][0]).toEqual({
    operation: "history",
    expectedInstallationGeneration: "private-generation",
    before: cursor,
  });
  expect(node.querySelector("table")).toBeNull();
  expect(button("Refresh import status")).toBeUndefined();
  expect(button("Older imports")).toBeUndefined();
  expect(node.textContent).toContain("could not be loaded");
  expect(node.innerHTML).not.toContain("private");
  expect(readHistory).toHaveBeenCalledTimes(2);
});
it.each([
  ["en", "Load latest imports", "No imports on this page."],
  ["ja", "最新のインポートを読み込む", "このページにインポートはありません。"],
  ["vi", "Tải các bản nhập mới nhất", "Không có bản nhập nào trên trang này."],
] as const)("renders the %s empty state", async (locale, load, message) => {
  await render(
    vi.fn().mockResolvedValue({ ...page, sources: [] }),
    vi.fn(),
    locale,
  );
  await click(load);
  expect(node.textContent).toContain(message);
  expect(node.querySelector("table")).toBeNull();
});
it("suppresses duplicate reads and ignores old-installation responses", async () => {
  let resolve!: (value: typeof page) => void;
  const readHistory = vi.fn().mockReturnValue(
    new Promise<typeof page>((done) => {
      resolve = done;
    }),
  );
  await render(readHistory);
  await act(async () => {
    button("Load latest imports").click();
    button("Load latest imports").click();
  });
  expect(readHistory).toHaveBeenCalledTimes(1);
  expect(button("Load latest imports").disabled).toBe(true);
  await render(vi.fn(), vi.fn(), "en", "new-generation");
  await act(async () => resolve(page));
  expect(node.querySelector("table")).toBeNull();
  expect(button("Load latest imports").disabled).toBe(false);
});
