// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarningRulesResponse } from "../../lib/weletic/loyalty/earning-rule-contract";
import {
  newEarningRuleForm,
  parseEarningRuleForm,
} from "../../ui/weletic/loyalty/earning-rule-form";
import {
  EarningRulesScreen,
  EarningRulesSession,
  type EarningRulesTransport,
} from "../../ui/weletic/loyalty/earning-rules-screen";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const parsed = parseEarningRuleForm({
  ...newEarningRuleForm(),
  name: "Purchase rule",
});
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
      name: "Purchase rule",
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
let transport: EarningRulesTransport;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  transport = {
    scopeKey: "a",
    read: vi.fn().mockResolvedValue(view),
    save: vi.fn().mockResolvedValue(view),
    retire: vi.fn().mockResolvedValue({ ...view, rules: [] }),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(createElement(EarningRulesScreen, { transport })),
  );
}
it.each(["JPY", "VND", "BHD", null, undefined])(
  "shows honest shop currency context: %s",
  async (shopCurrency) => {
    vi.mocked(transport.read).mockResolvedValue({ ...view, shopCurrency });
    await render();
    expect(container.textContent).toContain(
      `Current shop currency: ${shopCurrency ?? "Unavailable"}`,
    );
    expect(container.textContent).toContain(
      "not the program accounting currency",
    );
    await click("Edit");
    expect(container.textContent).toContain(
      `Current shop currency: ${shopCurrency ?? "Unavailable"}`,
    );
  },
);
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (el) => el.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
describe("shared earning-rule management screen", () => {
  it("changes locale without discarding the active edit", async () => {
    await act(async () =>
      root.render(createElement(EarningRulesSession, { transport })),
    );
    await click("Edit");
    const language = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      language.value = "ja";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("ルールを保存");
    expect(
      container.querySelector<HTMLInputElement>('input[name="name"]')?.value,
    ).toBe("Purchase rule");
    expect(transport.read).toHaveBeenCalledTimes(1);
  });
  it("does not let an old save restore access after a same-scope transport refresh", async () => {
    let resolve!: (value: EarningRulesResponse) => void;
    vi.mocked(transport.save).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    await click("Edit");
    await submit();
    transport = {
      ...transport,
      read: vi.fn().mockRejectedValue(new Error("denied")),
    };
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => resolve(view));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("New rule");
    expect(container.textContent).not.toContain("Purchase rule");
  });
  it("lists and saves existing rules with the displayed revision", async () => {
    await render();
    await click("Edit");
    await submit();
    expect(transport.save).toHaveBeenCalledWith({
      expectedInstallationGeneration: "g1",
      expectedRevision: view.revision,
      ruleId: "rule-a",
      rule: parsed.data,
    });
    expect(container.textContent).toContain("Rule saved.");
  });
  it("requires retirement confirmation", async () => {
    await render();
    await click("Retire");
    expect(transport.retire).not.toHaveBeenCalled();
    await click("Confirm retirement");
    expect(transport.retire).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("No earning rules configured.");
  });
  it("hides editing after an uncertain save until explicit reload", async () => {
    vi.mocked(transport.save).mockRejectedValue(new Error("uncertain"));
    await render();
    await click("Edit");
    await submit();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(transport.save).toHaveBeenCalledTimes(1);
    await click("Reload");
    expect(container.textContent).toContain("Purchase rule");
  });
  it("renders no mutation buttons for read-only access", async () => {
    vi.mocked(transport.read).mockResolvedValue({
      ...view,
      capabilities: { configure: false },
    });
    await render();
    expect(container.textContent).toContain("Read-only access");
    expect(container.textContent).toContain("Purchase multiplier");
    expect(container.querySelector("dl")?.textContent).toContain("1");
    expect(
      Array.from(container.querySelectorAll("button")).map(
        (el) => el.textContent,
      ),
    ).toEqual(["Reload"]);
  });
  it("rejects duplicate synchronous submissions", async () => {
    let resolve!: (value: EarningRulesResponse) => void;
    vi.mocked(transport.save).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
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
    await act(async () => resolve(view));
  });
});
