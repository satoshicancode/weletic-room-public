// @vitest-environment jsdom
import { AppProvider } from "@shopify/polaris";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewTranslationForm } from "../app/components/ReviewTranslationForm";
import { ReviewTranslationsPanel } from "../app/components/ReviewTranslationsPanel";
import { merchantPolarisTranslations } from "../app/merchant-polaris-translations";
import { createMerchantReviewTranslationsClient } from "../app/merchant-review-translations-client";
import { reviewTranslationCopy } from "../app/review-translation-copy";
import { StaffAccessClientError } from "../app/staff-access-client";

vi.hoisted(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  });
});

type Props = React.ComponentProps<typeof ReviewTranslationForm>;
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const page: Props["page"] = {
  reviewId: "review_private",
  installationGeneration: "generation_private",
  reviewVersion: 4,
  original: {
    title: "Original <script>alert(1)</script>",
    body: "Original content",
    status: "published",
  },
  translations: [
    {
      locale: "en",
      revision: 2,
      status: "active",
      sourceLocale: "ja",
      title: "Translation",
      body: "Translated content",
    },
  ],
};
let root: Root;
let container: HTMLDivElement;
const save = vi.fn<Props["save"]>();
const reload = vi.fn<Props["reload"]>();
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
async function render(extra: Partial<Props> = {}) {
  const locale = extra.locale ?? "en";
  await act(async () =>
    root.render(
      React.createElement(
        AppProvider,
        { i18n: merchantPolarisTranslations[locale] },
        React.createElement(ReviewTranslationForm, {
          snapshotKey: "read_1",
          page,
          locale,
          disabled: false,
          save,
          reload,
          ...extra,
        }),
      ),
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
it.each(["en", "ja", "vi"] as const)(
  "renders labelled %s controls without private identifiers or raw HTML",
  async (locale) => {
    await render({ locale });
    expect(container.textContent).toContain(
      reviewTranslationCopy[locale].heading,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("generation_private");
    expect(container.innerHTML).not.toContain("review_private");
    for (const element of container.querySelectorAll("input,textarea,select"))
      expect(
        container.querySelector(`label[for="${element.id}"]`),
      ).not.toBeNull();
  },
);
it("fences duplicate pending and confirmed submissions", async () => {
  let resolve!: () => void;
  save.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await render();
  await submit();
  await submit();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({
    action: "save",
    reviewId: page.reviewId,
    locale: "en",
    sourceLocale: "ja",
    title: "Translation",
    body: "Translated content",
    expectedReviewVersion: 4,
    expectedTranslationRevision: 2,
    expectedInstallationGeneration: page.installationGeneration,
  });
  await act(async () => resolve());
  await submit();
  expect(save).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(reviewTranslationCopy.en.saved);
});
it("locks an ambiguous result without automatic retry or raw error disclosure", async () => {
  save.mockRejectedValue(new Error("private provider details"));
  await render();
  await submit();
  await submit();
  expect(save).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(reviewTranslationCopy.en.uncertain);
  expect(container.textContent).not.toContain("private provider details");
});
it.each(["redacted", "disabled"] as const)(
  "blocks edits when %s",
  async (condition) => {
    await render({
      disabled: condition === "disabled",
      page:
        condition === "redacted"
          ? {
              ...page,
              translations: [
                {
                  ...page.translations[0],
                  status: "redacted",
                  title: null,
                  body: null,
                },
              ],
            }
          : page,
    });
    await submit();
    expect(save).not.toHaveBeenCalled();
  },
);
it("sends removal with revision identity but no translated text", async () => {
  await render();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === reviewTranslationCopy.en.remove)!
      .click();
  });
  expect(save).toHaveBeenCalledWith({
    action: "remove",
    reviewId: page.reviewId,
    locale: "en",
    expectedReviewVersion: 4,
    expectedTranslationRevision: 2,
    expectedInstallationGeneration: page.installationGeneration,
  });
});

it("requires a fresh read snapshot to unlock after an uncertain save", async () => {
  save.mockRejectedValueOnce(new Error("unknown"));
  await render();
  await submit();
  await render({ locale: "ja" });
  await submit();
  expect(save).toHaveBeenCalledTimes(1);
  await render({ snapshotKey: "read_2" });
  await submit();
  expect(save).toHaveBeenCalledTimes(2);
});

it("preserves unsaved text when switching target locales and returning", async () => {
  await render();
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Unsaved translation");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const locale of ["vi", "en"]) {
    await act(async () => {
      const target = container.querySelector("select")!;
      target.value = locale;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(
    "Unsaved translation",
  );
  await submit();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Unsaved translation", locale: "en" }),
  );
});

it("remounts source identity without reusing the prior review's translated text", async () => {
  await render();
  await render({
    page: {
      ...page,
      reviewId: "review_other",
      reviewVersion: 1,
      translations: [],
    },
  });
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
    "",
  );
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain(reviewTranslationCopy.en.invalid);
});

async function clickLabel(label: string) {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  });
}
async function editTitle(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("requires explicit discard permission for a draft in a different locale", async () => {
  await render();
  await editTitle("Keep this English draft");
  await act(async () => {
    const target = container.querySelector("select")!;
    target.value = "vi";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await clickLabel(reviewTranslationCopy.en.reload);
  expect(reload).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    reviewTranslationCopy.en.discardWarning,
  );
  await clickLabel(reviewTranslationCopy.en.keepDrafts);
  expect(reload).not.toHaveBeenCalled();
  await clickLabel(reviewTranslationCopy.en.reload);
  await clickLabel(reviewTranslationCopy.en.discardReload);
  expect(reload).toHaveBeenCalledTimes(1);
});
it("keeps drafts if an approved reload fails and does not disclose errors", async () => {
  reload.mockRejectedValue(new Error("private auth details"));
  await render();
  await editTitle("Unsaved title");
  await clickLabel(reviewTranslationCopy.en.reload);
  await clickLabel(reviewTranslationCopy.en.discardReload);
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe(
    "Unsaved title",
  );
  expect(container.textContent).toContain(
    reviewTranslationCopy.en.reloadFailed,
  );
  expect(container.textContent).not.toContain("private auth details");
});
it("reloads a clean snapshot without a discard prompt", async () => {
  await render();
  await clickLabel(reviewTranslationCopy.en.reload);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain(
    reviewTranslationCopy.en.discardWarning,
  );
});
it("prevents reload while a save is pending", async () => {
  let finish!: () => void;
  save.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await submit();
  await clickLabel(reviewTranslationCopy.en.reload);
  expect(reload).not.toHaveBeenCalled();
  await act(async () => finish());
});
it("prevents same-batch submit then reload before React updates state", async () => {
  let finish!: () => void;
  save.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === reviewTranslationCopy.en.reload)!
      .click();
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  await act(async () => finish());
});

async function renderPanel(
  client: React.ComponentProps<typeof ReviewTranslationsPanel>["client"],
  reviewId = page.reviewId,
) {
  await act(async () =>
    root.render(
      React.createElement(
        AppProvider,
        { i18n: merchantPolarisTranslations.en },
        React.createElement(ReviewTranslationsPanel, {
          reviewId,
          client,
          locale: "en",
        }),
      ),
    ),
  );
}
it("panel loads only explicitly and does not refresh after a save", async () => {
  const client = {
    read: vi.fn().mockResolvedValue(page),
    save: vi.fn().mockResolvedValue({}),
  };
  await renderPanel(client);
  expect(client.read).not.toHaveBeenCalled();
  await clickLabel(reviewTranslationCopy.en.load);
  expect(container.querySelector("form")).not.toBeNull();
  await submit();
  expect(client.save).toHaveBeenCalledTimes(1);
  expect(client.read).toHaveBeenCalledTimes(1);
});
it("panel clears private content on denied write instead of retaining editor drafts", async () => {
  const client = {
    read: vi.fn().mockResolvedValue(page),
    save: vi.fn().mockRejectedValue(new StaffAccessClientError("denied")),
  };
  await renderPanel(client);
  await clickLabel(reviewTranslationCopy.en.load);
  await submit();
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).not.toContain(page.original.body);
  expect(container.textContent).toContain(
    reviewTranslationCopy.en.accessChanged,
  );
});
it("panel ignores a late read from a replaced authenticated client", async () => {
  let finish!: (result: typeof page) => void;
  const previous = {
    read: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    save: vi.fn(),
  };
  const next = { read: vi.fn().mockResolvedValue(page), save: vi.fn() };
  await renderPanel(previous);
  await clickLabel(reviewTranslationCopy.en.load);
  await renderPanel(next);
  await act(async () => finish(page));
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).not.toContain(page.original.body);
  await clickLabel(reviewTranslationCopy.en.load);
  expect(container.querySelector("form")).not.toBeNull();
});
it("panel clears the previous review on target change", async () => {
  const client = { read: vi.fn().mockResolvedValue(page), save: vi.fn() };
  await renderPanel(client);
  await clickLabel(reviewTranslationCopy.en.load);
  await renderPanel(client, "another-review");
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).not.toContain(page.original.body);
  expect(client.read).toHaveBeenCalledTimes(1);
});
it.each([404, 410])(
  "clears loaded private text when reload reports definitive %s",
  async (status) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(new Response("", { status }));
    const client = createMerchantReviewTranslationsClient(
      async () => "test-token",
      transport,
    );
    await renderPanel(client);
    await clickLabel(reviewTranslationCopy.en.load);
    expect(container.textContent).toContain(page.original.body);
    await clickLabel(reviewTranslationCopy.en.reload);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain(page.original.body);
    expect(container.textContent).toContain(
      reviewTranslationCopy.en.accessChanged,
    );
  },
);
