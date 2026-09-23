import {
  ShopperDeliveryDeferredError,
  ShopperDeliveryIneligibleError,
  ShopperDeliveryReconciliationRequiredError,
} from "@/lib/weletic/merchant-settings/delivery-reservations";
import { hashReviewToken, ReviewError } from "@/lib/weletic/reviews/contracts";
import { deliverReviewReminder as deliver } from "@/lib/weletic/reviews/reminder-email";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  admit: vi.fn(),
  confirm: vi.fn(),
  identity: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  parent: vi.fn(),
  settings: vi.fn(),
  communications: vi.fn(),
  mutation: vi.fn(),
  lock: vi.fn(),
  purchase: vi.fn(),
  suppression: vi.fn(),
  erase: vi.fn(),
  prepare: vi.fn(),
  dispatch: vi.fn(),
  open: vi.fn(),
  seal: vi.fn(),
  transport: vi.fn(),
  provider: { resend: {} as unknown },
}));
vi.mock(
  "@/lib/weletic/merchant-settings/delivery-reservations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/merchant-settings/delivery-reservations")
    >()),
    admitShopperDeliveryInTransaction: m.admit,
    confirmShopperDeliveryInTransaction: m.confirm,
  }),
);
vi.mock("@/lib/encryption", () => ({ decrypt: () => "a".repeat(43) }));
vi.mock("@dub/email/resend", () => m.provider);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticReviewReminder: { findFirst: m.identity, updateMany: m.update },
    $transaction: (fn: any) => fn(tx),
  },
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: m.mutation,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: m.lock,
}));
vi.mock("@/lib/weletic/merchant-settings/communications", () => ({
  readShopperCommunicationSettings: m.communications,
}));
vi.mock("@/lib/weletic/reviews/purchase", () => ({
  assertReviewPurchase: m.purchase,
  assertReviewPurchaseNotSuppressed: m.suppression,
  reviewRequestInclude: {},
}));
vi.mock("@/lib/weletic/reviews/reminder-retention", () => ({
  eraseReviewReminderMaterialInTransaction: m.erase,
}));
vi.mock("@/lib/weletic/reviews/incentive-policy", () => ({
  readReviewIncentivePolicySnapshot: async () => null,
}));
vi.mock("@/lib/weletic/reviews/prepared-email", () => ({
  prepareReviewEmail: m.prepare,
  dispatchPreparedReviewEmail: m.dispatch,
  reviewTransportIdentity: m.transport,
}));
vi.mock("@/lib/weletic/reviews/delivery-snapshot", () => ({
  openReviewDeliverySnapshot: m.open,
  sealReviewDeliverySnapshot: m.seal,
  reviewDeliveryProviderKey: (_request: string, reminder: string) =>
    `native-review-reminder:${reminder}`,
}));
const tx = {
  $queryRaw: vi.fn(),
  weleticReviewReminder: {
    findFirst: m.find,
    updateMany: m.update,
    count: m.count,
  },
  weleticReviewSettings: { findUnique: m.settings },
  weleticReviewRequest: { updateMany: m.parent },
  weleticShopifyStore: {
    findUniqueOrThrow: async () => ({ shopDomain: "test.myshopify.com" }),
  },
  weleticLoyaltyProgram: { findUnique: async () => ({ name: "Weletic" }) },
};
const input = {
  storeId: "store",
  requestId: "request",
  reminderId: `wrevrem_${"x".repeat(20)}`,
  installationGeneration: "g1",
};
const content = {
  to: "fixture@example.test",
  subject: "Review",
  html: "immutable",
};
function row() {
  return {
    ...input,
    id: input.reminderId,
    status: "queued",
    scheduledFor: new Date(Date.now() - 1000),
    leaseExpiresAt: null,
    attempts: 0,
    encryptedDeliverySnapshot: null,
    request: {
      id: "request",
      status: "sent",
      sentAt: new Date(Date.now() - 86400000),
      expiresAt: new Date(Date.now() + 86400000),
      encryptedReminderToken: "cipher-token",
      tokenHash: hashReviewToken("a".repeat(43)),
      incentivePolicyId: null,
      shopper: {
        email: "fixture@example.test",
        locale: "en",
        shopifyCustomerId: "customer",
      },
      product: { title: "Fixture" },
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.provider.resend = {};
  m.admit.mockResolvedValue({ status: "attempted" });
  m.confirm.mockResolvedValue(undefined);
  m.identity.mockResolvedValue({
    request: {
      store: { projectId: "workspace" },
      shopper: { shopifyCustomerId: "customer" },
    },
  });
  m.lock.mockImplementation(({ fn }) => fn());
  m.mutation.mockImplementation((_store, fn) => fn(tx, "g1"));
  m.find.mockResolvedValue(row());
  m.settings.mockResolvedValue({ enabled: true, requestEmailEnabled: true });
  m.communications.mockResolvedValue({ paused: false });
  m.transport.mockReturnValue("provider-identity");
  m.prepare.mockResolvedValue({
    provider: "resend",
    content,
    transportIdentity: "provider-identity",
  });
  m.seal.mockReturnValue("cipher-content");
  m.open.mockReturnValue({
    content,
    retryUntil: new Date(Date.now() + 3600000),
  });
  m.update.mockResolvedValue({ count: 1 });
  m.count.mockResolvedValueOnce(1).mockResolvedValue(0);
});
it("holds the customer lock through preparation, dispatch and exact receipt; erases the final token", async () => {
  await deliver(input);
  expect(m.lock).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      storeId: "store",
      shopifyCustomerId: "customer",
    }),
  );
  expect(m.mutation.mock.calls.every((call) => call[2] === "g1")).toBe(true);
  expect(m.purchase).toHaveBeenCalledWith(
    expect.objectContaining({ id: "request", status: "sent" }),
    "g1",
  );
  expect(m.update.mock.calls[0][0]).toMatchObject({
    where: {
      id: input.reminderId,
      storeId: "store",
      installationGeneration: "g1",
      attempts: 0,
    },
    data: {
      status: "sending",
      attempts: { increment: 1 },
      encryptedDeliverySnapshot: "cipher-content",
    },
  });
  expect(m.dispatch).toHaveBeenCalledWith({
    provider: "resend",
    content,
    transportIdentity: "provider-identity",
    providerKey: `native-review-reminder:${input.reminderId}`,
  });
  expect(m.update.mock.invocationCallOrder[0]).toBeLessThan(
    m.dispatch.mock.invocationCallOrder[0],
  );
  expect(m.update.mock.calls[1][0]).toMatchObject({
    where: { attempts: 1, installationGeneration: "g1" },
    data: { status: "sent", encryptedDeliverySnapshot: null },
  });
  expect(m.parent).toHaveBeenCalledWith({
    where: { id: "request", storeId: "store", installationGeneration: "g1" },
    data: { encryptedReminderToken: null },
  });
});
it.each(["sent", "cancelled"])(
  "does not dispatch terminal %s rows",
  async (status) => {
    m.find.mockResolvedValue({ ...row(), status });
    await deliver(input);
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  },
);
it.each(["scheduledFor", "leaseExpiresAt"])(
  "honors the %s not-before boundary",
  async (field) => {
    m.find.mockResolvedValue({
      ...row(),
      [field]: new Date(Date.now() + 60000),
    });
    await expect(deliver(input)).rejects.toThrow("deferred before transport");
    expect(m.prepare).not.toHaveBeenCalled();
  },
);
it.each(["submitted", "cancelled", "queued"])(
  "cancels when the original invitation is %s",
  async (status) => {
    const value = row();
    value.request.status = status;
    m.find.mockResolvedValue(value);
    await deliver(input);
    expect(m.erase).toHaveBeenCalled();
    expect(m.dispatch).not.toHaveBeenCalled();
  },
);
it("erases expired authority", async () => {
  const value = row();
  value.request.expiresAt = new Date(0);
  m.find.mockResolvedValue(value);
  await deliver(input);
  expect(m.erase).toHaveBeenCalledWith(tx, {
    storeId: "store",
    requestIds: ["request"],
    reason: "expired",
  });
});
it("contains suppressed purchases before preparing content", async () => {
  m.suppression.mockRejectedValue(new ReviewError("not_found", "unavailable"));
  await deliver(input);
  expect(m.erase).toHaveBeenCalled();
  expect(m.prepare).not.toHaveBeenCalled();
});
it("pauses without consuming an attempt", async () => {
  m.communications.mockResolvedValue({ paused: true });
  await expect(deliver(input)).rejects.toThrow("deferred before transport");
  expect(m.update).not.toHaveBeenCalled();
});
it("reuses saved bytes and provider identity after an ambiguous Resend attempt", async () => {
  m.find.mockResolvedValue({
    ...row(),
    status: "failed",
    attempts: 1,
    encryptedDeliverySnapshot: "original",
  });
  await deliver(input);
  expect(m.open).toHaveBeenCalledWith(
    expect.objectContaining({
      ciphertext: "original",
      retry: true,
      context: expect.objectContaining({
        requestId: "request",
        reminderId: input.reminderId,
      }),
    }),
  );
  expect(m.prepare).not.toHaveBeenCalled();
  expect(m.seal).not.toHaveBeenCalled();
});
it.each([{ attempts: 1 }, { attempts: 5, encryptedDeliverySnapshot: "old" }])(
  "contains attempts without safe retry evidence %j",
  async (patch) => {
    m.find.mockResolvedValue({ ...row(), ...patch });
    await expect(deliver(input)).rejects.toThrow(
      "requires delivery reconciliation",
    );
    expect(m.update.mock.calls[0][0].data.status).toBe("reconciliation");
    expect(m.dispatch).not.toHaveBeenCalled();
  },
);
it("contains invalid or expired evidence without regenerating content", async () => {
  m.find.mockResolvedValue({
    ...row(),
    attempts: 1,
    encryptedDeliverySnapshot: "old",
  });
  m.open.mockImplementation(() => {
    throw new Error("expired");
  });
  await expect(deliver(input)).rejects.toThrow(
    "requires delivery reconciliation",
  );
  expect(m.update.mock.calls[0][0].data.status).toBe("reconciliation");
  expect(m.prepare).not.toHaveBeenCalled();
});
it("does not send after losing the reservation", async () => {
  m.update.mockResolvedValueOnce({ count: 0 });
  await expect(deliver(input)).rejects.toThrow("already reserved");
  expect(m.dispatch).not.toHaveBeenCalled();
});
it("rechecks module enablement immediately before transport", async () => {
  m.settings
    .mockResolvedValueOnce({ enabled: true, requestEmailEnabled: true })
    .mockResolvedValue({ enabled: false });
  await expect(deliver(input)).rejects.toThrow("deferred before transport");
  expect(m.dispatch).not.toHaveBeenCalled();
});
it("contains SMTP after an admitted reservation is paused without discarding evidence", async () => {
  m.provider.resend = null;
  m.prepare.mockResolvedValue({
    provider: "smtp",
    content,
    transportIdentity: "provider-identity",
  });
  m.communications
    .mockResolvedValueOnce({ paused: false })
    .mockResolvedValue({ paused: true });
  await expect(deliver(input)).rejects.toThrow(
    "requires delivery reconciliation",
  );
  expect(m.dispatch).not.toHaveBeenCalled();
  expect(m.update.mock.calls[1][0]).toMatchObject({
    where: { status: "sending", leaseToken: expect.any(String), attempts: 1 },
    data: {
      status: "reconciliation",
      outcomeReason: "deferred_after_admission",
    },
  });
  expect(m.update.mock.calls[1][0].data).not.toHaveProperty(
    "encryptedDeliverySnapshot",
  );
  expect(m.update.mock.calls[1][0].data).not.toHaveProperty("attempts");
});
it("pre-dispatch pause never discards an earlier ambiguous attempt's evidence", async () => {
  m.find.mockResolvedValue({
    ...row(),
    status: "failed",
    attempts: 1,
    encryptedDeliverySnapshot: "original",
  });
  m.communications
    .mockResolvedValueOnce({ paused: false })
    .mockResolvedValue({ paused: true });
  await expect(deliver(input)).rejects.toThrow("deferred before transport");
  expect(m.update.mock.calls[1][0].data).toMatchObject({
    status: "failed",
    outcomeReason: "deferred_after_admission",
  });
  expect(m.update.mock.calls[1][0].data).not.toHaveProperty(
    "encryptedDeliverySnapshot",
  );
});
it("preserves provider ambiguity when cancellation wins during transport", async () => {
  m.dispatch.mockRejectedValue(new Error("unknown provider result"));
  await expect(deliver(input)).rejects.toThrow("retry or reconciliation");
  expect(m.update.mock.calls[2][0]).toMatchObject({
    where: { status: "cancelled", attempts: 1 },
    data: {
      status: "reconciliation",
      outcomeReason: "cancelled_during_unconfirmed_delivery",
    },
  });
});
it("contains provider-configuration loss on an earlier attempt instead of regenerating", async () => {
  m.find.mockResolvedValue({
    ...row(),
    status: "failed",
    attempts: 1,
    encryptedDeliverySnapshot: "original",
  });
  m.transport.mockImplementation(() => {
    throw new Error("configuration unavailable");
  });
  await expect(deliver(input)).rejects.toThrow(
    "requires delivery reconciliation",
  );
  expect(m.update.mock.calls[0][0].data.status).toBe("reconciliation");
  expect(m.prepare).not.toHaveBeenCalled();
  expect(m.dispatch).not.toHaveBeenCalled();
});
it("backs off a provider error without leaking its message or replacing evidence", async () => {
  m.dispatch.mockRejectedValue(new Error("secret recipient or token"));
  await expect(deliver(input)).rejects.toThrow(
    "Review reminder delivery requires retry or reconciliation",
  );
  expect(m.update.mock.calls[1][0]).toMatchObject({
    where: { status: "sending", leaseToken: expect.any(String) },
    data: {
      status: "failed",
      leaseExpiresAt: expect.any(Date),
      outcomeReason: "delivery_outcome_unconfirmed",
    },
  });
  expect(m.update.mock.calls[1][0].data).not.toHaveProperty(
    "encryptedDeliverySnapshot",
  );
});
it("never automatically retries an ambiguous SMTP send", async () => {
  m.provider.resend = null;
  m.prepare.mockResolvedValue({
    provider: "smtp",
    content,
    transportIdentity: "provider-identity",
  });
  m.dispatch.mockRejectedValue(new Error("ambiguous"));
  await expect(deliver(input)).rejects.toThrow(
    "requires delivery reconciliation",
  );
  expect(m.update.mock.calls[1][0].data).toMatchObject({
    status: "reconciliation",
    leaseExpiresAt: null,
  });
  expect(m.parent).toHaveBeenCalledWith({
    where: { id: "request", storeId: "store", installationGeneration: "g1" },
    data: { encryptedReminderToken: null },
  });
});
it("retains the parent token after terminal ambiguity only when another reminder remains pending", async () => {
  m.provider.resend = null;
  m.prepare.mockResolvedValue({
    provider: "smtp",
    content,
    transportIdentity: "provider-identity",
  });
  m.count.mockReset().mockResolvedValue(1);
  m.dispatch.mockRejectedValue(new Error("ambiguous"));
  await expect(deliver(input)).rejects.toThrow(
    "requires delivery reconciliation",
  );
  expect(m.parent).not.toHaveBeenCalled();
});
it("retains the encrypted invitation while later reminders remain", async () => {
  m.count.mockReset().mockResolvedValue(1);
  await deliver(input);
  expect(m.parent).not.toHaveBeenCalled();
});
it("rejects malformed generation or reminder identity before any lookup", async () => {
  await expect(
    deliver({ ...input, installationGeneration: "" }),
  ).rejects.toThrow();
  await expect(deliver({ ...input, reminderId: "request" })).rejects.toThrow();
  expect(m.identity).not.toHaveBeenCalled();
});
it("defers customer lock contention without consuming an attempt or sending", async () => {
  m.lock.mockImplementation(({ onLocked }) => onLocked());
  await expect(deliver(input)).rejects.toThrow("deferred before transport");
  expect(m.mutation).not.toHaveBeenCalled();
  expect(m.dispatch).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
it("keeps an earlier ambiguous attempt visible when expiry cancels the invitation", async () => {
  const value = { ...row(), attempts: 1 };
  value.request.expiresAt = new Date(0);
  m.find.mockResolvedValue(value);
  await expect(deliver(input)).rejects.toThrow(
    "requires delivery reconciliation",
  );
  expect(m.erase).toHaveBeenCalled();
  expect(m.dispatch).not.toHaveBeenCalled();
});

it.each(["resend", "smtp"] as const)(
  "contains a confirmed %s transport when the receipt database write fails",
  async (provider) => {
    m.provider.resend = provider === "resend" ? {} : null;
    m.prepare.mockResolvedValue({
      provider,
      content,
      transportIdentity: "provider-identity",
    });
    m.update
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(
        new Error("database unavailable: private details"),
      );

    await expect(deliver(input)).rejects.toThrow(
      provider === "smtp"
        ? "requires delivery reconciliation"
        : "requires retry or reconciliation",
    );
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    const reservation = m.update.mock.calls[0][0];
    const attemptedReceipt = m.update.mock.calls[1][0];
    const containment = m.update.mock.calls[2][0];
    expect(attemptedReceipt.where).toMatchObject({
      storeId: input.storeId,
      requestId: input.requestId,
      installationGeneration: input.installationGeneration,
      id: input.reminderId,
      attempts: 1,
    });
    expect(containment).toMatchObject({
      where: {
        id: input.reminderId,
        status: "sending",
        installationGeneration: "g1",
        leaseToken: reservation.data.leaseToken,
      },
      data: {
        status: provider === "smtp" ? "reconciliation" : "failed",
        outcomeReason: "delivery_outcome_unconfirmed",
      },
    });
    // A returned provider call is not a durable receipt. Preserve the original
    // encrypted payload for reconciliation/idempotent retry, never compose anew.
    expect(containment.data).not.toHaveProperty("encryptedDeliverySnapshot");
    expect(m.prepare).toHaveBeenCalledTimes(1);
  },
);

it("cannot settle or reset a newer reservation when its late receipt loses ownership", async () => {
  m.update.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
  await expect(deliver(input)).rejects.toThrow(
    "requires retry or reconciliation",
  );
  const leaseToken = m.update.mock.calls[0][0].data.leaseToken;
  expect(m.update.mock.calls[1][0].where).toMatchObject({
    attempts: 1,
    OR: [
      { status: "sending", leaseToken },
      { status: "cancelled", leaseToken: null },
      { status: "reconciliation", leaseToken: null },
    ],
  });
  expect(m.update.mock.calls[2][0].where).toMatchObject({
    status: "sending",
    leaseToken,
  });
  expect(m.update.mock.calls[3][0].where).toMatchObject({
    status: "cancelled",
    attempts: 1,
    leaseToken: null,
  });
  expect(m.dispatch).toHaveBeenCalledTimes(1);
  expect(m.parent).not.toHaveBeenCalled();
});

it("reclaims an expired sending reservation using saved content rather than treating it as unsent", async () => {
  m.find.mockResolvedValue({
    ...row(),
    status: "sending",
    attempts: 1,
    leaseToken: "previous-process",
    leaseExpiresAt: new Date(Date.now() - 1),
    encryptedDeliverySnapshot: "original",
  });
  await deliver(input);
  expect(m.open).toHaveBeenCalledWith(
    expect.objectContaining({ ciphertext: "original", retry: true }),
  );
  expect(m.update.mock.calls[0][0]).toMatchObject({
    where: { status: "sending", attempts: 1 },
    data: { attempts: { increment: 1 } },
  });
  expect(m.update.mock.calls[0][0].data.leaseToken).not.toBe(
    "previous-process",
  );
  expect(m.update.mock.calls[1][0].where.attempts).toBe(2);
  expect(m.prepare).not.toHaveBeenCalled();
  expect(m.seal).not.toHaveBeenCalled();
  expect(m.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      content,
      providerKey: `native-review-reminder:${input.reminderId}`,
    }),
  );
});

it("commits budget admission inside the same transaction as the source attempt", async () => {
  let active = false;
  m.mutation.mockImplementation(async (_store, fn) => {
    active = true;
    try {
      return await fn(tx, "g1");
    } finally {
      active = false;
    }
  });
  m.admit.mockImplementation(
    async ({ tx: client, input: identity, priorAttempt }) => {
      expect(active).toBe(true);
      expect(client).toBe(tx);
      expect(priorAttempt).toBe(false);
      expect(identity).toMatchObject({
        producer: "review_reminder",
        email: content.to,
        shopifyCustomerId: "customer",
        sourceKey: `native-review-reminder:${input.reminderId}`,
      });
      return { status: "admitted" };
    },
  );
  await deliver(input);
  expect(m.admit).toHaveBeenCalledTimes(1);
  expect(m.confirm).toHaveBeenCalledTimes(1);
});
it("does not unwind immutable evidence after a lost source/admission commit acknowledgment", async () => {
  m.mutation.mockImplementation(async (_store, fn) => {
    await fn(tx, "g1");
    throw new Error("lost commit acknowledgment");
  });
  await expect(deliver(input)).rejects.toThrow("lost commit acknowledgment");
  expect(m.admit).toHaveBeenCalledTimes(1);
  expect(m.update).toHaveBeenCalledTimes(1);
  expect(m.dispatch).not.toHaveBeenCalled();
});
it("settles a confirmed shared reservation without repeating provider transport", async () => {
  m.admit.mockResolvedValue({ status: "sent" });
  await deliver(input);
  expect(m.dispatch).not.toHaveBeenCalled();
  expect(m.confirm).toHaveBeenCalledTimes(1);
});

it("lets shared policy deferral roll back the source transaction before dispatch", async () => {
  const deferred = new ShopperDeliveryDeferredError(
    new Date(Date.now() + 60000),
    "capacity",
  );
  m.admit.mockRejectedValue(deferred);
  await expect(deliver(input)).rejects.toBe(deferred);
  expect(m.dispatch).not.toHaveBeenCalled();
  expect(m.confirm).not.toHaveBeenCalled();
  // Only the in-transaction CAS occurred; no outside-transaction compensation.
  expect(m.update).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  "settles terminal shared admission and erases the final invitation (reconciliation=%s)",
  async (reconciliation) => {
    m.admit.mockRejectedValue(
      reconciliation
        ? new ShopperDeliveryReconciliationRequiredError()
        : new ShopperDeliveryIneligibleError(),
    );
    m.count.mockReset().mockResolvedValue(0);
    if (reconciliation)
      await expect(deliver(input)).rejects.toThrow(
        "requires delivery reconciliation",
      );
    else await deliver(input);
    expect(m.update.mock.calls[1][0].data).toMatchObject({
      status: reconciliation ? "reconciliation" : "cancelled",
      attempts: 0,
    });
    expect(m.parent).toHaveBeenCalledWith(
      expect.objectContaining({ data: { encryptedReminderToken: null } }),
    );
    expect(m.dispatch).not.toHaveBeenCalled();
  },
);
