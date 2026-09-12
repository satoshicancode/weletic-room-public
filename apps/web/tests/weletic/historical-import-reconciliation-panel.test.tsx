// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importReconciliationCopy } from "../../../../packages/shopify-app/app/import-reconciliation-copy";
import { ImportReconciliationPanel } from "../../../../packages/shopify-app/app/import-reconciliation-panel";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Props = ComponentProps<typeof ImportReconciliationPanel>;
const result = {
  sourceId: "private-source",
  storeId: "private-store",
  installationGeneration: "private-generation",
  sourceInstallationGeneration: "private-old",
  revision: "a".repeat(64),
  status: "committed",
  rowCount: 1,
  totalOpeningBalance: "9007199254740993",
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  verification: "ledger_provenance",
  reconciled: true,
  fullyCommitted: true,
  fullyRolledBack: false,
  issues: [],
  importedPoints: "9007199254740993",
  reversedPoints: "0",
  expectedNetPoints: "9007199254740993",
  observedNetPoints: "9007199254740993",
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
async function render(
  reconcile: Props["reconcile"],
  locale: Props["locale"] = "en",
) {
  await act(async () =>
    root.render(
      createElement(ImportReconciliationPanel, {
        sourceId: "private-source",
        generation: "private-generation",
        revision: result.revision,
        locale,
        reconcile,
      }),
    ),
  );
}
const run = () => act(async () => node.querySelector("button")!.click());
it("runs only on demand with the observed revision and exact private evidence", async () => {
  const reconcile = vi.fn().mockResolvedValue(result);
  await render(reconcile);
  expect(reconcile).not.toHaveBeenCalled();
  await run();
  expect(reconcile).toHaveBeenCalledWith({
    operation: "reconcile",
    sourceId: "private-source",
    expectedInstallationGeneration: "private-generation",
    expectedRevision: result.revision,
  });
  expect(node.textContent).toContain("9007199254740993");
  expect(node.textContent).toContain(
    "Cached wallet balances are not audited here",
  );
  expect(node.innerHTML).not.toMatch(/private-|ledger_provenance|revision/);
});
it.each(["en", "ja", "vi"] as const)(
  "distinguishes all reconciliation outcomes in %s",
  async (locale) => {
    const text = importReconciliationCopy[locale];
    const reconcile = vi.fn();
    await render(reconcile, locale);
    for (const [change, message] of [
      [{}, text.committed],
      [
        {
          status: "rolled_back",
          fullyCommitted: false,
          fullyRolledBack: true,
          reversedPoints: result.importedPoints,
          expectedNetPoints: "0",
          observedNetPoints: "0",
        },
        text.rolledBack,
      ],
      [
        {
          status: "preview",
          fullyCommitted: false,
          importedPoints: "0",
          expectedNetPoints: "0",
          observedNetPoints: "0",
        },
        text.clean,
      ],
      [
        {
          reconciled: false,
          fullyCommitted: false,
          observedNetPoints: "-1",
          issues: ["net_points_mismatch"],
        },
        text.mismatch,
      ],
    ] as const) {
      reconcile.mockResolvedValue({ ...result, ...change });
      await run();
      expect(node.querySelector('[role="status"]')?.textContent).toBe(message);
    }
    expect(node.textContent).toContain(text.issues.net_points_mismatch);
  },
);
it("clears evidence on failure and never retries or exposes raw errors", async () => {
  const reconcile = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new Error("private ledger identity"));
  await render(reconcile);
  await run();
  await run();
  expect(node.querySelector("dl")).toBeNull();
  expect(node.textContent).toContain("Refresh import status");
  expect(node.innerHTML).not.toContain("private");
  expect(reconcile).toHaveBeenCalledTimes(2);
});
it("suppresses duplicate requests and discards detached responses", async () => {
  let resolve!: (value: typeof result) => void;
  const reconcile = vi.fn().mockReturnValue(
    new Promise<typeof result>((done) => {
      resolve = done;
    }),
  );
  await render(reconcile);
  await act(async () => {
    node.querySelector("button")!.click();
    node.querySelector("button")!.click();
  });
  expect(reconcile).toHaveBeenCalledTimes(1);
  await act(async () => root.render(createElement("p", null, "New context")));
  await act(async () => resolve(result));
  expect(node.textContent).toBe("New context");
});
