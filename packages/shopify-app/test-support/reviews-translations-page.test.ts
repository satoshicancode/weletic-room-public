// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { merchantReviewsCopy } from "../app/merchant-reviews-copy";
import { reviewTranslationCopy } from "../app/review-translation-copy";
import ReviewsPage from "../app/routes/reviews";
import { StaffAccessClientError } from "../app/staff-access-client";

const mocks = vi.hoisted(() => {
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
  return {
    bridge: { idToken: async () => "synthetic" },
    list: vi.fn(),
    read: vi.fn(),
    save: vi.fn(),
    moderate: vi.fn(),
  };
});
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => mocks.bridge,
}));
vi.mock("@remix-run/react", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
  }) => React.createElement("a", { href: to, ...props }, children),
  useRouteError: () => null,
}));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("@shopify/shopify-app-remix/server", () => ({
  boundary: { headers: () => ({}), error: () => null },
}));
vi.mock("../app/merchant-reviews-client", () => ({
  createMerchantReviewsClient: () => mocks.list,
}));
vi.mock("../app/merchant-review-translations-client", () => ({
  createMerchantReviewTranslationsClient: () => ({
    read: mocks.read,
    save: mocks.save,
  }),
}));
vi.mock("../app/merchant-review-moderation-client", () => ({
  createMerchantReviewModerationClient: () => mocks.moderate,
}));
vi.mock("../app/merchant-review-incentives-client", () => ({
  createMerchantReviewIncentivesClient: () => ({}),
}));
vi.mock("../app/components/ReviewIncentivesPanel", () => ({
  ReviewIncentivesPanel: () => null,
}));
// Keep translation UI real; the existing moderation form has separate tests.
vi.mock("../app/components/ReviewModerationForm", () => ({
  ReviewModerationForm: ({
    disabled,
    save,
  }: {
    disabled: boolean;
    save: (input: unknown) => Promise<void>;
  }) =>
    React.createElement(
      "button",
      { disabled, onClick: () => void save({ fixture: true }) },
      "Moderate fixture",
    ),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const row = {
  id: "private-review",
  version: 1,
  status: "published",
  rating: 2,
  title: "Original",
  body: "Original review",
  displayName: "Shopper",
  createdAt: "2026-09-20T00:00:00.000Z",
  product: { title: "Product", externalId: "private-product" },
  merchantReply: null,
  verifiedPurchase: true,
  incentivized: false,
  rewardStatus: "ineligible",
  photoCount: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({
    view: "reviews",
    items: [row],
    nextCursor: "next",
  });
  mocks.read.mockResolvedValue({
    reviewId: row.id,
    installationGeneration: "private-generation",
    reviewVersion: 1,
    original: { title: row.title, body: row.body, status: "published" },
    translations: [
      {
        locale: "en",
        revision: 1,
        status: "active",
        sourceLocale: "ja",
        title: "English",
        body: "English review",
      },
    ],
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
const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  if (!found) throw new Error("Missing button: " + text);
  return found;
};
async function render() {
  await act(async () => root.render(React.createElement(ReviewsPage)));
}
it("saving one locale leaves another locale's draft protected", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  mocks.save.mockResolvedValue({});
  await render();
  await act(async () => button(reviewTranslationCopy.en.load).click());
  const edit = async (selector: string, value: string) => {
    await act(async () => {
      const field = container.querySelector("form")!.querySelector(selector)!;
      const prototype =
        selector === "textarea"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await edit("input", "Unsaved English");
  await act(async () => {
    const select = container.querySelector("form")!.querySelector("select")!;
    select.value = "ja";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await edit("input", "日本語");
  await edit("textarea", "日本語のレビュー");
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(reviewTranslationCopy.en.saved);
  await act(async () => button(merchantReviewsCopy.en.reload).click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});
it.each(["en", "ja", "vi"] as const)(
  "mounts the real %s translation editor without DOM identifiers",
  async (locale) => {
    await render();
    if (locale !== "en") {
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = locale;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    expect(mocks.read).not.toHaveBeenCalled();
    await act(async () => button(reviewTranslationCopy[locale].load).click());
    expect(container.textContent).toContain(
      reviewTranslationCopy[locale].heading,
    );
    expect(container.textContent).toContain("English review");
    expect(container.innerHTML).not.toContain("private-review");
    expect(container.innerHTML).not.toContain("private-generation");
    expect(container.innerHTML).not.toContain("private-product");
  },
);
it("does not mount translations for privacy-redacted reviews", async () => {
  mocks.list.mockResolvedValue({
    view: "reviews",
    items: [{ ...row, status: "redacted" }],
    nextCursor: null,
  });
  await render();
  expect(container.textContent).not.toContain(reviewTranslationCopy.en.load);
  expect(mocks.read).not.toHaveBeenCalled();
});
it("holds list navigation and moderation while a translation save is unresolved", async () => {
  let resolve!: (value: unknown) => void;
  mocks.save.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await act(async () => button(reviewTranslationCopy.en.load).click());
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(
    button(merchantReviewsCopy.en.reload).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    button(merchantReviewsCopy.en.next).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(button("Moderate fixture").disabled).toBe(true);
  const link = container.querySelector("a")!;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    link.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(mocks.moderate).not.toHaveBeenCalled();
  await act(async () => resolve({}));
  expect(
    button(merchantReviewsCopy.en.reload).getAttribute("aria-disabled"),
  ).not.toBe("true");
  expect(container.textContent).toContain(reviewTranslationCopy.en.saved);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
it("asks before list reload discards an unsaved translation and respects cancellation", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await render();
  await act(async () => button(reviewTranslationCopy.en.load).click());
  await act(async () => {
    const field = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, "Unsaved draft");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(merchantReviewsCopy.en.reload).click());
  expect(confirm).toHaveBeenCalledWith(reviewTranslationCopy.en.discardPage);
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(container.querySelector("input")!.value).toBe("Unsaved draft");
  confirm.mockReturnValue(true);
  await act(async () => button(merchantReviewsCopy.en.reload).click());
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(container.querySelector("form")).toBeNull();
});
it.each(["read", "save"] as const)(
  "clears the enclosing private review after definitive %s access loss",
  async (operation) => {
    await render();
    if (operation === "save") {
      await act(async () => button(reviewTranslationCopy.en.load).click());
      mocks.save.mockRejectedValue(new StaffAccessClientError("denied"));
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
    } else {
      mocks.read.mockRejectedValue(new StaffAccessClientError("denied"));
      await act(async () => button(reviewTranslationCopy.en.load).click());
    }
    expect(container.textContent).not.toContain("Original review");
    expect(container.textContent).not.toContain("Shopper");
    expect(container.textContent).not.toContain("English review");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain(merchantReviewsCopy.en.denied);
  },
);
it.each(["next", "filter", "moderate", "home"] as const)(
  "preserves dirty translations when cancelling %s",
  async (operation) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    await act(async () => button(reviewTranslationCopy.en.load).click());
    await act(async () => {
      const field = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, "Keep draft");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      if (operation === "next") button(merchantReviewsCopy.en.next).click();
      if (operation === "moderate") button("Moderate fixture").click();
      if (operation === "filter") {
        const select = container.querySelectorAll("select")[1];
        select.value = "requests";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (operation === "home") {
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        });
        container.querySelector("a")!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")!.value).toBe("Keep draft");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.moderate).not.toHaveBeenCalled();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  },
);
