import type { PermissionAction } from "@/lib/api/rbac/permissions";
import { LoyaltySettingsWriteError } from "@/lib/weletic/loyalty/settings-writer";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  PATCH,
} from "../../app/(ee)/api/weletic/loyalty-configuration/route";

const mocks = vi.hoisted(() => ({ manage: vi.fn(), options: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/workspace-configuration", () => ({
  manageWorkspaceLoyaltyConfiguration: mocks.manage,
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace:
    (
      handler: (context: {
        workspace: { id: string; users: { role: string }[] };
        req: Request;
        permissions: PermissionAction[];
      }) => unknown,
      options: unknown,
    ) =>
    (req: Request) => {
      mocks.options(options);
      return handler({
        workspace: { id: "authorized", users: [{ role: "member" }] },
        req,
        permissions: ["loyalty.read", "loyalty.write"],
      });
    },
}));
const context = { params: Promise.resolve({}) };
const body = {
  expectedRevision: null,
  expectedInstallationGeneration: "g1",
  settings: { name: "Changed" },
};
const request = (raw = JSON.stringify(body)) =>
  new NextRequest(
    "https://local.test/api/weletic/loyalty-configuration?workspaceId=foreign",
    { method: "PATCH", body: raw },
  );
describe("workspace configuration HTTP boundary (mocked authentication)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.manage.mockResolvedValue({ configurationRevision: null });
  });
  it("uses authenticated workspace and scoped permissions on reads", async () => {
    const response = await GET(
      new NextRequest(
        "https://local.test/api/weletic/loyalty-configuration?workspaceId=foreign",
      ),
      context,
    );
    expect(mocks.manage).toHaveBeenCalledWith({
      workspaceId: "authorized",
      role: "member",
      permissions: ["loyalty.read", "loyalty.write"],
    });
    expect(mocks.options).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.read"],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("passes only boundary-supplied authority alongside untrusted update input", async () => {
    expect((await PATCH(request(), context)).status).toBe(200);
    expect(mocks.manage).toHaveBeenCalledWith(
      {
        workspaceId: "authorized",
        role: "member",
        permissions: ["loyalty.read", "loyalty.write"],
      },
      body,
    );
    expect(mocks.options).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.write"],
    });
  });
  it.each(["{", "x".repeat(16385)])(
    "rejects malformed or oversized bodies before service access",
    async (raw) => {
      expect((await PATCH(request(raw), context)).status).toBe(400);
      expect(mocks.manage).not.toHaveBeenCalled();
    },
  );
  it.each([
    [new MerchantSettingsError("forbidden"), 403],
    [new MerchantSettingsError("not_found"), 404],
    [
      new LoyaltySettingsWriteError({ code: "conflict", message: "Reload" }),
      409,
    ],
    [
      new LoyaltySettingsWriteError({
        code: "bad_request",
        message: "Invalid currency",
      }),
      400,
    ],
    [
      new Prisma.PrismaClientKnownRequestError("private database detail", {
        code: "P2034",
        clientVersion: "test",
      }),
      409,
    ],
    [new Error("private database detail"), 503],
  ])(
    "maps expected failures without retrying or leaking internal details",
    async (error, status) => {
      mocks.manage.mockRejectedValue(error);
      const response = await PATCH(request(), context);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("private database detail");
      expect(mocks.manage).toHaveBeenCalledTimes(1);
    },
  );
});
