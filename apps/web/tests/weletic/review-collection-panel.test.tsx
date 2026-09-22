// @vitest-environment jsdom
import { defaultReviewCollectionPolicy } from "@/lib/weletic/reviews/collection-contract";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewCollectionPanel } from "../../../../packages/shopify-app/app/components/ReviewCollectionPanel";
import { reviewCollectionCopy as copy } from "../../../../packages/shopify-app/app/review-collection-copy";
import { StaffAccessClientError } from "../../../../packages/shopify-app/app/staff-access-client";
type Props = React.ComponentProps<typeof ReviewCollectionPanel>;
const client = {
  read: vi.fn<Props["client"]["read"]>(),
  write: vi.fn<Props["client"]["write"]>(),
};
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const settings = {
  revision: 2,
  installationGeneration: "g1",
  moduleEnabled: false,
  policy: defaultReviewCollectionPolicy(),
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  client.read.mockResolvedValue(settings);
  client.write.mockResolvedValue({ ...settings, revision: 3 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(locale: Props["locale"] = "en") {
  await act(async () =>
    root.render(
      <React.StrictMode>
        <ReviewCollectionPanel client={client} locale={locale} />
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
async function confirm() {
  await act(async () =>
    (
      container.querySelector('input[id$="-confirm"]') as HTMLInputElement
    ).click(),
  );
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
it.each(["en", "ja", "vi"] as const)(
  "loads explicitly with labelled controls and no private identity in %s",
  async (locale) => {
    await render(locale);
    expect(client.read).not.toHaveBeenCalled();
    await click(copy[locale].load);
    expect(container.textContent).toContain(copy[locale].disabled);
    for (const input of container.querySelectorAll("input"))
      expect(
        container.querySelector(`label[for="${input.id}"]`),
      ).not.toBeNull();
    expect(container.innerHTML).not.toContain("g1");
    expect(container.innerHTML).not.toContain("expectedRevision");
    expect(client.write).not.toHaveBeenCalled();
  },
);
it("requires confirmation and sends saved revision/generation without module activation", async () => {
  await render();
  await click(copy.en.load);
  await submit();
  expect(client.write).not.toHaveBeenCalled();
  await confirm();
  await submit();
  expect(client.write).toHaveBeenCalledWith({
    expectedRevision: 2,
    expectedInstallationGeneration: "g1",
    policy: settings.policy,
  });
  expect(container.textContent).toContain(copy.en.saved);
  expect(document.activeElement?.getAttribute("role")).toBe("status");
});
it("requires explicit reload after an ambiguous write and does not repeat it", async () => {
  client.write.mockRejectedValue(new StaffAccessClientError("unavailable"));
  await render();
  await click(copy.en.load);
  await confirm();
  await submit();
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  await submit();
  expect(client.write).toHaveBeenCalledOnce();
  await click(copy.en.reload);
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(container.querySelector("fieldset")!.disabled).toBe(false);
});
it("shows denied state without a configuration form", async () => {
  client.read.mockRejectedValue(new StaffAccessClientError("denied"));
  await render();
  await click(copy.en.load);
  expect(container.textContent).toContain(copy.en.denied);
  expect(container.querySelector("form")).toBeNull();
});
it("contains duplicate submission while a write is in flight", async () => {
  let finish!: (value: typeof settings) => void;
  client.write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await click(copy.en.load);
  await confirm();
  await submit();
  await submit();
  expect(client.write).toHaveBeenCalledOnce();
  await act(async () => finish({ ...settings, revision: 3 }));
});
it("discards confirmed drafts when the authenticated client changes", async () => {
  await render();
  await click(copy.en.load);
  await confirm();
  const replacement = {
    read: vi
      .fn()
      .mockResolvedValue({ ...settings, installationGeneration: "g2" }),
    write: vi.fn(),
  };
  await act(async () =>
    root.render(
      <React.StrictMode>
        <ReviewCollectionPanel client={replacement} locale="en" />
      </React.StrictMode>,
    ),
  );
  expect(container.querySelector("form")).toBeNull();
  await click(copy.en.load);
  await submit();
  expect(replacement.write).not.toHaveBeenCalled();
});
it("ignores a late old-client response without unlocking the replacement request", async () => {
  let oldFinish!: (value: typeof settings) => void;
  let newFinish!: (value: typeof settings) => void;
  client.read.mockReturnValue(
    new Promise((resolve) => {
      oldFinish = resolve;
    }),
  );
  await render();
  await click(copy.en.load);
  const replacement = {
    read: vi.fn().mockReturnValue(
      new Promise((resolve) => {
        newFinish = resolve;
      }),
    ),
    write: vi.fn(),
  };
  await act(async () =>
    root.render(
      <React.StrictMode>
        <ReviewCollectionPanel client={replacement} locale="en" />
      </React.StrictMode>,
    ),
  );
  await click(copy.en.load);
  await act(async () => oldFinish(settings));
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain(copy.en.loading);
  expect(container.querySelector("button")!.disabled).toBe(true);
  await act(async () =>
    newFinish({ ...settings, installationGeneration: "g2" }),
  );
  expect(container.querySelector("form")).not.toBeNull();
});
it("preserves a loaded draft and confirmation on locale-only changes", async () => {
  await render();
  await click(copy.en.load);
  await confirm();
  await render("ja");
  expect(
    (container.querySelector('input[id$="-confirm"]') as HTMLInputElement)
      .checked,
  ).toBe(true);
  await submit();
  expect(client.write).toHaveBeenCalledOnce();
  expect(client.read).toHaveBeenCalledOnce();
});
