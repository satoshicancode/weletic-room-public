import type { ValidatedEarningRuleData } from "@/lib/weletic/loyalty/earning-rule-writer";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  DELETE,
  GET,
  POST,
} from "../../app/(ee)/api/shopify/loyalty/admin/earn-rules/route";
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  program: vi.fn(),
  upsert: vi.fn(),
  rule: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  fence: vi.fn(),
  permissions: vi.fn(),
  native: vi.fn(),
  judgeme: vi.fn(),
}));
const tx = {
  weleticReviewSettings: { findUnique: mocks.native },
  weleticLoyaltyReviewIntegration: { findUnique: mocks.judgeme },
  weleticLoyaltyProgram: { findUnique: mocks.program, upsert: mocks.upsert },
  weleticLoyaltyEarningRule: {
    findFirst: mocks.rule,
    create: mocks.create,
    update: mocks.update,
  },
};
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    weleticLoyaltyProgram: { findUnique: mocks.program },
    weleticLoyaltyEarningRule: { findFirst: mocks.rule },
  },
}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: mocks.publish,
}));
vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: (options: {
    storeId: string;
    action: string;
    operation: (client: typeof tx) => Promise<unknown>;
  }) => {
    mocks.fence({ storeId: options.storeId, action: options.action });
    return options.operation(tx);
  },
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace:
    (
      handler: (context: {
        workspace: { id: string };
        req: Request;
        searchParams: Record<string, string>;
      }) => Promise<Response>,
      options: unknown,
    ) =>
    (req: Request) => {
      mocks.permissions(options);
      return handler({
        workspace: { id: "workspace-a" },
        req,
        searchParams: Object.fromEntries(new URL(req.url).searchParams),
      });
    },
}));
const context = { params: Promise.resolve({}) };
const request = (body: unknown) =>
  new NextRequest("https://local.test/api/shopify/loyalty/admin/earn-rules", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("earning-rule production route (mocked authority and persistence)", () => {
  it("requires explicit activation and excludes lifecycle fields from normalized writes", () => {
    expectTypeOf<Pick<ValidatedEarningRuleData, "isActive">>().toEqualTypeOf<{
      isActive: boolean;
    }>();
    expectTypeOf<
      Extract<
        keyof ValidatedEarningRuleData,
        "id" | "programId" | "deletedAt" | "createdAt" | "updatedAt"
      >
    >().toEqualTypeOf<never>();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.store.mockResolvedValue({ id: "store-a" });
    mocks.program.mockResolvedValue({ id: "program-a", earningRules: [] });
    mocks.upsert.mockResolvedValue({ id: "program-a" });
    mocks.rule.mockResolvedValue({
      id: "rule-a",
      programId: "program-a",
      deletedAt: null,
    });
    mocks.create.mockImplementation(async ({ data }) => data);
    mocks.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
    }));
  });
  it("serializes populated reads without losing large point values", async () => {
    mocks.program.mockResolvedValue({
      id: "program-a",
      earningRules: [
        {
          id: "rule-a",
          fixedPoints: BigInt("9007199254740993"),
          multiplier: new Prisma.Decimal("1.25"),
        },
      ],
    });
    const response = await GET(
      new NextRequest(
        "https://local.test/api/shopify/loyalty/admin/earn-rules",
      ),
      context,
    );
    expect(await response.json()).toEqual({
      data: {
        programId: "program-a",
        rules: [
          { id: "rule-a", fixedPoints: "9007199254740993", multiplier: "1.25" },
        ],
      },
    });
  });
  it("updates a scoped rule and preserves order defaults in its response", async () => {
    const response = await POST(
      request({ ruleId: "rule-a", name: "Changed" }),
      context,
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "rule-a" },
      data: expect.objectContaining({
        priority: 0,
        isActive: true,
        excludeDiscountedItems: false,
        excludeTaxesAndShipping: true,
        maxEventsPerCustomer: null,
        limitInterval: null,
        conditions: Prisma.DbNull,
      }),
    });
    expect(await response.json()).toMatchObject({
      data: {
        success: true,
        rule: { id: "rule-a", name: "Changed", multiplier: "1" },
      },
    });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store-a",
      programId: "program-a",
      reason: "earning_rule_updated",
    });
  });
  it.each(["native", "judgeme"])(
    "requires the selected %s review provider before activation",
    async (provider) => {
      const selected = provider === "native" ? mocks.native : mocks.judgeme;
      const other = provider === "native" ? mocks.judgeme : mocks.native;
      selected.mockResolvedValue({ enabled: false });
      const body = {
        name: "Review",
        triggerCode: "product_review",
        fixedPoints: "20",
        conditions: { provider },
      };
      await expect(POST(request(body), context)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
      selected.mockResolvedValue({ enabled: true });
      await POST(request(body), context);
      expect(mocks.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conditions: expect.objectContaining({ provider }),
          maxEventsPerCustomer: 2,
          limitInterval: "monthly",
        }),
      });
      expect(mocks.publish).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps the legacy id alias for scoped soft retirement", async () => {
    const response = await DELETE(
      new NextRequest(
        "https://local.test/api/shopify/loyalty/admin/earn-rules?id=rule-a",
        { method: "DELETE" },
      ),
      context,
    );
    expect(mocks.rule).toHaveBeenCalledWith({
      where: { id: "rule-a", programId: "program-a", deletedAt: null },
    });
    expect(await response.json()).toEqual({
      data: { success: true, deletedRuleId: "rule-a" },
    });
  });
  it("returns an empty read without initializing a program", async () => {
    mocks.program.mockResolvedValue(null);
    const response = await GET(
      new NextRequest(
        "https://local.test/api/shopify/loyalty/admin/earn-rules",
      ),
      context,
    );
    expect(await response.json()).toEqual({ data: { rules: [] } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.permissions).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.read"],
    });
  });
  it("preserves order defaults and publishes through the fenced transaction", async () => {
    await POST(
      request({
        name: "Purchase",
        multiplier: "1.25",
        minOrderSubtotal: "20.50",
      }),
      context,
    );
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        programId: "program-a",
        triggerCode: "order_paid",
        ruleType: "multiplier",
        multiplier: new Prisma.Decimal("1.25"),
        minOrderSubtotal: new Prisma.Decimal("20.50"),
        fixedPoints: null,
        excludeTaxesAndShipping: true,
      }),
    });
    expect(mocks.fence).toHaveBeenCalledWith({
      storeId: "store-a",
      action: "loyalty_earning_rule_write",
    });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store-a",
      programId: "program-a",
      reason: "earning_rule_created",
    });
    expect(mocks.permissions).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.write"],
    });
  });
  it.each([
    ["birthday", "calendar_year"],
    ["account_created", "lifetime"],
  ])("enforces the fixed interval for %s", async (triggerCode, interval) => {
    await POST(
      request({
        name: "Action",
        triggerCode,
        fixedPoints: "9007199254740993",
        limitInterval: "monthly",
      }),
      context,
    );
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fixedPoints: BigInt("9007199254740993"),
        limitInterval: interval,
        ruleType: "fixed_points",
        multiplier: new Prisma.Decimal(1),
      }),
    });
  });
  it.each([
    { name: "Invalid", triggerCode: "unknown" },
    { name: "Invalid", multiplier: 0 },
    { name: "Invalid", triggerCode: "birthday", fixedPoints: 0 },
    { name: "Invalid", excludeTaxesAndShipping: false },
    { name: "Invalid", isActive: "true" },
  ])("rejects invalid inputs before persistence: %j", async (body) => {
    await expect(POST(request(body), context)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("scopes updates to the program and refuses foreign or retired rules", async () => {
    mocks.rule.mockResolvedValue(null);
    await expect(
      POST(request({ name: "Changed", ruleId: "foreign" }), context),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.rule).toHaveBeenCalledWith({
      where: { id: "foreign", programId: "program-a", deletedAt: null },
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rechecks a rule that became unavailable after the pre-fence lookup", async () => {
    mocks.rule
      .mockResolvedValueOnce({
        id: "rule-a",
        programId: "program-a",
        deletedAt: null,
      })
      .mockResolvedValueOnce(null);
    await expect(
      DELETE(
        new NextRequest(
          "https://local.test/api/shopify/loyalty/admin/earn-rules?ruleId=rule-a",
          { method: "DELETE" },
        ),
        context,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.fence).toHaveBeenCalledWith({
      storeId: "store-a",
      action: "loyalty_earning_rule_delete",
    });
    expect(mocks.rule).toHaveBeenCalledTimes(2);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("soft-retires a rule and publishes its new policy instead of deleting history", async () => {
    await DELETE(
      new NextRequest(
        "https://local.test/api/shopify/loyalty/admin/earn-rules?ruleId=rule-a",
        { method: "DELETE" },
      ),
      context,
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "rule-a" },
      data: { deletedAt: expect.any(Date), isActive: false },
    });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({
      tx,
      storeId: "store-a",
      programId: "program-a",
      reason: "earning_rule_retired",
    });
  });
});
