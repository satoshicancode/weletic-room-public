// @vitest-environment jsdom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerAccountModules } from "../extensions/weletic-customer-account/src/CustomerAccountLoyalty";
import { CustomerAccountReviews } from "../extensions/weletic-customer-account/src/CustomerAccountReviews";
import {
  AccountReviewError,
  type ReviewTransport,
} from "../extensions/weletic-customer-account/src/reviews-client";
import { accountReviewCopy } from "../extensions/weletic-customer-account/src/reviews-copy";

const productId = "gid://shopify/Product/456";
const prepared = {
  productId,
  productTitle: "Product fixture",
  expectedInstallationGeneration: "private-generation",
  expectedSettingsRevision: 1,
  authorBinding: "a".repeat(64),
  disclosureRevision: "open_unverified_unrewarded_v1",
  verifiedPurchase: false,
  incentivized: false,
  photoUploadsAvailable: true,
};
afterEach(() => {
  act(() => render(null, document.body));
  vi.unstubAllGlobals();
});
async function mount(
  transport: ReviewTransport,
  language = "en",
  id: string | null = productId,
) {
  await act(async () => {
    render(
      h(CustomerAccountReviews, { productId: id, language, transport }),
      document.body,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}
function field(selector: string, value: string | boolean, event = "input") {
  const node = document.querySelector(selector)!;
  Object.assign(
    node,
    typeof value === "boolean" ? { checked: value } : { value },
  );
  act(() => {
    node.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
function fill() {
  field("s-select", "1", "change");
  field("s-text-field", "Reviewer");
  field("s-text-field + s-text-field", "Honest feedback");
  field("s-text-area", "This product did not meet my expectations.");
  field("s-checkbox", true, "change");
}
async function click() {
  await act(async () => {
    document.querySelector("s-button")!.dispatchEvent(new Event("click"));
  });
  await act(async () => {
    await Promise.resolve();
  });
}
async function waitForForm() {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector("s-select")).not.toBeNull();
  });
}

it.each(["en", "ja", "vi"] as const)(
  "renders %s disclosure with no private authority in markup",
  async (locale) => {
    await mount(async () => prepared, locale);
    expect(document.body.textContent).toContain(
      accountReviewCopy[locale].disclosure,
    );
    expect(document.body.textContent).toContain(
      accountReviewCopy[locale].photosPending,
    );
    expect(document.body.innerHTML).not.toContain(prepared.authorBinding);
    expect(document.body.innerHTML).not.toContain(
      prepared.expectedInstallationGeneration,
    );
  },
);
it("accepts negative feedback and clears content after a confirmed receipt", async () => {
  const transport = vi
    .fn<ReviewTransport>()
    .mockResolvedValueOnce(prepared)
    .mockResolvedValue({ status: "received", duplicate: false });
  await mount(transport);
  fill();
  await click();
  expect(transport.mock.calls[1][1]).toMatchObject({
    rating: 1,
    publishConsent: true,
    locale: "en",
    mediaIds: [],
  });
  expect(transport.mock.calls[1][1]).not.toHaveProperty("productTitle");
  expect(document.body.textContent).toContain(accountReviewCopy.en.received);
  expect(document.querySelector("s-text-area")).toBeNull();
});
it("rejects invalid content before dispatch", async () => {
  const transport = vi.fn<ReviewTransport>().mockResolvedValue(prepared);
  await mount(transport);
  await click();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain(
    accountReviewCopy.en.invalidInput,
  );
});
it("unlocks a definite pre-dispatch rejection without losing the shopper draft", async () => {
  const transport = vi
    .fn<ReviewTransport>()
    .mockResolvedValueOnce(prepared)
    .mockRejectedValueOnce(new AccountReviewError("invalidInput"))
    .mockResolvedValueOnce({ status: "received", duplicate: false });
  await mount(transport);
  fill();
  await click();
  expect(document.body.textContent).toContain(
    accountReviewCopy.en.invalidInput,
  );
  expect(document.querySelector("s-text-area")!.hasAttribute("disabled")).toBe(
    false,
  );
  await click();
  expect(transport.mock.calls[1][1].submissionId).not.toBe(
    transport.mock.calls[2][1].submissionId,
  );
  expect(transport.mock.calls[2][1].body).toBe(transport.mock.calls[1][1].body);
});
it("freezes fields after ambiguity and retries the exact original draft", async () => {
  const transport = vi
    .fn<ReviewTransport>()
    .mockResolvedValueOnce(prepared)
    .mockRejectedValueOnce(new Error("private provider detail"))
    .mockResolvedValue({ status: "received", duplicate: true });
  await mount(transport);
  fill();
  await click();
  expect(document.body.textContent).toContain(accountReviewCopy.en.uncertain);
  expect(document.body.textContent).not.toContain("private provider detail");
  expect(
    document.querySelector("s-text-area")!.getAttribute("disabled"),
  ).not.toBeNull();
  await click();
  expect(transport.mock.calls[1]).toEqual(transport.mock.calls[2]);
});
it("does not query for a missing product", async () => {
  const transport = vi.fn<ReviewTransport>();
  await mount(transport, "en", null);
  expect(transport).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    accountReviewCopy.en.selectProduct,
  );
});
it("clears a draft and publication consent before preparing another product", async () => {
  const second = "gid://shopify/Product/789";
  const transport = vi
    .fn<ReviewTransport>()
    .mockResolvedValueOnce(prepared)
    .mockResolvedValueOnce({ ...prepared, productId: second });
  await mount(transport);
  fill();
  await mount(transport, "en", second);
  await click();
  expect(transport).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain(
    accountReviewCopy.en.invalidInput,
  );
});
it("prepares the new destination after resolving the original in-flight submission", async () => {
  let finish!: (value: unknown) => void;
  const second = "gid://shopify/Product/789";
  const transport = vi
    .fn<ReviewTransport>()
    .mockResolvedValueOnce(prepared)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...prepared, productId: second });
  await mount(transport);
  fill();
  await click();
  await mount(transport, "en", second);
  await act(async () => {
    finish({ status: "received", duplicate: false });
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(transport.mock.calls[1][1].productId).toBe(productId);
  expect(transport.mock.calls[2]).toEqual([
    "open-prepare",
    { productId: second },
  ]);
  await waitForForm();
  await click();
  expect(transport).toHaveBeenCalledTimes(3);
  expect(document.body.textContent).toContain(
    accountReviewCopy.en.invalidInput,
  );
});
it("prepares the current product after a delayed definite rejection and clears old consent", async () => {
  let reject!: (reason: unknown) => void;
  const second = "gid://shopify/Product/789";
  const transport = vi
    .fn<ReviewTransport>()
    .mockResolvedValueOnce(prepared)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce({ ...prepared, productId: second });
  await mount(transport);
  fill();
  await click();
  await mount(transport, "en", second);
  await act(async () => {
    reject(new AccountReviewError("invalidInput"));
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.mock.calls[2]).toEqual([
      "open-prepare",
      { productId: second },
    ]);
  });
  await waitForForm();
  await click();
  expect(transport).toHaveBeenCalledTimes(3);
  expect(document.body.textContent).toContain(
    accountReviewCopy.en.invalidInput,
  );
});
it("releases the Reviews module lock after a delayed definite rejection on Loyalty home", async () => {
  let respond!: (response: Response) => void;
  const url = `extension://reviews?productId=${encodeURIComponent(productId)}`;
  const navigation = {
    currentEntry: { url },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("navigation", navigation);
  vi.stubGlobal("shopify", {
    sessionToken: { get: async () => "synthetic-session" },
    localization: { language: { value: { isoCode: "en" } } },
    i18n: { translate: (key: string) => key },
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(prepared))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValue(Response.json({}, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    render(h(CustomerAccountModules, {}), document.body);
  });
  await waitForForm();
  fill();
  await click();
  navigation.currentEntry.url = "extension://home";
  await act(async () => {
    navigation.addEventListener.mock.calls[0][1]();
  });
  // Exercise real transport classification; a raw fetch failure is ambiguous.
  await act(async () => {
    respond(
      Response.json(
        { error: { code: "invalid_review_input" } },
        { status: 400 },
      ),
    );
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector("s-page")?.getAttribute("heading")).toBe(
      "hub.hubTitle",
    );
  });
});
it("keeps an uncertain operation mounted across internal module navigation", async () => {
  const url = `extension://reviews?productId=${encodeURIComponent(productId)}`;
  const navigation = {
    currentEntry: { url },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("navigation", navigation);
  vi.stubGlobal("shopify", {
    sessionToken: { get: async () => "synthetic-session" },
    localization: { language: { value: { isoCode: "en" } } },
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(prepared))
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockResolvedValueOnce(
      Response.json({ status: "received", duplicate: true }),
    );
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    render(h(CustomerAccountModules, {}), document.body);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await waitForForm();
  fill();
  await click();
  const changed = navigation.addEventListener.mock.calls[0][1];
  navigation.currentEntry.url = "extension://reviews?view=store-reviews";
  await act(async () => {
    changed();
  });
  expect(document.body.textContent).toContain(accountReviewCopy.en.uncertain);
  navigation.currentEntry.url = "extension://home";
  await act(async () => {
    changed();
  });
  expect(document.body.textContent).toContain(accountReviewCopy.en.uncertain);
  navigation.currentEntry.url = url;
  await act(async () => {
    changed();
  });
  await click();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[2][1]?.body);
});
it("ignores stale preparation after product navigation", async () => {
  let finish!: (value: unknown) => void;
  const transport = vi
    .fn<ReviewTransport>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("unavailable"));
  await mount(transport);
  await mount(transport, "en", "gid://shopify/Product/789");
  await act(async () => {
    finish(prepared);
  });
  expect(document.body.textContent).toContain(accountReviewCopy.en.unavailable);
  expect(document.querySelector("s-button")).toBeNull();
});
it("renders Reviews without contacting Loyalty", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(prepared));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("navigation", {
    currentEntry: {
      url: `https://account.example.test?productId=${encodeURIComponent(productId)}`,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("shopify", {
    sessionToken: { get: async () => "synthetic-session" },
    localization: { language: { value: { isoCode: "en" } } },
  });
  await act(async () => {
    render(h(CustomerAccountModules, {}), document.body);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://shopify.weletic.com/api/customer-account/reviews/open-prepare",
  );
  expect(document.body.innerHTML).not.toContain("synthetic-session");
});
