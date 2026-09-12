import {
  GOOGLE_ADS_INTEGRATION_ID,
  SHOPIFY_INTEGRATION_ID,
  SLACK_INTEGRATION_ID,
} from "@dub/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "../../app/api/integrations/uninstall/route";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  delete: vi.fn(),
  slackUninstall: vi.fn(),
  googleRemove: vi.fn(),
  waitUntil: vi.fn(),
  options: {} as { requiredPermissions?: string[] },
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace: (handler: unknown, options: typeof mocks.options) => {
    mocks.options = options;
    return handler;
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    installedIntegration: {
      findUnique: mocks.findUnique,
      delete: mocks.delete,
    },
  },
}));
vi.mock("@/lib/integrations/slack/oauth", () => ({
  slackOAuthProvider: { uninstall: mocks.slackUninstall },
}));
vi.mock("@/lib/integrations/google-ads/installed-workspaces", () => ({
  googleAdsInstalledWorkspaces: { remove: mocks.googleRemove },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

const invoke = () =>
  (DELETE as unknown as (context: unknown) => Promise<Response>)({
    searchParams: { installationId: "installation-test" },
    session: { user: { id: "installer-test" } },
    workspace: { id: "workspace-test" },
  });

describe("generic uninstall Shopify lifecycle boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "installation-test",
      projectId: "workspace-test",
      userId: "installer-test",
      integrationId: SHOPIFY_INTEGRATION_ID,
    });
  });

  it("retains workspace write permission and exact installation lookup", async () => {
    expect(mocks.options.requiredPermissions).toEqual(["integrations.write"]);
    await expect(invoke()).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "installation-test", projectId: "workspace-test" },
    });
  });

  it("rejects Shopify before generic deletion or provider effects", async () => {
    await expect(invoke()).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
    expect(mocks.slackUninstall).not.toHaveBeenCalled();
    expect(mocks.googleRemove).not.toHaveBeenCalled();
  });

  it("does not claim disconnection for a native-only or foreign installation", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(invoke()).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("preserves installer ownership denial", async () => {
    mocks.findUnique.mockResolvedValue({
      integrationId: SLACK_INTEGRATION_ID,
      userId: "different-user",
    });
    await expect(invoke()).rejects.toMatchObject({ code: "unauthorized" });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each([SLACK_INTEGRATION_ID, GOOGLE_ADS_INTEGRATION_ID, "other-provider"])(
    "preserves allowed non-Shopify uninstall for %s",
    async (integrationId) => {
      const installation = {
        id: "installation-test",
        projectId: "workspace-test",
        userId: "installer-test",
        integrationId,
      };
      mocks.findUnique.mockResolvedValue(installation);
      mocks.delete.mockResolvedValue({ integrationId, webhooks: [] });
      const response = await invoke();
      expect(await response.json()).toEqual({ id: "installation-test" });
      expect(mocks.delete).toHaveBeenCalledOnce();
      expect(mocks.waitUntil).toHaveBeenCalledOnce();
      if (integrationId === SLACK_INTEGRATION_ID)
        expect(mocks.slackUninstall).toHaveBeenCalledWith(installation);
      else expect(mocks.slackUninstall).not.toHaveBeenCalled();
      if (integrationId === GOOGLE_ADS_INTEGRATION_ID)
        expect(mocks.googleRemove).toHaveBeenCalledWith("workspace-test");
      else expect(mocks.googleRemove).not.toHaveBeenCalled();
    },
  );
});
