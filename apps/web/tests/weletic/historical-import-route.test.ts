import { HistoricalImportConflictError } from "@/lib/weletic/loyalty/historical-import-persistence";
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/imports/route";
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  manage: vi.fn(),
  context: vi.fn(),
  status: vi.fn(),
  history: vi.fn(),
  reconcile: vi.fn(),
  transaction: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/historical-import-start", () => ({
  startShopifyHistoricalImportCommit: mocks.commit,
  startShopifyHistoricalImportRollback: mocks.rollback,
}));
vi.mock("@/lib/weletic/shopify/historical-imports", async (original) => ({
  ...(await original<object>()),
  prepareShopifyHistoricalImportInTransaction: mocks.manage,
  readShopifyImportContextInTransaction: mocks.context,
  readShopifyImportStatusInTransaction: mocks.status,
  readShopifyImportHistoryInTransaction: mocks.history,
  reconcileShopifyHistoricalImportInTransaction: mocks.reconcile,
}));
vi.mock("@/lib/weletic/shopify/service-auth", async (original) => ({
  ...(await original<object>()),
  verifyWeleticShopifyRequest: mocks.verify,
}));
const actor = {
  version: 1,
  appId: "app",
  shop: "fixture.myshopify.com",
  storeId: "store",
  installationGeneration: "generation",
  userId: "123",
  sessionId: "fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1000000,
  requestId: "b".repeat(64),
};
const input = {
  actor,
  request: {
    operation: "inspect",
    expectedInstallationGeneration: "generation",
    source: { format: "json", sha256: "c".repeat(64) },
  },
  sourceBase64: Buffer.from("[]").toString("base64"),
};
const request = (body: unknown) =>
  new Request("https://backend.example/api/internal/shopify/merchant/imports", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.transaction.mockImplementation(async (fn) => fn({ fixture: true }));
  mocks.manage.mockResolvedValue({ valid: true });
});
it.each(["commit", "rollback"] as const)(
  "dispatches signed %s to the transaction-owning authorized service",
  async (operation) => {
    const input = {
      operation,
      sourceId: "source",
      expectedInstallationGeneration: "generation",
      expectedRevision: "c".repeat(64),
    };
    const result = {
      operation,
      sourceId: "source",
      storeId: "store",
      installationGeneration: "generation",
      status: operation === "commit" ? "committing" : "rolling_back",
    };
    mocks[operation].mockResolvedValue(result);
    const response = await POST(request({ actor, request: input }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        body: JSON.stringify({ actor, request: input }),
      }),
    );
    expect(mocks[operation]).toHaveBeenCalledWith({
      envelope: actor,
      request: input,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.manage).not.toHaveBeenCalled();
  },
);
it("rejects unsigned or worker-token-injected execution before dispatch", async () => {
  const input = {
    operation: "commit",
    sourceId: "source",
    expectedInstallationGeneration: "generation",
    expectedRevision: "c".repeat(64),
  };
  mocks.verify.mockReturnValueOnce(false);
  expect((await POST(request({ actor, request: input }))).status).toBe(401);
  expect(
    (
      await POST(
        request({ actor, request: { ...input, leaseId: "private-token" } }),
      )
    ).status,
  ).toBe(400);
  expect(mocks.commit).not.toHaveBeenCalled();
});

it("reads signed import context without uploading or preparing a source", async () => {
  const context = {
    storeId: "store",
    installationGeneration: "generation",
    configure: true,
  };
  mocks.context.mockResolvedValue(context);
  const body = { actor, request: { operation: "context" } };
  const response = await POST(request(body));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(context);
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(body) }),
  );
  expect(mocks.context).toHaveBeenCalledWith({
    tx: { fixture: true },
    envelope: actor,
  });
  expect(mocks.manage).not.toHaveBeenCalled();
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
  });
});
it("routes signed status reads without source upload or preparation", async () => {
  const body = {
    actor,
    request: {
      operation: "status",
      sourceId: "source",
      expectedInstallationGeneration: "generation",
    },
  };
  mocks.status.mockResolvedValue({ sourceId: "source" });
  expect((await POST(request(body))).status).toBe(200);
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(body) }),
  );
  expect(mocks.status).toHaveBeenCalledWith({
    tx: { fixture: true },
    envelope: actor,
    request: body.request,
  });
  expect(mocks.manage).not.toHaveBeenCalled();
  expect(mocks.context).not.toHaveBeenCalled();
  expect((await POST(request({ ...body, sourceBase64: "W10=" }))).status).toBe(
    400,
  );
});
it("routes signed history and its cursor without upload", async () => {
  const body = {
    actor,
    request: {
      operation: "history",
      expectedInstallationGeneration: "generation",
      before: { sourceId: "source", createdAt: "2026-09-01T00:00:00.000Z" },
    },
  };
  mocks.history.mockResolvedValue({ sources: [] });
  expect((await POST(request(body))).status).toBe(200);
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(body) }),
  );
  expect(mocks.history).toHaveBeenCalledWith({
    tx: { fixture: true },
    envelope: actor,
    request: body.request,
  });
  expect(mocks.manage).not.toHaveBeenCalled();
  expect((await POST(request({ ...body, sourceBase64: "W10=" }))).status).toBe(
    400,
  );
});
it("binds reconciliation revision to the signed body and performs no preparation", async () => {
  const body = {
    actor,
    request: {
      operation: "reconcile",
      sourceId: "source",
      expectedInstallationGeneration: "generation",
      expectedRevision: "a".repeat(64),
    },
  };
  mocks.reconcile.mockResolvedValue({ reconciled: true });
  expect((await POST(request(body))).status).toBe(200);
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
    timeout: 30_000,
  });
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(body) }),
  );
  expect(mocks.reconcile).toHaveBeenCalledWith({
    tx: { fixture: true },
    envelope: actor,
    request: body.request,
  });
  expect(mocks.manage).not.toHaveBeenCalled();
  expect((await POST(request({ ...body, sourceBase64: "W10=" }))).status).toBe(
    400,
  );
});
it("rejects unsigned context and context carrying upload or scope fields", async () => {
  const body = { actor, request: { operation: "context" } };
  mocks.verify.mockReturnValue(false);
  expect((await POST(request(body))).status).toBe(401);
  mocks.verify.mockReturnValue(true);
  for (const extra of [{ sourceBase64: "W10=" }, { storeId: "other" }]) {
    expect((await POST(request({ ...body, ...extra }))).status).toBe(400);
  }
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.context).not.toHaveBeenCalled();
});
it("signs actor, operation and file together and forwards exact decoded bytes", async () => {
  const response = await POST(request(input));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(input) }),
  );
  expect(mocks.manage).toHaveBeenCalledWith({
    tx: { fixture: true },
    envelope: actor,
    request: input.request,
    bytes: Buffer.from("[]"),
  });
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
    timeout: 30_000,
  });
});
it.each(["", "W10", "W10=\n", "W10=!!!", "!!!!"])(
  "rejects noncanonical upload %j",
  async (sourceBase64) => {
    expect((await POST(request({ ...input, sourceBase64 }))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);
it("rejects unsigned uploads without database access", async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(request(input))).status).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("cancels an oversized streamed body before signature or database work", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
    },
    cancel,
  });
  const streamed = new Request(
    "https://backend.example/api/internal/shopify/merchant/imports",
    {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit,
  );
  expect((await POST(streamed)).status).toBe(400);
  expect(cancel).toHaveBeenCalled();
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("rejects injected scope and unsupported commit operations", async () => {
  expect((await POST(request({ ...input, storeId: "other" }))).status).toBe(
    400,
  );
  expect(
    (
      await POST(
        request({
          ...input,
          request: { ...input.request, operation: "commit" },
        }),
      )
    ).status,
  ).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("enforces decoded file size even within encoded padding allowance", async () => {
  const sourceBase64 = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  expect((await POST(request({ ...input, sourceBase64 }))).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("sanitizes failures and never retries a transaction", async () => {
  mocks.manage.mockRejectedValue(new HistoricalImportConflictError());
  expect((await POST(request(input))).status).toBe(409);
  mocks.manage.mockRejectedValue(new Error("private customer record"));
  const response = await POST(request(input));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "imports_unavailable" });
  expect(mocks.transaction).toHaveBeenCalledTimes(2);
});
