// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  earningRuleCopy,
  type EarningRuleLocale,
} from "../../ui/weletic/loyalty/earning-rule-copy";
import { EarningRuleEditor } from "../../ui/weletic/loyalty/earning-rule-editor";
import {
  newEarningRuleForm,
  type EarningRuleForm,
} from "../../ui/weletic/loyalty/earning-rule-form";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const submit = vi.fn();
const cancel = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  form: EarningRuleForm,
  locale: EarningRuleLocale = "en",
  disabled = false,
) {
  function Harness() {
    const [value, setValue] = React.useState(form);
    return (
      <EarningRuleEditor
        value={value}
        onChange={setValue}
        onSubmit={submit}
        onCancel={cancel}
        locale={locale}
        disabled={disabled}
      />
    );
  }
  await act(async () => root.render(<Harness />));
}
async function send() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
describe("rendered shared earning-rule form", () => {
  it.each(["en", "ja", "vi"] as const)(
    "clears hidden subscription terms when selecting one-time purchases in %s",
    async (locale) => {
      await render(
        {
          ...newEarningRuleForm(),
          name: "Purchase earning",
          purchaseType: "subscription",
          subscriptionCadence: "first_n_payments",
          subscriptionPaymentLimit: "3",
        },
        locale,
      );
      const control = container.querySelector<HTMLSelectElement>(
        '[name="purchaseType"]',
      )!;
      await act(async () => {
        control.value = "one_time";
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        container.querySelector('[name="subscriptionCadence"]'),
      ).toBeNull();
      expect(
        container.querySelector('[name="subscriptionPaymentLimit"]'),
      ).toBeNull();
      await send();
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          purchaseType: "one_time",
          subscriptionCadence: "first_payment",
          subscriptionPaymentLimit: null,
        }),
      );
      submit.mockClear();
      await act(async () => {
        control.value = "both";
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await send();
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          purchaseType: "both",
          subscriptionCadence: "first_payment",
          subscriptionPaymentLimit: null,
        }),
      );
    },
  );
  it("can save one-time eligibility after the default every-renewal policy", async () => {
    await render({ ...newEarningRuleForm(), name: "Purchase earning" });
    const control = container.querySelector<HTMLSelectElement>(
      '[name="purchaseType"]',
    )!;
    await act(async () => {
      control.value = "one_time";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await send();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseType: "one_time",
        subscriptionCadence: "first_payment",
        subscriptionPaymentLimit: null,
      }),
    );
  });
  it.each([
    [
      "en",
      "Legacy review earning rules depend on publication",
      "do not configure participation-based incentives",
    ],
    [
      "ja",
      "公開状況と連携先の適格条件",
      "参加型インセンティブは設定できません",
    ],
    [
      "vi",
      "phụ thuộc trạng thái xuất bản",
      "không cấu hình ưu đãi dựa trên việc tham gia",
    ],
  ] as const)(
    "labels legacy review behavior honestly in %s",
    async (locale, legacy, boundary) => {
      await render(newEarningRuleForm("product_review"), locale);
      expect(container.textContent).toContain(legacy);
      expect(container.textContent).toContain(boundary);
    },
  );
  it.each([
    {
      trigger: "link_click" as const,
      patch: { targetUrl: "http://example.com" },
      field: "targetUrl",
    },
    {
      trigger: "product_review" as const,
      patch: { photoBonusPoints: "-1" },
      field: "photoBonusPoints",
    },
    {
      trigger: "birthday" as const,
      patch: { limitInterval: "monthly" as const },
      field: "limitInterval",
    },
  ])(
    "identifies invalid $field in the rendered form",
    async ({ trigger, patch, field }) => {
      await render({
        ...newEarningRuleForm(trigger),
        name: "Rule",
        fixedPoints: "10",
        ...patch,
      });
      await send();
      const control = container.querySelector(`[name="${field}"]`)!;
      expect(control.getAttribute("aria-invalid")).toBe("true");
      expect(control.getAttribute("aria-describedby")).toBe(
        container.querySelector('[role="alert"]')?.id,
      );
      expect(submit).not.toHaveBeenCalled();
    },
  );
  it.each(["en", "ja", "vi"] as const)(
    "renders labeled controls in %s",
    async (locale) => {
      await render({ ...newEarningRuleForm(), name: "Rule" }, locale);
      expect(container.textContent).toContain(earningRuleCopy[locale].save);
      const input =
        container.querySelector<HTMLInputElement>('input[name="name"]')!;
      expect(input.labels?.[0]?.textContent).toContain(
        earningRuleCopy[locale].fields.name,
      );
      expect(container.querySelector("form")?.lang).toBe(locale);
    },
  );
  it("submits exact points without activating a new rule", async () => {
    await render({
      ...newEarningRuleForm("account_created"),
      name: "Signup",
      fixedPoints: "9007199254740993",
    });
    await send();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        fixedPoints: "9007199254740993",
        isActive: false,
      }),
    );
  });
  it("blocks invalid input with an accessible error", async () => {
    await render(newEarningRuleForm());
    await send();
    expect(submit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      container
        .querySelector('input[name="name"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
  });
  it("blocks submission while disabled", async () => {
    await render({ ...newEarningRuleForm(), name: "Rule" }, "en", true);
    await send();
    expect(submit).not.toHaveBeenCalled();
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
  });
  it("shows social honor-system disclosure and resets activation on trigger change", async () => {
    await render({ ...newEarningRuleForm(), name: "Rule", isActive: true });
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="triggerCode"]',
    )!;
    await act(async () => {
      select.value = "x_share";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain(earningRuleCopy.en.honor);
    expect(
      container.querySelector<HTMLInputElement>('input[name="isActive"]')
        ?.checked,
    ).toBe(false);
    expect(container.querySelector('input[name="multiplier"]')).toBeNull();
    expect(container.querySelector('input[name="targetUrl"]')).not.toBeNull();
  });
});
