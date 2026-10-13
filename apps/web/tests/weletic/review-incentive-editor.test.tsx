// @vitest-environment jsdom
import { CoreLaunchContext } from "@/ui/weletic/core-launch-context";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewIncentiveEditor } from "../../../../packages/shopify-app/app/components/ReviewIncentiveEditor";
import { reviewIncentiveEditorCopy } from "../../../../packages/shopify-app/app/review-incentive-editor-copy";
import { StaffAccessClientError } from "../../../../packages/shopify-app/app/staff-access-client";
type Props = React.ComponentProps<typeof ReviewIncentiveEditor>;
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const policy: Props["policy"] = {
  revision: 0,
  installationGeneration: "g1",
  activePolicy: null,
  latestPolicy: null,
  mode: "legacy",
};
const save = vi.fn<Props["save"]>();
const reload = vi.fn();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(extra: Partial<Props> = {}, coreLaunch = false) {
  await act(async () =>
    root.render(
      <React.StrictMode>
        <CoreLaunchContext.Provider value={coreLaunch}>
          <ReviewIncentiveEditor
            policy={policy}
            coupons={[{ id: "reward", name: "Coupon" }]}
            locale="en"
            save={save}
            reload={reload}
            {...extra}
          />
        </CoreLaunchContext.Provider>
      </React.StrictMode>,
    ),
  );
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function select(name: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(
      `[name="${name}"]`,
    )!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it.each(["en", "ja", "vi"] as const)(
  "renders labelled controls and preserves draft on locale changes: %s",
  async (locale) => {
    await render({ locale });
    expect(container.textContent).toContain(
      reviewIncentiveEditorCopy[locale].help,
    );
    await select("kind", "points");
    for (const input of container.querySelectorAll("input"))
      expect(
        container.querySelector(`label[for="${input.id}"]`),
      ).not.toBeNull();
    await render({ locale: locale === "en" ? "ja" : "en" });
    expect(
      container.querySelector<HTMLSelectElement>('[name="kind"]')!.value,
    ).toBe("points");
  },
);
it("submits exact revision/generation and locks duplicate pending and settled saves", async () => {
  let finish!: (value: Awaited<ReturnType<Props["save"]>>) => void;
  save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await submit();
  await submit();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({
    expectedRevision: 0,
    expectedInstallationGeneration: "g1",
    draft: { kind: "none" },
  });
  await act(async () =>
    finish({
      policyId: "policy",
      revision: 1,
      contentDigest: "c".repeat(64),
      activated: false,
    }),
  );
  await submit();
  expect(save).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(reviewIncentiveEditorCopy.en.saved);
  expect(document.activeElement?.getAttribute("role")).toBe("status");
});
it.each(["unavailable", "reload", "denied", "reauthenticate"] as const)(
  "requires reload after %s without automatic retry",
  async (code) => {
    save.mockRejectedValue(new StaffAccessClientError(code));
    await render();
    await submit();
    await submit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
  },
);
it("refuses stale props without silently adopting a newer revision", async () => {
  await render();
  await render({ policy: { ...policy, installationGeneration: "g2" } });
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain(reviewIncentiveEditorCopy.en.stale);
});
it("requires an available coupon and never accepts an unlisted saved choice", async () => {
  await render();
  await select("kind", "coupon");
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain(reviewIncentiveEditorCopy.en.invalid);
  await select("rewardDefinitionId", "reward");
  await render({ coupons: [] });
  await submit();
  expect(save).not.toHaveBeenCalled();
});
it("confirms before discarding unsaved edits", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await render();
  await select("kind", "points");
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === reviewIncentiveEditorCopy.en.reload,
  )!;
  await act(async () => button.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => button.click());
  expect(reload).toHaveBeenCalledOnce();
});

it("preserves exact large points and renders saved disclosures as text", async () => {
  const draft = {
    kind: "points" as const,
    basePoints: "9007199254740993",
    photoBonusPoints: "20",
    videoBonusPoints: "30",
    maxPoints: "9223372036854775807",
  };
  const latestPolicy = {
    policyId: "policy",
    revision: 1,
    contentDigest: "c".repeat(64),
    draft,
    disclosureState: "available" as const,
    disclosure: {
      en: ["<img src=x onerror=alert(1)>"],
      ja: ["保存済み"],
      vi: ["Đã lưu"],
    },
  };
  save.mockResolvedValue({
    policyId: "new",
    revision: 2,
    contentDigest: "d".repeat(64),
    activated: false,
  });
  await render({ policy: { ...policy, revision: 1, latestPolicy } });
  expect(container.querySelector("aside img")).toBeNull();
  expect(container.querySelector("aside")?.textContent).toContain("<img");
  expect(container.textContent).toContain(reviewIncentiveEditorCopy.en.video);
  await submit();
  expect(save).toHaveBeenCalledWith({
    expectedRevision: 1,
    expectedInstallationGeneration: "g1",
    draft,
  });
});

it("warns on browser navigation while the draft is dirty", async () => {
  await render();
  await select("kind", "points");
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

it.each(["en", "ja", "vi"] as const)(
  "core editor offers participation-only policies in %s",
  async (locale) => {
    await render({ locale }, true);
    expect(
      [
        ...container.querySelectorAll<HTMLOptionElement>(
          '[name="kind"] option',
        ),
      ].map((option) => option.value),
    ).toEqual(["none", "points"]);
    await select("kind", "points");
    expect(container.querySelector('[name="photoBonusPoints"]')).toBeNull();
    expect(container.querySelector('[name="videoBonusPoints"]')).toBeNull();
    expect(container.querySelector('[name="basePoints"]')).not.toBeNull();
    expect(container.querySelector('[name="maxPoints"]')).not.toBeNull();
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 0,
      expectedInstallationGeneration: "g1",
      draft: {
        kind: "points",
        basePoints: "0",
        maxPoints: "0",
        photoBonusPoints: "0",
        videoBonusPoints: "0",
      },
    });
  },
);
