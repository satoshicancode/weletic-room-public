// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ImportStatusPanel,
  importExecutionCopy,
} from "../../../../packages/shopify-app/app/import-status-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Props = ComponentProps<typeof ImportStatusPanel>;
const result = {
  sourceId: "private-source",
  storeId: "private-store",
  installationGeneration: "private-generation",
  sourceInstallationGeneration: "private-generation",
  revision: "a".repeat(64),
  status: "preview" as const,
  rowCount: 2,
  totalOpeningBalance: "18446744073709551614",
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  verification: "source_record_only" as const,
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
  readStatus: Props["readStatus"],
  locale: Props["locale"] = "en",
  sourceId = "private-source",
  reconcile: Props["reconcile"] = vi.fn(),
  execute: Props["execute"] = vi.fn(),
) => {
  await act(async () =>
    root.render(
      createElement(ImportStatusPanel, {
        key: sourceId,
        sourceId,
        generation: "private-generation",
        locale,
        readStatus,
        reconcile,
        execute,
      }),
    ),
  );
};
const refresh = () => act(async () => node.querySelector("button")!.click());
it("only fetches on demand and renders exact totals without identifiers", async () => {
  const readStatus = vi.fn().mockResolvedValue(result);
  await render(readStatus);
  expect(readStatus).not.toHaveBeenCalled();
  await refresh();
  expect(readStatus).toHaveBeenCalledWith({
    operation: "status",
    sourceId: "private-source",
    expectedInstallationGeneration: "private-generation",
  });
  expect(node.textContent).toContain("18446744073709551614");
  expect(node.textContent).toContain("not proof of ledger reconciliation");
  expect(node.innerHTML).not.toMatch(/private-|revision|source_record_only/);
});
it.each([
  ["en", "contained", "Contained — requires investigation"],
  ["ja", "contained", "保留中 — 調査が必要です"],
  ["vi", "contained", "Tạm giữ — cần kiểm tra"],
  ["en", "committed", "Committed"],
  ["ja", "committed", "反映済み"],
  ["vi", "committed", "Đã ghi điểm"],
] as const)("localizes %s/%s", async (locale, status, text) => {
  await render(vi.fn().mockResolvedValue({ ...result, status }), locale);
  await refresh();
  expect(node.querySelector('[role="status"]')?.textContent).toBe(text);
});
it("distinguishes older installations without offering a restart", async () => {
  await render(
    vi.fn().mockResolvedValue({
      ...result,
      sourceInstallationGeneration: "private-old",
    }),
  );
  await refresh();
  expect(node.textContent).toContain("does not restart it");
  expect(
    [...node.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual(["Refresh import status", "Reconcile import ledger"]);
  expect(node.innerHTML).not.toContain("private-old");
});
it("discards pending reconciliation on a same-revision status refresh", async () => {
  let resolve!: (value: unknown) => void;
  const reconcile = vi.fn().mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render(
    vi.fn().mockResolvedValue(result),
    "en",
    "private-source",
    reconcile,
  );
  await refresh();
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Reconcile import ledger")!
      .click(),
  );
  expect(reconcile).toHaveBeenCalledWith({
    operation: "reconcile",
    sourceId: "private-source",
    expectedInstallationGeneration: "private-generation",
    expectedRevision: result.revision,
  });
  await refresh();
  await act(async () =>
    resolve({
      ...result,
      verification: "ledger_provenance",
      reconciled: true,
      fullyCommitted: false,
      fullyRolledBack: false,
      issues: [],
      importedPoints: "0",
      reversedPoints: "0",
      expectedNetPoints: "0",
      observedNetPoints: "0",
    }),
  );
  expect(node.querySelectorAll("dl")).toHaveLength(1);
  expect(node.textContent).not.toContain("Ledger evidence reconciles;");
});
it.each(["en", "ja", "vi"] as const)(
  "clears stale success on %s failure without retry or error disclosure",
  async (locale) => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error("private permission detail"));
    await render(readStatus, locale);
    await refresh();
    expect(node.querySelector("dl")).not.toBeNull();
    await refresh();
    expect(node.querySelector("dl")).toBeNull();
    expect(node.querySelector('[role="status"]')?.textContent).not.toBe("");
    expect(node.innerHTML).not.toContain("private");
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(node.querySelector("button")!.disabled).toBe(false);
  },
);
it("suppresses duplicate dispatch and ignores a response after source replacement", async () => {
  let resolve!: (value: typeof result) => void;
  const readStatus = vi.fn().mockReturnValue(
    new Promise<typeof result>((done) => {
      resolve = done;
    }),
  );
  await render(readStatus);
  await act(async () => {
    node.querySelector("button")!.click();
    node.querySelector("button")!.click();
  });
  expect(readStatus).toHaveBeenCalledTimes(1);
  expect(node.querySelector("button")!.disabled).toBe(true);
  await render(vi.fn(), "en", "new-source");
  await act(async () => resolve(result));
  expect(node.querySelector("dl")).toBeNull();
  expect(node.querySelector("button")!.disabled).toBe(false);
});

it.each(["en", "ja", "vi"] as const)(
  "requires confirmation and invalidates the revision after %s commit",
  async (locale) => {
    const execute = vi.fn().mockResolvedValue({});
    const readStatus = vi.fn().mockResolvedValue(result);
    await render(readStatus, locale, "private-source", vi.fn(), execute);
    expect(node.querySelector('input[type="checkbox"]')).toBeNull();
    await refresh();
    const button = [...node.querySelectorAll("button")].find(
      (item) => item.textContent === importExecutionCopy[locale].commit,
    )!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(execute).not.toHaveBeenCalled();
    await act(async () =>
      (
        node.querySelector('input[type="checkbox"]') as HTMLInputElement
      ).click(),
    );
    await act(async () => {
      button.click();
      button.click();
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      operation: "commit",
      sourceId: "private-source",
      expectedInstallationGeneration: "private-generation",
      expectedRevision: result.revision,
    });
    expect(node.textContent).toContain(importExecutionCopy[locale].queued);
    expect(node.querySelector("dl")).toBeNull();
    expect(node.querySelector('input[type="checkbox"]')).toBeNull();
    expect(node.innerHTML).not.toMatch(/private-|revision|lease/);
    expect(readStatus).toHaveBeenCalledTimes(1);
    await refresh();
    expect(
      (node.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(false);
  },
);

it.each(["en", "ja", "vi"] as const)(
  "requires refresh after an ambiguous %s rollback without automatic retry",
  async (locale) => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error("private worker token"));
    await render(
      vi.fn().mockResolvedValue({ ...result, status: "committed" }),
      locale,
      "private-source",
      vi.fn(),
      execute,
    );
    await refresh();
    expect(node.textContent).toContain(
      importExecutionCopy[locale].confirmRollback,
    );
    await act(async () =>
      (
        node.querySelector('input[type="checkbox"]') as HTMLInputElement
      ).click(),
    );
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find(
          (item) => item.textContent === importExecutionCopy[locale].rollback,
        )!
        .click(),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].operation).toBe("rollback");
    expect(node.textContent).toContain(importExecutionCopy[locale].uncertain);
    expect(node.querySelector('input[type="checkbox"]')).toBeNull();
    expect(node.innerHTML).not.toContain("private");
  },
);

it.each([
  "committing",
  "rolling_back",
  "rolled_back",
  "contained",
  "cancelled",
] as const)("offers no mutation for %s", async (status) => {
  await render(vi.fn().mockResolvedValue({ ...result, status }));
  await refresh();
  expect(node.querySelector('input[type="checkbox"]')).toBeNull();
});

it("disables refresh while dispatching and ignores a late mutation response after replacement", async () => {
  let resolve!: (value: unknown) => void;
  const execute = vi.fn().mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render(
    vi.fn().mockResolvedValue(result),
    "en",
    "private-source",
    vi.fn(),
    execute,
  );
  await refresh();
  await act(async () =>
    (node.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((item) => item.textContent === importExecutionCopy.en.commit)!
      .click(),
  );
  expect(node.querySelector("button")!.disabled).toBe(true);
  await render(vi.fn(), "en", "new-source");
  await act(async () => resolve({}));
  expect(node.textContent).not.toContain(importExecutionCopy.en.queued);
  expect(node.querySelector("button")!.disabled).toBe(false);
});
