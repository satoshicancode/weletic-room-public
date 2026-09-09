import {
  assertHistoricalImportExecutionLeaseInTransaction,
  claimHistoricalImportExecutionLeaseInTransaction,
  recoverHistoricalImportCommitLeaseInTransaction,
  recoverHistoricalImportRollbackLeaseInTransaction,
  renewHistoricalImportExecutionLeaseInTransaction,
  verifyHistoricalImportCommitCompletionInTransaction,
} from "@/lib/weletic/loyalty/historical-import-execution-lease";
import { historicalImportRevision } from "@/lib/weletic/loyalty/historical-import-persistence";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  program: vi.fn(),
  proof: vi.fn(),
}));
vi.mock(
  "@/lib/weletic/loyalty/historical-import-reconciliation-service",
  () => ({
    readHistoricalImportExecutionProofInTransaction: mocks.proof,
  }),
);
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.store,
}));
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRow: mocks.program,
}));
const scope = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  installationGeneration: "generation",
};
let source: {
  id: string;
  storeId: string;
  programId: string;
  installationGeneration: string;
  normalizedSha256: string;
  status: string;
  revision: number;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
};
let now: Date;
const raw = vi.fn();
const update = vi.fn();
const tx = {
  $queryRaw: raw,
  weleticLoyaltyImportSource: { updateMany: update },
} as unknown as Prisma.TransactionClient;
const claim = (
  phase: "committing" | "rolling_back" = "committing",
  expectedRevision = historicalImportRevision({
    ...scope,
    normalizedSha256: source.normalizedSha256,
    source,
  }),
) =>
  claimHistoricalImportExecutionLeaseInTransaction({
    tx,
    request: { ...scope, phase, expectedRevision },
  });
beforeEach(() => {
  vi.resetAllMocks();
  now = new Date("2026-09-09T00:00:00.000Z");
  source = {
    id: "source",
    storeId: "store",
    programId: "program",
    installationGeneration: "generation",
    normalizedSha256: "a".repeat(64),
    status: "preview",
    revision: 0,
    leaseId: null,
    leaseExpiresAt: null,
  };
  mocks.program.mockResolvedValue({ id: "program", storeId: "store" });
  mocks.proof.mockImplementation(async () => ({
    sourceRevision: source.revision,
    sourceInstallationGeneration: source.installationGeneration,
    normalizedSha256: source.normalizedSha256,
    rowStates: source.status === "preview" ? ["pending"] : ["committed"],
    rowsFullyCommitted: source.status !== "preview",
    rowsFullyRolledBack: false,
    summary: {
      reconciled: true,
      issues: [],
      rowCount: 1,
      sourceStatus: source.status,
    },
  }));
  raw.mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes("UTC_TIMESTAMP") ? [{ now }] : [{ ...source }],
  );
  update.mockImplementation(
    async ({
      data,
    }: {
      data: {
        status?: string;
        leaseId?: string;
        leaseExpiresAt: Date;
        revision: { increment: number };
      };
    }) => {
      source = {
        ...source,
        ...data,
        revision: source.revision + data.revision.increment,
      };
      return { count: 1 };
    },
  );
});
it("recovers only an already-started expired rollback, never the commit phase", async () => {
  source.status = "committed";
  const rolling = await claim("rolling_back");
  now = new Date(rolling.expiresAt);
  await expect(
    recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
  ).rejects.toThrow("state changed");
  const result = await recoverHistoricalImportRollbackLeaseInTransaction({
    tx,
    scope,
  });
  expect(result.lease).toMatchObject({ phase: "rolling_back", revision: 2 });
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: rolling.lease,
    }),
  ).rejects.toThrow("state changed");
});

it("claims with database time and scoped compare-and-swap after ordered locks", async () => {
  const result = await claim();
  expect(result.lease).toMatchObject({
    ...scope,
    phase: "committing",
    revision: 1,
  });
  expect(result.expiresAt).toEqual(new Date("2026-09-09T00:01:00.000Z"));
  expect(mocks.store).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    expectedInstallationGeneration: "generation",
    action: "loyalty_import_execution",
  });
  expect(mocks.program).toHaveBeenCalledWith({
    tx,
    storeId: "store",
    mode: "active",
  });
  expect(mocks.store.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.program.mock.invocationCallOrder[0],
  );
  expect(mocks.program.mock.invocationCallOrder[0]).toBeLessThan(
    raw.mock.invocationCallOrder[0],
  );
  expect(raw.mock.calls[0][0].sql).toContain("FOR UPDATE");
  expect(raw.mock.calls[0][0].values).toEqual(["source", "store", "program"]);
  expect(raw.mock.calls[1][0].sql).toContain("UTC_TIMESTAMP(3)");
  expect(update).toHaveBeenCalledWith({
    where: {
      id: "source",
      storeId: "store",
      programId: "program",
      installationGeneration: "generation",
      revision: 0,
      status: "preview",
      leaseId: null,
      leaseExpiresAt: null,
    },
    data: {
      status: "committing",
      revision: { increment: 1 },
      leaseId: result.lease.leaseId,
      leaseExpiresAt: result.expiresAt,
    },
  });
});

async function boundLease() {
  const claimed = await claim();
  const outboxClaim = {
    jobId: "job",
    ownerToken: "owner",
    claimedAt: now,
    attempt: 1,
    sourceRevision: 0,
  };
  const job = {
    id: "job",
    storeId: scope.storeId,
    jobType: "HISTORICAL_IMPORT_COMMIT",
    status: "processing",
    lockedBy: "owner",
    lockedAt: now,
    attempts: 1,
    payload: {
      sourceId: scope.sourceId,
      programId: scope.programId,
      installationGeneration: scope.installationGeneration,
      sourceRevision: 0,
    },
  };
  raw.mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes("UTC_TIMESTAMP")
      ? [{ now }]
      : query.sql.includes("WeleticLoyaltyOutboxJob")
        ? [job]
        : [{ ...source }],
  );
  return { lease: { ...claimed.lease, outboxClaim }, job };
}
it("proves completed source replay under the current queue claim without a source lease", async () => {
  const { lease } = await boundLease();
  source.status = "committed";
  source.leaseId = null;
  source.leaseExpiresAt = null;
  await expect(
    verifyHistoricalImportCommitCompletionInTransaction({
      tx,
      scope,
      claim: lease.outboxClaim,
    }),
  ).resolves.toBe(true);
});
it("does not mistake an in-progress source for terminal completion", async () => {
  const { lease } = await boundLease();
  source.leaseExpiresAt = new Date(0);
  await expect(
    verifyHistoricalImportCommitCompletionInTransaction({
      tx,
      scope,
      claim: lease.outboxClaim,
    }),
  ).resolves.toBe(false);
});
it("defers a live source lease until its DB expiry under the current queue claim", async () => {
  const { lease } = await boundLease();
  await expect(
    verifyHistoricalImportCommitCompletionInTransaction({
      tx,
      scope,
      claim: lease.outboxClaim,
    }),
  ).rejects.toMatchObject({
    name: "HistoricalImportLeasePendingError",
    retryAt: source.leaseExpiresAt,
  });
});
it.each(["ledger", "owner", "lease"])(
  "rejects terminal completion with invalid %s evidence",
  async (changed) => {
    const { lease, job } = await boundLease();
    source.status = "committed";
    source.leaseId = null;
    source.leaseExpiresAt = null;
    if (changed === "ledger") {
      const proof = await mocks.proof();
      mocks.proof.mockResolvedValue({ ...proof, rowsFullyCommitted: false });
    } else if (changed === "owner") job.lockedBy = "replacement";
    else {
      source.leaseId = lease.leaseId;
      source.leaseExpiresAt = new Date(now.getTime() + 1000);
    }
    await expect(
      verifyHistoricalImportCommitCompletionInTransaction({
        tx,
        scope,
        claim: lease.outboxClaim,
      }),
    ).rejects.toThrow("state changed");
  },
);
it("preserves and rechecks the queue binding through source renewal", async () => {
  const { lease } = await boundLease();
  const result = await renewHistoricalImportExecutionLeaseInTransaction({
    tx,
    lease,
  });
  expect(result.lease.outboxClaim).toEqual(lease.outboxClaim);
  expect(result.lease.revision).toBe(2);
  const query = raw.mock.calls.find(([query]) =>
    query.sql.includes("WeleticLoyaltyOutboxJob"),
  )?.[0];
  expect(query).toBeDefined();
  expect(query.sql).toContain("FOR UPDATE");
  expect(query.values).toEqual(["job", "store"]);
});
it.each([
  { status: "failed" },
  { lockedBy: "replacement" },
  { attempts: 2 },
  { lockedAt: new Date("2026-09-09T01:00:00Z") },
  { lockedAt: null },
  { jobType: "HISTORICAL_IMPORT_ROLLBACK" },
  { storeId: "foreign" },
  { id: "foreign" },
  { payload: {} },
])(
  "rejects changed outbox ownership before source renewal: %j",
  async (changed) => {
    const { lease, job } = await boundLease();
    Object.assign(job, changed);
    update.mockClear();
    await expect(
      renewHistoricalImportExecutionLeaseInTransaction({ tx, lease }),
    ).rejects.toThrow("state changed");
    expect(update).not.toHaveBeenCalled();
  },
);
it.each([
  "sourceId",
  "programId",
  "installationGeneration",
  "sourceRevision",
] as const)("rejects changed job payload %s", async (field) => {
  const { lease, job } = await boundLease();
  Object.assign(job.payload, {
    [field]: field === "sourceRevision" ? 1 : "foreign",
  });
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({ tx, lease }),
  ).rejects.toThrow("state changed");
});
it("rejects source expiration while waiting for the queue lock", async () => {
  const { lease, job } = await boundLease();
  raw.mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes("WeleticLoyaltyOutboxJob")) {
      now = new Date(source.leaseExpiresAt!);
      return [job];
    }
    return query.sql.includes("UTC_TIMESTAMP") ? [{ now }] : [{ ...source }];
  });
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({ tx, lease }),
  ).rejects.toThrow("state changed");
});
it("starts rollback only from committed evidence", async () => {
  source.status = "committed";
  expect((await claim("rolling_back")).lease.phase).toBe("rolling_back");
});
it.each([
  { sourceRevision: 99 },
  { sourceInstallationGeneration: "stale" },
  { normalizedSha256: "b".repeat(64) },
  { rowStates: [] },
  { rowStates: ["contained"] },
  { rowStates: ["committed"] },
])(
  "rejects invalid initial manifest proof case %# before claiming",
  async (change) => {
    mocks.proof.mockResolvedValue({ ...(await mocks.proof()), ...change });
    await expect(claim()).rejects.toThrow("state changed");
    expect(update).not.toHaveBeenCalled();
  },
);
it("rejects corrupt financial evidence and propagates failed manifest verification", async () => {
  const proof = await mocks.proof();
  mocks.proof.mockResolvedValue({
    ...proof,
    summary: { ...proof.summary, reconciled: false },
  });
  await expect(claim()).rejects.toThrow("state changed");
  const error = new Error("invalid manifest");
  mocks.proof.mockRejectedValue(error);
  await expect(claim()).rejects.toBe(error);
  expect(update).not.toHaveBeenCalled();
});
it("starts the lease lifetime after full-file proof finishes", async () => {
  const proof = await mocks.proof();
  mocks.proof.mockImplementation(async () => {
    now = new Date("2026-09-09T00:02:00.000Z");
    return proof;
  });
  const result = await claim();
  expect(result.expiresAt).toEqual(new Date("2026-09-09T00:03:00.000Z"));
  expect(mocks.proof.mock.invocationCallOrder.at(-1)).toBeLessThan(
    update.mock.invocationCallOrder[0],
  );
});
it("requires completed rows before initial rollback", async () => {
  source.status = "committed";
  mocks.proof.mockResolvedValue({
    ...(await mocks.proof()),
    rowsFullyCommitted: false,
  });
  await expect(claim("rolling_back")).rejects.toThrow("state changed");
  expect(update).not.toHaveBeenCalled();
});
it.each(["committing", "rolling_back"] as const)(
  "reclaims expired %s work only with compatible partial progress",
  async (phase) => {
    if (phase === "rolling_back") source.status = "committed";
    const first = await claim(phase);
    now = new Date(first.expiresAt.getTime() + 1);
    const proof = await mocks.proof();
    mocks.proof.mockResolvedValue({
      ...proof,
      rowStates:
        phase === "committing"
          ? ["pending", "committed"]
          : ["committed", "rolled_back"],
      rowsFullyCommitted: false,
    });
    expect((await claim(phase)).lease.leaseId).not.toBe(first.lease.leaseId);
  },
);
it.each([
  "contained",
  "cancelled",
  "rolled_back",
  "rolling_back",
  "committing",
])("never adopts unleased %s state", async (status) => {
  source.status = status;
  await expect(claim()).rejects.toThrow();
  expect(update).not.toHaveBeenCalled();
});
it("rejects stale revisions and a live lease without replacing its owner", async () => {
  const oldRevision = historicalImportRevision({
    ...scope,
    normalizedSha256: source.normalizedSha256,
    source,
  });
  await claim();
  update.mockClear();
  await expect(claim("committing", oldRevision)).rejects.toThrow(
    "state changed",
  );
  await expect(claim()).rejects.toThrow("state changed");
  expect(update).not.toHaveBeenCalled();
});
it("reclaims at the expiry boundary and rejects the displaced worker", async () => {
  const first = await claim();
  now = first.expiresAt;
  const second = await claim();
  expect(second.lease.leaseId).not.toBe(first.lease.leaseId);
  expect(second.lease.revision).toBe(2);
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: first.lease,
    }),
  ).rejects.toThrow();
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: second.lease,
    }),
  ).resolves.toMatchObject({ lease: second.lease });
});
it("recovers a lost commit token from locked source evidence and fences its old owner", async () => {
  const first = await claim();
  now = first.expiresAt;
  mocks.proof.mockClear();
  const recovered = await recoverHistoricalImportCommitLeaseInTransaction({
    tx,
    scope,
  });
  expect(recovered.lease).toMatchObject({
    ...scope,
    phase: "committing",
    revision: 2,
  });
  expect(recovered.lease.leaseId).not.toBe(first.lease.leaseId);
  expect(mocks.proof).toHaveBeenCalledTimes(1);
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: first.lease,
    }),
  ).rejects.toThrow("state changed");
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: recovered.lease,
    }),
  ).resolves.toMatchObject({ lease: recovered.lease });
});
it.each([
  "preview",
  "committed",
  "rolling_back",
  "rolled_back",
  "contained",
  "cancelled",
])("recovery cannot initiate or adopt %s work", async (status) => {
  source.status = status;
  await expect(
    recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
  ).rejects.toThrow("state changed");
  expect(update).not.toHaveBeenCalled();
  expect(mocks.proof).not.toHaveBeenCalled();
});
it("recovery rejects live and missing leases before financial proof", async () => {
  await claim();
  update.mockClear();
  mocks.proof.mockClear();
  await expect(
    recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
  ).rejects.toThrow("state changed");
  source.leaseId = null;
  source.leaseExpiresAt = null;
  await expect(
    recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
  ).rejects.toThrow("state changed");
  expect(update).not.toHaveBeenCalled();
  expect(mocks.proof).not.toHaveBeenCalled();
});
it("recovery never bypasses corrupt evidence or generation fences", async () => {
  const first = await claim();
  now = first.expiresAt;
  update.mockClear();
  const proof = await mocks.proof();
  mocks.proof.mockResolvedValue({
    ...proof,
    summary: { ...proof.summary, reconciled: false },
  });
  await expect(
    recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
  ).rejects.toThrow("state changed");
  mocks.proof.mockClear();
  source.installationGeneration = "stale";
  await expect(
    recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
  ).rejects.toThrow("state changed");
  expect(update).not.toHaveBeenCalled();
  expect(mocks.proof).not.toHaveBeenCalled();
});
it("recovery rejects injected phase, revision and token fields", async () => {
  for (const extra of [
    { phase: "rolling_back" },
    { expectedRevision: "a".repeat(64) },
    { leaseId: "lost-token" },
  ]) {
    await expect(
      recoverHistoricalImportCommitLeaseInTransaction({
        tx,
        scope: { ...scope, ...extra },
      }),
    ).rejects.toThrow();
  }
  expect(mocks.store).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it("renews a live lease and invalidates the previous revision", async () => {
  const first = await claim();
  now = new Date(now.getTime() + 1000);
  const next = await renewHistoricalImportExecutionLeaseInTransaction({
    tx,
    lease: first.lease,
  });
  expect(next.lease.revision).toBe(2);
  expect(next.lease.leaseId).toBe(first.lease.leaseId);
  expect(next.expiresAt).toEqual(new Date("2026-09-09T00:01:01.000Z"));
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: first.lease,
    }),
  ).rejects.toThrow();
});
it("cannot renew after expiration", async () => {
  const first = await claim();
  now = first.expiresAt;
  update.mockClear();
  await expect(
    renewHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: first.lease,
    }),
  ).rejects.toThrow();
  expect(update).not.toHaveBeenCalled();
});
it("allows the final representable revision but refuses to renew past it", async () => {
  source.revision = 2147483646;
  const current = await claim();
  expect(current.lease.revision).toBe(2147483647);
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: current.lease,
    }),
  ).resolves.toMatchObject({ lease: current.lease });
  update.mockClear();
  await expect(
    renewHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: current.lease,
    }),
  ).rejects.toThrow();
  expect(update).not.toHaveBeenCalled();
});
it("fails closed when the database clock is unavailable", async () => {
  now = new Date("invalid");
  await expect(claim()).rejects.toThrow();
  expect(update).not.toHaveBeenCalled();
});
it.each(["store", "program", "source-store", "source-program", "generation"])(
  "rejects %s fence failures before writing",
  async (kind) => {
    if (kind === "store") mocks.store.mockRejectedValue(new Error("frozen"));
    if (kind === "program")
      mocks.program.mockResolvedValue({ id: "other", storeId: "store" });
    if (kind === "source-store") source.storeId = "other";
    if (kind === "source-program") source.programId = "other";
    if (kind === "generation") source.installationGeneration = "old";
    await expect(claim()).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  },
);
it.each([
  { leaseId: "invalid", leaseExpiresAt: new Date("2020-01-01") },
  { leaseId: null, leaseExpiresAt: new Date("2020-01-01") },
  { revision: 2147483647 },
  { revision: -1 },
  { normalizedSha256: "invalid" },
])("rejects malformed or exhausted source state %j", async (change) => {
  Object.assign(source, change);
  await expect(claim()).rejects.toThrow();
  expect(update).not.toHaveBeenCalled();
});
it("fails closed if a compare-and-swap does not update exactly one source", async () => {
  update.mockResolvedValue({ count: 0 });
  await expect(claim()).rejects.toThrow("state changed");
});
it("rejects the old worker after privacy containment even before lease expiration", async () => {
  const current = await claim();
  source.status = "contained";
  source.leaseId = null;
  source.leaseExpiresAt = null;
  await expect(
    assertHistoricalImportExecutionLeaseInTransaction({
      tx,
      lease: current.lease,
    }),
  ).rejects.toThrow();
});
