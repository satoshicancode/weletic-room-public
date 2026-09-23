import { expect, it, vi } from "vitest";
import {
  AccountStoreReviewError,
  accountStoreReviewSubmission,
  accountStoreReviewTransport,
  type AccountStoreInvitation,
  type AccountStoreReviewTransport,
} from "../extensions/weletic-customer-account/src/store-reviews-client";

const invitation: AccountStoreInvitation = {
  requestId: `wstorereq_${"a".repeat(20)}`,
  orderExternalId: "1045",
  fulfilledAt: "2026-09-20T00:00:00.000Z",
  expiresAt: "2026-10-20T00:00:00.000Z",
  incentiveDisclosure: null,
};
const draft = {
  rating: 1,
  title: "Honest feedback",
  body: "The store could improve.",
  displayName: "Buyer",
  publishConsent: true,
  locale: "en" as const,
};

it("loads bounded account invitations with a fresh session and no browser credentials", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ items: [invitation], nextCursor: null }),
    );
  const token = vi.fn().mockResolvedValue("signed-session");
  const transport = accountStoreReviewTransport(
    "https://app.example.test/api/customer-account/reviews",
    token,
    request,
  );
  expect(await transport.list()).toEqual({
    items: [invitation],
    nextCursor: null,
  });
  expect(request).toHaveBeenCalledWith(
    "https://app.example.test/api/customer-account/reviews/store-invitations?limit=10",
    expect.objectContaining({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { Authorization: "Bearer signed-session" },
    }),
  );
  expect(token).toHaveBeenCalledOnce();
});

it("rejects malformed, oversized or cross-boundary response data", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      items: [{ ...invitation, requestId: "forged" }],
      nextCursor: null,
    }),
  );
  const transport = accountStoreReviewTransport(
    "https://app.example.test/api/customer-account/reviews",
    async () => "token",
    request,
  );
  await expect(transport.list()).rejects.toThrow(AccountStoreReviewError);
  await expect(transport.list("bad cursor!")).rejects.toThrow(
    AccountStoreReviewError,
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("retries exactly the same submission after an uncertain response", async () => {
  const transport: AccountStoreReviewTransport = {
    list: vi.fn(),
    submit: vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue({ status: "received", duplicate: true }),
  };
  const operation = accountStoreReviewSubmission(invitation, draft, transport);
  await expect(operation.send()).rejects.toThrow("uncertain");
  await operation.send();
  expect(transport.submit).toHaveBeenCalledTimes(2);
  expect(vi.mocked(transport.submit).mock.calls[1][0]).toEqual(
    vi.mocked(transport.submit).mock.calls[0][0],
  );
  expect(vi.mocked(transport.submit).mock.calls[0][0]).toEqual({
    requestId: invitation.requestId,
    rating: 1,
    title: "Honest feedback",
    body: "The store could improve.",
    displayName: "Buyer",
    publishConsent: true,
    locale: "en",
  });
  await operation.send();
  expect(transport.submit).toHaveBeenCalledTimes(2);
});

it("rejects invalid text or consent before dispatch", () => {
  const transport: AccountStoreReviewTransport = {
    list: vi.fn(),
    submit: vi.fn(),
  };
  expect(() =>
    accountStoreReviewSubmission(
      invitation,
      { ...draft, body: "", publishConsent: false },
      transport,
    ),
  ).toThrow("invalidInput");
  expect(transport.submit).not.toHaveBeenCalled();
});
