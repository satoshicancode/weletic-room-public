// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarningRulesResponse } from "../../lib/weletic/loyalty/earning-rule-contract";
import {
  newEarningRuleForm,
  parseEarningRuleForm,
} from "../../ui/weletic/loyalty/earning-rule-form";
import { EarningRulesAdmin } from "../../ui/weletic/loyalty/earning-rules-admin";
const mocks = vi.hoisted(() => ({
  factory: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("../../lib/weletic/loyalty/workspace-earning-rules-client", () => ({
  createWorkspaceEarningRulesClient: mocks.factory,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const parsed = parseEarningRuleForm({ ...newEarningRuleForm(), name: "Rule" });
if (!parsed.success) throw new Error("fixture");
const view: EarningRulesResponse = {
  storeId: "store-a",
  installationGeneration: "g1",
  programId: "program-a",
  revision: "a".repeat(64),
  affectedRuleId: null,
  capabilities: { configure: true },
  rules: [
    {
      id: "rule-a",
      name: "Rule",
      triggerCode: "order_paid",
      isActive: false,
      fields: parsed.data,
      editUnavailableReason: null,
      constraints: { startAt: null, endAt: null, hasTierEligibility: false },
    },
  ],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.read.mockResolvedValue(view);
  mocks.save.mockResolvedValue(view);
  mocks.retire.mockResolvedValue(view);
  mocks.factory.mockReturnValue({
    read: mocks.read,
    save: mocks.save,
    retire: mocks.retire,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(workspaceId: string, onSaved: () => void) {
  await act(async () =>
    root.render(createElement(EarningRulesAdmin, { workspaceId, onSaved })),
  );
}
async function save() {
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((el) => el.textContent === "Edit")!
      .click(),
  );
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
describe("workspace shared earning-rule mounting", () => {
  it("ignores an old A read after navigating A to B to A", async () => {
    let resolve!: (value: EarningRulesResponse) => void;
    mocks.read.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render("workspace-a", vi.fn());
    await render("workspace-b", vi.fn());
    await render("workspace-a", vi.fn());
    expect(container.textContent).toContain("Rule");
    await act(async () =>
      resolve({
        ...view,
        rules: [{ ...view.rules[0], name: "Obsolete first A" }],
      }),
    );
    expect(container.textContent).not.toContain("Obsolete first A");
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });
  it("keeps the write lock across A to B to A and ignores the first A save", async () => {
    let resolve!: (value: EarningRulesResponse) => void;
    mocks.save.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = vi.fn();
    const second = vi.fn();
    const returned = vi.fn();
    await render("workspace-a", first);
    await save();
    await render("workspace-b", second);
    await render("workspace-a", returned);
    const create = () =>
      Array.from(container.querySelectorAll("button")).find(
        (el) => el.textContent === "New rule",
      )!;
    expect(create().disabled).toBe(true);
    await act(async () => create().click());
    expect(container.querySelector("form")).toBeNull();
    await act(async () =>
      resolve({
        ...view,
        rules: [{ ...view.rules[0], name: "Obsolete saved A" }],
      }),
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(returned).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Obsolete saved A");
    expect(create().disabled).toBe(false);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("does not notify or populate a replacement mount after unmounting during save", async () => {
    let resolve!: (value: EarningRulesResponse) => void;
    mocks.save.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const old = vi.fn();
    const replacement = vi.fn();
    await render("workspace-a", old);
    await save();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render("workspace-a", replacement);
    await act(async () =>
      resolve({
        ...view,
        rules: [{ ...view.rules[0], name: "Unmounted result" }],
      }),
    );
    expect(old).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Unmounted result");
    expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
  });
  it("uses explicit workspace scope and refreshes only after acknowledged saves", async () => {
    const refresh = vi.fn();
    await render("workspace-a", refresh);
    expect(mocks.factory).toHaveBeenCalledWith("workspace-a");
    expect(refresh).not.toHaveBeenCalled();
    await save();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("keeps the client stable when only the parent callback changes", async () => {
    await render("workspace-a", vi.fn());
    const latest = vi.fn();
    await render("workspace-a", latest);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await save();
    expect(latest).toHaveBeenCalledTimes(1);
  });
  it("does not refresh another workspace after an obsolete save resolves", async () => {
    let resolve!: (value: EarningRulesResponse) => void;
    mocks.save.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const old = vi.fn();
    const current = vi.fn();
    await render("workspace-a", old);
    await save();
    await render("workspace-b", current);
    await act(async () => resolve(view));
    expect(old).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(mocks.factory).toHaveBeenCalledWith("workspace-b");
  });
  it("does not refresh the overview for failed saves", async () => {
    mocks.save.mockRejectedValue(new Error("uncertain"));
    const refresh = vi.fn();
    await render("workspace-a", refresh);
    await save();
    expect(refresh).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
