import type { PermissionAction } from "@/lib/api/rbac/permissions";
import { EarningRuleWriteError } from "@/lib/weletic/loyalty/earning-rule-writer";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GET, POST } from "../../app/(ee)/api/weletic/earning-rules/route";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ manage: vi.fn(), options: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/workspace-earning-rules", () => ({
  manageWorkspaceEarningRules: mocks.manage,
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace:
    (
      handler: (context: {
        workspace: { id: string; users: { role: string }[] };
        permissions: PermissionAction[];
        req: Request;
      }) => unknown,
      options: unknown,
    ) =>
    (req: Request) => {
      mocks.options(options);
      return handler({
        workspace: { id: "authorized", users: [{ role: "member" }] },
        permissions: ["loyalty.read", "loyalty.write"],
        req,
      });
    },
}));
const context = { params: Promise.resolve({}) };
const authority = {
  workspaceId: "authorized",
  role: "member",
  permissions: ["loyalty.read", "loyalty.write"],
};
const retire = {
  operation: "retire",
  input: {
    expectedInstallationGeneration: "g1",
    expectedRevision: "a".repeat(64),
    ruleId: "rule-a",
  },
};
const request = (body = JSON.stringify(retire)) =>
  new NextRequest(
    "https://local.test/api/weletic/earning-rules?workspaceId=foreign",
    { method: "POST", body },
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.manage.mockResolvedValue({ fixture: "service projection" });
});
describe("workspace earning-rule HTTP route (mocked authentication/service)", () => {
  it("forwards exact create values without coercion", async () => {
    const save = {
      operation: "save",
      input: {
        ...retire.input,
        ruleId: null,
        rule: {
          name: "Signup",
          description: null,
          triggerCode: "account_created",
          priority: 0,
          multiplier: "1",
          fixedPoints: "9007199254740993",
          maxPointsPerEvent: null,
          minOrderSubtotal: null,
          excludeDiscountedItems: false,
          excludeTaxesAndShipping: true,
          purchaseType: "one_time",
          subscriptionCadence: "first_payment",
          subscriptionPaymentLimit: null,
          maxEventsPerCustomer: 1,
          limitInterval: "lifetime",
          conditions: null,
          isActive: false,
        },
      },
    };
    expect((await POST(request(JSON.stringify(save)), context)).status).toBe(
      200,
    );
    expect(mocks.manage).toHaveBeenCalledExactlyOnceWith(authority, save);
  });
  it("uses authenticated workspace and private responses for reads", async () => {
    const response = await GET(
      new NextRequest(
        "https://local.test/api/weletic/earning-rules?workspaceId=foreign",
      ),
      context,
    );
    expect(response.status).toBe(200);
    expect(mocks.manage).toHaveBeenCalledWith(authority, { operation: "read" });
    expect(mocks.options).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.read"],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("forwards validated retirement separately from authority", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.manage).toHaveBeenCalledExactlyOnceWith(authority, retire);
    expect(mocks.options).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.write"],
    });
  });
  it.each([
    "{",
    "x".repeat(16385),
    "あ".repeat(6000),
    JSON.stringify({ operation: "read" }),
    JSON.stringify({ ...retire, role: "owner" }),
    JSON.stringify({
      ...retire,
      input: { ...retire.input, storeId: "foreign" },
    }),
  ])("rejects malformed, oversized or injected input", async (body) => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(mocks.manage).not.toHaveBeenCalled();
  });
  it.each([
    [new MerchantSettingsError("forbidden"), 403, "forbidden"],
    [
      new EarningRuleWriteError({ code: "not_found", message: "private" }),
      404,
      "not_found",
    ],
    [
      new EarningRuleWriteError({ code: "conflict", message: "private" }),
      409,
      "conflict",
    ],
    [
      new Prisma.PrismaClientKnownRequestError("private", {
        code: "P2034",
        clientVersion: "test",
      }),
      409,
      "conflict",
    ],
    [new Error("private"), 503, "unavailable"],
  ])("sanitizes failures without retry", async (error, status, code) => {
    mocks.manage.mockRejectedValue(error);
    const response = await POST(request(), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
    expect(mocks.manage).toHaveBeenCalledTimes(1);
  });
  it("does not classify internal schema errors as client errors", async () => {
    const result = z.string().safeParse(1);
    if (result.success) throw new Error("fixture");
    mocks.manage.mockRejectedValue(result.error);
    expect((await POST(request(), context)).status).toBe(503);
  });
});
