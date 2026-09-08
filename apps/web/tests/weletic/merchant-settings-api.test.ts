import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "../../app/(ee)/api/weletic/merchant-settings/route";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  permissions: vi.fn(),
  role: "owner",
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/weletic/merchant-settings/service", () => ({
  readMerchantSettings: mocks.read,
  updateMerchantSettings: mocks.save,
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace:
    (
      handler: (context: {
        workspace: { id: string; users: { role: string }[] };
        req: Request;
      }) => unknown,
      options: unknown,
    ) =>
    (req: Request) => {
      mocks.permissions(options);
      return handler({
        workspace: { id: "authorized", users: [{ role: mocks.role }] },
        req,
      });
    },
}));
const context = { params: Promise.resolve({}) };
describe("shared settings HTTP adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "owner";
    mocks.read.mockResolvedValue({ revision: 0 });
    mocks.save.mockResolvedValue({ revision: 1 });
  });
  it("reads through authorized workspace and private response contract", async () => {
    const response = await GET(
      new NextRequest(
        "https://local.test/api/weletic/merchant-settings?workspaceId=foreign",
      ),
      context,
    );
    expect(mocks.read).toHaveBeenCalledWith("authorized");
    expect(mocks.permissions).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.read"],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("passes authenticated role and workspace to the owner-enforcing service", async () => {
    mocks.role = "member";
    mocks.save.mockRejectedValueOnce(new MerchantSettingsError("forbidden"));
    const body = {
      expectedRevision: 0,
      expectedInstallationGeneration: "g1",
      settings: { brandName: "Shop" },
    };
    const response = await PATCH(
      new NextRequest(
        "https://local.test/api/weletic/merchant-settings?workspaceId=foreign",
        { method: "PATCH", body: JSON.stringify(body) },
      ),
      context,
    );
    expect(response.status).toBe(403);
    expect(mocks.save).toHaveBeenCalledWith("authorized", body, "member");
    expect(mocks.permissions).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.write"],
    });
  });
  it.each(["{", "x".repeat(16385)])(
    "rejects invalid or oversized body before service writes",
    async (body) => {
      const response = await PATCH(
        new NextRequest("https://local.test/api/weletic/merchant-settings", {
          method: "PATCH",
          body,
        }),
        context,
      );
      expect(response.status).toBe(400);
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );
});
