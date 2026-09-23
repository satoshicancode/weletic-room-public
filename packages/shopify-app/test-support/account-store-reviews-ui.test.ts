// @vitest-environment jsdom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerAccountStoreReviews } from "../extensions/weletic-customer-account/src/CustomerAccountStoreReviews";
import type { AccountStoreReviewTransport } from "../extensions/weletic-customer-account/src/store-reviews-client";
import { accountStoreReviewCopy } from "../extensions/weletic-customer-account/src/store-reviews-copy";

const item = {
  requestId: `wstorereq_${"a".repeat(20)}`,
  orderExternalId: "1045",
  fulfilledAt: "2026-09-20T00:00:00.000Z",
  expiresAt: "2040-10-20T00:00:00.000Z",
  incentiveDisclosure: null,
};
afterEach(() => {
  act(() => render(null, document.body));
});
async function mount(transport: AccountStoreReviewTransport, language = "en") {
  await act(async () => {
    render(
      h(CustomerAccountStoreReviews, { language, transport }),
      document.body,
    );
  });
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("1045");
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("s-button")].find(
    (node) => node.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new Event("click"));
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
  field("s-text-field", "Buyer");
  field("s-text-field + s-text-field", "Honest feedback");
  field("s-text-area", "The store could improve.");
  field("s-checkbox", true, "change");
}

it.each(["en", "ja", "vi"] as const)(
  "shows %s invitation disclosure without exposing private identity",
  async (locale) => {
    const transport: AccountStoreReviewTransport = {
      list: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
      submit: vi.fn(),
    };
    await mount(transport, locale);
    expect(document.body.textContent).toContain(
      accountStoreReviewCopy[locale].intro,
    );
    await click(accountStoreReviewCopy[locale].choose);
    expect(document.body.textContent).toContain(
      accountStoreReviewCopy[locale].noReward,
    );
    expect(document.body.innerHTML).not.toContain("shopperId");
    expect(document.body.innerHTML).not.toContain("buyer@example.test");
  },
);

it("accepts critical feedback and clears the draft after a confirmed receipt", async () => {
  const transport: AccountStoreReviewTransport = {
    list: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
    submit: vi.fn().mockResolvedValue({ status: "received", duplicate: false }),
  };
  await mount(transport);
  await click(accountStoreReviewCopy.en.choose);
  fill();
  await click(accountStoreReviewCopy.en.submit);
  expect(transport.submit).toHaveBeenCalledWith(
    expect.objectContaining({ rating: 1, requestId: item.requestId }),
  );
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      accountStoreReviewCopy.en.received,
    ),
  );
  expect(document.body.textContent).toContain(
    accountStoreReviewCopy.en.received,
  );
  expect(document.querySelector("s-text-area")).toBeNull();
});

it("allows another invitation after a confirmed receipt", async () => {
  const second = {
    ...item,
    requestId: `wstorereq_${"b".repeat(20)}`,
    orderExternalId: "1046",
  };
  const transport: AccountStoreReviewTransport = {
    list: vi
      .fn()
      .mockResolvedValue({ items: [item, second], nextCursor: null }),
    submit: vi.fn().mockResolvedValue({ status: "received", duplicate: false }),
  };
  await mount(transport);
  await click(accountStoreReviewCopy.en.choose);
  fill();
  await click(accountStoreReviewCopy.en.submit);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      accountStoreReviewCopy.en.continue,
    ),
  );
  await click(accountStoreReviewCopy.en.continue);
  expect(document.body.textContent).toContain("1046");
  await click(accountStoreReviewCopy.en.choose);
  expect(document.querySelector("s-text-area")).not.toBeNull();
});

it("discards a prior transport's late submission after account context changes", async () => {
  let resolveSubmit!: (value: unknown) => void;
  const first: AccountStoreReviewTransport = {
    list: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
    submit: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    ),
  };
  const secondItem = {
    ...item,
    requestId: `wstorereq_${"b".repeat(20)}`,
    orderExternalId: "1046",
  };
  const second: AccountStoreReviewTransport = {
    list: vi.fn().mockResolvedValue({ items: [secondItem], nextCursor: null }),
    submit: vi.fn(),
  };
  await mount(first);
  await click(accountStoreReviewCopy.en.choose);
  fill();
  await click(accountStoreReviewCopy.en.submit);
  await act(async () => {
    render(
      h(CustomerAccountStoreReviews, { language: "en", transport: second }),
      document.body,
    );
  });
  await vi.waitFor(() => expect(document.body.textContent).toContain("1046"));
  await act(async () => {
    resolveSubmit({ status: "received", duplicate: false });
  });
  expect(document.body.textContent).not.toContain(
    accountStoreReviewCopy.en.received,
  );
  expect(document.body.textContent).not.toContain("1045");
  await click(accountStoreReviewCopy.en.choose);
  expect(document.querySelector("s-text-area")?.getAttribute("value")).toBe("");
});

it("retains the exact pending operation after an uncertain result", async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValue({ status: "received", duplicate: true });
  const transport: AccountStoreReviewTransport = {
    list: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
    submit,
  };
  await mount(transport);
  await click(accountStoreReviewCopy.en.choose);
  fill();
  await click(accountStoreReviewCopy.en.submit);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      accountStoreReviewCopy.en.uncertain,
    ),
  );
  expect(document.body.textContent).toContain(
    accountStoreReviewCopy.en.uncertain,
  );
  expect(
    document.querySelector("s-text-area")?.getAttribute("disabled"),
  ).not.toBeNull();
  await click(accountStoreReviewCopy.en.retry);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      accountStoreReviewCopy.en.received,
    ),
  );
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0]);
  expect(document.body.textContent).toContain(
    accountStoreReviewCopy.en.received,
  );
});
