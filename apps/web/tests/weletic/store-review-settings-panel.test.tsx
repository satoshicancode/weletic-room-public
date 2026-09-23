// @vitest-environment jsdom
import { defaultStoreReviewSettingsPolicy } from "@/lib/weletic/reviews/store-settings-contract";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoreReviewSettingsPanel } from "../../../../packages/shopify-app/app/components/StoreReviewSettingsPanel";
import { storeReviewSettingsCopy } from "../../../../packages/shopify-app/app/store-review-settings-copy";

type Props = React.ComponentProps<typeof StoreReviewSettingsPanel>;
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const settings = {
  revision: 0,
  installationGeneration: "generation-a",
  productReviewsEnabled: true,
  policy: defaultStoreReviewSettingsPolicy(),
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(client: Props["client"]) {
  await act(async () =>
    root.render(<StoreReviewSettingsPanel client={client} locale="en" />),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
it("clears old identity state and ignores a late old-client load", async () => {
  let oldFinish!: (value: typeof settings) => void;
  let newFinish!: (value: typeof settings) => void;
  const oldClient = {
    read: vi.fn().mockReturnValue(
      new Promise((resolve) => {
        oldFinish = resolve;
      }),
    ),
    write: vi.fn(),
  } as unknown as Props["client"];
  const newClient = {
    read: vi.fn().mockReturnValue(
      new Promise((resolve) => {
        newFinish = resolve;
      }),
    ),
    write: vi.fn(),
  } as unknown as Props["client"];
  await render(oldClient);
  await click(storeReviewSettingsCopy.en.load);
  await render(newClient);
  await click(storeReviewSettingsCopy.en.load);
  await act(async () => oldFinish(settings));
  expect(container.querySelector("form")).toBeNull();
  await act(async () =>
    newFinish({ ...settings, installationGeneration: "generation-b" }),
  );
  expect(container.querySelector("form")).not.toBeNull();
  expect(container.textContent).toContain(storeReviewSettingsCopy.en.save);
});
it("requires explicit confirmation and reloads after an uncertain save", async () => {
  const client = {
    read: vi.fn().mockResolvedValue(settings),
    write: vi.fn().mockRejectedValue(new Error("lost acknowledgement")),
  } as unknown as Props["client"];
  await render(client);
  await click(storeReviewSettingsCopy.en.load);
  const form = container.querySelector("form")!;
  expect(
    form.querySelector('button[type="submit"]')?.hasAttribute("disabled"),
  ).toBe(true);
  await act(async () =>
    (form.querySelector('input[id$="-confirm"]') as HTMLInputElement).click(),
  );
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(client.write).toHaveBeenCalledOnce();
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain(storeReviewSettingsCopy.en.uncertain);
  await click(storeReviewSettingsCopy.en.load);
  expect(container.querySelector("form")).not.toBeNull();
});
it("allows disabling store reviews after parent Reviews is disabled", async () => {
  const active = {
    ...settings,
    revision: 2,
    productReviewsEnabled: false,
    policy: { ...settings.policy, enabled: true },
  };
  const client = {
    read: vi.fn().mockResolvedValue(active),
    write: vi.fn().mockResolvedValue({
      ...active,
      revision: 3,
      policy: { ...active.policy, enabled: false },
    }),
  } as unknown as Props["client"];
  await render(client);
  await click(storeReviewSettingsCopy.en.load);
  const enabled = container.querySelector(
    'input[id$="-enabled"]',
  ) as HTMLInputElement;
  expect(enabled.disabled).toBe(false);
  await act(async () => enabled.click());
  await act(async () =>
    (
      container.querySelector('input[id$="-confirm"]') as HTMLInputElement
    ).click(),
  );
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(client.write).toHaveBeenCalledWith(
    expect.objectContaining({
      policy: expect.objectContaining({ enabled: false }),
    }),
  );
});
it("rejects a blank delay instead of treating it as immediate delivery", async () => {
  const client = {
    read: vi.fn().mockResolvedValue(settings),
    write: vi.fn(),
  } as unknown as Props["client"];
  await render(client);
  await click(storeReviewSettingsCopy.en.load);
  const delay = container.querySelector(
    'input[id$="-send"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(delay, "");
    delay.dispatchEvent(new Event("input", { bubbles: true }));
    delay.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    (
      container.querySelector('input[id$="-confirm"]') as HTMLInputElement
    ).click(),
  );
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(client.write).not.toHaveBeenCalled();
  expect(container.textContent).toContain(storeReviewSettingsCopy.en.invalid);
});
