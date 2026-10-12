import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

const state = vi.hoisted(() => ({
  scopes: "links.read",
  isMachine: true,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ Authorization: "Bearer dub_testkey" })),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (handler: any) => handler,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), flush: vi.fn(async () => {}) },
  toErrorFields: (e: unknown) => ({ message: String(e) }),
}));

vi.mock("@/lib/api-logs/capture-request-log", () => ({
  captureRequestLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/edge-config", () => ({ getFeatureFlags: vi.fn(async () => ({})) }));

vi.mock("@/lib/auth/token-cache", () => ({
  tokenCache: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
}));

vi.mock("@/lib/upstash", () => ({
  ratelimit: () => ({ limit: vi.fn(async () => ({ success: false })) }),
  redis: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    restrictedToken: {
      findUnique: vi.fn(async () => ({
        id: "tok_1",
        expires: null,
        scopes: state.scopes,
        projectId: "ws_1",
        installationId: null,
        project: { plan: "business", trialEndsAt: null },
        user: { id: "user_machine", name: "Machine", email: "m@x.test", isMachine: state.isMachine },
      })),
      update: vi.fn(async () => ({})),
    },
    project: {
      findUnique: vi.fn(async () => ({
        id: "ws_1",
        slug: "acme",
        plan: "business",
        users: [{ role: "owner", defaultFolderId: null, workspacePreferences: null }],
      })),
    },
  },
}));

import { withWorkspace } from "@/lib/auth/workspace";
import { workspaceAuthCache } from "@/lib/auth/workspace-cache";

function call(handlerOptions: Parameters<typeof withWorkspace>[1]) {
  const handler = vi.fn(async () => Response.json({ ok: true }));
  const route = withWorkspace(handler as any, {
    requiredPlan: ["business"],
    ...handlerOptions,
  }) as any;
  const req = new NextRequest("https://api.test/api/weletic/commission-rules?workspaceId=ws_1", {
    method: "POST",
  });
  return { handler, run: () => route(req, { params: Promise.resolve({}) }) };
}

describe("withWorkspace: restricted token scope enforcement on role-only routes", () => {
  beforeEach(() => {
    workspaceAuthCache.clear();
    state.scopes = "links.read";
    state.isMachine = true;
  });

  it("rejects a restricted key without apis.all when the route only declares requiredRoles", async () => {
    const { handler, run } = call({ requiredRoles: ["owner"] });

    const res = await run();

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows a restricted key with apis.all on a role-only route", async () => {
    state.scopes = "apis.all";
    const { handler, run } = call({ requiredRoles: ["owner"] });

    const res = await run();

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still enforces scopes through requiredPermissions (unchanged behavior)", async () => {
    const denied = call({ requiredPermissions: ["links.write"], requiredRoles: ["owner"] });
    expect((await denied.run()).status).toBe(403);
    expect(denied.handler).not.toHaveBeenCalled();

    state.scopes = "links.write";
    workspaceAuthCache.clear();
    const allowed = call({ requiredPermissions: ["links.write"], requiredRoles: ["owner"] });
    expect((await allowed.run()).status).toBe(200);
  });

  it("does not affect routes with no role or permission requirement", async () => {
    const { handler, run } = call({});
    expect((await run()).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
