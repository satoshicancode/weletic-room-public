import { verifyWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import type {
  ShopifySessionLeaseProof,
  ShopifySessionMutationFence,
  ShopifySessionProperty,
  ShopifySessionSnapshot,
} from "@/lib/weletic/shopify/session-contract";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatedWeleticSessionStorage } from "../../../../packages/shopify-app/app/coordinated-session-storage.server";

const shop = "coordination-test.myshopify.com";
const id = `offline_${shop}`;
const serviceSecret = "synthetic-session-test-service-secret-32-characters";
const digest = (input: string) =>
  createHash("sha256").update(input).digest("hex");

// This gateway is an intercepted HTTP fixture, NOT database/live proof. The
// actual Shopify SDK, storage adapter, signed client and transport run below.
function gateway(preparedReconnect = false) {
  let epoch = "0";
  let revision = "0";
  let owner: ShopifySessionLeaseProof | null = null;
  let properties: ShopifySessionProperty[] | null = [
    ["id", id],
    ["shop", shop],
    ["state", ""],
    ["isOnline", false],
    ["scope", "read_products"],
    ["accessToken", "synthetic-old-token"],
    ["expires", Date.now() - 60_000],
    ["refreshToken", "synthetic-refresh"],
    ["refreshTokenExpires", Date.now() + 86_400_000],
  ];
  if (preparedReconnect) properties = null;
  const snapshot = (): ShopifySessionSnapshot => ({
    properties: controls.missingSession ? null : properties,
    observed: {
      epoch,
      revision,
      sessionDigest: digest(
        properties ? JSON.stringify(properties) : "missing",
      ),
      installationGeneration: controls.generation,
      credentialTokenHash: controls.credentialTokenHash,
    },
  });
  const controls = {
    generation: (preparedReconnect ? "prepared-generation" : "generation-1") as
      | string
      | null,
    missingSession: false,
    credentialTokenHash: (preparedReconnect
      ? null
      : digest("synthetic-old-token")) as string | null,
    reconnectBeforeRenew: false,
    rejectAcquire: false,
    invalidAcquireAck: false,
    rejectRenew: false,
    uncertainPublish: false,
    invalidPublishAck: false,
    malformedPublishAck: false,
    providerCalls: 0,
    mutationCalls: 0,
    providerFailure: false,
  };
  const fetcher = vi.fn(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === shop) {
        if (url.pathname === "/admin/oauth/access_token") {
          controls.providerCalls++;
          expect(owner).not.toBeNull();
          expect(request.signal).toBeDefined();
          if (preparedReconnect) {
            expect(await request.clone().json()).toMatchObject({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              requested_token_type:
                "urn:shopify:params:oauth:token-type:offline-access-token",
            });
          }
          if (controls.providerFailure)
            throw new Error("synthetic transport uncertainty");
          return Response.json({
            access_token: "synthetic-fresh-token",
            scope: "read_products",
            expires_in: 3600,
            refresh_token: "synthetic-fresh-refresh",
            refresh_token_expires_in: 7_776_000,
          });
        }
        return Response.json({
          data: {
            currentAppInstallation: {
              accessScopes: [{ handle: "read_products" }],
            },
          },
        });
      }
      expect(url.hostname).toBe("session-gateway.invalid");
      const body = init?.body ? String(init.body) : "";
      expect(verifyWeleticShopifyRequest({ request, body })).toBe(true);
      if (request.method === "GET") return Response.json(snapshot());
      const data = JSON.parse(body);
      if (url.pathname.endsWith("/coordination")) {
        if (data.action === "acquire") {
          if (
            controls.rejectAcquire ||
            owner ||
            data.observed.epoch !== epoch ||
            data.observed.revision !== revision
          )
            return Response.json({ error: "lease_busy" }, { status: 409 });
          epoch = String(BigInt(epoch) + BigInt(1));
          owner = { token: data.token, epoch, revision };
          return Response.json(
            controls.invalidAcquireAck ? {} : { lease: owner },
          );
        }
        if (data.action === "renew") {
          if (controls.reconnectBeforeRenew)
            controls.generation = "generation-2";
          const stale =
            data.observed &&
            (data.observed.installationGeneration !== controls.generation ||
              data.observed.credentialTokenHash !==
                controls.credentialTokenHash);
          return Response.json(
            controls.rejectRenew || stale
              ? { error: "stale_session" }
              : { renewed: true },
            { status: controls.rejectRenew || stale ? 409 : 200 },
          );
        }
        if (data.action === "release") {
          if (owner?.token === data.lease.token) owner = null;
          return Response.json({ released: true });
        }
      }
      expect(url.pathname).toBe("/api/internal/shopify/sessions/coordinated");
      controls.mutationCalls++;
      const fence = data.coordination as ShopifySessionMutationFence;
      expect(fence.lease).toEqual(owner);
      expect(fence.observed.revision).toBe(revision);
      expect(fence.observed.sessionDigest).toBe(
        snapshot().observed.sessionDigest,
      );
      properties = request.method === "DELETE" ? null : data.properties;
      const token = properties?.find(([key]) => key === "accessToken")?.[1];
      if (typeof token === "string" && token)
        controls.credentialTokenHash = digest(token);
      revision = String(BigInt(revision) + BigInt(1));
      owner = { ...fence.lease, revision };
      if (controls.uncertainPublish)
        throw new Error("synthetic post-commit crash");
      const result =
        request.method === "DELETE" ? { deleted: 1 } : { stored: true };
      return Response.json({
        ...result,
        ...(!controls.invalidPublishAck && {
          coordination: controls.malformedPublishAck
            ? {}
            : { lease: owner, observed: snapshot().observed },
        }),
      });
    },
  );
  return { controls, fetcher, snapshot, owner: () => owner };
}

describe("coordinated Shopify SDK operations", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SHOPIFY_API_KEY", "synthetic-app-key");
    vi.stubEnv("SHOPIFY_API_SECRET", "synthetic-app-secret");
    vi.stubEnv("SCOPES", "read_products");
    vi.stubEnv("SHOPIFY_APP_URL", "https://shopify-runtime.invalid");
    vi.stubEnv("WELETIC_API_URL", "https://session-gateway.invalid");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("recovers a prepared mapped reconnect through real SDK token exchange after provider failure", async () => {
    const fixture = gateway(true);
    fixture.controls.providerFailure = true;
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const now = Math.floor(Date.now() / 1000);
    const encoded = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({
          iss: `https://${shop}/admin`,
          dest: `https://${shop}`,
          aud: "synthetic-app-key",
          sub: "123",
          iat: now - 1,
          nbf: now - 1,
          exp: now + 60,
          sid: "synthetic-session",
          jti: "synthetic-reconnect",
        }),
      ).toString("base64url"),
    ].join(".");
    const token = `${encoded}.${createHmac("sha256", "synthetic-app-secret").update(encoded).digest("base64url")}`;
    const request = () =>
      new Request(`https://shopify-runtime.invalid/?shop=${shop}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    await expect(sdk.authenticate.admin(request())).rejects.toBeDefined();
    expect(fixture.controls.providerCalls).toBe(1);
    expect(fixture.controls.mutationCalls).toBe(0);
    expect(fixture.snapshot().observed).toMatchObject({
      installationGeneration: "prepared-generation",
      credentialTokenHash: null,
      revision: "0",
    });
    expect(fixture.owner()).toBeNull();
    fixture.controls.providerFailure = false;
    const result = await sdk.authenticate.admin(request());
    expect(result.session.accessToken).toBe("synthetic-fresh-token");
    expect(fixture.controls.providerCalls).toBe(2);
    expect(fixture.controls.mutationCalls).toBe(1);
    expect(fixture.snapshot().observed).toMatchObject({
      installationGeneration: "prepared-generation",
      credentialTokenHash: digest("synthetic-fresh-token"),
      revision: "1",
    });
    expect(fixture.owner()).toBeNull();
    // Simulated backend transport, not SQL or live-install acceptance. No
    // generic integration, workspace user, or generation recreation is modeled.
  });

  it("uses the production SDK refresh path, saves its NEW Session, then releases ownership", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const { session } = await sdk.unauthenticated.admin(shop);
    expect(session.accessToken).toBe("synthetic-fresh-token");
    expect(session.refreshToken).toBe("synthetic-fresh-refresh");
    expect(fixture.controls.providerCalls).toBe(1);
    expect(fixture.controls.mutationCalls).toBe(1);
    expect(fixture.snapshot().observed.revision).toBe("1");
    expect(fixture.owner()).toBeNull();
  });

  it("retains an old object's observation across a later successful SDK refresh", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const stale = await sdk.sessionStorage.loadSession(id);
    expect(stale).toBeDefined();
    await sdk.unauthenticated.admin(shop);
    stale!.accessToken = undefined; // The SDK's delayed 401 invalidation behavior.
    await expect(sdk.sessionStorage.storeSession(stale!)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(fixture.controls.mutationCalls).toBe(1);
    expect(fixture.snapshot().observed.revision).toBe("1");
  });

  it("allows one provider refresh across competing SDK operations", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const results = await Promise.allSettled([
      sdk.unauthenticated.admin(shop),
      sdk.unauthenticated.admin(shop),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(fixture.controls.providerCalls).toBe(1);
    expect(fixture.controls.mutationCalls).toBe(1);
  });

  it("uses the actual SDK for an installed background operation", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const { session } = await sdk.installedUnauthenticated.admin(
      shop,
      "generation-1",
    );
    expect(session.accessToken).toBe("synthetic-fresh-token");
    expect(fixture.controls.providerCalls).toBe(1);
    expect(fixture.controls.mutationCalls).toBe(1);
    expect(fixture.owner()).toBeNull();
  });

  it("maps an actual SDK missing-session error to the scoped reconnect contract", async () => {
    const fixture = gateway();
    fixture.controls.missingSession = true;
    vi.stubGlobal("fetch", fixture.fetcher);
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.installed-admin-session"
    );
    const {
      signWeleticShopifyRequest,
      WELETIC_SHOPIFY_SIGNATURE_HEADER,
      WELETIC_SHOPIFY_TIMESTAMP_HEADER,
    } = await import("@/lib/weletic/shopify/service-auth");
    const path = `/api/internal/installed-admin-session?shop=${shop}&generation=generation-1`;
    const timestamp = String(Date.now());
    const request = new Request(`https://shopify-runtime.invalid${path}`, {
      headers: {
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signWeleticShopifyRequest({
          timestamp,
          method: "GET",
          path,
          body: "",
          secret: serviceSecret,
        }),
      },
    });
    const response = await loader({ request, params: {}, context: {} });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "SESSION_MISSING",
      shop,
      installationGeneration: "generation-1",
      error: "Offline Shopify session unavailable",
    });
    expect(fixture.controls.providerCalls).toBe(0);
    expect(fixture.controls.mutationCalls).toBe(0);
  });

  it.each(["generation-2", null])(
    "rejects delayed background work before provider I/O when current generation is %s",
    async (generation) => {
      const fixture = gateway();
      fixture.controls.generation = generation;
      vi.stubGlobal("fetch", fixture.fetcher);
      const sdk = await import(
        "../../../../packages/shopify-app/app/shopify.server"
      );
      await expect(
        sdk.installedUnauthenticated.admin(shop, "generation-1"),
      ).rejects.toMatchObject({ status: 409 });
      expect(fixture.controls.providerCalls).toBe(0);
      expect(fixture.controls.mutationCalls).toBe(0);
      expect(fixture.owner()).toBeNull();
    },
  );

  it("allows one refresh across background and interactive contenders; a later duplicate only loads", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const results = await Promise.allSettled([
      sdk.installedUnauthenticated.admin(shop, "generation-1"),
      sdk.installedUnauthenticated.admin(shop, "generation-1"),
      sdk.unauthenticated.admin(shop),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await sdk.installedUnauthenticated.admin(shop, "generation-1");
    expect(fixture.controls.providerCalls).toBe(1);
    expect(fixture.controls.mutationCalls).toBe(1);
  });

  it("rejects reconnect between acquisition and token transport without calling Shopify", async () => {
    const fixture = gateway();
    fixture.controls.reconnectBeforeRenew = true;
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    await expect(
      sdk.installedUnauthenticated.admin(shop, "generation-1"),
    ).rejects.toThrow();
    expect(fixture.controls.providerCalls).toBe(0);
    expect(fixture.controls.mutationCalls).toBe(0);
  });

  it("does not return a missing-session alert after a reconnect", async () => {
    const fixture = gateway();
    fixture.controls.missingSession = true;
    fixture.controls.reconnectBeforeRenew = true;
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    await expect(
      sdk.installedUnauthenticated.admin(shop, "generation-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.controls.providerCalls).toBe(0);
  });

  it.each([null, "invalid"])(
    "rejects an installed operation without a valid projection binding: %s",
    async (credentialTokenHash) => {
      const fixture = gateway();
      fixture.controls.credentialTokenHash = credentialTokenHash;
      vi.stubGlobal("fetch", fixture.fetcher);
      const sdk = await import(
        "../../../../packages/shopify-app/app/shopify.server"
      );
      await expect(
        sdk.installedUnauthenticated.admin(shop, "generation-1"),
      ).rejects.toMatchObject({ status: 409 });
      expect(fixture.controls.providerCalls).toBe(0);
      expect(fixture.controls.mutationCalls).toBe(0);
    },
  );

  it.each(["rejectAcquire", "invalidAcquireAck", "rejectRenew"] as const)(
    "does not exchange tokens when %s",
    async (flag) => {
      const fixture = gateway();
      fixture.controls[flag] = true;
      vi.stubGlobal("fetch", fixture.fetcher);
      const sdk = await import(
        "../../../../packages/shopify-app/app/shopify.server"
      );
      await expect(sdk.unauthenticated.admin(shop)).rejects.toThrow();
      expect(fixture.controls.providerCalls).toBe(0);
      expect(fixture.controls.mutationCalls).toBe(0);
    },
  );

  it("never retries an uncertain token exchange within the operation", async () => {
    const fixture = gateway();
    fixture.controls.providerFailure = true;
    vi.stubGlobal("fetch", fixture.fetcher);
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    await expect(sdk.unauthenticated.admin(shop)).rejects.toThrow();
    expect(fixture.controls.providerCalls).toBe(1);
    expect(fixture.controls.mutationCalls).toBe(0);
  });

  it.each([
    "uncertainPublish",
    "invalidPublishAck",
    "malformedPublishAck",
  ] as const)(
    "fails closed after %s, even if a caller catches the store error",
    async (flag) => {
      const fixture = gateway();
      fixture.controls[flag] = true;
      vi.stubGlobal("fetch", fixture.fetcher);
      const storage = new CoordinatedWeleticSessionStorage();
      await expect(
        storage.runOperation(async () => {
          const session = await storage.loadSession(id);
          await expect(storage.storeSession(session!)).rejects.toThrow();
          await expect(storage.storeSession(session!)).rejects.toMatchObject({
            status: 409,
          });
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(fixture.controls.mutationCalls).toBe(1);
    },
  );

  it("rejects an online exchange observed before an intervening offline publication", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    const { deserializeShopifySession } = await import(
      "../../../../packages/shopify-app/app/session-properties.server"
    );
    await storage.runOperation(async () => {
      const offline = (await storage.loadSession(id))!;
      await storage.tokenRequest(
        `https://${shop}/admin/oauth/access_token`,
        {},
        async () =>
          Response.json({
            access_token: "synthetic-online-token",
            expires_in: 60,
            associated_user_scope: "read_products",
            associated_user: {
              id: 123,
              account_owner: false,
              collaborator: false,
            },
          }),
      );
      offline.accessToken = "synthetic-fresh-token";
      expect(await storage.storeSession(offline)).toBe(true);
      const online = deserializeShopifySession([
        ["id", `${shop}_123`],
        ["shop", shop],
        ["state", ""],
        ["isOnline", true],
        ["userId", 123],
        ["accountOwner", false],
        ["collaborator", false],
        ["associatedUserScope", "read_products"],
        ["accessToken", "synthetic-online-token"],
        ["expires", Date.now() + 60000],
      ])!;
      await expect(storage.storeSession(online)).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(fixture.controls.mutationCalls).toBe(1);
    expect(fixture.snapshot().observed.revision).toBe("1");
    expect(
      fixture
        .snapshot()
        .properties?.find(([key]) => key === "accessToken")?.[1],
    ).toBe("synthetic-fresh-token");
  });

  it("rejects token exchange outside an operation before provider I/O", async () => {
    const storage = new CoordinatedWeleticSessionStorage();
    const transport = vi.fn<typeof fetch>();
    await expect(
      storage.tokenRequest(
        `https://${shop}/admin/oauth/access_token`,
        {},
        transport,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["truncated", "malformed", "oversized", "missing-token"])(
    "poisons ownership after a %s token response body, even if caught",
    async (kind) => {
      const fixture = gateway();
      vi.stubGlobal("fetch", fixture.fetcher);
      const storage = new CoordinatedWeleticSessionStorage();
      const transport = vi.fn<typeof fetch>(async () => {
        if (kind === "truncated")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new Error("synthetic interrupted response body"),
                );
              },
            }),
          );
        return new Response(
          kind === "oversized"
            ? "x".repeat(65_537)
            : kind === "malformed"
              ? "{"
              : "{}",
        );
      });
      await expect(
        storage.runOperation(async () => {
          await storage.loadSession(id);
          await expect(
            storage.tokenRequest(
              `https://${shop}/admin/oauth/access_token`,
              {},
              transport,
            ),
          ).rejects.toMatchObject({ status: 503 });
          await expect(
            storage.tokenRequest(
              `https://${shop}/admin/oauth/access_token`,
              {},
              transport,
            ),
          ).rejects.toMatchObject({ status: 409 });
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(transport).toHaveBeenCalledOnce();
      expect(fixture.controls.mutationCalls).toBe(0);
    },
  );

  it("fails closed after a local pause crosses the safe ownership deadline", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await expect(
      storage.runOperation(async () => {
        const session = await storage.loadSession(id);
        vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
        await expect(storage.storeSession(session!)).rejects.toMatchObject({
          status: 409,
        });
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.controls.mutationCalls).toBe(0);
  });

  it("publishes deletion with the original snapshot and updated revision", async () => {
    const fixture = gateway();
    vi.stubGlobal("fetch", fixture.fetcher);
    const storage = new CoordinatedWeleticSessionStorage();
    await storage.runOperation(async () => {
      await storage.loadSession(id);
      await storage.deleteSession(id);
    });
    expect(fixture.snapshot().properties).toBeNull();
    expect(fixture.snapshot().observed.revision).toBe("1");
  });
});
