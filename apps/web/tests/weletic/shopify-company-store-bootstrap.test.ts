import {
  bootstrapCompanyStore,
  companyStoreBootstrapInputSchema,
} from "@/lib/weletic/shopify/company-store-bootstrap";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/shopify/session-coordination", () => ({
  revokeShopifySessionCoordination: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lifecycle: vi.fn(),
  snapshot: vi.fn(),
  pending: vi.fn(),
  verify: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  audit: vi.fn(),
  models: Object.fromEntries(
    [
      "project",
      "program",
      "folder",
      "partnerGroup",
      "weleticShopifyStore",
      "projectUsers",
      "projectInvite",
      "installedIntegration",
      "restrictedToken",
      "oAuthCode",
    ].map((name) => [name, { count: vi.fn(), create: vi.fn() }]),
  ),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.pending,
}));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", () => ({
  lockShopifySessionLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  fetchVerifiedShopifyShopDetails: mocks.verify,
}));
vi.mock("@/lib/weletic/shopify/session-snapshot", () => ({
  configuredShopifySessionScope: (shop: string) => ({ appId: "testapp", shop }),
  readShopifySessionSnapshot: mocks.snapshot,
  assertShopifySessionObservation: (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error("stale observation");
  },
}));

const input = {
  appId: "testapp",
  shop: "fixture.myshopify.com",
  pendingInstallationId: "pending",
  expectedInstallationGeneration: "generation",
  expectedRevision: 1,
  operator: "test-operator",
  reason: "approved fixture",
};
const now = new Date("2026-09-10T00:00:00Z");
const snapshot = () => ({
  observed: {
    epoch: "1",
    revision: "1",
    sessionDigest: "digest",
    installationGeneration: "generation",
    credentialTokenHash: null,
  },
  properties: [
    ["id", "offline_fixture.myshopify.com"],
    ["shop", input.shop],
    ["isOnline", false],
    ["accessToken", "synthetic-secret"],
  ],
});
const pending = () => ({
  id: "pending",
  appId: "testapp",
  state: "pending_approval",
  mappedStoreId: null,
  installationGeneration: "generation",
  revision: 1,
  authenticatedAt: now,
  uninstalledAt: null,
  redactedAt: null,
  expiresAt: null,
});
const tx = {
  ...mocks.models,
  $queryRaw: mocks.query,
  $executeRaw: mocks.execute,
  weleticShopifyPendingInstallationChange: { create: mocks.audit },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((fn) => fn(tx));
  mocks.lifecycle.mockResolvedValue(undefined);
  mocks.snapshot.mockImplementation(async () => snapshot());
  mocks.pending.mockImplementation(async () => pending());
  mocks.verify.mockResolvedValue({
    shopDomain: input.shop,
    shopCurrency: "JPY",
  });
  mocks.query.mockImplementation(async (sql) =>
    sql.strings.join("").includes("CURRENT_TIMESTAMP")
      ? [{ now }]
      : [{ expiresAt: null }],
  );
  mocks.execute.mockResolvedValue(1);
  for (const model of Object.values(mocks.models)) {
    model.count.mockResolvedValue(0);
    model.create.mockResolvedValue({});
  }
});
const noWrites = () => {
  for (const model of Object.values(mocks.models))
    expect(model.create).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
};

describe("audited minimal company-store bootstrap", () => {
  it("previews without writes or credential disclosure", async () => {
    const result = await bootstrapCompanyStore(input);
    expect(result).toMatchObject({
      applied: false,
      loyaltyActivated: false,
      createsUser: false,
      shopCurrency: "JPY",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(result.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    noWrites();
  });
  it("creates only the five bookkeeping records and one admission audit", async () => {
    const preview = await bootstrapCompanyStore(input);
    const result = await bootstrapCompanyStore({
      ...input,
      apply: true,
      expectedPreview: preview.previewDigest,
    });
    expect(result).toMatchObject({
      applied: true,
      revision: 2,
      storeAccessState: "pending_approval",
      loyaltyActivated: false,
    });
    for (const [name, model] of Object.entries(mocks.models))
      expect(model.create).toHaveBeenCalledTimes(
        [
          "project",
          "program",
          "folder",
          "partnerGroup",
          "weleticShopifyStore",
        ].includes(name)
          ? 1
          : 0,
      );
    expect(mocks.models.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ plan: "free", billingCycleStart: 1 }),
    });
    expect(mocks.models.program.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountingCurrency: "JPY",
        payoutMode: "external",
      }),
    });
    expect(mocks.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "bootstrap",
        operator: input.operator,
        revision: 2,
        reason: `${preview.previewDigest}: ${input.reason}`,
      }),
    });
  });
  it.each([
    "appId",
    "expectedRevision",
    "expectedInstallationGeneration",
    "pendingInstallationId",
  ])("rejects foreign or stale %s", async (field) => {
    await expect(
      bootstrapCompanyStore({
        ...input,
        [field]: field === "expectedRevision" ? 2 : "foreign",
      }),
    ).rejects.toThrow();
    noWrites();
  });
  it.each(["mapped", "uninstalled", "redacted"])(
    "rejects %s admission",
    async (state) => {
      mocks.pending.mockResolvedValue({ ...pending(), state });
      await expect(bootstrapCompanyStore(input)).rejects.toThrow();
      noWrites();
    },
  );
  it("requires preview approval and rejects changed currency", async () => {
    expect(
      companyStoreBootstrapInputSchema.safeParse({ ...input, apply: true })
        .success,
    ).toBe(false);
    const p = await bootstrapCompanyStore(input);
    mocks.verify.mockResolvedValue({
      shopDomain: input.shop,
      shopCurrency: "USD",
    });
    await expect(
      bootstrapCompanyStore({
        ...input,
        apply: true,
        expectedPreview: p.previewDigest,
      }),
    ).rejects.toThrow();
    noWrites();
  });
  it("rejects a session publication during provider I/O", async () => {
    mocks.snapshot.mockResolvedValueOnce(snapshot()).mockResolvedValue({
      ...snapshot(),
      observed: { ...snapshot().observed, revision: "2" },
    });
    await expect(bootstrapCompanyStore(input)).rejects.toThrow();
    noWrites();
  });
  it("rejects expired evidence after waiting for locks", async () => {
    let clocks = 0;
    mocks.query.mockImplementation(async (sql) =>
      sql.strings.join("").includes("CURRENT_TIMESTAMP")
        ? [{ now: new Date(now.getTime() + (clocks++ ? 60_001 : 0)) }]
        : [{ expiresAt: null }],
    );
    await expect(bootstrapCompanyStore(input)).rejects.toThrow();
    noWrites();
  });
  it("rejects an expired offline token", async () => {
    mocks.query.mockImplementation(async (sql) =>
      sql.strings.join("").includes("CURRENT_TIMESTAMP")
        ? [{ now }]
        : [{ expiresAt: now }],
    );
    await expect(bootstrapCompanyStore(input)).rejects.toThrow();
    noWrites();
  });
  it.each(Object.keys(mocks.models))(
    "rejects a %s collision without adoption",
    async (name) => {
      mocks.models[name].count.mockResolvedValue(1);
      await expect(bootstrapCompanyStore(input)).rejects.toThrow();
      noWrites();
    },
  );
  it("rejects a pre-existing store and unverifiable provider identity", async () => {
    mocks.lifecycle.mockResolvedValue({ id: "existing" });
    await expect(bootstrapCompanyStore(input)).rejects.toThrow();
    mocks.lifecycle.mockResolvedValue(undefined);
    mocks.verify.mockResolvedValue(null);
    await expect(bootstrapCompanyStore(input)).rejects.toThrow();
    noWrites();
  });
  it("does not accept injected currency, credentials or membership", () => {
    for (const key of ["shopCurrency", "accessToken", "userId"])
      expect(
        companyStoreBootstrapInputSchema.safeParse({
          ...input,
          [key]: "untrusted",
        }).success,
      ).toBe(false);
  });
});
