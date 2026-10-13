// @vitest-environment jsdom
import { CoreLaunchContext } from "@/ui/weletic/core-launch-context";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewIncentiveActivation } from "../../../../packages/shopify-app/app/components/ReviewIncentiveActivation";
import { ReviewIncentivesPanel } from "../../../../packages/shopify-app/app/components/ReviewIncentivesPanel";
import { reviewIncentiveActivationCopy as activationCopy } from "../../../../packages/shopify-app/app/review-incentive-activation-copy";
import { reviewIncentiveEditorCopy as copy } from "../../../../packages/shopify-app/app/review-incentive-editor-copy";
import { StaffAccessClientError } from "../../../../packages/shopify-app/app/staff-access-client";
type Props = React.ComponentProps<typeof ReviewIncentivesPanel>;
const client = {
  read: vi.fn<Props["client"]["read"]>(),
  coupons: vi.fn<Props["client"]["coupons"]>(),
  draft: vi.fn<Props["client"]["draft"]>(),
  activate: vi.fn<Props["client"]["activate"]>(),
};
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  client.read.mockResolvedValue({
    revision: 0,
    installationGeneration: "g1",
    activePolicy: null,
    latestPolicy: null,
    mode: "legacy",
  });
  client.coupons.mockResolvedValue({
    items: [{ id: "reward", name: "Coupon" }],
    nextCursor: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(locale: Props["locale"] = "en", coreLaunch = false) {
  await act(async () =>
    root.render(
      <React.StrictMode>
        <CoreLaunchContext.Provider value={coreLaunch}>
          <ReviewIncentivesPanel client={client} locale={locale} />
        </CoreLaunchContext.Provider>
      </React.StrictMode>,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function submit() {
  await act(async () =>
    container
      .querySelectorAll("form")[1]
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
it.each(["en", "ja", "vi"] as const)(
  "loads core participation settings without the deferred coupon endpoint in %s",
  async (locale) => {
    client.coupons.mockRejectedValue(new StaffAccessClientError("denied"));
    await render(locale, true);
    await click(copy[locale].load);
    expect(client.read).toHaveBeenCalledOnce();
    expect(client.coupons).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(copy[locale].loadFailed);
    expect(container.textContent).not.toContain(copy[locale].search);
    expect(container.querySelector('[name="kind"]')).not.toBeNull();
  },
);
it.each(["en", "ja", "vi"] as const)(
  "loads only on explicit action in %s",
  async (locale) => {
    await render(locale);
    expect(client.read).not.toHaveBeenCalled();
    await click(copy[locale].load);
    expect(client.read).toHaveBeenCalledOnce();
    expect(client.coupons).toHaveBeenCalledWith({});
    expect(container.textContent).toContain(copy[locale].legacy);
    expect(container.querySelector('[name="kind"]')).not.toBeNull();
  },
);
it("recovers from a failed non-commit by explicitly reloading the same revision", async () => {
  client.draft.mockRejectedValue(new StaffAccessClientError("unavailable"));
  await render();
  await click(copy.en.load);
  await submit();
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  await click(copy.en.reload);
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(container.querySelector("fieldset")!.disabled).toBe(false);
});
it("does not mount an editor after an incomplete load", async () => {
  client.coupons.mockRejectedValue(new StaffAccessClientError("denied"));
  await render();
  await click(copy.en.load);
  expect(container.textContent).toContain(copy.en.loadFailed);
  expect(container.querySelector('[name="kind"]')).toBeNull();
});
it("coupon paging and locale changes preserve a dirty form", async () => {
  client.coupons
    .mockResolvedValueOnce({
      items: [{ id: "reward", name: "Coupon" }],
      nextCursor: "cursor",
    })
    .mockResolvedValueOnce({
      items: [{ id: "reward2", name: "Second" }],
      nextCursor: null,
    });
  await render();
  await click(copy.en.load);
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[name="kind"]')!;
    select.value = "points";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(copy.en.more);
  expect(client.coupons).toHaveBeenLastCalledWith({
    query: "",
    cursor: "cursor",
  });
  await render("ja");
  expect(
    container.querySelector<HTMLSelectElement>('[name="kind"]')!.value,
  ).toBe("points");
  expect(client.read).toHaveBeenCalledOnce();
});

it("narrows searched choices while preserving the selected coupon and dirty draft", async () => {
  client.coupons
    .mockResolvedValueOnce({
      items: [
        { id: "chosen", name: "Chosen" },
        { id: "old", name: "Old nonmatch" },
      ],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      items: [{ id: "new", name: "New match" }],
      nextCursor: null,
    });
  await render();
  await click(copy.en.load);
  const select = async (name: string, value: string) =>
    act(async () => {
      const item = container.querySelector<HTMLSelectElement>(
        `[name="${name}"]`,
      )!;
      item.value = value;
      item.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await select("kind", "coupon");
  await select("rewardDefinitionId", "chosen");
  await click(copy.en.find);
  const options = [
    ...container.querySelectorAll<HTMLSelectElement>(
      '[name="rewardDefinitionId"] option',
    ),
  ].map((item) => item.value);
  expect(options).toEqual(["", "chosen", "new"]);
  expect(
    container.querySelector<HTMLSelectElement>('[name="rewardDefinitionId"]')!
      .value,
  ).toBe("chosen");
  expect(client.read).toHaveBeenCalledOnce();
});

const savedPolicy = {
  policyId: "saved-policy",
  revision: 1,
  contentDigest: "c".repeat(64),
  draft: { kind: "none" as const },
  disclosureState: "available" as const,
  disclosure: {
    en: ["No incentive."],
    ja: ["特典なし。"],
    vi: ["Không có thưởng."],
  },
};
function ready() {
  client.read.mockResolvedValue({
    revision: 1,
    installationGeneration: "g1",
    activePolicy: null,
    latestPolicy: savedPolicy,
    mode: "legacy",
  });
  client.activate.mockResolvedValue({
    activationId: "activation",
    policyId: savedPolicy.policyId,
    revision: 1,
    effectiveAt: "2026-09-20T00:00:00.000Z",
  });
}
it.each(["en", "ja", "vi"] as const)(
  "confirms the exact saved promise explicitly in %s",
  async (locale) => {
    ready();
    await render(locale);
    await click(copy[locale].load);
    await click(activationCopy[locale].review);
    expect(container.textContent).toContain(savedPolicy.disclosure[locale][0]);
    expect(container.querySelector('[name="kind"]')).toBeNull();
    await click(activationCopy[locale].confirm);
    expect(client.activate).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
    );
    await click(activationCopy[locale].confirm);
    expect(client.activate).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 1,
      expectedInstallationGeneration: "g1",
      expectedActivePolicyId: null,
      policyId: "saved-policy",
      contentDigest: "c".repeat(64),
    });
    expect(container.textContent).toContain(activationCopy[locale].success);
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    client.read.mockResolvedValue({
      revision: 1,
      installationGeneration: "g1",
      activePolicy: savedPolicy,
      latestPolicy: savedPolicy,
      mode: "versioned",
    });
    await click(copy[locale].reload);
    expect(container.textContent).not.toContain(activationCopy[locale].review);
  },
);
it("blocks activation from dirty or newly saved-but-not-reloaded drafts", async () => {
  ready();
  await render();
  await click(copy.en.load);
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[name="kind"]')!;
    select.value = "points";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(activationCopy.en.review);
  expect(container.querySelector('[type="checkbox"]')).toBeNull();
  client.draft.mockResolvedValue({
    policyId: "new-policy",
    revision: 2,
    contentDigest: "d".repeat(64),
    activated: false,
  });
  await submit();
  await click(activationCopy.en.review);
  expect(container.querySelector('[type="checkbox"]')).toBeNull();
  expect(client.activate).not.toHaveBeenCalled();
});
it.each(["unavailable", "denied", "reauthenticate", "reload"] as const)(
  "requires a fresh read after activation result %s",
  async (code) => {
    ready();
    client.activate.mockRejectedValue(new StaffAccessClientError(code));
    await render();
    await click(copy.en.load);
    await click(activationCopy.en.review);
    await act(async () =>
      container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
    );
    await click(activationCopy.en.confirm);
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(client.activate).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain(activationCopy.en.cancel);
    expect(container.textContent).toContain(
      code === "unavailable"
        ? activationCopy.en.uncertain
        : code === "denied"
          ? copy.en.denied
          : code === "reauthenticate"
            ? copy.en.auth
            : copy.en.stale,
    );
    await click(copy.en.reload);
    expect(client.read).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[name="kind"]')).not.toBeNull();
  },
);
it("does not duplicate an in-flight activation or allow cancelling it", async () => {
  ready();
  let resolve!: (
    result: Awaited<ReturnType<Props["client"]["activate"]>>,
  ) => void;
  client.activate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click(copy.en.load);
  await click(activationCopy.en.review);
  await act(async () =>
    container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
  );
  await act(async () => {
    const form = container.querySelector("form")!;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(client.activate).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain(activationCopy.en.cancel);
  await click(copy.en.reload);
  expect(client.read).toHaveBeenCalledOnce();
  await act(async () =>
    resolve({
      activationId: "activation",
      policyId: "saved-policy",
      revision: 1,
      effectiveAt: "2026-09-20T00:00:00.000Z",
    }),
  );
});
it("allows cancelling before submission without a write", async () => {
  ready();
  await render();
  await click(copy.en.load);
  await click(activationCopy.en.review);
  await click(activationCopy.en.cancel);
  expect(document.activeElement?.textContent).toBe(copy.en.heading);
  expect(container.querySelector('[name="kind"]')).not.toBeNull();
  expect(client.activate).not.toHaveBeenCalled();
});
it.each(["generation", "active", "digest"] as const)(
  "rejects checked confirmation after changed %s props",
  async (change) => {
    ready();
    const initial = await client.read();
    const display = async (policy: typeof initial) =>
      act(async () =>
        root.render(
          <ReviewIncentiveActivation
            policy={policy}
            locale="en"
            activate={client.activate}
            cancel={vi.fn()}
            reload={vi.fn()}
          />,
        ),
      );
    await display(initial);
    expect(document.activeElement?.textContent).toBe(activationCopy.en.heading);
    await act(async () =>
      container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
    );
    await display({
      ...initial,
      ...(change === "generation"
        ? { installationGeneration: "g2" }
        : change === "active"
          ? { activePolicy: savedPolicy, mode: "versioned" as const }
          : {
              latestPolicy: { ...savedPolicy, contentDigest: "d".repeat(64) },
            }),
    });
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(client.activate).not.toHaveBeenCalled();
    expect(container.textContent).toContain(copy.en.stale);
  },
);

it.each([
  { kind: "coupon" as const, rewardDefinitionId: "old-coupon" },
  {
    kind: "points" as const,
    basePoints: "100",
    maxPoints: "110",
    photoBonusPoints: "10",
    videoBonusPoints: "0",
  },
])(
  "core keeps historical disclosure but cannot activate deferred draft $kind",
  async (draft) => {
    const existing = {
      ...savedPolicy,
      draft,
      disclosure: {
        en: ["Existing saved promise"],
        ja: ["既存の特典"],
        vi: ["Cam kết đã lưu"],
      },
    };
    client.read.mockResolvedValue({
      revision: 1,
      installationGeneration: "g1",
      activePolicy: existing,
      latestPolicy: { ...existing, policyId: "newer-policy" },
      mode: "legacy",
    });
    await render("en", true);
    await click(copy.en.load);
    expect(container.textContent).toContain("Existing saved promise");
    expect(container.textContent).not.toContain(activationCopy.en.review);
    expect(
      container.querySelector<HTMLSelectElement>('[name="kind"]')!.value,
    ).toBe("none");
    expect(client.draft).not.toHaveBeenCalled();
    expect(client.activate).not.toHaveBeenCalled();
  },
);
