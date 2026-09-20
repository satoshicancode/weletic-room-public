// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenReviewPolicyPanel } from "../../../../packages/shopify-app/app/components/OpenReviewPolicyPanel";
import { openReviewPolicyCopy as copy } from "../../../../packages/shopify-app/app/open-review-policy-copy";
type Props = React.ComponentProps<typeof OpenReviewPolicyPanel>;
const client = {
  read: vi.fn<Props["client"]["read"]>(),
  save: vi.fn<Props["client"]["save"]>(),
};
const view = {
  revision: 2,
  installationGeneration: "private-generation",
  policy: {
    enabled: false,
    photoUploadsEnabled: false,
    maxSubmissionsPer24Hours: 3,
  },
  requiresReauthorization: false,
  policyEnabledForInstallation: false,
};
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  client.read.mockResolvedValue(view);
  client.save.mockResolvedValue({ revision: 3, policy: view.policy });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  locale: Props["locale"] = "en",
  source = client,
  guards: Pick<Props, "acquireOperation" | "onDirtyChange"> = {},
) {
  await act(async () =>
    root.render(
      <React.StrictMode>
        <OpenReviewPolicyPanel client={source} locale={locale} {...guards} />
      </React.StrictMode>,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
it.each(["en", "ja", "vi"] as const)(
  "loads and saves explicitly in %s without rendering internal identity",
  async (locale) => {
    await render(locale);
    expect(client.read).not.toHaveBeenCalled();
    await click(copy[locale].load);
    await click(copy[locale].save);
    expect(client.save).toHaveBeenCalledExactlyOnceWith({
      expectedInstallationGeneration: view.installationGeneration,
      expectedRevision: 2,
      policy: view.policy,
    });
    expect(container.textContent).toContain(copy[locale].saved);
    expect(container.innerHTML).not.toContain("private-generation");
  },
);
it("reports drafts to the page and respects exclusive page operation ownership", async () => {
  const dirty = vi.fn();
  const release = vi.fn();
  const acquire = vi
    .fn<NonNullable<Props["acquireOperation"]>>()
    .mockReturnValue(null);
  await render("en", client, {
    onDirtyChange: dirty,
    acquireOperation: acquire,
  });
  await click(copy.en.load);
  expect(client.read).not.toHaveBeenCalled();
  acquire.mockReturnValue(release);
  await click(copy.en.load);
  expect(release).toHaveBeenCalledTimes(1);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  expect(dirty).toHaveBeenLastCalledWith(true);
  await click(copy.en.reload);
  await click(copy.en.confirm);
  expect(dirty).toHaveBeenLastCalledWith(false);
  expect(release).toHaveBeenCalledTimes(2);
});
it("keeps settings and touch targets separated in narrow merchant cards", async () => {
  await render();
  await click(copy.en.load);
  expect(container.querySelector("section")!.style.display).toBe("grid");
  expect(container.querySelector("fieldset")!.style.minWidth).toBe("0");
  for (const label of container.querySelectorAll("label:has(input)")) {
    expect((label as HTMLElement).style.display).toBe("flex");
    expect((label as HTMLElement).style.minHeight).toBe("44px");
  }
  for (const button of container.querySelectorAll("button")) {
    expect(button.style.minHeight).toBe("44px");
  }
  expect(
    container.querySelector<HTMLInputElement>('input[type="number"]')!.style
      .minHeight,
  ).toBe("44px");
});
it("holds the page operation until an uncertain save settles", async () => {
  const release = vi.fn();
  const acquire = vi.fn().mockReturnValue(release);
  let reject!: (reason: Error) => void;
  await render("en", client, { acquireOperation: acquire });
  await click(copy.en.load);
  release.mockClear();
  client.save.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await submit();
  expect(release).not.toHaveBeenCalled();
  await act(async () => reject(new Error("uncertain")));
  expect(release).toHaveBeenCalledTimes(1);
});
it("requires confirmation before discarding a dirty draft", async () => {
  await render();
  await click(copy.en.load);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await click(copy.en.reload);
  expect(client.read).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(copy.en.discard);
  await click(copy.en.cancel);
  expect(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .checked,
  ).toBe(true);
  await click(copy.en.reload);
  await click(copy.en.confirm);
  expect(client.read).toHaveBeenCalledTimes(2);
});
it("blocks simultaneous submissions and does not retry an ambiguous save", async () => {
  let reject!: (reason: Error) => void;
  client.save.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await render();
  await click(copy.en.load);
  await submit();
  await submit();
  expect(client.save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("uncertain")));
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain(copy.en.error);
  await click(copy.en.load);
  expect(container.querySelector("form")).not.toBeNull();
});
it("ignores an old client response after the authenticated client changes", async () => {
  let resolve!: (value: typeof view) => void;
  client.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click(copy.en.load);
  const next = { read: vi.fn().mockResolvedValue(view), save: vi.fn() };
  await render("en", next);
  await act(async () => resolve(view));
  expect(container.querySelector("form")).toBeNull();
  await click(copy.en.load);
  expect(next.read).toHaveBeenCalledTimes(1);
});
